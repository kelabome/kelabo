import { Worker } from "node:worker_threads";
import { queryUtt, getMeta } from "../db.js";
import { loadKelaboHistory } from "./history.js";
import { loadJourneyContext, historyStillApplies } from "./journeyContext.js";
import { loadEffectiveMcp } from "./mcp.js";
import { WEB_SEARCH_ENABLED } from "./subagents.js";
import { languageName } from "./language.js";

const SUMMARIZE_TIMEOUT_MS = 90_000;

export function createAgentDispatcher(c) {
  let worker = null;
  let workerReady = false;
  let reqSeq = 0;
  let initInfo = { llmApiKey: null, webSearchKey: null };
  const pendingSummarize = new Map();
  // kelaboId -> Map(serverName -> () => Promise<string|null>). These closures
  // hold AWS clients and cannot be structured-cloned into the worker, so they
  // stay here and the worker reaches them over postMessage.
  const mcpReauthorizers = new Map();

  async function ensureWorker() {
    if (worker) return worker;
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

    let llmApiKey = null;
    let webSearchKey = null;
    if (c.config.llm.provider !== "fake") {      try {
        const secret = await c.getSecret(c.config.secrets.llm);
        if (secret && typeof secret === "object") {
          llmApiKey = secret.apiKey ?? null;
          webSearchKey = secret.braveApiKey ?? null;
        } else if (typeof secret === "string") {
          llmApiKey = secret;
        }
      } catch (err) {
        c.logError("llm_secret_resolve_failed", err);
      }
    }
    initInfo = { llmApiKey, webSearchKey };
    w.postMessage({
      type: "init",
      modelConfig: c.config.llm,
      knobs: c.config.gateway.agent,
      llmApiKey,
      webSearchKey,
      openaiBaseUrl: c.config.openaiBaseUrl,
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
        if (p) {
          pendingSummarize.delete(msg.reqId);
          clearTimeout(p.timer);
          p.resolve(msg.minutes ?? null);
        }
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

  async function ensureContext(kelaboId) {
    let handle = c.state.agentWorkers.get(kelaboId);
    if (handle?.rehydrated) return handle;

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
    // web_search is disabled project-wide (WEB_SEARCH_ENABLED === false). It also
    // requires the Brave key, which dev has never had — the result was sub-agents
    // guessing URLs for web_fetch and failing with 403/404. Re-enable both to
    // bring it back.
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
    // broader record the moment the link exists — evaluated fresh every
    // turn, not fixed at creation time.
    const history = historyStillApplies(meta, journeys) ? await loadKelaboHistory(c, kelaboId, meta).catch((err) => {
      // Best-effort by design: a kelabo whose history lookup failed is a normal
      // kelabo, not a broken one.
      c.logError("agent_history_failed", err, { kelaboId });
      return [];
    }) : [];

    w.postMessage({ type: "context", kelaboId, transcript, mcp, capabilities, hostLanguage, history, journeys });
    handle = { kelaboId, createdAt: handle?.createdAt ?? Date.now(), rehydrated: true };
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
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pendingSummarize.delete(reqId);
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
