// A deterministic, fully-offline LLM provider for the dev harness.
//
// Unlike the built-in "fake" provider (which always returns NONE at the gate so
// no turn ever runs), this provider inspects each request and returns responses
// that DRIVE a full orchestration turn: the gate fires on question-like lines,
// the main agent dispatches a sub-agent, and the sub-agent returns a board-ready
// JSON result. It emits the exact { text, toolCalls, raw:{content} } shape the
// real providers do, so the whole MainAgent/SubAgent code path is exercised —
// grouping, tool_result nesting, board posts and all — with no API key.

let taskSeq = 0;

function lastUserText(messages) {
  const last = [...(messages ?? [])].reverse().find((m) => m.role === "user");
  if (!last) return "";
  return typeof last.content === "string" ? last.content : JSON.stringify(last.content);
}

function isQuestion(text) {
  // English + common CJK question markers (？ 吗 呢 请问 是多少 …) so the offline
  // demo exercises multilingual language-matching too.
  return /[?？]|吗|呢|请问|多少|什么|怎么|哪|does anyone know|what(?:'s| is| are)|how (?:do|does)|current|latest|version|price|weather|when|where|who/i.test(text);
}

/**
 * Exported so `e2e/harness/llmServer.mjs` can serve the same decisions over an
 * OpenAI-compatible HTTP endpoint. The e2e run must not fork this logic: the
 * agent worker builds its own provider from `modelConfig` inside a worker
 * thread, so the only way to script it without an injection hole in production
 * code is to be the endpoint it calls — and a second copy of the script would
 * drift from the one `devAgent.mjs` uses.
 */
export function respond(req) {
  const system = req.system || "";
  const lastUser = lastUserText(req.messages);

  // ---- GATE (small model, TRIGGER GATE system prompt) --------------------
  if (system.includes("TRIGGER GATE")) {
    const lines = lastUser.split("\n").filter(Boolean);
    const lastLine = lines[lines.length - 1] || "";
    if (isQuestion(lastLine)) {
      const query = lastLine.replace(/^\[[^\]]*\]\s*/, "").replace(/\?+$/, "").trim().slice(0, 120);
      return { text: JSON.stringify({ verdict: "INFO_GAP", confidence: 0.9, reason: "info need detected", query }), toolCalls: [] };
    }
    return { text: JSON.stringify({ verdict: "NONE", confidence: 0.9, reason: "no info need" }), toolCalls: [] };
  }

  // ---- MINUTES (summary system prompt) -----------------------------------
  // Matched on the prompt's opening line; the old marker ("end-of-kelabo
  // minutes") was a phrase the persona no longer contains, so the harness fell
  // through to the default reply and printed `null` minutes.
  if (system.includes("writing the minutes of the kelabo")) {
    return {
      text: JSON.stringify({
        title: "Planning sync",
        topics: ["planning", "logistics"],
        decisions: [],
        actionItems: [{ text: "Pin Node.js LTS in CI", owner: "Alice" }],
        openQuestions: [],
        findings: ["Resolved live lookups via sub-agents during the kelabo."],
      }),
      toolCalls: [],
    };
  }

  // ---- SUB-AGENT (research worker system prompt) -------------------------
  if (system.includes("RESEARCH WORKER")) {
    let brief = {};
    try {
      brief = JSON.parse(String(lastUser).replace(/^BRIEF:\n/, ""));
    } catch {}
    // Conclude immediately with a board-ready result (no tool loop) so the demo
    // stays deterministic and offline.
    return {
      text: JSON.stringify({
        task_id: brief.task_id,
        status: "ok",
        title: (brief.objective || "Research").slice(0, 60),
        to: brief.to || "all",
        answer: `**Answer:** ${brief.objective || "result"} — (scripted offline result).`,
        confidence: 0.8,
        sources: [{ title: "example.com", url: "https://example.com/scripted" }],
        gaps: "",
      }),
      toolCalls: [],
    };
  }

  // ---- MAIN AGENT (orchestrator) -----------------------------------------
  // Triggered turns arrive as a TRIGGER: <query> user message. Dispatch one
  // sub-agent for it. If there's no trigger, stay silent.
  const triggerMatch = /TRIGGER:\s*(.+)$/m.exec(lastUser);
  if (triggerMatch) {
    const objective = triggerMatch[1].trim();
    const taskId = `t${++taskSeq}`;
    const toolCalls = [
      { id: `tu_${taskId}`, name: "dispatch_subagent", input: { task_id: taskId, kind: "web", objective, context: "from kelabo", expected: "concise answer", to: "all" } },
    ];
    return { text: "", toolCalls };
  }
  return { text: "NO_POST: nothing actionable", toolCalls: [] };
}

let callCount = 0;

// Build the { text, toolCalls, raw:{content} } envelope the agents expect.
function envelope(r) {
  callCount++;
  const toolCalls = r.toolCalls ?? [];
  const content = [
    ...(r.text ? [{ type: "text", text: r.text }] : []),
    ...toolCalls.map((tc) => ({ type: "tool_use", id: tc.id, name: tc.name, input: tc.input })),
  ];
  const result = { text: r.text ?? "", toolCalls, raw: { content } };
  // Fake usage so the debug panel shows tokens even offline. Each call gets a
  // deterministic amount: 100 + call*50 input, 20 + call*10 output tokens so
  // the tokens-per-call growth is visible in the TurnGroup.
  result.usage = {
    input_tokens: 100 + callCount * 50,
    output_tokens: 20 + callCount * 10,
  };
  return result;
}

export function makeScriptedProvider() {
  return {
    async complete(req) {
      return respond(req).text;
    },
    async completeRaw(req) {
      return envelope(respond(req));
    },
    async *stream(req) {
      yield respond(req).text;
    },
  };
}
