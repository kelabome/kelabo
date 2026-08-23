const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

// Dump the exact request/response bodies exchanged with the provider. Gated
// behind KELABO_LLM_WIRE_LOG=1 because raw prompts are large and may contain
// kelabo content — opt-in only. Logs go through the same structured logger as
// everything else (JSON to stdout → CloudWatch).
const WIRE_LOG = process.env.KELABO_LLM_WIRE_LOG === "1";
let wireSeq = 0;

function makeWireLogger(provider, log) {
  if (!WIRE_LOG || typeof log !== "function") return null;
  return {
    request(url, body, req) {
      const id = ++wireSeq;
      log("llm_wire_request", {
        wireId: id,
        provider,
        url,
        model: body.model,
        // The EXACT JSON payload posted to the provider, verbatim.
        payload: JSON.stringify(body),
      });
      return { id, startedAt: Date.now() };
    },
    response(ctx, status, raw) {
      log("llm_wire_response", {
        wireId: ctx?.id,
        provider,
        status,
        latencyMs: ctx ? Date.now() - ctx.startedAt : undefined,
        // The EXACT response body received from the provider, verbatim.
        body: typeof raw === "string" ? raw : JSON.stringify(raw),
      });
    },
    error(ctx, err) {
      log("llm_wire_error", {
        wireId: ctx?.id,
        provider,
        latencyMs: ctx ? Date.now() - ctx.startedAt : undefined,
        error: err?.message ?? String(err),
      });
    },
  };
}

/**
 * Normalize provider token accounting into one shape.
 *
 *   cacheRead  - prompt tokens served from the provider's prompt cache (cheap)
 *   cacheWrite - prompt tokens written INTO the cache this call (Anthropic only)
 *   input      - prompt tokens actually billed at full rate
 *   output     - generated tokens
 *
 * Providers disagree on whether `prompt_tokens` already includes the cached
 * portion — Anthropic reports them as separate buckets, OpenAI/DeepSeek report a
 * total plus a "of which cached" breakdown. Both are folded into the same
 * non-overlapping buckets here so totals can simply be summed.
 *
 * @returns {{cacheRead:number,cacheWrite:number,input:number,output:number,total:number}|null}
 */
export function normalizeUsage(raw) {
  if (!raw || typeof raw !== "object") return null;
  const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

  // Anthropic: input_tokens EXCLUDES the cached buckets.
  if (raw.input_tokens !== undefined || raw.cache_read_input_tokens !== undefined) {
    const cacheRead = n(raw.cache_read_input_tokens);
    const cacheWrite = n(raw.cache_creation_input_tokens);
    const input = n(raw.input_tokens);
    const output = n(raw.output_tokens);
    return { cacheRead, cacheWrite, input, output, total: cacheRead + cacheWrite + input + output };
  }

  // OpenAI-compatible: prompt_tokens INCLUDES the cached portion, so subtract it
  // to keep the buckets disjoint. DeepSeek exposes prompt_cache_hit_tokens;
  // OpenAI nests it under prompt_tokens_details.cached_tokens.
  if (raw.prompt_tokens !== undefined || raw.completion_tokens !== undefined) {
    const prompt = n(raw.prompt_tokens);
    const cacheRead = n(raw.prompt_cache_hit_tokens ?? raw.prompt_tokens_details?.cached_tokens);
    const output = n(raw.completion_tokens);
    const input = Math.max(0, prompt - cacheRead);
    return { cacheRead, cacheWrite: 0, input, output, total: prompt + output };
  }
  return null;
}

/** Sum any number of usage records; returns null when there is nothing to add. */
export function addUsage(...records) {
  const present = records.filter(Boolean);
  if (!present.length) return null;
  return present.reduce(
    (acc, u) => ({
      cacheRead: acc.cacheRead + (u.cacheRead || 0),
      cacheWrite: acc.cacheWrite + (u.cacheWrite || 0),
      input: acc.input + (u.input || 0),
      output: acc.output + (u.output || 0),
      total: acc.total + (u.total || 0),
    }),
    { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 }
  );
}

export function createLlmProvider(modelConfig, { apiKey, openaiBaseUrl, log } = {}) {
  switch (modelConfig.provider) {
    case "anthropic":
      return anthropicProvider(modelConfig, apiKey, log);
    case "fake":
      return fakeProvider();
    default:
      return openAiCompatibleProvider(modelConfig, apiKey, openaiBaseUrl, log);
  }
}

function anthropicProvider(modelConfig, apiKey, log) {
  const wire = makeWireLogger("anthropic", log);
  async function call(req) {
    const body = {
      model: req.model ?? modelConfig.model,
      max_tokens: req.maxTokens ?? 2048,
      // Explicit cache breakpoint on the (static) system prompt; the
      // transcript messages only change at the tail, so their shared
      // prefix hits the prompt cache automatically.
      system: req.system ? [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }] : undefined,
      messages: req.messages,
      ...(req.tools?.length ? { tools: req.tools } : {}),
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
    };
    const wireCtx = wire?.request(ANTHROPIC_URL, body, req);
    let res;
    try {
      res = await fetch(ANTHROPIC_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey ?? "",
          "anthropic-version": ANTHROPIC_VERSION,
        },
        body: JSON.stringify(body),
        signal: req.signal,
      });
    } catch (err) {
      wire?.error(wireCtx, err);
      throw err;
    }
    if (!res.ok) {
      const errText = (await res.text()).slice(0, 300);
      wire?.response(wireCtx, res.status, errText);
      throw new Error(`anthropic ${res.status}: ${errText}`);
    }
    const data = await res.json();
    wire?.response(wireCtx, res.status, data);
    const text = (data.content ?? [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("");
    const toolCalls = (data.content ?? [])
      .filter((b) => b.type === "tool_use")
      .map((b) => ({ id: b.id, name: b.name, input: b.input }));
    return { text, toolCalls, raw: data, usage: normalizeUsage(data.usage) };
  }
  return {
    async complete(req) {
      return (await call(req)).text;
    },
    async completeRaw(req) {
      return call(req);
    },
    async *stream(req) {
      yield await this.complete(req);
    },
  };
}

/**
 * Last line of defence for the OpenAI tool-call contract.
 *
 * "An assistant message with 'tool_calls' must be followed by tool messages
 * responding to each 'tool_call_id'" is a 400, not a warning, and in a
 * persistent thread it is fatal rather than transient — the same malformed
 * prefix is resent on every subsequent turn, so the assistant stops answering
 * for the rest of the kelabo. Callers are responsible for answering their tool
 * calls; this guarantees the wire format even when one does not, because a
 * missing answer is worth a placeholder and never worth a dead kelabo.
 */
function answerDanglingToolCalls(messages) {
  const out = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    out.push(m);
    if (m.role !== "assistant" || !m.tool_calls?.length) continue;
    // Emit the tool block that follows this turn as-is, then fill in whichever
    // ids it left unanswered.
    const answered = new Set();
    while (i + 1 < messages.length && messages[i + 1].role === "tool") {
      i++;
      answered.add(messages[i].tool_call_id);
      out.push(messages[i]);
    }
    for (const tc of m.tool_calls) {
      if (answered.has(tc.id)) continue;
      out.push({
        role: "tool",
        tool_call_id: tc.id,
        content: JSON.stringify({ status: "error", answer: "No result was recorded for this call." }),
      });
    }
  }
  return out;
}

function toOpenAiMessages(messages) {
  const out = [];
  for (const m of messages ?? []) {
    if (typeof m.content === "string") {
      out.push({ role: m.role, content: m.content });
      continue;
    }
    const blocks = Array.isArray(m.content) ? m.content : [];
    if (m.role === "assistant") {
      const text = blocks.filter((b) => b.type === "text").map((b) => b.text).join("");
      const toolCalls = blocks
        .filter((b) => b.type === "tool_use")
        .map((b) => ({ id: b.id, type: "function", function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } }));
      out.push({ role: "assistant", content: text || null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) });
      continue;
    }
    const toolResults = blocks.filter((b) => b.type === "tool_result");
    if (toolResults.length) {
      for (const tr of toolResults) {
        out.push({ role: "tool", tool_call_id: tr.tool_use_id, content: typeof tr.content === "string" ? tr.content : JSON.stringify(tr.content) });
      }
      const rest = blocks.filter((b) => b.type === "text").map((b) => b.text).join("");
      if (rest) out.push({ role: "user", content: rest });
      continue;
    }
    out.push({ role: m.role, content: blocks.map((b) => b.text ?? "").join("") });
  }
  return out;
}

function toOpenAiTools(tools) {
  return (tools ?? []).map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.input_schema },
  }));
}

function openAiCompatibleProvider(modelConfig, apiKey, baseUrl, log) {
  const base = (baseUrl || "https://api.openai.com/v1").replace(/\/$/, "");
  const url = `${base}/chat/completions`;
  const wire = makeWireLogger("openai-compatible", log);
  async function call(req) {
    const messages = [];
    if (req.system) messages.push({ role: "system", content: req.system });
    messages.push(...answerDanglingToolCalls(toOpenAiMessages(req.messages)));
    const body = {
      model: req.model ?? modelConfig.model,
      messages,
      ...(req.maxTokens ? { max_tokens: req.maxTokens } : {}),
      ...(req.tools?.length ? { tools: toOpenAiTools(req.tools), tool_choice: "auto" } : {}),
    };
    const wireCtx = wire?.request(url, body, req);
    let res;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify(body),
        signal: req.signal,
      });
    } catch (err) {
      wire?.error(wireCtx, err);
      throw err;
    }
    if (!res.ok) {
      const errText = (await res.text()).slice(0, 300);
      wire?.response(wireCtx, res.status, errText);
      throw new Error(`openai-compatible ${res.status}: ${errText}`);
    }
    const data = await res.json();
    wire?.response(wireCtx, res.status, data);
    const msg = data.choices?.[0]?.message ?? {};
    const toolCalls = (msg.tool_calls ?? []).map((tc) => {
      let input = {};
      const rawArgs = tc.function?.arguments || "{}";
      try {
        input = JSON.parse(rawArgs);
      } catch (err) {
        // Previously silent: a malformed/truncated arguments string (a
        // reasoning model cut off mid-JSON by max_tokens is the known
        // culprit, per the fallback comment below) fell back to `{}` with
        // no trace anywhere — indistinguishable after the fact from the
        // model genuinely emitting no arguments at all. Logged with the
        // raw string so a truncation bug is diagnosable, not just visible
        // as a downstream "empty brief" failure several calls later.
        log?.("llm_tool_args_parse_failed", {
          provider: "openai-compatible",
          tool: tc.function?.name,
          rawArgsLength: rawArgs.length,
          rawArgs: rawArgs.slice(0, 500),
          error: err.message,
        });
      }
      return { id: tc.id, name: tc.function?.name, input };
    });
    // Reasoning models (e.g. deepseek-v4-*) may put the answer in reasoning_content
    // and leave content empty when max_tokens is exhausted mid-reasoning; fall back to it.
    const answer = (msg.content && msg.content.length ? msg.content : msg.reasoning_content) ?? "";
    const content = [{ type: "text", text: answer }, ...toolCalls.map((tc) => ({ type: "tool_use", id: tc.id, name: tc.name, input: tc.input }))];
    return { text: answer, toolCalls, raw: { content }, usage: normalizeUsage(data.usage) };
  }
  return {
    async complete(req) {
      return (await call(req)).text;
    },
    async completeRaw(req) {
      return call(req);
    },
    async *stream(req) {
      yield await this.complete(req);
    },
  };
}

function fakeProvider() {
  async function respond(req) {
    const last = req.messages?.[req.messages.length - 1];
    const content = typeof last?.content === "string" ? last.content : JSON.stringify(last?.content ?? "");
    if (req.system?.includes("TRIGGER GATE")) {
      return { text: JSON.stringify({ verdict: "NONE", confidence: 1, reason: "fake provider" }), toolCalls: [] };
    }
    if (content.includes(":KELABO-END")) {
      return {
        text: JSON.stringify({
          topics: ["fake topic"],
          decisions: [],
          actionItems: [],
          openQuestions: [],
          findings: ["fake summary"],
        }),
        toolCalls: [],
      };
    }
    return { text: "No contribution needed.", toolCalls: [] };
  }
  return {
    async complete(req) {
      return (await respond(req)).text;
    },
    async completeRaw(req) {
      return respond(req);
    },
    async *stream(req) {
      yield await this.complete(req);
    },
  };
}
