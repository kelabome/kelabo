import assert from "node:assert/strict";
import { MainAgent } from "../src/agent/mainAgent.js";
import { SubAgent } from "../src/agent/subAgent.js";
import { createMcpQuery } from "../src/agent/subagents.js";
import { loadEffectiveMcp } from "../src/agent/mcp.js";
import { subAgentSystemPrompt, mainAgentSystemPrompt, summarySystemPrompt } from "../src/agent/persona.js";
import { TriggerGate } from "../src/agent/gate.js";
import { languageName } from "../src/agent/language.js";
import { normalizeUsage, addUsage, createLlmProvider } from "../src/agent/llm.js";
import { parseMinutesJson } from "../src/agent/serverAgentRunner.js";

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`ok: ${name}`);
  } catch (e) {
    console.error(`FAIL: ${name}`);
    console.error(e);
    process.exitCode = 1;
  }
}

// A scriptable LLM stub: `plan` is an array of responses returned in order per
// call. Each response is { text, toolCalls?: [{id,name,input}] }.
function stubLlm(plan) {
  let i = 0;
  return {
    async completeRaw() {
      const r = plan[Math.min(i, plan.length - 1)];
      i++;
      const toolCalls = r.toolCalls ?? [];
      const content = [
        ...(r.text ? [{ type: "text", text: r.text }] : []),
        ...toolCalls.map((tc) => ({ type: "tool_use", id: tc.id, name: tc.name, input: tc.input })),
      ];
      return { text: r.text ?? "", toolCalls, raw: { content } };
    },
    async complete() {
      const r = plan[Math.min(i, plan.length - 1)];
      i++;
      return r.text ?? "";
    },
  };
}

const transcript = [
  { speaker: "alex", text: "What's Apple's share price today?", tStart: 1 },
  { speaker: "alex", text: "And the weather in Melbourne this weekend?", tStart: 2 },
];

await test("MainAgent dispatches → sub-agent outputs become board cards", async () => {
  // Main (flash) issues two parallel dispatches in one turn.
  const mainLlm = stubLlm([
    {
      text: "",
      toolCalls: [
        { id: "tu1", name: "dispatch_subagent", input: { task_id: "t1", kind: "web", objective: "AAPL price", to: "alex" } },
        { id: "tu2", name: "dispatch_subagent", input: { task_id: "t2", kind: "web", objective: "Melbourne weekend weather", to: "alex" } },
      ],
    },
  ]);

  // Each sub-agent (pro) returns a board-ready JSON result on its first call.
  const subResults = {
    t1: { task_id: "t1", status: "ok", title: "Apple share price", to: "alex", answer: "AAPL **$228.52**, +1.3%.", confidence: 0.9, sources: [{ title: "NASDAQ", url: "https://nasdaq.com/aapl" }], gaps: "" },
    t2: { task_id: "t2", status: "ok", title: "Melbourne weather", to: "alex", answer: "Sat 18/11°C, Sun 21/12°C.", confidence: 0.8, sources: [], gaps: "" },
  };
  const strong = {
    async completeRaw({ messages }) {
      const brief = JSON.parse(String(messages[0].content).replace(/^BRIEF:\n/, ""));
      return { text: JSON.stringify(subResults[brief.task_id]), toolCalls: [], raw: { content: [] } };
    },
  };

  const agent = new MainAgent({
    llm: mainLlm,
    smallModel: "flash",
    subAgentModel: "pro",
    subAgentDeps: {
      strong,
      webSearch: async () => [],
      webFetch: async () => ({}),
      makeMcpQuery: () => async () => ({}),
      capabilities: ["web", "web_search"],
      mcp: { servers: [] },
    },
    log: () => {},
    debug: () => {},
  });

  const out = [];
  for await (const c of agent.runTurn({ kelaboId: "m1", trigger: transcript[1], query: "Apple price; Melbourne weather", transcript })) {
    out.push(c);
  }

  // The turn card is cleared (a done card with no title/markdown) once the
  // per-task cards take over, so filter it out before counting real answers.
  const done = out.filter((c) => c.status === "done" && c.title);
  assert.equal(done.length, 2, "two board contributions");
  const byTitle = Object.fromEntries(done.map((c) => [c.title, c]));
  assert.equal(byTitle["Apple share price"].markdown, "AAPL **$228.52**, +1.3%.");
  assert.equal(byTitle["Apple share price"].to, "alex");
  assert.deepEqual(byTitle["Apple share price"].sources, [{ title: "NASDAQ", url: "https://nasdaq.com/aapl" }]);
  assert.equal(byTitle["Melbourne weather"].markdown, "Sat 18/11°C, Sun 21/12°C.");

  // The results are nested back into the persistent thread by task_id.
  const toolResultMsg = agent.thread.find((m) => Array.isArray(m.content) && m.content[0]?.type === "tool_result");
  assert.ok(toolResultMsg, "tool_result nested in thread");
  const ids = toolResultMsg.content.map((tr) => tr.tool_use_id).sort();
  assert.deepEqual(ids, ["tu1", "tu2"]);
});

await test("MainAgent refuses an empty/malformed dispatch brief before it ever reaches a SubAgent", async () => {
  // Reproduces a live production bug: a dispatch_subagent tool call whose
  // arguments came back empty (a truncated/unparseable arguments string in
  // the OpenAI-compatible adapter — see llm.js's own new parse-failure
  // logging for that half — or a small model calling the tool without
  // filling it in) used to reach SubAgent.run({}) unvalidated, which then
  // produced a confusing, sometimes non-English "the brief is empty"
  // failure card. `strong` throwing here proves no SubAgent is ever
  // constructed for either shape.
  const mainLlm = stubLlm([{
    text: "",
    toolCalls: [
      { id: "tu1", name: "dispatch_subagent", input: {} },
      { id: "tu2", name: "dispatch_subagent", input: { objective: "no task_id given", to: "all", language: "English" } },
    ],
  }]);
  const strong = { async completeRaw() { throw new Error("must never be called for an invalid brief"); } };
  const logged = [];
  const agent = new MainAgent({
    llm: mainLlm,
    smallModel: "flash",
    subAgentModel: "pro",
    subAgentDeps: { strong, webSearch: async () => [], webFetch: async () => ({}), makeMcpQuery: () => async () => ({}), capabilities: ["web"], mcp: { servers: [] } },
    log: (event, data) => logged.push({ event, data }),
    debug: () => {},
  });

  const out = [];
  for await (const c of agent.runTurn({ kelaboId: "m1", trigger: transcript[0], query: "what's fluxview?", transcript })) out.push(c);

  const skipped = out.filter((c) => c.status === "skipped");
  assert.equal(skipped.length, 2, "both invalid dispatches get a skipped card, not a hang or a crash");
  for (const card of skipped) {
    assert.equal(card.reason, "Research failed — the lookup request was incomplete and could not be run.", "deterministic, English, and never model-generated — the exact failure mode that used to come back in whatever language a confused sub-agent picked");
  }

  const invalidLogs = logged.filter((l) => l.event === "main_dispatch_brief_invalid");
  assert.equal(invalidLogs.length, 2);
  assert.deepEqual(invalidLogs[0].data.missing.sort(), ["objective", "task_id"], "a fully empty brief is missing both");
  assert.deepEqual(invalidLogs[1].data.missing, ["task_id"], "only the one actually missing field is named");

  // The thread still gets a tool_result for every tool_use, or the next
  // request to the provider is malformed and the kelabo's thread is dead —
  // this must hold even for a dispatch that never ran.
  const toolResultMsg = agent.thread.find((m) => Array.isArray(m.content) && m.content[0]?.type === "tool_result");
  assert.equal(toolResultMsg.content.length, 2);
});

await test("MainAgent stays silent (NO_POST) → no board cards, recorded in thread", async () => {
  const mainLlm = stubLlm([{ text: "NO_POST: small talk", toolCalls: [] }]);
  const agent = new MainAgent({
    llm: mainLlm,
    smallModel: "flash",
    subAgentModel: "pro",
    subAgentDeps: { strong: {}, webSearch: async () => [], webFetch: async () => ({}), makeMcpQuery: () => async () => ({}), capabilities: [], mcp: { servers: [] } },
    log: () => {},
    debug: () => {},
  });
  const out = [];
  for await (const c of agent.runTurn({ kelaboId: "m1", trigger: transcript[0], query: "hi", transcript })) out.push(c);
  // Nothing is posted, but the card the room watched appear does not vanish:
  // it lands as a "skipped" card carrying the reason.
  assert.ok(out.every((c) => !c.markdown), "no answer posted");
  const skipped = out.filter((c) => c.status === "skipped");
  assert.equal(skipped.length, 1, "one skipped card");
  assert.match(skipped[0].reason, /small talk/, "the card says why");
  // Working card and skipped card are the SAME card — it updates in place.
  assert.equal(out[0].status, "working");
  assert.equal(out[0].id, skipped[0].id);
  assert.equal(agent.thread.at(-1).content, "NO_POST: small talk");
});

await test("MainAgent transcript sync is append-only across turns", async () => {
  const mainLlm = stubLlm([{ text: "NO_POST: x", toolCalls: [] }, { text: "NO_POST: y", toolCalls: [] }]);
  const agent = new MainAgent({
    llm: mainLlm, smallModel: "flash", subAgentModel: "pro",
    subAgentDeps: { strong: {}, webSearch: async () => [], webFetch: async () => ({}), makeMcpQuery: () => async () => ({}), capabilities: [], mcp: { servers: [] } },
    log: () => {}, debug: () => {},
  });
  for await (const _ of agent.runTurn({ kelaboId: "m1", query: "q1", transcript: transcript.slice(0, 1) })) void _;
  for await (const _ of agent.runTurn({ kelaboId: "m1", query: "q2", transcript })) void _;
  const transcriptMsgs = agent.thread.filter((m) => typeof m.content === "string" && m.content.startsWith("TRANSCRIPT:"));
  assert.equal(transcriptMsgs.length, 2, "each utterance appended exactly once");
});

await test("SubAgent tool loop → parses structured result and merges sources", async () => {
  // First call fetches, second call concludes with JSON.
  let call = 0;
  const llm = {
    async completeRaw() {
      call++;
      if (call === 1) {
        return {
          text: "",
          toolCalls: [{ id: "f1", name: "web_fetch", input: { url: "https://api.weather/melb" } }],
          raw: { content: [{ type: "tool_use", id: "f1", name: "web_fetch", input: { url: "https://api.weather/melb" } }] },
        };
      }
      return {
        text: JSON.stringify({ task_id: "t9", status: "ok", title: "Weather", to: "all", answer: "Sunny 22°C.", confidence: 0.7, sources: [{ title: "BOM", url: "https://bom.gov.au" }], gaps: "" }),
        toolCalls: [],
        raw: { content: [] },
      };
    },
  };
  const sub = new SubAgent({
    llm,
    model: "pro",
    webSearch: async () => [],
    webFetch: async () => ({ url: "https://api.weather/melb", text: "22C sunny" }),
    mcpQuery: async () => ({}),
    capabilities: ["web", "web_search"],
    mcp: { servers: [] },
    log: () => {},
    debug: () => {},
  });
  const result = await sub.run({ task_id: "t9", objective: "Melbourne weather", to: "all" }, "m1");
  assert.equal(result.task_id, "t9");
  assert.equal(result.status, "ok");
  assert.equal(result.answer, "Sunny 22°C.");
  // Body source + the fetched url both present, de-duped.
  const urls = result.sources.map((s) => s.url).sort();
  assert.deepEqual(urls, ["https://api.weather/melb", "https://bom.gov.au"]);
});

await test("SubAgent prose-then-JSON: force-conclude commits a final result", async () => {
  // The model's final tool-less turn is prose (no JSON). forceConclude runs and
  // returns the structured result.
  // The tool loop passes `tools`; forceConclude deliberately passes none, which
  // is how the real call is distinguished (both go through completeRaw so the
  // force-conclude round trip's tokens are counted).
  const llm = {
    async completeRaw(req) {
      if (req.tools?.length) return { text: "Let me try some more sources.", toolCalls: [], raw: { content: [] } };
      return {
        text: JSON.stringify({ task_id: "t0", status: "ok", title: "Answer", to: "all", answer: "Final concrete answer.", confidence: 0.6, sources: [], gaps: "" }),
        toolCalls: [],
        raw: { content: [] },
      };
    },
  };
  const sub = new SubAgent({ llm, model: "pro", webSearch: async () => [], webFetch: async () => ({}), mcpQuery: async () => ({}), capabilities: [], mcp: { servers: [] }, log: () => {}, debug: () => {} });
  const r = await sub.run({ task_id: "t0", objective: "x", to: "all" }, "m1");
  assert.equal(r.status, "ok");
  assert.equal(r.answer, "Final concrete answer.");
});

await test("SubAgent that never concludes → status empty, no answer (not posted)", async () => {
  // completeRaw always narrates + calls a tool; conclude call also fails to JSON.
  const llm = {
    async completeRaw() {
      return {
        text: "Let me try some more sources.",
        toolCalls: [{ id: "s1", name: "web_search", input: { query: "largest farm" } }],
        raw: { content: [{ type: "tool_use", id: "s1", name: "web_search", input: { query: "largest farm" } }] },
      };
    },
    async complete() {
      return "Still searching, no definitive result yet.";
    },
  };
  const sub = new SubAgent({ llm, model: "pro", webSearch: async () => [], webFetch: async () => ({}), mcpQuery: async () => ({}), capabilities: ["web", "web_search"], mcp: { servers: [] }, log: () => {}, debug: () => {} });
  const r = await sub.run({ task_id: "t0", objective: "largest farm", to: "all" }, "m1");
  assert.equal(r.status, "empty");
  assert.equal(r.answer, "");
  assert.equal(r.gaps, "no_conclusive_result");
});

await test("MainAgent never posts an empty result, and says why instead", async () => {
  const mainLlm = stubLlm([
    { text: "", toolCalls: [{ id: "tu1", name: "dispatch_subagent", input: { task_id: "t1", objective: "largest farm", to: "all" } }] },
  ]);
  // Sub-agent concludes empty.
  const strong = {
    async completeRaw() {
      return { text: JSON.stringify({ task_id: "t1", status: "empty", title: "Largest farm", to: "all", answer: "", confidence: 0, sources: [], gaps: "no source" }), toolCalls: [], raw: { content: [] } };
    },
  };
  const agent = new MainAgent({
    llm: mainLlm, smallModel: "flash", subAgentModel: "pro",
    subAgentDeps: { strong, webSearch: async () => [], webFetch: async () => ({}), makeMcpQuery: () => async () => ({}), capabilities: ["web"], mcp: { servers: [] } },
    log: () => {}, debug: () => {},
  });
  const out = [];
  for await (const c of agent.runTurn({ kelaboId: "m1", query: "largest farm", transcript })) out.push(c);
  assert.ok(out.every((c) => !(c.status === "done" && c.markdown)), "no posted answer card");
  const skipped = out.filter((c) => c.status === "skipped");
  assert.equal(skipped.length, 1, "the task's card stays, marked skipped");
  assert.match(skipped[0].reason, /no source/, "the worker's gap is the reason shown");
  // And the outcome is recorded for the minutes.
  assert.equal(agent.taskLog.length, 1);
  assert.equal(agent.taskLog[0].outcome, "no_post");
});

await test("sub-agent tool calls stream to the board as progress", async () => {
  const mainLlm = stubLlm([
    { text: "", toolCalls: [{ id: "tu1", name: "dispatch_subagent", input: { task_id: "t1", objective: "Melbourne weather", to: "all" } }] },
  ]);
  let call = 0;
  const strong = {
    async completeRaw() {
      call++;
      if (call === 1) {
        return {
          text: "",
          toolCalls: [{ id: "f1", name: "web_fetch", input: { url: "https://api.weather.gov/melb" } }],
          raw: { content: [{ type: "tool_use", id: "f1", name: "web_fetch", input: { url: "https://api.weather.gov/melb" } }] },
        };
      }
      return {
        text: JSON.stringify({ task_id: "t1", status: "ok", title: "Weather", to: "all", answer: "Sunny 22°C.", confidence: 0.8, sources: [], gaps: "" }),
        toolCalls: [],
        raw: { content: [] },
      };
    },
  };
  const agent = new MainAgent({
    llm: mainLlm, smallModel: "flash", subAgentModel: "pro",
    subAgentDeps: { strong, webSearch: async () => [], webFetch: async () => ({ url: "https://api.weather.gov/melb", text: "22C" }), makeMcpQuery: () => async () => ({}), capabilities: ["web"], mcp: { servers: [] } },
    log: () => {}, debug: () => {},
  });
  const out = [];
  for await (const c of agent.runTurn({ kelaboId: "m1", query: "melbourne weather", transcript })) out.push(c);

  const progress = out.filter((c) => c.status === "working" && c.progress).map((c) => c.progress);
  assert.ok(progress.includes("Fetching api.weather.gov"), `tool call reported as progress: ${progress.join(" | ")}`);
  assert.ok(progress.includes("Writing the answer…"), "the final phase is reported");
  // The steps trail accumulates on the card, and the answer lands on that same card.
  const withSteps = out.find((c) => c.steps?.length);
  assert.deepEqual(withSteps.steps, ["Fetching api.weather.gov"]);
  const answer = out.find((c) => c.status === "done" && c.markdown);
  assert.equal(answer.markdown, "Sunny 22°C.");
  assert.equal(answer.id, withSteps.id, "progress and answer are the same card");
});

await test("dispatches beyond the per-turn cap still get a tool_result", async () => {
  // Anthropic rejects a thread where a tool_use has no matching tool_result, so
  // the ones the cap drops must be answered too.
  const mainLlm = stubLlm([
    {
      text: "",
      toolCalls: [1, 2, 3, 4, 5].map((n) => ({ id: `tu${n}`, name: "dispatch_subagent", input: { task_id: `t${n}`, objective: `o${n}`, to: "all" } })),
    },
  ]);
  const strong = {
    async completeRaw({ messages }) {
      const brief = JSON.parse(String(messages[0].content).replace(/^BRIEF:\n/, ""));
      return { text: JSON.stringify({ task_id: brief.task_id, status: "ok", title: brief.objective, to: "all", answer: "x", confidence: 1, sources: [], gaps: "" }), toolCalls: [], raw: { content: [] } };
    },
  };
  const agent = new MainAgent({
    llm: mainLlm, smallModel: "flash", subAgentModel: "pro",
    subAgentDeps: { strong, webSearch: async () => [], webFetch: async () => ({}), makeMcpQuery: () => async () => ({}), capabilities: ["web"], mcp: { servers: [] } },
    maxDispatchPerTurn: 3,
    log: () => {}, debug: () => {},
  });
  for await (const _ of agent.runTurn({ kelaboId: "m1", query: "five things", transcript })) void _;
  const results = agent.thread.find((m) => Array.isArray(m.content) && m.content[0]?.type === "tool_result");
  assert.deepEqual(results.content.map((r) => r.tool_use_id).sort(), ["tu1", "tu2", "tu3", "tu4", "tu5"]);
});

await test("debug entries carry a shared turnId linking main + sub-agents", async () => {
  const mainLlm = stubLlm([
    {
      text: "",
      toolCalls: [
        { id: "tu1", name: "dispatch_subagent", input: { task_id: "t1", objective: "AAPL price", to: "all" } },
        { id: "tu2", name: "dispatch_subagent", input: { task_id: "t2", objective: "Melbourne weather", to: "all" } },
      ],
    },
  ]);
  const strong = {
    async completeRaw({ messages }) {
      const brief = JSON.parse(String(messages[0].content).replace(/^BRIEF:\n/, ""));
      return { text: JSON.stringify({ task_id: brief.task_id, status: "ok", title: brief.objective, to: "all", answer: "x", confidence: 0.9, sources: [], gaps: "" }), toolCalls: [], raw: { content: [] } };
    },
  };
  const events = [];
  const agent = new MainAgent({
    llm: mainLlm, smallModel: "flash", subAgentModel: "pro",
    subAgentDeps: { strong, webSearch: async () => [], webFetch: async () => ({}), makeMcpQuery: () => async () => ({}), capabilities: ["web"], mcp: { servers: [] } },
    log: () => {}, debug: (_m, e) => events.push(e),
  });
  for await (const _ of agent.runTurn({ kelaboId: "m1", query: "q", transcript })) void _;

  const mainReq = events.find((e) => e.kind === "main" && e.phase === "request");
  assert.ok(mainReq?.turnId, "main request has a turnId");
  const subEvents = events.filter((e) => e.kind === "subagent");
  assert.ok(subEvents.length > 0, "sub-agent events emitted");
  // Every sub-agent event shares the SAME turnId as the main turn (grouping key).
  assert.ok(subEvents.every((e) => e.turnId === mainReq.turnId), "sub-agent events share the main turnId");
  // Both dispatched sub-agents are distinguishable by taskId within the turn.
  const taskIds = new Set(subEvents.map((e) => e.taskId));
  assert.deepEqual([...taskIds].sort(), ["t1", "t2"]);
  // The main request reports its thread length (used by the panel to reflect context).
  assert.equal(typeof mainReq.threadLen, "number");
});

await test("distinct turns get distinct turnIds", async () => {
  const mainLlm = stubLlm([{ text: "NO_POST: a", toolCalls: [] }, { text: "NO_POST: b", toolCalls: [] }]);
  const events = [];
  const agent = new MainAgent({
    llm: mainLlm, smallModel: "flash", subAgentModel: "pro",
    subAgentDeps: { strong: {}, webSearch: async () => [], webFetch: async () => ({}), makeMcpQuery: () => async () => ({}), capabilities: [], mcp: { servers: [] } },
    log: () => {}, debug: (_m, e) => events.push(e),
  });
  for await (const _ of agent.runTurn({ kelaboId: "m1", query: "q1", transcript: transcript.slice(0, 1) })) void _;
  for await (const _ of agent.runTurn({ kelaboId: "m1", query: "q2", transcript })) void _;
  const turnIds = events.filter((e) => e.kind === "main" && e.phase === "request").map((e) => e.turnId);
  assert.equal(turnIds.length, 2);
  assert.notEqual(turnIds[0], turnIds[1], "each turn has a unique id");
});

// ---- MCP transport: OAuth 401 -> refresh -> retry ---------------------------

await test("mcp_query retries once after reauthorizing on 401", async () => {
  const seen = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const auth = init.headers.Authorization ?? null;
    seen.push({ auth, body: JSON.parse(init.body).method });
    if (auth === "Bearer stale") {
      return {
        ok: false,
        status: 401,
        headers: { get: (k) => (k.toLowerCase() === "www-authenticate" ? 'Bearer error="invalid_token"' : null) },
        text: async () => "",
      };
    }
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "hi" }] } }),
    };
  };
  try {
    let reauthCalls = 0;
    const mcpQuery = createMcpQuery({
      mcp: {
        servers: [
          { name: "acme", transport: "http", url: "https://mcp.acme.test/mcp", headers: { Authorization: "Bearer stale" } },
        ],
      },
      log: () => {},
      reauthorize: async (name) => {
        reauthCalls++;
        assert.equal(name, "acme");
        return "Bearer fresh";
      },
    });
    const out = await mcpQuery("acme", { tool: "search", arguments: {} });
    assert.equal(out.content, "hi", "retry succeeded with the refreshed token");
    assert.equal(reauthCalls, 1, "refreshed exactly once");
    assert.ok(
      seen.some((s) => s.auth === "Bearer fresh" && s.body === "initialize"),
      "session re-initialized under the new token"
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});

await test("mcp_query surfaces a reconnect hint when refresh fails", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: false,
    status: 401,
    headers: { get: () => null },
    text: async () => "",
  });
  try {
    const mcpQuery = createMcpQuery({
      mcp: { servers: [{ name: "acme", transport: "http", url: "https://mcp.acme.test/mcp", headers: {} }] },
      log: () => {},
      // Dead refresh token: the user has to reconnect from Settings.
      reauthorize: async () => null,
    });
    const out = await mcpQuery("acme", { tool: "search", arguments: {} });
    assert.match(out.error, /mcp_unauthorized:acme/);
    assert.match(out.error, /reconnect/i, "the sub-agent gets an actionable message, not a bare 401");
  } finally {
    globalThis.fetch = realFetch;
  }
});

// ---- loadEffectiveMcp: token resolution + proactive refresh -----------------

// Minimal container: routes DynamoDB command objects by shape, like the real
// table would, so the db.js key patterns are exercised rather than mocked away.
function stubContainer({ server, token, client }) {
  const writes = [];
  return {
    writes,
    c: {
      config: { tableNames: { mcp: "t-mcp" }, secrets: { mcpPrefix: "kelabo/test/mcp/" } },
      db: {
        async send(cmd) {
          const i = cmd.input;
          if (i.KeyConditionExpression) return { Items: server ? [server] : [] };
          if (i.Item) {
            writes.push(i.Item);
            return {};
          }
          if (i.Key?.SK?.startsWith("TOKEN#")) return { Item: token ? { ...i.Key, ...token } : null };
          if (i.Key?.SK?.startsWith("AS#")) return { Item: client ? { ...i.Key, ...client } : null };
          return { Item: null };
        },
      },
      getSecret: async () => null,
      log: () => {},
      logError: () => {},
    },
  };
}

const OAUTH_SERVER = {
  name: "acme",
  transport: "http",
  url: "https://mcp.acme.test/mcp",
  enabled: true,
  authType: "oauth",
  oauth: {
    issuer: "https://auth.acme.test",
    tokenEndpoint: "https://auth.acme.test/token",
    resource: "https://mcp.acme.test/mcp",
    scope: "read:jira",
  },
};

await test("loadEffectiveMcp refreshes an expired OAuth token and persists the rotation", async () => {
  const { c, writes } = stubContainer({
    server: OAUTH_SERVER,
    token: { accessToken: "at-old", refreshToken: "rt-old", tokenType: "Bearer", expiresAt: Date.now() - 1000 },
    client: { clientId: "dyn-1", clientSecret: null },
  });
  const realFetch = globalThis.fetch;
  let form = null;
  globalThis.fetch = async (url, init) => {
    // loadEffectiveMcp also calls tools/list on the MCP server itself, so route
    // by URL rather than assuming every request is the refresh grant.
    if (String(url) === "https://auth.acme.test/token") {
      form = new URLSearchParams(init.body);
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: async () => JSON.stringify({ access_token: "at-new", refresh_token: "rt-new", token_type: "Bearer", expires_in: 3600 }),
      };
    }
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools: [] } }),
    };
  };
  try {
    const { servers } = await loadEffectiveMcp(c, { hostIdentity: "host@example.com" });
    assert.equal(servers.length, 1);
    assert.equal(servers[0].headers.Authorization, "Bearer at-new");
    assert.equal(form.get("grant_type"), "refresh_token");
    assert.equal(form.get("resource"), "https://mcp.acme.test/mcp", "RFC 8707 resource replayed on refresh");
    // OAuth 2.1 rotates refresh tokens for public clients: losing the new one
    // would permanently orphan the connection.
    const written = writes.find((w) => w.SK === "TOKEN#acme");
    assert.equal(written.accessToken, "at-new");
    assert.equal(written.refreshToken, "rt-new");
  } finally {
    globalThis.fetch = realFetch;
  }
});

await test("loadEffectiveMcp drops a server whose refresh grant is dead", async () => {
  const { c } = stubContainer({
    server: OAUTH_SERVER,
    token: { accessToken: "at-old", refreshToken: "rt-dead", tokenType: "Bearer", expiresAt: Date.now() - 1000 },
    client: { clientId: "dyn-1", clientSecret: null },
  });
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: false,
    status: 400,
    headers: { get: () => null },
    text: async () => JSON.stringify({ error: "invalid_grant" }),
  });
  try {
    const { servers } = await loadEffectiveMcp(c, { hostIdentity: "host@example.com" });
    // Better to hide the tool than to hand the agent one that can only 401.
    assert.equal(servers.length, 0, "unusable server is not offered to the agent");
  } finally {
    globalThis.fetch = realFetch;
  }
});

await test("loadEffectiveMcp leaves a still-valid OAuth token alone", async () => {
  const { c, writes } = stubContainer({
    server: OAUTH_SERVER,
    token: { accessToken: "at-good", refreshToken: "rt", tokenType: "Bearer", expiresAt: Date.now() + 3600_000 },
    client: { clientId: "dyn-1", clientSecret: null },
  });
  const realFetch = globalThis.fetch;
  let tokenEndpointHits = 0;
  globalThis.fetch = async (url) => {
    if (String(url).includes("auth.acme.test")) tokenEndpointHits++;
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools: [] } }),
    };
  };
  try {
    const { servers, reauthorizers } = await loadEffectiveMcp(c, { hostIdentity: "host@example.com" });
    assert.equal(tokenEndpointHits, 0, "a valid token must not trigger a refresh grant");
    assert.equal(servers[0].headers.Authorization, "Bearer at-good");
    assert.equal(writes.length, 0, "no needless write");
    assert.equal(typeof reauthorizers.get("acme"), "function", "a refresher is available for 401 recovery");
    // The servers array crosses a worker_thread boundary, so it must stay
    // structured-cloneable — no functions may leak onto it.
    assert.doesNotThrow(() => structuredClone(servers));
  } finally {
    globalThis.fetch = realFetch;
  }
});

// ---- MCP tool catalogue in the prompts --------------------------------------
// Regression guard for the "server configured but never called" failure: the
// agent was told only that a server named "Deepwiki" existed, with no hint of
// what it did, so it kept guessing URLs with web_fetch instead.

const CATALOGUE = [
  {
    name: "Deepwiki",
    tools: [
      { name: "ask_question", description: "Ask any question about a GitHub repository." },
      { name: "read_wiki_contents", description: "View documentation about a GitHub repository." },
    ],
  },
];

await test("sub-agent prompt lists each MCP server's tools, not just its name", async () => {
  const s = subAgentSystemPrompt({ capabilities: ["web"], mcpServers: CATALOGUE });
  assert.match(s, /Deepwiki/);
  assert.match(s, /ask_question: Ask any question about a GitHub repository\./);
  assert.match(s, /read_wiki_contents/);
  assert.match(s, /PREFER these over the open web/, "the model is told when to choose MCP over web_fetch");
});

await test("main agent prompt advertises connected MCP servers so briefs can route to them", async () => {
  const withMcp = mainAgentSystemPrompt({ mcpServers: CATALOGUE });
  assert.match(withMcp, /CONNECTED TOOL SERVERS/);
  assert.match(withMcp, /ask_question/);
  // No servers connected -> no dead section in the prompt.
  const without = mainAgentSystemPrompt({ mcpServers: [] });
  assert.doesNotMatch(without, /CONNECTED TOOL SERVERS/);
  assert.doesNotMatch(mainAgentSystemPrompt(), /CONNECTED TOOL SERVERS/, "callable with no args");
});

await test("a server whose tools/list failed still gets a usable prompt entry", async () => {
  const s = subAgentSystemPrompt({ capabilities: [], mcpServers: [{ name: "Flaky", tools: [] }] });
  assert.match(s, /Flaky: \(tool list unavailable/);
  assert.match(s, /listTools:true/, "the agent can still discover the tools itself");
});

await test("loadEffectiveMcp attaches a tool catalogue to each server", async () => {
  const { c } = stubContainer({
    server: { name: "Deepwiki", transport: "http", url: "https://mcp.deepwiki.test/mcp", enabled: true, authType: "none" },
  });
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    const method = JSON.parse(init.body).method;
    const result =
      method === "tools/list"
        ? { tools: [{ name: "ask_question", description: "Ask about a repo." }] }
        : {};
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => JSON.stringify({ jsonrpc: "2.0", id: 1, result }),
    };
  };
  try {
    const { servers } = await loadEffectiveMcp(c, { hostIdentity: "host@example.com" });
    assert.deepEqual(servers[0].tools, [{ name: "ask_question", description: "Ask about a repo." }]);
    // Still has to survive the trip into the agent worker_thread.
    assert.doesNotThrow(() => structuredClone(servers));
  } finally {
    globalThis.fetch = realFetch;
  }
});

// ---- Token accounting -------------------------------------------------------

await test("normalizeUsage folds provider shapes into disjoint buckets", async () => {
  // Anthropic: input_tokens EXCLUDES the cached buckets.
  assert.deepEqual(
    normalizeUsage({ input_tokens: 100, cache_read_input_tokens: 900, cache_creation_input_tokens: 50, output_tokens: 20 }),
    { cacheRead: 900, cacheWrite: 50, input: 100, output: 20, total: 1070 }
  );
  // DeepSeek: prompt_tokens INCLUDES the cache hits, so input must be the
  // remainder or the same tokens would be counted twice.
  assert.deepEqual(
    normalizeUsage({ prompt_tokens: 1000, prompt_cache_hit_tokens: 900, completion_tokens: 20 }),
    { cacheRead: 900, cacheWrite: 0, input: 100, output: 20, total: 1020 }
  );
  // OpenAI nests the same figure.
  assert.deepEqual(
    normalizeUsage({ prompt_tokens: 500, prompt_tokens_details: { cached_tokens: 200 }, completion_tokens: 10 }),
    { cacheRead: 200, cacheWrite: 0, input: 300, output: 10, total: 510 }
  );
  // No cache reporting at all.
  assert.deepEqual(
    normalizeUsage({ prompt_tokens: 30, completion_tokens: 5 }),
    { cacheRead: 0, cacheWrite: 0, input: 30, output: 5, total: 35 }
  );
  assert.equal(normalizeUsage(null), null);
  assert.equal(normalizeUsage({}), null);
  // A provider reporting fewer prompt tokens than cache hits must not go negative.
  assert.equal(normalizeUsage({ prompt_tokens: 10, prompt_cache_hit_tokens: 40, completion_tokens: 1 }).input, 0);
});

await test("addUsage totals across calls", async () => {
  const a = { cacheRead: 10, cacheWrite: 1, input: 5, output: 2, total: 18 };
  assert.deepEqual(addUsage(a, a), { cacheRead: 20, cacheWrite: 2, input: 10, output: 4, total: 36 });
  assert.deepEqual(addUsage(null, a), { cacheRead: 10, cacheWrite: 1, input: 5, output: 2, total: 18 });
  assert.equal(addUsage(null, undefined), null);
});

await test("a turn reports the token cost of the whole search", async () => {
  const usage = (input, output) => ({ prompt_tokens: input, prompt_cache_hit_tokens: 0, completion_tokens: output });
  // Orchestrator dispatches one sub-agent; the sub-agent runs two iterations.
  const mainLlm = {
    async completeRaw() {
      return {
        text: "",
        toolCalls: [{ id: "t1", name: "dispatch_subagent", input: { task_id: "t1", objective: "o" } }],
        raw: { content: [{ type: "tool_use", id: "t1", name: "dispatch_subagent", input: { task_id: "t1", objective: "o" } }] },
        usage: normalizeUsage(usage(1000, 100)),
      };
    },
  };
  let call = 0;
  const strong = {
    async completeRaw() {
      call++;
      if (call === 1) {
        return {
          text: "",
          toolCalls: [{ id: "w1", name: "web_fetch", input: { url: "https://x.test" } }],
          raw: { content: [{ type: "tool_use", id: "w1", name: "web_fetch", input: {} }] },
          usage: normalizeUsage(usage(2000, 200)),
        };
      }
      return {
        text: JSON.stringify({ task_id: "t1", status: "ok", title: "T", to: "all", answer: "A", confidence: 1, sources: [] }),
        toolCalls: [],
        raw: { content: [] },
        usage: normalizeUsage(usage(3000, 300)),
      };
    },
  };
  const events = [];
  const agent = new MainAgent({
    llm: mainLlm, smallModel: "flash", subAgentModel: "pro",
    subAgentDeps: {
      strong, webSearch: async () => [], webFetch: async () => ({ text: "x" }),
      makeMcpQuery: () => async () => ({}), capabilities: ["web"], mcp: { servers: [] },
    },
    log: () => {}, debug: (_m, e) => events.push(e),
  });
  for await (const _ of agent.runTurn({ kelaboId: "m1", query: "q", transcript })) void _;

  const rollup = events.find((e) => e.kind === "turn_usage");
  assert.ok(rollup, "the turn emits one rolled-up total");
  assert.equal(rollup.subAgents, 1);
  // main 1000/100 + sub 2000/200 + sub 3000/300
  assert.equal(rollup.usage.input, 6000);
  assert.equal(rollup.usage.output, 600);
  assert.equal(rollup.usage.total, 6600);
  // Individual exchanges still carry their own usage for the per-call view.
  assert.ok(events.some((e) => e.kind === "main" && e.phase === "response" && e.usage?.input === 1000));
  assert.ok(events.some((e) => e.kind === "subagent" && e.phase === "response" && e.usage?.input === 2000));
});

// ---- minutes: a write-up, not a list of labels ------------------------------

await test("parseMinutesJson keeps the detail of a rich write-up", async () => {
  const raw = JSON.stringify({
    title: "Website redesign review",
    summary: "The team reviewed the redesign and agreed to keep the sidebar layout.",
    topics: [{ title: "Navigation", detail: "Alex argued the sidebar tests better than tabs.", speakers: ["alex"] }],
    decisions: [{ text: "Keep the sidebar until October", rationale: "Two experiments finish in September." }],
    actionItems: [{ text: "Draft the design notes", owner: "alex", due: "Friday" }],
    openQuestions: ["Does the tablet breakpoint change?"],
    findings: [{ text: "AAPL closed at $228.52", sources: [{ title: "NASDAQ", url: "https://nasdaq.com/aapl" }] }],
  });
  const m = parseMinutesJson(raw, "m1", "server");
  assert.equal(m.summary, "The team reviewed the redesign and agreed to keep the sidebar layout.");
  assert.equal(m.topics[0].detail, "Alex argued the sidebar tests better than tabs.");
  assert.deepEqual(m.topics[0].speakers, ["alex"]);
  assert.equal(m.decisions[0].rationale, "Two experiments finish in September.");
  assert.equal(m.actionItems[0].due, "Friday");
  assert.equal(m.findings[0].sources[0].url, "https://nasdaq.com/aapl");
});

await test("parseMinutesJson still reads the old string-array shape", async () => {
  // Archived records predate the richer document and must keep rendering.
  const raw = JSON.stringify({
    topics: ["Navigation", "Accessibility"],
    decisions: ["Keep the sidebar"],
    actionItems: ["Draft the notes"],
    openQuestions: ["Tablet breakpoint?"],
    findings: ["AAPL $228.52"],
  });
  const m = parseMinutesJson(raw, "m1", "opencode");
  assert.deepEqual(m.topics, [{ title: "Navigation" }, { title: "Accessibility" }]);
  assert.deepEqual(m.decisions, [{ text: "Keep the sidebar" }]);
  assert.deepEqual(m.actionItems, [{ text: "Draft the notes" }]);
  assert.deepEqual(m.findings, [{ text: "AAPL $228.52" }]);
});

await test("the summary is given the research the agent actually did", async () => {
  const mainLlm = stubLlm([
    { text: "", toolCalls: [{ id: "tu1", name: "dispatch_subagent", input: { task_id: "t1", objective: "AAPL price", to: "all" } }] },
  ]);
  const strong = {
    async completeRaw() {
      return {
        text: JSON.stringify({ task_id: "t1", status: "ok", title: "Apple", to: "all", answer: "AAPL $228.52", confidence: 1, sources: [{ title: "NASDAQ", url: "https://nasdaq.com/aapl" }], gaps: "" }),
        toolCalls: [], raw: { content: [] },
      };
    },
  };
  let summaryPrompt = "";
  const agent = new MainAgent({
    llm: {
      ...mainLlm,
      async complete(req) {
        summaryPrompt = String(req.messages.at(-1).content);
        return JSON.stringify({ title: "T", summary: "s", topics: [], decisions: [], actionItems: [], openQuestions: [], findings: [] });
      },
    },
    smallModel: "flash", subAgentModel: "pro",
    subAgentDeps: { strong, webSearch: async () => [], webFetch: async () => ({}), makeMcpQuery: () => async () => ({}), capabilities: ["web"], mcp: { servers: [] } },
    log: () => {}, debug: () => {},
  });
  for await (const _ of agent.runTurn({ kelaboId: "m1", query: "AAPL price", transcript })) void _;
  await agent.summarize({ kelaboId: "m1", transcript });

  assert.match(summaryPrompt, /RESEARCH THE ASSISTANT PERFORMED/, "the arrangement log is handed to the summariser");
  assert.match(summaryPrompt, /AAPL \$228\.52/, "with the answer it found");
  assert.match(summaryPrompt, /nasdaq\.com/, "and its sources");
  assert.match(summaryPrompt, /Participants heard/, "and who was in the room");
});

// ---- the thread stays sendable ----------------------------------------------
//
// "An assistant message with 'tool_calls' must be followed by tool messages
// responding to each 'tool_call_id'" is fatal in a persistent thread: the same
// malformed prefix is resent every turn, so one bad turn ends the assistant for
// the whole kelabo. Three independent guards, one test each.

await test("a tool the model invented still gets a tool_result", async () => {
  // The orchestrator has exactly one tool, but small models call `web_search`
  // anyway. Recording that call without answering it is what killed kelabos.
  const mainLlm = stubLlm([
    {
      text: "",
      toolCalls: [
        { id: "tu1", name: "dispatch_subagent", input: { task_id: "t1", objective: "last emperor of China", to: "all", language: "Chinese" } },
        { id: "tu9", name: "web_search", input: { query: "中国最后一个皇帝" } },
      ],
    },
  ]);
  const strong = {
    async completeRaw() {
      return { text: JSON.stringify({ task_id: "t1", status: "ok", title: "末代皇帝", to: "all", answer: "溥仪。", confidence: 1, sources: [], gaps: "" }), toolCalls: [], raw: { content: [] } };
    },
  };
  const agent = new MainAgent({
    llm: mainLlm, smallModel: "flash", subAgentModel: "pro",
    subAgentDeps: { strong, webSearch: async () => [], webFetch: async () => ({}), makeMcpQuery: () => async () => ({}), capabilities: ["web"], mcp: { servers: [] } },
    log: () => {}, debug: () => {},
  });
  for await (const _ of agent.runTurn({ kelaboId: "m1", query: "末代皇帝", transcript })) void _;

  const assistant = agent.thread.find((m) => Array.isArray(m.content) && m.content.some((b) => b.type === "tool_use"));
  const called = assistant.content.filter((b) => b.type === "tool_use").map((b) => b.id).sort();
  const results = agent.thread.find((m) => Array.isArray(m.content) && m.content[0]?.type === "tool_result");
  assert.deepEqual(results.content.map((r) => r.tool_use_id).sort(), called, "every call recorded is answered");
  assert.match(results.content.find((r) => r.tool_use_id === "tu9").content, /No such tool: web_search/);
});

await test("a thread left broken by a lost turn repairs itself", async () => {
  const agent = new MainAgent({
    llm: stubLlm([{ text: "NO_POST: nothing", toolCalls: [] }]),
    smallModel: "flash", subAgentModel: "pro",
    subAgentDeps: { strong: {}, webSearch: async () => [], webFetch: async () => ({}), makeMcpQuery: () => async () => ({}), capabilities: [], mcp: { servers: [] } },
    log: () => {}, debug: () => {},
  });
  // A turn that recorded its dispatch and then died before its results landed.
  agent.thread.push({ role: "assistant", content: [{ type: "tool_use", id: "tu1", name: "dispatch_subagent", input: {} }] });
  agent.thread.push({ role: "user", content: "TRANSCRIPT: [alex] anyone there?" });

  assert.equal(agent.repairThread(), 1, "one dangling call filled in");
  const stub = agent.thread[1];
  assert.equal(stub.content[0].type, "tool_result");
  assert.equal(stub.content[0].tool_use_id, "tu1");
  assert.equal(agent.thread[2].content, "TRANSCRIPT: [alex] anyone there?", "the transcript line is not lost");
  // Repair is idempotent, and runTurn does it before touching the model.
  assert.equal(agent.repairThread(), 0);
  // A partially answered turn is topped up rather than duplicated.
  agent.thread.push({ role: "assistant", content: [{ type: "tool_use", id: "a" }, { type: "tool_use", id: "b" }] });
  agent.thread.push({ role: "user", content: [{ type: "tool_result", tool_use_id: "a", content: "{}" }] });
  assert.equal(agent.repairThread(), 1);
  assert.deepEqual(agent.thread.at(-1).content.map((r) => r.tool_use_id), ["a", "b"]);
});

await test("the OpenAI adapter never sends an unanswered tool call", async () => {
  // Whatever a caller hands it, what goes on the wire is valid — this is the
  // guard that would have turned a dead kelabo into one placeholder line.
  const realFetch = globalThis.fetch;
  let body = null;
  globalThis.fetch = async (_url, init) => {
    body = JSON.parse(init.body);
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "ok" } }] }) };
  };
  try {
    const llm = createLlmProvider({ provider: "deepseek", model: "m" }, { apiKey: "k" });
    await llm.completeRaw({
      model: "m",
      messages: [
        { role: "user", content: "TRANSCRIPT: [alex] 中国历史上最后一个皇帝是谁" },
        { role: "assistant", content: [{ type: "tool_use", id: "tu1", name: "dispatch_subagent", input: {} }] },
        { role: "user", content: "TRANSCRIPT: [alex] 还在吗" },
      ],
    });
    const roles = body.messages.map((m) => m.role);
    const idx = roles.indexOf("assistant");
    assert.equal(roles[idx + 1], "tool", "the dangling call is answered before the next turn");
    assert.equal(body.messages[idx + 1].tool_call_id, "tu1");
  } finally {
    globalThis.fetch = realFetch;
  }
});

await test("the OpenAI adapter logs a malformed tool-call arguments string instead of silently defaulting to {}", async () => {
  // The other half of the same production bug: this failure was previously
  // indistinguishable after the fact from a model genuinely emitting no
  // arguments — both silently became input:{}. Now it leaves a trace.
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{
        message: {
          content: "",
          tool_calls: [{ id: "tu1", function: { name: "dispatch_subagent", arguments: '{"task_id": "t1", "objective": ' } }],
        },
      }],
    }),
  });
  const logged = [];
  try {
    const llm = createLlmProvider({ provider: "deepseek", model: "m" }, { apiKey: "k", log: (event, data) => logged.push({ event, data }) });
    const res = await llm.completeRaw({ model: "m", messages: [{ role: "user", content: "hi" }] });
    assert.deepEqual(res.toolCalls[0].input, {}, "still falls back to {} — behavior is unchanged, only the visibility is new");
    const entry = logged.find((l) => l.event === "llm_tool_args_parse_failed");
    assert.ok(entry, "the parse failure is logged, not swallowed");
    assert.equal(entry.data.tool, "dispatch_subagent");
    assert.ok(entry.data.rawArgs.includes('"task_id": "t1"'), "the actual malformed string is captured for diagnosis");
  } finally {
    globalThis.fetch = realFetch;
  }
});

await test("two captions in flight at once fire the gate only once", async () => {
  // The failure this reproduces: two captions 0.5s apart both passed the
  // 45-second cooldown check because neither had recorded a fire yet by the
  // time the other checked. Both turns then ran on one kelabo's thread.
  let release;
  const gate = new TriggerGate({
    llm: {
      async completeRaw() {
        await new Promise((r) => (release = r));
        return { text: JSON.stringify({ verdict: "INFO_GAP", confidence: 1, reason: "q", query: "q" }), toolCalls: [], raw: { content: [] } };
      },
    },
    smallModel: "flash",
    knobs: { cooldownSeconds: 45, maxContributionsPerMinute: 3, sensitivity: "medium" },
    log: () => {},
  });
  const a = gate.decide("m1", { speaker: "moon", text: "biggest building?", at: 1 }, transcript);
  const b = gate.decide("m1", { speaker: "moon", text: "last emperor?", at: 2 }, transcript);
  release();
  const [ra, rb] = await Promise.all([a, b]);
  const verdicts = [ra.verdict, rb.verdict].sort();
  assert.deepEqual(verdicts, ["INFO_GAP", "NONE"], "exactly one fires");
  assert.equal([ra, rb].find((r) => r.verdict === "NONE").reason, "classifier_busy");

  // And a second, later caption is held by the real cooldown.
  const after = await gate.decide("m1", { speaker: "moon", text: "and the weather?", at: 3 }, transcript);
  assert.equal(after.verdict, "NONE");
  assert.equal(after.reason, "cooldown_active");
});

await test("one kelabo's cooldown does not silence another kelabo", async () => {
  const gate = new TriggerGate({
    llm: {
      async completeRaw() {
        return { text: JSON.stringify({ verdict: "INFO_GAP", confidence: 1, reason: "q", query: "q" }), toolCalls: [], raw: { content: [] } };
      },
    },
    smallModel: "flash",
    knobs: { cooldownSeconds: 45, maxContributionsPerMinute: 3, sensitivity: "medium" },
    log: () => {},
  });
  const first = await gate.decide("m1", { speaker: "a", text: "q", at: 1 }, transcript);
  const other = await gate.decide("m2", { speaker: "b", text: "q", at: 2 }, transcript);
  const same = await gate.decide("m1", { speaker: "a", text: "q", at: 3 }, transcript);
  assert.equal(first.verdict, "INFO_GAP");
  assert.equal(other.verdict, "INFO_GAP", "a different kelabo has its own cooldown");
  assert.equal(same.verdict, "NONE");
});

// ---- language, and reading a noisy transcript -------------------------------

await test("languageName maps the SPA's tags, and refuses to guess", async () => {
  assert.equal(languageName("zh"), "Chinese");
  assert.equal(languageName("zh-TW"), "Traditional Chinese");
  assert.equal(languageName("ja"), "Japanese");
  assert.equal(languageName("en-GB"), "English");
  // "multi" and anything unknown mean there is no single language to enforce.
  assert.equal(languageName("multi"), null);
  assert.equal(languageName(""), null);
  assert.equal(languageName(undefined), null);
  assert.equal(languageName("xx"), null);
});

await test("the answer language is pinned by the brief, the research is not", async () => {
  const prompt = subAgentSystemPrompt({ capabilities: ["web"], mcpServers: [], language: "Chinese" });
  assert.match(prompt, /ANSWER LANGUAGE — HARD RULE: write `title` and `answer` in Chinese/);
  assert.match(prompt, /does NOT depend on the language of your sources/);
  assert.match(prompt, /SEARCH IN ANY LANGUAGE/, "tools are explicitly unconstrained");
  assert.match(prompt, /THE BRIEF CAME FROM SPEECH/, "worker knows its terms may be misheard");
  // With no language given it falls back to mirroring the brief.
  assert.match(subAgentSystemPrompt({}), /SAME language the brief is phrased in/);
});

await test("the orchestrator passes each requester's language to its worker", async () => {
  const mainLlm = stubLlm([
    {
      text: "",
      toolCalls: [
        { id: "tu1", name: "dispatch_subagent", input: { task_id: "t1", objective: "AAPL price", to: "alex", language: "Japanese" } },
        { id: "tu2", name: "dispatch_subagent", input: { task_id: "t2", objective: "Melbourne weather", to: "ann", language: "English" } },
      ],
    },
  ]);
  const systems = {};
  const strong = {
    async completeRaw({ system, messages }) {
      const brief = JSON.parse(String(messages[0].content).replace(/^BRIEF:\n/, ""));
      systems[brief.task_id] = system;
      return { text: JSON.stringify({ task_id: brief.task_id, status: "ok", title: "t", to: "all", answer: "a", confidence: 1, sources: [], gaps: "" }), toolCalls: [], raw: { content: [] } };
    },
  };
  const agent = new MainAgent({
    llm: mainLlm, smallModel: "flash", subAgentModel: "pro",
    subAgentDeps: { strong, webSearch: async () => [], webFetch: async () => ({}), makeMcpQuery: () => async () => ({}), capabilities: ["web"], mcp: { servers: [] } },
    log: () => {}, debug: () => {},
  });
  for await (const _ of agent.runTurn({ kelaboId: "m1", query: "two things", transcript })) void _;

  // Two people, two languages, one kelabo — each answered in their own.
  assert.match(systems.t1, /write `title` and `answer` in Japanese/);
  assert.match(systems.t2, /write `title` and `answer` in English/);
});

await test("the dispatch tool requires a language", async () => {
  // Without it in `required`, the model omits it and the worker falls back to
  // guessing from the brief — which is what let source language win.
  const captured = [];
  const llm = { async completeRaw(req) { captured.push(req); return { text: "NO_POST: x", toolCalls: [], raw: { content: [] } }; } };
  const agent = new MainAgent({
    llm, smallModel: "flash", subAgentModel: "pro",
    subAgentDeps: { strong: {}, webSearch: async () => [], webFetch: async () => ({}), makeMcpQuery: () => async () => ({}), capabilities: [], mcp: { servers: [] } },
    log: () => {}, debug: () => {},
  });
  for await (const _ of agent.runTurn({ kelaboId: "m1", query: "q", transcript })) void _;
  const tool = captured[0].tools.find((t) => t.name === "dispatch_subagent");
  assert.ok(tool.input_schema.required.includes("language"), "language is required");
  assert.match(tool.input_schema.properties.language.description, /English language name/);
});

await test("minutes are written in the host's language, whatever the room spoke", async () => {
  const host = summarySystemPrompt({ hostLanguage: "Chinese" });
  assert.match(host, /write EVERY string value in Chinese/);
  assert.match(host, /does NOT depend on which language the kelabo was conducted in/);
  // Unknown host language → the kelabo's own language, as before.
  const unknown = summarySystemPrompt({});
  assert.match(unknown, /DOMINANT language of the transcript/);
  // And the agent hands its host language through to that prompt.
  let system = "";
  const agent = new MainAgent({
    llm: { async complete(req) { system = req.system; return "{}"; } },
    smallModel: "flash", subAgentModel: "pro", hostLanguage: "Japanese",
    subAgentDeps: { strong: {}, webSearch: async () => [], webFetch: async () => ({}), makeMcpQuery: () => async () => ({}), capabilities: [], mcp: { servers: [] } },
    log: () => {}, debug: () => {},
  });
  await agent.summarize({ kelaboId: "m1", transcript });
  assert.match(system, /write EVERY string value in Japanese/);
});

await test("gate and orchestrator both know the transcript is misheard speech", async () => {
  let gateSystem = "";
  const gate = new TriggerGate({
    llm: {
      async completeRaw(req) {
        gateSystem = req.system;
        return { text: JSON.stringify({ verdict: "NONE", confidence: 1, reason: "x" }), toolCalls: [], raw: { content: [] } };
      },
    },
    smallModel: "flash",
    knobs: { cooldownSeconds: 0, maxContributionsPerMinute: 9 },
    log: () => {},
  });
  await gate.decide("m1", { speaker: "alex", text: "hi", at: Date.now() }, transcript);

  for (const [what, prompt] of [["gate", gateSystem], ["orchestrator", mainAgentSystemPrompt({})]]) {
    assert.match(prompt, /MACHINE TRANSCRIPTION, NOT A VERBATIM RECORD/, `${what} is told the transcript is noisy`);
    // Addressed by a name speech-to-text cannot spell.
    assert.match(prompt, /klabo/, `${what} knows the mangled spellings`);
    assert.match(prompt, /book club/, `${what} is told not to fire on ordinary uses`);
  }
  assert.match(gateSystem, /Kelabo/, "the gate knows the assistant's actual name");
});

console.log(`\n${passed} agent tests passed${process.exitCode ? " (with failures)" : ""}`);
