// Whose text is the answer, when a reasoning model runs out of budget.
//
// This is the failure of kelabo c0d15552-67fb-48fb-b490-b7cf8bb14b57 ("DORA"),
// 23 minutes and 83 utterances, and the first real-length kelabo the minutes
// path had ever been asked to summarise. deepseek-v4-flash spent its whole 8192
// output tokens reasoning, returned empty `content`, and the provider fell back
// to `reasoning_content` — 32,948 characters of prose handed to a parser that
// wanted a JSON document. The record showed no minutes and blamed the
// deployment.
//
// The fallback is right for a prose caller and wrong for a JSON one, and no
// amount of parser cleverness fixes it downstream: reasoning is not a truncated
// JSON document, it is a different kind of text. So the provider is the place
// that has to know, and this pins it — with a stubbed fetch, because the whole
// point is a shape of reply no offline test would otherwise ever see.
import assert from "node:assert/strict";
import { createLlmProvider } from "../src/agent/llm.js";

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
  } catch (err) {
    console.error(`FAIL ${name}`);
    throw err;
  }
}

// One chat-completions reply, as the wire delivers it.
function stubFetch(message, { finishReason = "stop" } = {}) {
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message, finish_reason: finishReason }], usage: {} }),
  });
  return () => {
    globalThis.fetch = original;
  };
}

const provider = () => createLlmProvider({ provider: "deepseek", model: "deepseek-v4-flash" }, { apiKey: "k" });

await test("content wins whenever there is any", async () => {
  const restore = stubFetch({ content: '{"title":"real"}', reasoning_content: "thinking out loud" });
  try {
    const res = await provider().completeRaw({ messages: [], responseFormat: "json" });
    assert.equal(res.text, '{"title":"real"}');
  } finally {
    restore();
  }
});

await test("a prose caller still gets the reasoning when content is empty", async () => {
  // Unchanged on purpose: for a caller that wanted prose, the chain of thought
  // is at least about the right subject, and losing it gains nothing.
  const restore = stubFetch({ content: "", reasoning_content: "Let me think about the retry logic." });
  try {
    const res = await provider().completeRaw({ messages: [] });
    assert.equal(res.text, "Let me think about the retry logic.");
  } finally {
    restore();
  }
});

await test("a JSON caller gets nothing rather than reasoning — the DORA failure", async () => {
  // The exact shape that lost a record its minutes: budget gone, no content,
  // and a wall of reasoning the parser can only fail on. An empty string fails
  // too — but it fails honestly, and it fails as "the model wrote no answer"
  // rather than as "the model wrote something unreadable".
  const restore = stubFetch(
    { content: "", reasoning_content: "Okay, so the participants discussed DORA metrics. ".repeat(600) },
    { finishReason: "length" }
  );
  try {
    const res = await provider().completeRaw({ messages: [], responseFormat: "json", maxTokens: 16384 });
    assert.equal(res.text, "");
    assert.equal(res.truncated, true);
  } finally {
    restore();
  }
});

await test("missing content and missing reasoning is the empty string, never undefined", async () => {
  // `parseMinutesJson` guards on falsiness; `undefined` would reach the logs as
  // "chars: 0" via a different route and read as a different bug.
  const restore = stubFetch({});
  try {
    const res = await provider().completeRaw({ messages: [] });
    assert.equal(res.text, "");
  } finally {
    restore();
  }
});

console.log(`gateway/minutesAnswer: ${passed} passed`);
