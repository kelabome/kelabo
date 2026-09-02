// A scripted, offline, OpenAI-COMPATIBLE endpoint.
//
// WHY AN HTTP SERVER AND NOT AN INJECTED PROVIDER. The agent runs in a worker
// thread that builds its own provider from `modelConfig`
// (gateway/src/agent/worker.js:95) — there is no `overrides.llm` reaching it,
// and adding one would be a seam that exists for nothing but this suite. There
// already IS a seam: `openaiBaseUrl`. Pointing it here scripts the agent
// end-to-end while exercising the real provider client — its request shaping,
// its tool-call parsing, its streaming reassembly — which an injected object
// would skip entirely, and which is where provider bugs actually live.
//
// The decisions come from `gateway/test/scriptedProvider.mjs`, unchanged, so
// the e2e agent behaves exactly as `node test/devAgent.mjs --provider scripted`
// does.

import http from "node:http";
import { respond } from "../../gateway/test/scriptedProvider.mjs";

/** OpenAI wire -> the `{ system, messages }` shape `respond` expects. */
function toProviderRequest(body) {
  const messages = body.messages ?? [];
  return {
    system: messages
      .filter((m) => m.role === "system")
      .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
      .join("\n"),
    messages: messages.filter((m) => m.role !== "system"),
    model: body.model,
    tools: body.tools,
  };
}

/** `respond`'s `{ text, toolCalls }` -> an OpenAI chat completion. */
function toCompletion(result, model) {
  const toolCalls = (result.toolCalls ?? []).map((tc) => ({
    id: tc.id,
    type: "function",
    function: { name: tc.name, arguments: JSON.stringify(tc.input ?? {}) },
  }));
  return {
    id: `chatcmpl-e2e-${Math.random().toString(36).slice(2, 10)}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: result.text ?? "",
          ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: toolCalls.length ? "tool_calls" : "stop",
      },
    ],
    usage: { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 },
  };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      try {
        resolve(JSON.parse(raw || "{}"));
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

export function createLlmServer() {
  /** Every request served, so a test can assert the agent was actually asked. */
  const calls = [];

  const server = http.createServer(async (req, res) => {
    if (!req.url.endsWith("/chat/completions")) {
      res.writeHead(404, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: "not_found" }));
    }
    let body;
    try {
      body = await readBody(req);
    } catch {
      res.writeHead(400, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: "bad_json" }));
    }
    const providerReq = toProviderRequest(body);
    const result = respond(providerReq);
    calls.push({ system: providerReq.system, model: body.model, stream: !!body.stream });
    const completion = toCompletion(result, body.model);

    if (!body.stream) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify(completion));
    }

    // Streamed, because MainAgent passes `onDelta` and the provider then sets
    // `stream: true`. Answered as one content chunk plus the usage chunk the
    // client asks for with `stream_options` — enough for the reassembly path
    // to be real without simulating token-by-token generation.
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    const msg = completion.choices[0].message;
    const chunk = (delta, finish = null) =>
      `data: ${JSON.stringify({
        id: completion.id,
        object: "chat.completion.chunk",
        model: completion.model,
        choices: [{ index: 0, delta, finish_reason: finish }],
      })}\n\n`;
    res.write(chunk({ role: "assistant" }));
    if (msg.content) res.write(chunk({ content: msg.content }));
    if (msg.tool_calls) {
      res.write(
        chunk({
          tool_calls: msg.tool_calls.map((tc, index) => ({
            index,
            id: tc.id,
            type: "function",
            function: tc.function,
          })),
        })
      );
    }
    res.write(chunk({}, completion.choices[0].finish_reason));
    res.write(`data: ${JSON.stringify({ ...completion, object: "chat.completion.chunk", choices: [] })}\n\n`);
    res.write("data: [DONE]\n\n");
    res.end();
  });

  return { server, calls };
}
