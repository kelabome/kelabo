import { subAgentSystemPrompt } from "./persona.js";
import { addUsage, LLM_TIMEOUT_MS } from "./llm.js";
import { withLlmRetry } from "./llmRetry.js";

const MAX_TOOL_ITERATIONS = 16;
// The force-conclude call runs even when the deadline has passed — it is the
// difference between a late partial answer and nothing — so it gets its own
// small, fixed budget rather than the (exhausted) remainder of the deadline.
const CONCLUDE_BUDGET_MS = 45_000;

// Extracts the last balanced JSON object from a model reply (tolerates prose or
// reasoning text before/after it).
function extractJsonObject(text) {
  if (!text) return null;
  const cleaned = text.replace(/```json|```/g, "");
  let depth = 0;
  let start = -1;
  let last = null;
  for (let i = 0; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0 && start !== -1) last = cleaned.slice(start, i + 1);
    }
  }
  if (!last) return null;
  try {
    return JSON.parse(last);
  } catch {
    return null;
  }
}

const TOOLS = [
  {
    name: "web_search",
    description:
      "Search the public web. Returns [{title,url,snippet}], or {error} when the search itself failed — an error means the TOOL failed, not that no results exist.",
    input_schema: {
      type: "object",
      properties: { query: { type: "string", description: "The search query" } },
      required: ["query"],
    },
  },
  {
    name: "web_fetch",
    description: "Fetch a web page or API endpoint and return its text content. Use for real-time data (weather, stock prices) and to read pages found via web_search.",
    input_schema: {
      type: "object",
      properties: { url: { type: "string", description: "The URL to fetch (http/https)" } },
      required: ["url"],
    },
  },
  {
    name: "mcp_query",
    description: 'Query a configured MCP tool server. request = {listTools:true} to discover, or {tool, arguments} to call.',
    input_schema: {
      type: "object",
      properties: { server: { type: "string" }, request: { type: "object" } },
      required: ["server", "request"],
    },
  },
];

function truncate(s, n) {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

function hostOf(url) {
  try {
    return new URL(String(url)).host.replace(/^www\./, "");
  } catch {
    return String(url ?? "").slice(0, 40);
  }
}

/**
 * A short human line for one tool call — this is what a participant reads while
 * they wait, so it says where the worker is looking, not which function it
 * called. "web_fetch(https://api.weather.gov/…)" is a log line; "Fetching
 * api.weather.gov" is a status.
 */
function describeToolCall(tc) {
  const input = tc.input ?? {};
  if (tc.name === "web_search") return `Searching “${truncate(String(input.query ?? ""), 48)}”`;
  if (tc.name === "web_fetch") return `Fetching ${hostOf(input.url)}`;
  if (tc.name === "mcp_query") {
    const server = String(input.server ?? "tool server");
    const tool = input.request?.tool;
    return input.request?.listTools ? `Listing ${server} tools` : `Asking ${server}${tool ? ` · ${tool}` : ""}`;
  }
  return tc.name;
}

function clipMessages(messages, limit = 4000) {
  return (messages ?? []).map((m) => ({
    role: m.role,
    content: typeof m.content === "string" ? truncate(m.content, limit) : m.content,
  }));
}

/**
 * The `answer` field of a *partially generated* result JSON, or "".
 *
 * While the concluding turn streams, the only part worth showing a room is
 * the answer text itself — everything around it is scaffolding. The field is
 * recovered with a tolerant scan rather than JSON.parse (the object is by
 * definition incomplete), and a trailing half-escape is dropped rather than
 * rendered.
 */
export function partialAnswer(text) {
  const m = /"answer"\s*:\s*"((?:[^"\\]|\\.)*)/.exec(String(text ?? ""));
  if (!m) return "";
  let raw = m[1];
  if (/(^|[^\\])(\\\\)*\\$/.test(raw)) raw = raw.slice(0, -1); // torn escape at the tail
  try {
    return JSON.parse(`"${raw}"`);
  } catch {
    return "";
  }
}

/**
 * A single ephemeral research worker. Created for ONE brief, runs a multi-call
 * tool loop on the strong (pro) model, then returns a SubAgentResult. Its context
 * is never reused — the caller keeps only the returned result.
 */
export class SubAgent {
  constructor({ llm, model, webSearch, webFetch, mcpQuery, capabilities, mcp, language, deadlineAt, log, debug, turnId, onProgress }) {
    this.llm = llm;
    this.model = model;
    this.webSearch = webSearch;
    this.webFetch = webFetch;
    this.mcpQuery = mcpQuery;
    this.capabilities = capabilities ?? [];
    // Full server descriptors (name + the tool catalogue discovered at kelabo
    // start), not just names — the prompt needs the tools to judge relevance.
    this.mcpServers = mcp?.servers ?? [];
    // The language the ANSWER must be written in — the requester's, not the
    // sources'. Empty falls back to mirroring the brief's own language.
    this.language = language ?? "";
    // Wall-clock deadline (epoch ms) for this worker's research. Before it,
    // `deadline_ms` was only prompt text nothing enforced (docs 21 §3.2) and
    // the sole bound was 16 LLM round trips — a pathological worker ran for
    // minutes while its kelabo's queue sat behind it. Past the deadline the
    // loop stops and force-concludes from what was gathered.
    this.deadlineAt = Number.isFinite(deadlineAt) ? deadlineAt : Infinity;
    this.log = log;
    this.debug = debug;
    this.turnId = turnId; // parent orchestration turn (for grouping in the debug UI)
    // Called with a one-line status every time this worker changes what it is
    // doing. The orchestrator forwards it to the board card so a task that
    // takes 20 seconds shows its 20 seconds of work instead of a still spinner.
    this.onProgress = onProgress;
    this.steps = [];
    this.sources = [];
    // Running token total across this worker's whole tool loop, including the
    // force-conclude call. Surfaced on the result so the turn can be totalled.
    this.usage = null;
  }

  /**
   * Report what this worker is doing now. `step` marks the line as a completed
   * action worth keeping in the card's history; plain status lines replace each
   * other and are not accumulated.
   */
  progress(text, { step = false } = {}) {
    if (!text) return;
    if (step) this.steps.push(text);
    this.onProgress?.({ text, steps: [...this.steps] });
  }

  /**
   * Called with the accumulated text of a streaming turn. When that text has
   * started to carry the result's `answer` field, forward it (throttled — the
   * SSE fan-out serves every subscriber in the room) so the board card shows
   * the answer growing instead of a spinner for the whole generation. A turn
   * that becomes a tool call never grows an `answer`, so this stays silent
   * through research and only speaks during the conclusion — exactly the
   * turn the room is waiting on.
   */
  streamDelta(textSoFar) {
    const partial = partialAnswer(textSoFar);
    if (partial.length < 24) return; // too little to be worth a repaint
    const now = Date.now();
    if (now - (this.lastDeltaPushAt ?? 0) < 400) return;
    this.lastDeltaPushAt = now;
    this.onProgress?.({ text: "Writing the answer…", steps: [...this.steps], partial });
  }

  availableTools() {
    return TOOLS.filter((t) => {
      if (t.name === "web_search") return this.capabilities.includes("web_search");
      if (t.name === "web_fetch") return this.capabilities.includes("web") && this.webFetch;
      if (t.name === "mcp_query") return this.mcpServers.length > 0;
      return false;
    });
  }

  /** ms left before this worker's deadline, floored so a call started just
   *  inside the deadline still has something to work with. */
  remainingMs(floor = 15_000) {
    return this.deadlineAt === Infinity ? LLM_TIMEOUT_MS : Math.max(this.deadlineAt - Date.now(), floor);
  }

  /** @param {object} brief - the dispatch_subagent brief */
  async run(brief, kelaboId) {
    const system = subAgentSystemPrompt({ capabilities: this.capabilities, mcpServers: this.mcpServers, language: this.language });
    const tools = this.availableTools();
    const messages = [{ role: "user", content: `BRIEF:\n${JSON.stringify(brief)}` }];

    let text = "";
    let concluded = false; // the model produced a final (no-tool) turn on its own
    for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
      if (Date.now() >= this.deadlineAt) {
        // Out of time is a conclusion trigger, not a failure: whatever was
        // gathered so far goes to forceConclude, which demands a committed
        // result from it. A late partial answer beats a spinner that ends in
        // "nothing was posted".
        this.log?.("subagent_deadline", { kelaboId, taskId: brief.task_id, iteration: i });
        this.progress("Out of time — concluding from what was gathered…");
        break;
      }
      this.progress(i === 0 ? "Planning the lookup…" : "Reading what came back…");
      this.debug?.(kelaboId, {
        kind: "subagent",
        phase: "request",
        turnId: this.turnId,
        model: this.model,
        taskId: brief.task_id,
        objective: brief.objective,
        system,
        messages: clipMessages(messages),
        iteration: i + 1,
      });
      let res;
      try {
        // One retry on a transient provider failure; a failure that survives
        // it breaks OUT of the loop rather than throwing — everything already
        // gathered still reaches forceConclude instead of being discarded as
        // an error result with none of the research in it.
        res = await withLlmRetry(
          () =>
            this.llm.completeRaw({
              model: this.model,
              system,
              messages,
              tools,
              maxTokens: 2048,
              timeoutMs: Math.min(LLM_TIMEOUT_MS, this.remainingMs()),
              onDelta: (t) => this.streamDelta(t),
            }),
          { log: this.log, event: "subagent_llm_retry", fields: { kelaboId, taskId: brief.task_id, iteration: i + 1 } }
        );
      } catch (err) {
        this.log?.("subagent_llm_failed", { kelaboId, taskId: brief.task_id, iteration: i + 1, error: err.message });
        this.debug?.(kelaboId, { kind: "subagent", phase: "loop_error", turnId: this.turnId, taskId: brief.task_id, raw: err.message, iteration: i + 1 });
        break;
      }
      text = res.text;
      this.usage = addUsage(this.usage, res.usage);
      this.debug?.(kelaboId, {
        kind: "subagent",
        phase: "response",
        turnId: this.turnId,
        model: this.model,
        taskId: brief.task_id,
        raw: text,
        toolCalls: (res.toolCalls ?? []).map((tc) => ({ name: tc.name, input: tc.input })),
        iteration: i + 1,
        usage: res.usage,
      });
      if (!res.toolCalls?.length) {
        concluded = true;
        break;
      }
      messages.push({ role: "assistant", content: res.raw.content });
      // Announce the calls before running them: the wait belongs to the fetch,
      // so the status has to be on screen for the duration of the fetch.
      for (const tc of res.toolCalls) this.progress(describeToolCall(tc), { step: true });
      const results = await Promise.all(
        res.toolCalls.map(async (tc) => ({
          type: "tool_result",
          tool_use_id: tc.id,
          content: (await this.executeTool(tc)).slice(0, 8000),
        }))
      );
      messages.push({ role: "user", content: results });
    }
    this.progress("Writing the answer…");

    // If the model stopped calling tools, its final turn should already be the
    // JSON result. If it ran out of iterations mid-loop (concluded === false) or
    // its final turn wasn't parseable JSON, force ONE conclusion call with no
    // tools so it commits to a result instead of leaking intermediate narration.
    let result = concluded ? extractJsonObject(text) : null;
    if (!result) {
      result = await this.forceConclude(brief, messages, kelaboId);
    }
    return this.normalizeResult(brief, result);
  }

  // One final no-tools call: the worker must commit to the JSON result now, using
  // only what it has already gathered. Prevents mid-research prose from being
  // posted to the board as if it were the answer.
  async forceConclude(brief, messages, kelaboId) {
    const system = subAgentSystemPrompt({ capabilities: this.capabilities, mcpServers: this.mcpServers, language: this.language });
    const convo = [
      ...messages,
      {
        role: "user",
        content:
          "Stop researching. Using ONLY what you have gathered so far, output your FINAL result now as the JSON object described in your instructions (task_id, status, title, to, answer, confidence, sources, gaps). If you could not determine a concrete answer, set status to \"partial\" or \"empty\" and say plainly in `answer` what is known and what is missing — do NOT narrate your process. Output ONLY the JSON.",
      },
    ];
    this.debug?.(kelaboId, { kind: "subagent", phase: "conclude_request", turnId: this.turnId, model: this.model, taskId: brief.task_id, messages: clipMessages(convo) });
    let text = "";
    let concludeUsage = null;
    try {
      // completeRaw (not complete) so the force-conclude call's tokens are
      // counted too — it is a full extra round trip over the whole thread.
      const res = await this.llm.completeRaw({
        model: this.model,
        system,
        messages: convo,
        maxTokens: 1024,
        // Fixed small budget, deliberately NOT the deadline remainder: this
        // call runs precisely when the deadline is spent, and it is the last
        // chance to turn gathered research into an answer.
        timeoutMs: CONCLUDE_BUDGET_MS,
        // The reply is one JSON object by instruction; JSON mode makes the
        // provider enforce it, so this second round trip stops failing to
        // parse — which is what used to turn one extra call into a lost turn.
        responseFormat: "json",
        onDelta: (t) => this.streamDelta(t),
      });
      text = res.text;
      concludeUsage = res.usage;
      this.usage = addUsage(this.usage, concludeUsage);
    } catch (err) {
      this.debug?.(kelaboId, { kind: "subagent", phase: "conclude_error", turnId: this.turnId, taskId: brief.task_id, raw: err.message });
      return null;
    }
    this.debug?.(kelaboId, { kind: "subagent", phase: "conclude_response", turnId: this.turnId, model: this.model, taskId: brief.task_id, raw: text, usage: concludeUsage });
    return extractJsonObject(text);
  }

  async executeTool(toolCall) {
    try {
      if (toolCall.name === "web_search") {
        const results = await this.webSearch(String(toolCall.input?.query ?? ""));
        // A failed search now comes back as {error}, not [] — only a real
        // result list contributes sources.
        if (Array.isArray(results)) {
          for (const r of results) if (r.url) this.sources.push({ title: r.title || r.url, url: r.url });
        }
        return JSON.stringify(results);
      }
      if (toolCall.name === "web_fetch") {
        const result = await this.webFetch(String(toolCall.input?.url ?? ""));
        if (result?.url) this.sources.push({ title: result.url, url: result.url });
        return JSON.stringify(result);
      }
      if (toolCall.name === "mcp_query") {
        return JSON.stringify(await this.mcpQuery(String(toolCall.input?.server ?? ""), toolCall.input?.request ?? {}));
      }
      return JSON.stringify({ error: `unknown_tool:${toolCall.name}` });
    } catch (err) {
      return JSON.stringify({ error: err.message });
    }
  }

  dedupeSources(extra = []) {
    const seen = new Set();
    return [...extra, ...this.sources].filter((s) => s && s.url && (seen.has(s.url) ? false : (seen.add(s.url), true)));
  }

  // Turn a parsed JSON result (or null) into a normalized SubAgentResult. Never
  // emits intermediate reasoning as the answer: if the worker did not produce a
  // parseable, non-empty result, we report status "empty" with a candid note so
  // the orchestrator can suppress the card rather than post half-finished text.
  normalizeResult(brief, json) {
    if (!json || typeof json !== "object") {
      return {
        task_id: brief.task_id,
        status: "empty",
        title: brief.objective ? truncate(String(brief.objective), 60) : "Research",
        to: brief.to || "all",
        answer: "",
        confidence: 0,
        sources: this.dedupeSources(),
        gaps: "no_conclusive_result",
        tool_trace: [],
        usage: this.usage,
      };
    }
    let status = ["ok", "partial", "empty", "error"].includes(json.status) ? json.status : "ok";
    const bodySources = Array.isArray(json.sources)
      ? json.sources.filter((s) => s && s.url).map((s) => ({ title: String(s.title || s.url), url: String(s.url) }))
      : [];
    const answer = String(json.answer ?? "").trim().slice(0, 8000);
    // A "successful" result with no actual answer is really empty — don't post it.
    if ((status === "ok" || status === "partial") && !answer) status = "empty";
    return {
      task_id: brief.task_id,
      status,
      title: String(json.title || brief.objective || "Research").slice(0, 80),
      to: String(json.to || brief.to || "all").slice(0, 64),
      answer,
      confidence: typeof json.confidence === "number" ? json.confidence : 0,
      sources: this.dedupeSources(bodySources),
      gaps: String(json.gaps ?? ""),
      tool_trace: Array.isArray(json.tool_trace) ? json.tool_trace.map(String).slice(0, 12) : [],
      // Whole-worker token cost, rolled up by the orchestrator into the turn total.
      usage: this.usage,
    };
  }
}
