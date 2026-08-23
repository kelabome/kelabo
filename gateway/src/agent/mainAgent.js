import { randomUUID } from "node:crypto";
import { tagTranscript } from "@kelabo/contracts";
import { mainAgentSystemPrompt, summarySystemPrompt } from "./persona.js";
import { SubAgent } from "./subAgent.js";
import { addUsage } from "./llm.js";
import { parseMinutesJson } from "./serverAgentRunner.js";

const MAX_DISPATCH_PER_TURN = 3;

const DISPATCH_TOOL = {
  name: "dispatch_subagent",
  description:
    "Dispatch a research worker to fetch information. The worker has NO kelabo context — the brief must be self-contained. Its answer is posted to the board automatically.",
  input_schema: {
    type: "object",
    properties: {
      task_id: { type: "string", description: "Unique id for this task within the kelabo" },
      kind: { type: "string", enum: ["web", "mcp", "code"], description: "Routing hint" },
      objective: { type: "string", description: "What to find, self-contained (resolve references)" },
      context: { type: "string", description: "Minimum context the worker needs (no transcript)" },
      expected: { type: "string", description: "The exact output shape expected" },
      to: { type: "string", description: "Participant this addresses, or 'all'" },
      language: {
        type: "string",
        description:
          "REQUIRED. The language of the request that triggered this, as an English language name (e.g. 'English', 'Chinese', 'Japanese'). The worker writes the board answer in this language, whatever language its sources are in.",
      },
      constraints: { type: "object", description: "{freshness, mcp_server?, max_tool_calls?, deadline_ms?}" },
    },
    required: ["task_id", "objective", "language"],
  },
};

function truncate(s, n) {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

function clipMessages(messages, limit = 4000) {
  return (messages ?? []).map((m) => ({
    role: m.role,
    content: typeof m.content === "string" ? truncate(m.content, limit) : m.content,
  }));
}

/**
 * A push stream consumed as an async iterable.
 *
 * Sub-agents run in parallel and each emits progress while it works. Awaiting
 * `Promise.all` first and yielding afterwards would hold every one of those
 * updates until the slowest worker finished — which is exactly the silence this
 * is meant to remove. Results are pushed through the same channel, so a fast
 * task also posts its card without waiting for a slow sibling.
 */
function createStream() {
  const queued = [];
  let waiting = null;
  let closed = false;
  return {
    push(value) {
      if (closed) return;
      if (waiting) {
        const resolve = waiting;
        waiting = null;
        resolve({ value, done: false });
      } else {
        queued.push(value);
      }
    },
    close() {
      closed = true;
      if (waiting) {
        const resolve = waiting;
        waiting = null;
        resolve({ value: undefined, done: true });
      }
    },
    [Symbol.asyncIterator]() {
      return {
        next() {
          if (queued.length) return Promise.resolve({ value: queued.shift(), done: false });
          if (closed) return Promise.resolve({ value: undefined, done: true });
          return new Promise((resolve) => {
            waiting = resolve;
          });
        },
      };
    },
  };
}

/** The card title for a dispatched task, before its worker has titled it. */
function briefTitle(brief, query) {
  return truncate(String(brief?.title || brief?.objective || query || "Researching"), 80);
}

/**
 * The two fields the whole downstream pipeline assumes exist: the worker
 * echoes `task_id` back so its result can be matched to this dispatch, and
 * a worker with no `objective` has nothing to look up. Everything else in
 * the brief (`context`/`expected`/`kind`/`to`/`constraints`) can genuinely
 * be omitted. The dispatch tool's own JSON schema marks all three of
 * `task_id`/`objective`/`language` `required`, but that is a hint to the
 * provider, not something this codebase enforces — nothing between the
 * model's tool call and `SubAgent.run()` ever checked it before.
 */
function missingBriefFields(brief) {
  if (!brief || typeof brief !== "object") return ["task_id", "objective"];
  const missing = [];
  if (!String(brief.task_id ?? "").trim()) missing.push("task_id");
  if (!String(brief.objective ?? "").trim()) missing.push("objective");
  return missing;
}

/** Why a worker's result never made it to the board, in one plain sentence. */
function skipReason(result) {
  const gaps = String(result?.gaps ?? "").trim();
  if (result?.status === "error") {
    // The worker's own message often already begins "Research failed:" — do not
    // say it twice.
    const why = String(result.answer || gaps).trim().replace(/^research failed:?\s*/i, "");
    return why ? `Research failed — ${truncate(why, 160)}` : "Research failed.";
  }
  if (gaps && gaps !== "no_conclusive_result") return `Nothing conclusive found — ${truncate(gaps, 160)}`;
  return "The search finished without a concrete answer, so nothing was posted.";
}

/**
 * The single, long-lived orchestrator per kelabo. Runs on the flash (small)
 * model. Holds a persistent thread: transcript turns + its own dispatch decisions
 * + each sub-agent's final output (nested by task_id). Its only tool is
 * dispatch_subagent; it never touches web/MCP directly and never posts [LLM_CON]
 * itself — a sub-agent's output is the board post.
 */
export class MainAgent {
  constructor({ llm, smallModel, subAgentModel, subAgentDeps, maxDispatchPerTurn, hostLanguage, history, journeys, log, debug }) {
    this.llm = llm;
    this.smallModel = smallModel;
    this.subAgentModel = subAgentModel;
    this.subAgentDeps = subAgentDeps; // { strong, webSearch, webFetch, makeMcpQuery, capabilities, mcp }
    this.maxDispatchPerTurn = maxDispatchPerTurn ?? MAX_DISPATCH_PER_TURN;
    // The host's language, resolved from their settings when they joined. The
    // minutes are written in it regardless of what the room spoke; board answers
    // are NOT — those follow whoever asked (each brief carries its own language).
    this.hostLanguage = hostLanguage || "";
    this.log = log;
    this.debug = debug;
    // The orchestrator writes the brief, so it is the one that has to know which
    // tool servers exist — otherwise its brief never mentions them and the
    // worker has no reason to look.
    // Earlier kelabos go in the SYSTEM prompt, not the thread: they are fixed
    // for the whole kelabo, and the system prompt is the one part of the
    // request that never changes — which is exactly what provider-side prompt
    // caching keys on. In the thread they would be re-sent, uncached, on every
    // turn, and would drift out of position as the transcript grows.
    this.system = mainAgentSystemPrompt({
      mcpServers: subAgentDeps?.mcp?.servers ?? [],
      history: history ?? [],
      // Journey context (docs 20 §12.1) — independent of `history` above:
      // that is the host's own past kelabos, this is a deliberately-linked
      // shared container. Same "fixed for the kelabo, goes in the system
      // prompt not the thread" reasoning as history.
      journeys: journeys ?? [],
    });
    this.thread = []; // persistent message array (excludes system)
    this.transcriptLen = 0;
    // The arrangement log: one compact record per dispatched task, kept beside
    // the thread because the minutes need it in a form that does not require
    // re-reading tool_result blobs. This is what lets the summary say what was
    // looked up and what came back (doc 14 §5.4/§7).
    this.taskLog = [];
  }

  /**
   * Make the thread safe to send.
   *
   * Every provider rejects a request in which an assistant turn calls a tool and
   * the next message does not answer it — OpenAI-compatible ones with a flat
   * 400. Because this thread is persistent, one such turn does not fail once: it
   * fails every trigger for the rest of the kelabo, and the room sees the
   * assistant die mid-conversation. The turn path is careful to answer every
   * call it records, but "careful" is not a guarantee — a run abandoned partway
   * (worker error while streaming) leaves exactly this gap. So the invariant is
   * enforced here, immediately before the thread is used, rather than trusted.
   */
  repairThread() {
    let inserted = 0;
    for (let i = 0; i < this.thread.length; i++) {
      const m = this.thread[i];
      if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
      const ids = m.content.filter((b) => b?.type === "tool_use").map((b) => b.id);
      if (!ids.length) continue;
      const next = this.thread[i + 1];
      const answered = new Set(
        Array.isArray(next?.content) ? next.content.filter((b) => b?.type === "tool_result").map((b) => b.tool_use_id) : []
      );
      const missing = ids.filter((id) => !answered.has(id));
      if (!missing.length) continue;
      const stubs = missing.map((id) => ({
        type: "tool_result",
        tool_use_id: id,
        content: JSON.stringify({ status: "error", answer: "This task did not complete — its result was lost." }),
      }));
      if (answered.size) next.content.push(...stubs);
      else this.thread.splice(i + 1, 0, { role: "user", content: stubs });
      inserted += missing.length;
    }
    if (inserted) this.log?.("main_thread_repaired", { toolResults: inserted });
    return inserted;
  }

  /** Sync the persistent thread with the latest transcript (append-only). */
  syncTranscript(transcript) {
    for (let i = this.transcriptLen; i < transcript.length; i++) {
      const u = transcript[i];
      this.thread.push({ role: "user", content: `TRANSCRIPT: ${tagTranscript(u.speaker, u.text)}` });
    }
    this.transcriptLen = transcript.length;
  }

  /**
   * Run one orchestration turn for a positive gate trigger. Yields board
   * Contributions (built from each sub-agent's output). Sub-agents run in
   * parallel; each is created fresh and discarded after producing its result.
   */
  async *runTurn({ kelaboId, trigger, query, transcript, turnId: turnIdIn, cardId: cardIdIn }) {
    this.repairThread();
    this.syncTranscript(transcript);
    if (query) this.thread.push({ role: "user", content: `TRIGGER: ${query}` });

    // A stable id for this orchestration turn. Every debug entry produced by this
    // turn — the main-agent request/response AND each sub-agent it dispatches —
    // carries the same turnId so the UI can group them together.
    const turnId = turnIdIn ?? randomUUID();
    // The worker already put a card on the board the moment the gate fired, so
    // the room can see the assistant heard them. We keep updating THAT card
    // rather than adding a second one.
    const turnCardId = cardIdIn ?? randomUUID();
    const startedAt = Date.now();
    yield this.workingCard(kelaboId, turnCardId, query || "Working…", startedAt, "Deciding what to look up…");

    this.debug?.(kelaboId, {
      kind: "main",
      phase: "request",
      turnId,
      model: this.smallModel,
      query: query || undefined,
      system: this.system,
      messages: clipMessages(this.thread),
      threadLen: this.thread.length,
    });
    const res = await this.llm.completeRaw({
      model: this.smallModel,
      system: this.system,
      messages: this.thread,
      tools: [DISPATCH_TOOL],
      maxTokens: 1024,
    });
    // Running token total for this whole turn: the orchestrator call plus every
    // sub-agent it dispatches. Emitted as a `turn_usage` debug entry at the end
    // so the UI can show one figure for the entire search.
    let turnUsage = res.usage ?? null;
    this.debug?.(kelaboId, {
      kind: "main",
      phase: "response",
      turnId,
      model: this.smallModel,
      raw: res.text,
      toolCalls: (res.toolCalls ?? []).map((tc) => ({ name: tc.name, input: tc.input })),
      usage: res.usage,
    });

    const allDispatches = (res.toolCalls ?? []).filter((tc) => tc.name === "dispatch_subagent");
    const dispatches = allDispatches.slice(0, this.maxDispatchPerTurn);
    const dropped = allDispatches.slice(this.maxDispatchPerTurn);
    // Anything the model called that is NOT dispatch_subagent — it only has the
    // one tool, but small models do invent `web_search`. These still have to be
    // answered: an unanswered tool call makes every later request malformed.
    const unknown = (res.toolCalls ?? []).filter((tc) => tc.name !== "dispatch_subagent");
    if (unknown.length) this.log?.("main_unknown_tool", { kelaboId, names: unknown.map((tc) => tc.name) });

    // No dispatch → the main agent stayed silent (NO_POST) or had nothing to do.
    if (!dispatches.length) {
      const text = String(res.text ?? "").trim();
      // Recorded as plain text, deliberately: with no dispatch there is nothing
      // to answer, so the turn must not carry tool calls into the thread.
      this.thread.push({ role: "assistant", content: text || "NO_POST: no action" });
      const reason = text.replace(/^NO_POST:\s*/i, "").trim();
      this.log?.("main_no_dispatch", { kelaboId, reason: reason.slice(0, 200) });
      // Say so, rather than letting the card the room just watched appear
      // disappear. A skipped card is ephemeral (never archived) but it stays on
      // screen with its reason, so "it flashed and vanished" becomes "it heard
      // us and decided this didn't need looking up".
      yield this.skippedCard(
        kelaboId,
        turnCardId,
        query || "Nothing to look up",
        startedAt,
        reason ? `Nothing to add — ${truncate(reason, 200)}` : "Nothing to add here."
      );
      this.emitTurnUsage(kelaboId, turnId, turnUsage, 0);
      return;
    }

    // Record the decision (the assistant tool_use turn) in the persistent thread.
    this.thread.push({ role: "assistant", content: res.raw.content });

    // The turn card has done its job — one card per dispatched task takes over.
    yield this.clearCard(kelaboId, turnCardId, startedAt);

    const at = Date.now();
    const cards = new Map();
    for (const tc of dispatches) {
      const brief = tc.input ?? {};
      const cardId = randomUUID();
      const title = briefTitle(brief, query);
      cards.set(tc.id, { cardId, brief, title });
      yield this.workingCard(kelaboId, cardId, title, at, "Starting research…");
    }

    // Run sub-agents in parallel. Each gets a fresh SubAgent (context not shared)
    // and pushes progress + its result through one stream, so a card updates
    // while its worker works and posts the moment that worker finishes —
    // independently of its slower siblings.
    const stream = createStream();
    let pending = dispatches.length;
    for (const tc of dispatches) {
      const { cardId, brief, title } = cards.get(tc.id);
      // Everything for one task — including building the worker, which resolves
      // MCP credentials and can throw — lives inside this async function, so no
      // failure path can skip the `finally` that closes the stream.
      (async () => {
        // An empty or near-empty brief (an unparseable tool-call-arguments
        // string — see llm.js's own new logging for that side of it — or a
        // small model calling the tool without filling it in) must never
        // reach a SubAgent: it has nothing to research, and running one
        // anyway wastes a full LLM round trip on a doomed call AND produces
        // a confusing failure card in an unpredictable language (the
        // sub-agent's own language rule falls back to "detect it from the
        // brief," which an empty brief gives it nothing to detect from).
        // Caught here instead: a deterministic, English, immediately
        // diagnosable result, with the actual missing fields logged
        // server-side rather than only visible as prose on the board.
        const missing = missingBriefFields(brief);
        if (missing.length) {
          this.log?.("main_dispatch_brief_invalid", { kelaboId, taskId: brief?.task_id, missing, briefKeys: Object.keys(brief || {}) });
          return {
            task_id: brief?.task_id,
            status: "error",
            title,
            to: brief?.to || "all",
            answer: "Research failed: the lookup request was incomplete and could not be run.",
            confidence: 0,
            sources: [],
            gaps: `missing_fields:${missing.join(",")}`,
            tool_trace: [],
            usage: null,
          };
        }
        let sub = null;
        try {
          sub = new SubAgent({
            llm: this.subAgentDeps.strong,
            model: this.subAgentModel,
            webSearch: this.subAgentDeps.webSearch,
            webFetch: this.subAgentDeps.webFetch,
            mcpQuery: this.subAgentDeps.makeMcpQuery(),
            capabilities: this.subAgentDeps.capabilities,
            mcp: this.subAgentDeps.mcp,
            // The language the requester used, decided by the orchestrator and
            // pinned into the worker's system prompt so its sources cannot
            // drag the answer into another language.
            language: String(brief.language ?? "").slice(0, 40),
            log: this.log,
            debug: this.debug,
            turnId, // ties this sub-agent's debug entries back to the parent turn
            onProgress: ({ text, steps }) => stream.push({ type: "progress", cardId, title, text, steps }),
          });
          return await sub.run(brief, kelaboId);
        } catch (err) {
          return {
            task_id: brief.task_id,
            status: "error",
            title,
            to: brief.to || "all",
            answer: `Research failed: ${err.message}`,
            confidence: 0,
            sources: [],
            gaps: err.message,
            tool_trace: [],
            usage: sub?.usage ?? null,
          };
        }
      })()
        .then((result) => stream.push({ type: "result", toolUseId: tc.id, brief, title, cardId, result }))
        .finally(() => {
          pending -= 1;
          if (pending === 0) stream.close();
        });
    }

    // Nest each result into the main thread as the tool_result for its dispatch,
    // and emit the board contribution only when the worker actually concluded
    // with an answer. A non-conclusive run still gets a card — one that says why
    // it came back empty — so the board never silently loses a task.
    const settled = [];
    for await (const ev of stream) {
      if (ev.type === "progress") {
        yield this.workingCard(kelaboId, ev.cardId, ev.title, at, ev.text, ev.steps);
        continue;
      }
      const { result, cardId, title, brief } = ev;
      settled.push(ev);
      turnUsage = addUsage(turnUsage, result?.usage);
      const postable = (result.status === "ok" || result.status === "partial") && String(result.answer ?? "").trim().length > 0;
      this.taskLog.push({
        at: Date.now(),
        trigger: query || "",
        taskId: result.task_id ?? brief.task_id ?? "",
        objective: String(brief.objective ?? title ?? ""),
        status: result.status,
        answer: postable ? result.answer : "",
        gaps: result.gaps ?? "",
        sources: (result.sources ?? []).map((s) => ({ title: s.title, url: s.url })),
        outcome: postable ? "posted" : "no_post",
      });
      if (!postable) {
        yield this.skippedCard(kelaboId, cardId, title, at, skipReason(result));
        this.log?.("subagent_no_post", { kelaboId, taskId: result.task_id, status: result.status, gaps: result.gaps });
        continue;
      }
      yield {
        id: cardId,
        kelaboId,
        tag: "LLM_CON",
        kind: "answer",
        title: result.title,
        to: result.to,
        markdown: result.answer,
        ...(result.sources?.length ? { sources: result.sources.map((s) => ({ title: s.title, url: s.url })) } : {}),
        author: "assistant",
        origin: "server",
        status: "done",
        at,
      };
      this.log?.("subagent_result", { kelaboId, taskId: result.task_id, status: result.status, sources: result.sources?.length ?? 0 });
    }

    // The results become part of the main agent's memory for future turns. EVERY
    // tool_use in the recorded assistant turn must get a tool_result back or the
    // next request is malformed and the kelabo's thread is dead for good —
    // that includes the ones the per-turn cap dropped and any tool the model
    // invented, both of which are answered with a plain refusal.
    this.thread.push({
      role: "user",
      content: [
        ...settled.map((ev) => ({ type: "tool_result", tool_use_id: ev.toolUseId, content: JSON.stringify(ev.result) })),
        ...dropped.map((tc) => ({
          type: "tool_result",
          tool_use_id: tc.id,
          content: JSON.stringify({
            task_id: tc.input?.task_id,
            status: "error",
            answer: `Not run: more than ${this.maxDispatchPerTurn} tasks were dispatched in one turn.`,
          }),
        })),
        ...unknown.map((tc) => ({
          type: "tool_result",
          tool_use_id: tc.id,
          content: JSON.stringify({
            status: "error",
            answer: `No such tool: ${tc.name}. Your only tool is dispatch_subagent — the worker it dispatches is what holds web and MCP access.`,
          }),
        })),
      ],
    });
    if (dropped.length) this.log?.("main_dispatch_capped", { kelaboId, dropped: dropped.length, cap: this.maxDispatchPerTurn });
    this.emitTurnUsage(kelaboId, turnId, turnUsage, settled.length);
  }

  /**
   * One rolled-up figure for the whole search: the gate is counted separately
   * (it runs before a turn exists), this covers the orchestrator call plus every
   * sub-agent's full tool loop including its force-conclude call.
   */
  emitTurnUsage(kelaboId, turnId, usage, subAgents) {
    if (!usage) return;
    this.debug?.(kelaboId, { kind: "turn_usage", turnId, usage, subAgents });
    this.log?.("turn_usage", {
      kelaboId,
      turnId,
      subAgents,
      cacheRead: usage.cacheRead,
      input: usage.input,
      output: usage.output,
      total: usage.total,
    });
  }

  /** An in-progress card. `progress` is the live status line; `steps` the trail. */
  workingCard(kelaboId, id, title, at, progress, steps) {
    return {
      id,
      kelaboId,
      tag: "LLM_CON",
      kind: "answer",
      title,
      to: "all",
      markdown: "",
      author: "assistant",
      origin: "server",
      status: "working",
      ...(progress ? { progress } : {}),
      ...(steps?.length ? { steps: steps.slice(-6) } : {}),
      at,
    };
  }

  /** A card that will not become an answer, and says why. Never archived. */
  skippedCard(kelaboId, id, title, at, reason) {
    return {
      id,
      kelaboId,
      tag: "LLM_CON",
      kind: "answer",
      title,
      to: "all",
      markdown: "",
      reason,
      author: "assistant",
      origin: "server",
      status: "skipped",
      at,
    };
  }

  clearCard(kelaboId, id, at) {
    return {
      id,
      kelaboId,
      tag: "LLM_CON",
      kind: "answer",
      title: "",
      to: "all",
      markdown: "",
      author: "assistant",
      origin: "server",
      status: "done",
      at,
    };
  }

  /**
   * The research the agent did during the kelabo, as prose the summariser can
   * quote and attribute. Without this the minutes can only describe what people
   * said, and every answer the assistant put on the board — the part nobody has
   * a record of afterwards — is lost.
   */
  researchBrief() {
    if (!this.taskLog.length) return "";
    const lines = this.taskLog.map((t, i) => {
      const sources = t.sources.map((s) => `${s.title}${s.url ? ` <${s.url}>` : ""}`).join("; ");
      return [
        `${i + 1}. [${t.status}] ${t.objective || t.trigger}`,
        t.answer ? `   answer: ${truncate(t.answer, 1200)}` : `   answer: (none) ${t.gaps || ""}`.trimEnd(),
        sources ? `   sources: ${truncate(sources, 400)}` : null,
      ]
        .filter(Boolean)
        .join("\n");
    });
    return `\n\nRESEARCH THE ASSISTANT PERFORMED DURING THIS KELABO (use for "findings"; keep the sources):\n${lines.join("\n")}`;
  }

  /** End-of-kelabo minutes (main/small model, over the full transcript). */
  async summarize({ kelaboId, transcript }) {
    const system = summarySystemPrompt({ hostLanguage: this.hostLanguage });
    const body = transcript.map((u) => tagTranscript(u.speaker, u.text)).join("\n");
    const speakers = [...new Set(transcript.map((u) => u.speaker).filter(Boolean))];
    const messages = [
      {
        role: "user",
        content:
          `Participants heard in the transcript: ${speakers.join(", ") || "unknown"}.\n\n` +
          `Full kelabo transcript:\n${body}` +
          this.researchBrief() +
          `\n\n:KELABO-END — write the full minutes now. Reply with ONLY the JSON object.`,
      },
    ];
    this.debug?.(kelaboId, { kind: "minutes", phase: "request", model: this.smallModel, system, messages: clipMessages(messages) });
    // Minutes are the one long-form output the agent produces; a 4k cap was
    // truncating the write-up back into the bullet list it is meant to replace.
    const text = await this.llm.complete({ model: this.smallModel, system, messages, maxTokens: 8192 });
    this.debug?.(kelaboId, { kind: "minutes", phase: "response", model: this.smallModel, raw: text });
    return parseMinutesJson(text, kelaboId, "server");
  }
}
