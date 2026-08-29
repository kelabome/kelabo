import { Worker } from "node:worker_threads";
import { queryUtt, getMeta } from "../db.js";
import { loadKelaboHistory } from "./history.js";
import { loadJourneyContext, historyStillApplies } from "./journeyContext.js";
import { loadEffectiveMcp } from "./mcp.js";
import { WEB_SEARCH_ENABLED } from "./subagents.js";
import { languageName } from "./language.js";
import { LLM_CONFIG, llmApiKeyFrom } from "@kelabo/contracts/credentials";
import { resolveModelConfig as resolveModel } from "./llm.js";

/**
 * How long the minutes may take before the request is abandoned.
 *
 * Minutes are the largest prompt the system ever sends — the entire transcript
 * of the kelabo against an 8k output — and they run on the same single worker
 * that is still classifying whatever captions arrived while the room was being
 * torn down. At 90 s this silently produced **no minutes for any real kelabo**:
 * a one-utterance test finished in 10 s and passed, a 32-minute conversation
 * with 103 utterances did not, and because a timeout resolved `null` and the
 * caller logged nothing, the only symptom was a record with no minutes and not
 * one line anywhere saying why.
 *
 * Generous on purpose. Nothing waits on this — the kelabo has already ended and
 * the archive is already durable — so the only cost of a long ceiling is a
 * pending promise, while the cost of a short one is the feature silently not
 * working. The real bound is the task's shutdown, not this number.
 */
const SUMMARIZE_TIMEOUT_MS = 8 * 60_000;
// How stale the push journey digest may grow before a caption re-checks it.
// The digest is baked into the worker's system prompt (deliberately, for
// provider prompt caching), so this is a compromise between two costs: a
// note pinned mid-kelabo that the assistant never sees, and a cache-busting
// system-prompt rewrite on every turn. One minute keeps mid-kelabo edits
// visible without touching the prompt when nothing changed.
const JOURNEY_REFRESH_MS = 60_000;

export function createAgentDispatcher(c) {
  let worker = null;
  // What the running worker was last configured with, so a published change can
  // be told from a no-op.
  let activeModelConfig = null;
  let workerReady = false;
  let reqSeq = 0;
  let initInfo = { llmApiKey: null, webSearchKey: null };
  const pendingSummarize = new Map();
  // kelaboId -> Map(serverName -> () => Promise<string|null>). These closures
  // hold AWS clients and cannot be structured-cloned into the worker, so they
  // stay here and the worker reaches them over postMessage.
  const mcpReauthorizers = new Map();

  async function resolveLlmKeys(modelConfig) {
    if (modelConfig.provider === "fake") return { llmApiKey: null, webSearchKey: null };
    try {
      const cred = await c.getCredential("llm");
      if (cred && typeof cred === "object") {
        // Both stored shapes, read in one shared place (`llmApiKeyFrom`).
        return { llmApiKey: llmApiKeyFrom(cred), webSearchKey: cred.braveApiKey ?? null };
      }
    } catch (err) {
      c.logError("llm_credential_resolve_failed", err);
    }
    return { llmApiKey: null, webSearchKey: null };
  }

  /**
   * Which model answers — `agent/llm.js`, shared with `container.js`.
   *
   * It used to live here, private, and the comment on it claimed the worker,
   * the reconfigure check below and the journey-report path all agreed on what
   * "the model" is. The first two did. The journey paths go through `c.llm`,
   * which built its provider from `config.llm` directly and so answered with a
   * blank model wherever the deployment sets it in the environment instead of
   * the file. Moving it is the fix: one resolution, so the claim is structural
   * rather than a thing this comment asserts.
   */
  const resolveModelConfig = () => resolveModel(c.config);

  const sameModelConfig = (a, b) =>
    !!a && !!b && a.provider === b.provider && a.model === b.model && a.smallModel === b.smallModel && a.baseUrl === b.baseUrl;

  async function ensureWorker() {
    if (worker) {
      // A configuration change reaches a *running* task. The worker is
      // long-lived — without this, swapping the model would take effect on the
      // next deploy, exactly the wait this replaced.
      const next = resolveModelConfig();
      if (next && !sameModelConfig(next, activeModelConfig)) {
        const keys = await resolveLlmKeys(next);
        activeModelConfig = next;
        initInfo = keys;
        worker.postMessage({
          type: "init",
          modelConfig: next,
          knobs: c.config.gateway.agent,
          llmApiKey: keys.llmApiKey,
          webSearchKey: keys.webSearchKey,
          openaiBaseUrl: next.baseUrl,
        });
        c.log("agent_model_reconfigured", { provider: next.provider, model: next.model });
      }
      return worker;
    }
    const w = new Worker(new URL("./worker.js", import.meta.url));
    w.on("message", (msg) => onWorkerMessage(msg));
    w.on("error", (err) => c.logError("agent_worker_error", err));
    w.on("exit", (code) => {
      c.log("agent_worker_exit", { code });
      if (worker === w) {
        worker = null;
        workerReady = false;
        for (const [, p] of pendingSummarize) {
          clearTimeout(p.timer);
          p.resolve(null);
        }
        pendingSummarize.clear();
      }
    });
    worker = w;

    const modelConfig = resolveModelConfig();
    const keys = await resolveLlmKeys(modelConfig);
    activeModelConfig = modelConfig;
    initInfo = keys;
    w.postMessage({
      type: "init",
      modelConfig,
      knobs: c.config.gateway.agent,
      llmApiKey: keys.llmApiKey,
      webSearchKey: keys.webSearchKey,
      openaiBaseUrl: modelConfig.baseUrl,
    });
    workerReady = true;
    c.shutdownHooks.push(async () => {
      try {
        await w.terminate();
      } catch {}
    });
    return w;
  }

  function onWorkerMessage(msg) {
    switch (msg.type) {
      case "contribution":
        c.sseHub.publish(msg.kelaboId, msg.contribution).catch((err) =>
          c.logError("agent_contribution_publish_failed", err, { kelaboId: msg.kelaboId })
        );
        return;
      case "summarize_result": {
        const p = pendingSummarize.get(msg.reqId);
        if (!p) {
          // The worker answered after the request was abandoned. The minutes it
          // carries are real and are being thrown away, which is worth a line:
          // it is the signature of a ceiling set too low rather than of an LLM
          // that failed.
          c.log("summarize_late", { kelaboId: msg.kelaboId, hadMinutes: !!msg.minutes, error: msg.error ?? null });
          return;
        }
        pendingSummarize.delete(msg.reqId);
        clearTimeout(p.timer);
        // An error from the worker is the one outcome that used to arrive as an
        // ordinary `null` — indistinguishable from "the model wrote nothing".
        if (msg.error) c.logError("summarize_failed", new Error(msg.error), { kelaboId: msg.kelaboId });
        p.resolve(msg.minutes ?? null);
        return;
      }
      case "mcp_reauth": {
        // A sub-agent hit 401 on an OAuth MCP server. Run the refresh grant here
        // (the worker has no AWS credentials or table access) and hand back just
        // the new Authorization header value.
        const fn = mcpReauthorizers.get(msg.kelaboId)?.get(msg.server);
        const reply = (authorization) =>
          worker?.postMessage({ type: "mcp_reauth_result", reqId: msg.reqId, authorization });
        if (!fn) {
          reply(null);
          return;
        }
        fn()
          .then(reply)
          .catch((err) => {
            c.logError("mcp_reauth_failed", err, { kelaboId: msg.kelaboId, server: msg.server });
            reply(null);
          });
        return;
      }
      case "log":
        c.log(msg.event, msg.fields);
        return;
      case "debug":
        c.sseHub.debug(msg.kelaboId, msg.entry);
        return;
    }
  }

  /**
   * Re-read the journey digest for a kelabo whose context is already built,
   * and tell the worker only when it actually changed. Fire-and-forget from
   * the caption path — a refresh must never delay the caption it rode in on.
   * This is what makes the "evaluated fresh" promise in the history comment
   * below true in practice: without it the digest was loaded once per worker
   * lifetime, and a board note posted or document added mid-kelabo never
   * reached the assistant until the process restarted.
   */
  function maybeRefreshJourneys(kelaboId, handle) {
    const now = Date.now();
    if (now - (handle.journeysAt ?? 0) < JOURNEY_REFRESH_MS) return;
    if (handle.journeysRefreshing) return;
    handle.journeysRefreshing = true;
    loadJourneyContext(c, kelaboId)
      .then((journeys) => {
        handle.journeysAt = Date.now();
        const fingerprint = JSON.stringify(journeys);
        if (fingerprint === handle.journeysFingerprint) return;
        handle.journeysFingerprint = fingerprint;
        worker?.postMessage({ type: "journeys_update", kelaboId, journeys });
        c.log("agent_journeys_refreshed", { kelaboId, journeys: journeys.length });
      })
      .catch((err) => c.logError("agent_journey_context_refresh_failed", err, { kelaboId }))
      .finally(() => {
        handle.journeysRefreshing = false;
      });
  }

  async function ensureContext(kelaboId) {
    let handle = c.state.agentWorkers.get(kelaboId);
    if (handle?.rehydrated) {
      maybeRefreshJourneys(kelaboId, handle);
      return handle;
    }

    const w = await ensureWorker();
    // Rehydrate the full kelabo transcript (no limit) so the agent has the
    // entire history, not just a rolling window.
    const [uttDesc, meta] = await Promise.all([
      queryUtt(c, kelaboId, { desc: true }).catch(() => []),
      getMeta(c, kelaboId).catch(() => null),
    ]);
    const transcript = [...uttDesc].reverse().map((i) => ({
      kelaboId,
      clientId: i.clientId ?? "",
      speaker: i.speaker,
      text: i.text,
      tStart: i.tStart,
      tEnd: i.tEnd,
      isFinal: true,
    }));
    const effective = meta?.mcpEnabled === false
      ? { servers: [], reauthorizers: new Map() }
      : await loadEffectiveMcp(c, { hostIdentity: meta?.hostIdentity }).catch(() => ({
          servers: [],
          reauthorizers: new Map(),
        }));
    // Only the plain-data half crosses into the worker.
    const mcp = { servers: effective.servers };
    mcpReauthorizers.set(kelaboId, effective.reauthorizers);
    const capabilities = [];
    const realProvider = c.config.llm.provider !== "fake";
    // web_fetch needs no API key (plain fetch), so it's available whenever the
    // provider is real — this is what answers real-time weather/stock queries.
    if (realProvider || c.config.llm.provider === "fake") capabilities.push("web");
    // web_search needs both the switch (WEB_SEARCH_ENABLED) and a Brave key in
    // the llm secret. A deployment without the key degrades exactly as before:
    // no capability, no tool offered, sub-agents lean on web_fetch alone.
    if (WEB_SEARCH_ENABLED && (initInfo.webSearchKey || c.config.llm.provider === "fake")) {
      capabilities.push("web_search");
    }
    for (const s of mcp.servers) capabilities.push(`mcp:${s.name}`);

    // The host's speech-to-text language, stamped on the kelabo when they
    // joined (rest-api/join.js). The minutes are written in it; board answers
    // follow whoever asked, not this. "multi"/unknown → null, and the summariser
    // falls back to the language the kelabo was actually held in.
    const hostLanguage = languageName(meta?.hostLang);

    // Journey context (docs 20 §12.1) — no opt-in flag: linking a kelabo into
    // a journey (a deliberate, visible act) already IS the decision, unlike
    // historyEnabled's automatic host-scoped record which needs one. Always
    // attempted, always best-effort — a kelabo with no journey link costs one
    // cheap, empty query. Loaded first because `history`'s own load, below,
    // now depends on the result.
    const journeys = await loadJourneyContext(c, kelaboId).catch((err) => {
      c.logError("agent_journey_context_failed", err, { kelaboId });
      return [];
    });

    // What the assistant remembers of earlier kelabos (notes #3) — the host's
    // opt-in record, loaded by agent/history.js (which also serves the
    // dev-mode bridge's `kelabo_history`, so both brains see one record).
    // Suppressed the moment this kelabo has journey context to offer instead
    // (`historyStillApplies`, journeyContext.js) — a corrected decision, not
    // the original one: the two used to load independently, on the reasoning
    // that a kelabo could plausibly want both. In practice a journey already
    // *is* the narrower, deliberately-linked version of the same continuity
    // historyEnabled provides more diffusely, and giving the assistant both
    // at once serves nobody. This also means a kelabo linked to a journey
    // after historyEnabled was already turned on for it stops getting the
    // broader record once the link is seen — at context creation here, and
    // afterwards on maybeRefreshJourneys' one-minute cadence (the worker
    // drops the history section from the prompt when a journey digest
    // arrives), not fixed for the worker's lifetime as it once was.
    const history = historyStillApplies(meta, journeys) ? await loadKelaboHistory(c, kelaboId, meta).catch((err) => {
      // Best-effort by design: a kelabo whose history lookup failed is a normal
      // kelabo, not a broken one.
      c.logError("agent_history_failed", err, { kelaboId });
      return [];
    }) : [];

    w.postMessage({ type: "context", kelaboId, transcript, mcp, capabilities, hostLanguage, history, journeys });
    handle = {
      kelaboId,
      createdAt: handle?.createdAt ?? Date.now(),
      rehydrated: true,
      // Seed the refresh bookkeeping so maybeRefreshJourneys can tell "same
      // digest, leave the prompt cache alone" from a real change.
      journeysAt: Date.now(),
      journeysFingerprint: JSON.stringify(journeys),
    };
    c.state.agentWorkers.set(kelaboId, handle);
    c.log("agent_context_ready", {
      kelaboId,
      transcriptSize: transcript.length,
      mcpServers: mcp.servers.length,
      hostLanguage: hostLanguage ?? "unset",
      // Three states, not two: "off" (never opted in), "superseded" (opted
      // in, but a journey link now provides context instead), or a real
      // count — collapsing the last two would hide exactly the interaction
      // this log line exists to make visible.
      history: !meta?.historyEnabled ? "off" : journeys.length > 0 ? "superseded" : history.length,
      journeys: journeys.length,
    });
    return handle;
  }

  // Submit a closed message (caption) to the agent. Only complete messages
  // ever reach this point (doc 13, I3).
  //
  // `addressed` means a participant typed "@kelabo …": the turn runs with the
  // trigger gate skipped and `query` as the lookup, because the decision the
  // gate exists to make has already been made by a person.
  async function handleCaption(caption, { addressed = false, query = "" } = {}) {
    if (c.state.tunnelByKelabo.has(caption.kelaboId)) return;
    await ensureContext(caption.kelaboId);
    worker.postMessage({ type: "caption", kelaboId: caption.kelaboId, caption, addressed, query });
  }

  async function summarize(kelaboId) {
    await ensureContext(kelaboId);
    const reqId = ++reqSeq;
    const startedAt = Date.now();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pendingSummarize.delete(reqId);
        // Said out loud. A silent timeout here is indistinguishable from a
        // kelabo that never asked for minutes, which is how this went unnoticed
        // for every long kelabo the system has ever archived.
        c.log("summarize_timeout", { kelaboId, waitedMs: Date.now() - startedAt });
        resolve(null);
      }, SUMMARIZE_TIMEOUT_MS);
      timer.unref?.();
      pendingSummarize.set(reqId, { resolve, timer });
      worker.postMessage({ type: "summarize", reqId, kelaboId });
    });
  }

  function drop(kelaboId) {
    c.state.agentWorkers.delete(kelaboId);
    mcpReauthorizers.delete(kelaboId);
    if (worker) worker.postMessage({ type: "drop", kelaboId });
  }

  function renameSpeaker(kelaboId, from, to) {
    if (worker) worker.postMessage({ type: "rename", kelaboId, from, to });
  }

  return { handleCaption, summarize, drop, ensureContext, renameSpeaker };
}
