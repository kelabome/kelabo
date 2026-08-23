import { parentPort } from "node:worker_threads";
import { randomUUID } from "node:crypto";
import { createLlmProvider } from "./llm.js";
import { TriggerGate } from "./gate.js";
import { MainAgent } from "./mainAgent.js";
import { createWebSearch, createWebFetch, createMcpQuery } from "./subagents.js";

const log = (event, fields) => parentPort.postMessage({ type: "log", event, fields });
const debug = (kelaboId, entry) => parentPort.postMessage({ type: "debug", kelaboId, entry: { at: Date.now(), ...entry } });

let runtime = null;
const contexts = new Map();
let activeRuns = 0;
const runQueue = [];

// Refreshing an OAuth token needs DynamoDB + the client registration, neither of
// which this thread has. Ask the main thread and await its reply.
const MCP_REAUTH_TIMEOUT_MS = 20_000;
let reauthSeq = 0;
const pendingReauth = new Map();

function requestMcpReauth(kelaboId, server) {
  const reqId = ++reauthSeq;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingReauth.delete(reqId);
      resolve(null);
    }, MCP_REAUTH_TIMEOUT_MS);
    timer.unref?.();
    pendingReauth.set(reqId, { resolve, timer });
    parentPort.postMessage({ type: "mcp_reauth", reqId, kelaboId, server });
  });
}

parentPort.on("message", (msg) => {
  handle(msg).catch((err) => log("worker_message_error", { error: err.message, msgType: msg?.type }));
});

async function handle(msg) {
  switch (msg.type) {
    case "init":
      return init(msg);
    case "context":
      return initContext(msg);
    case "caption":
      return onCaption(msg);
    case "summarize":
      return onSummarize(msg);
    case "rename":
      return onRename(msg);
    case "mcp_reauth_result": {
      const p = pendingReauth.get(msg.reqId);
      if (p) {
        pendingReauth.delete(msg.reqId);
        clearTimeout(p.timer);
        p.resolve(msg.authorization ?? null);
      }
      return;
    }
    case "drop":
      contexts.delete(msg.kelaboId);
      runtime?.gate.forget(msg.kelaboId);
      return;
  }
}

function onRename(msg) {
  const ctx = contexts.get(msg.kelaboId);
  if (!ctx) return;
  for (const u of ctx.transcript) {
    if (u.speaker === msg.from) u.speaker = msg.to;
  }
}

function init(msg) {
  const { modelConfig, knobs, llmApiKey, webSearchKey, openaiBaseUrl } = msg;
  // Pro (strong) model → sub-agents. Flash (small) model → main agent + gate.
  const strong = createLlmProvider(modelConfig, { apiKey: llmApiKey, openaiBaseUrl, log });
  const small = createLlmProvider({ ...modelConfig, model: modelConfig.smallModel }, { apiKey: llmApiKey, openaiBaseUrl, log });
  runtime = {
    modelConfig,
    knobs,
    strong,
    small,
    gate: new TriggerGate({ llm: small, smallModel: modelConfig.smallModel, knobs, log, debug }),
    webSearch: createWebSearch({ apiKey: webSearchKey, log }),
    webFetch: createWebFetch({ log }),
    maxConcurrent: knobs.maxConcurrentRuns ?? 4,
    maxDispatchPerTurn: knobs.maxDispatchPerTurn ?? 3,
  };
  log("agent_worker_ready", { provider: modelConfig.provider, model: modelConfig.model, smallModel: modelConfig.smallModel });
}

// One MainAgent (flash) per kelabo; holds the persistent orchestration thread.
function makeMainAgent(ctx) {
  return new MainAgent({
    llm: runtime.small,
    smallModel: runtime.modelConfig.smallModel,
    subAgentModel: runtime.modelConfig.model,
    subAgentDeps: {
      strong: runtime.strong,
      webSearch: runtime.webSearch,
      webFetch: runtime.webFetch,
      makeMcpQuery: () =>
        createMcpQuery({
          mcp: ctx.mcp,
          log,
          reauthorize: (server) => requestMcpReauth(ctx.kelaboId, server),
        }),
      capabilities: ctx.capabilities,
      mcp: ctx.mcp,
    },
    maxDispatchPerTurn: runtime.maxDispatchPerTurn,
    hostLanguage: ctx.hostLanguage,
    history: ctx.history,
    journeys: ctx.journeys,
    log,
    debug,
  });
}

function initContext(msg) {
  const ctx = {
    kelaboId: msg.kelaboId,
    transcript: msg.transcript ?? [],
    mcp: msg.mcp ?? { servers: [] },
    capabilities: msg.capabilities ?? [],
    hostLanguage: msg.hostLanguage ?? "",
    // Minutes of the host's earlier kelabos, empty unless they opted in
    // (notes #3). Fixed for the life of the context: it is history, and nothing
    // that happens in this kelabo can change what happened in an earlier one.
    history: msg.history ?? [],
    // Journey(s) this kelabo is linked to (docs 20 §12.1) — independent of
    // `history` above and, like it, fixed for the life of this context.
    journeys: msg.journeys ?? [],
    mainAgent: null,
  };
  ctx.mainAgent = makeMainAgent(ctx);
  contexts.set(msg.kelaboId, ctx);
}

function ensureCtx(kelaboId) {
  let ctx = contexts.get(kelaboId);
  if (!ctx) {
    ctx = { kelaboId, transcript: [], mcp: { servers: [] }, capabilities: [], hostLanguage: "", history: [], journeys: [], mainAgent: null };
    ctx.mainAgent = makeMainAgent(ctx);
    contexts.set(kelaboId, ctx);
  }
  return ctx;
}

async function onCaption(msg) {
  if (!runtime) return;
  const ctx = ensureCtx(msg.kelaboId);
  // Full kelabo history is kept (no trimming): the transcript is append-only,
  // which is ideal for prompt caching, and gives the LLM full kelabo context.
  // The caption that triggers context creation was persisted BEFORE dispatch,
  // so the rehydrated transcript already contains it — never add it twice.
  const caption = msg.caption;
  const alreadyInTranscript = ctx.transcript.some(
    (u) => u.tStart === caption.tStart && u.speaker === caption.speaker && u.text === caption.text
  );
  if (!alreadyInTranscript) ctx.transcript.push(caption);

  // Someone typed "@kelabo …". The gate is skipped rather than merely
  // pre-empted: running it would let a classifier, a cooldown or a rate cap
  // silently discard a request a participant made in so many words. The query
  // is what they typed with the mention removed — no model needed to work out
  // what was being asked when it was asked directly.
  let decision = { verdict: "INFO_GAP", query: msg.query || caption.text, reason: "addressed" };
  if (!msg.addressed) {
    decision = await runtime.gate.decide(msg.kelaboId, caption, ctx.transcript);
  } else {
    log("gate_bypassed", { kelaboId: msg.kelaboId, reason: "addressed" });
  }
  if (decision.verdict === "NONE") return;
  enqueueRun({
    kelaboId: msg.kelaboId,
    trigger: msg.caption,
    verdict: decision.verdict,
    // Context-aware standalone lookup query produced by the gate.
    query: decision.query,
    // Fixed here rather than in the MainAgent so the board can react the instant
    // the gate says yes. The orchestrator's own first call takes a second or
    // two, and a run can sit in the queue behind others — from the room's side
    // that gap looked like the assistant had not heard them at all.
    turnId: randomUUID(),
    cardId: randomUUID(),
  });
}

function enqueueRun(job) {
  const queued = activeRuns >= runtime.maxConcurrent || runningKelabos.has(job.kelaboId);
  parentPort.postMessage({
    type: "contribution",
    kelaboId: job.kelaboId,
    contribution: {
      id: job.cardId,
      kelaboId: job.kelaboId,
      tag: "LLM_CON",
      kind: "answer",
      title: job.query || "Looking into that",
      to: "all",
      markdown: "",
      author: "assistant",
      origin: "server",
      status: "working",
      progress: queued ? "Queued behind another lookup…" : "Picking up what was just said…",
      at: Date.now(),
    },
  });
  runQueue.push(job);
  pumpQueue();
}

// Kelabos with a run in flight. A MainAgent owns ONE persistent thread and
// appends to it as a turn progresses, so two turns for the same kelabo running
// at once interleave their writes — and an assistant tool-call turn that gets
// another turn's messages appended after it instead of its own results is
// exactly the malformed thread that kills the kelabo. Concurrency is across
// kelabos, never within one.
const runningKelabos = new Set();

function pumpQueue() {
  while (activeRuns < runtime.maxConcurrent && runQueue.length) {
    // Skip past jobs whose kelabo is busy rather than blocking the queue head;
    // they run when that kelabo's current turn finishes.
    const i = runQueue.findIndex((j) => !runningKelabos.has(j.kelaboId));
    if (i === -1) return;
    const [job] = runQueue.splice(i, 1);
    runningKelabos.add(job.kelaboId);
    activeRuns++;
    executeRun(job)
      .catch((err) => {
        log("agent_run_failed", { kelaboId: job.kelaboId, error: err.message });
        // The card announced at enqueue time is still spinning. Land it with the
        // reason rather than leaving it to spin for the rest of the kelabo.
        emitSkipped(job, `The lookup failed — ${err.message}`);
      })
      .finally(() => {
        activeRuns--;
        runningKelabos.delete(job.kelaboId);
        pumpQueue();
      });
  }
}

function emitSkipped(job, reason) {
  parentPort.postMessage({
    type: "contribution",
    kelaboId: job.kelaboId,
    contribution: {
      id: job.cardId,
      kelaboId: job.kelaboId,
      tag: "LLM_CON",
      kind: "answer",
      title: job.query || "Lookup",
      to: "all",
      markdown: "",
      reason,
      author: "assistant",
      origin: "server",
      status: "skipped",
      at: Date.now(),
    },
  });
}

async function executeRun(job) {
  const ctx = contexts.get(job.kelaboId);
  if (!ctx) {
    emitSkipped(job, "The kelabo ended before this lookup started.");
    return;
  }
  for await (const contribution of ctx.mainAgent.runTurn({
    kelaboId: job.kelaboId,
    trigger: job.trigger,
    query: job.query,
    transcript: [...ctx.transcript],
    turnId: job.turnId,
    cardId: job.cardId,
  })) {
    parentPort.postMessage({ type: "contribution", kelaboId: job.kelaboId, contribution });
  }
  log("agent_run_completed", { kelaboId: job.kelaboId, verdict: job.verdict });
}

async function onSummarize(msg) {
  if (!runtime) {
    parentPort.postMessage({ type: "summarize_result", reqId: msg.reqId, minutes: null, error: "not_initialized" });
    return;
  }
  const ctx = ensureCtx(msg.kelaboId);
  if (Array.isArray(msg.transcript)) ctx.transcript = msg.transcript;
  if (msg.mcp) ctx.mcp = msg.mcp;
  try {
    const minutes = await ctx.mainAgent.summarize({ kelaboId: msg.kelaboId, transcript: ctx.transcript });
    parentPort.postMessage({ type: "summarize_result", reqId: msg.reqId, minutes });
  } catch (err) {
    parentPort.postMessage({ type: "summarize_result", reqId: msg.reqId, minutes: null, error: err.message });
  }
}
