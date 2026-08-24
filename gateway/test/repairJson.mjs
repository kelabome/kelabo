// Minutes that arrive cut in half.
//
// The sample at the bottom is the real reply from kelabo
// e2b4b9c1-b62b-411f-9732-8fbe08b56878, shortened but truncated in exactly the
// same place: mid-sentence, inside the last finding's `text`. Before this, that
// kelabo's record showed a wall of escaped JSON instead of its minutes, and the
// title, summary, four topics, an action item and two open questions the model
// had written perfectly were all discarded with it.
import assert from "node:assert/strict";
import { repairTruncatedJson } from "../src/agent/repairJson.js";
import { parseMinutesJson } from "../src/agent/serverAgentRunner.js";

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
  } catch (err) {
    console.error(`FAIL ${name}`);
    throw err;
  }
}

test("valid JSON is returned untouched", () => {
  const src = '{"a":1,"b":[1,2],"c":{"d":"x"}}';
  assert.equal(repairTruncatedJson(src), src);
});

test("an unterminated string is dropped, not closed", () => {
  // Closing it would attribute a sentence ending to someone who never wrote
  // one. These are meeting minutes; a half-quote is worse than no quote.
  const out = repairTruncatedJson('{"title":"done","summary":"the model stopped here');
  assert.deepEqual(JSON.parse(out), { title: "done" });
});

test("a dangling key with no value is dropped with its key", () => {
  const out = repairTruncatedJson('{"title":"done","summary":');
  assert.deepEqual(JSON.parse(out), { title: "done" });
});

test("open arrays and objects are closed, innermost first", () => {
  const out = repairTruncatedJson('{"topics":[{"title":"one","detail":"a"},{"title":"two"');
  assert.deepEqual(JSON.parse(out), { topics: [{ title: "one", detail: "a" }, { title: "two" }] });
});

test("a trailing comma left by the cut is removed", () => {
  const out = repairTruncatedJson('{"openQuestions":["a","b"],');
  assert.deepEqual(JSON.parse(out), { openQuestions: ["a", "b"] });
});

test("escaped quotes inside a string do not look like the end of it", () => {
  const out = repairTruncatedJson('{"text":"he said \\"no\\" and then');
  assert.deepEqual(JSON.parse(out), {});
});

test("text that is not JSON at all is not invented into some", () => {
  assert.equal(repairTruncatedJson("I could not summarise this kelabo."), null);
  assert.equal(repairTruncatedJson(""), null);
  assert.equal(repairTruncatedJson(null), null);
});

// --- through the real parser -------------------------------------------------

const TRUNCATED = `{
  "title": "系统测试与周朝历史核查",
  "summary": "本次 kelabo 先围绕一段 quote 的时长与 charging 是否正确展开。",
  "topics": [
    { "title": "quote/charging 校验", "detail": "检查范围不限于 air M。", "speakers": ["Super"] },
    { "title": "用历史问题测试系统", "detail": "拿一个问题给系统做测试。", "speakers": ["Super"] }
  ],
  "decisions": [],
  "actionItems": [
    { "text": "用最长的朝代作为测试问题跑一遍。", "owner": "Super", "due": "" }
  ],
  "openQuestions": [
    "武王伐纣年份有多种说法，以哪个结论为准？"
  ],
  "findings": [
    {
      "text": "中国历史上持续时间最长的朝代是周朝：约公元前1046年—公元前256年，历时约790年；依据以夏商周断代工程定武王伐纣`;

test("a truncated reply keeps everything the model did finish", () => {
  const minutes = parseMinutesJson(TRUNCATED, "k1", "server");
  assert.ok(minutes, "minutes are recovered rather than thrown away");
  assert.equal(minutes.title, "系统测试与周朝历史核查");
  assert.match(minutes.summary, /charging/);
  assert.equal(minutes.topics.length, 2);
  assert.equal(minutes.topics[1].title, "用历史问题测试系统");
  assert.equal(minutes.actionItems.length, 1);
  assert.equal(minutes.actionItems[0].owner, "Super");
  // The sections *after* the last complete `}` survive too. Matching `{` to the
  // last `}` would have stopped at the action item and silently lost these.
  assert.equal(minutes.openQuestions.length, 1);
  // The finding that was cut mid-sentence is dropped rather than half-quoted.
  assert.equal(minutes.findings.length, 0);
});

test("a reply the model finished, with prose after it, still parses whole", () => {
  const minutes = parseMinutesJson(
    'Here are the minutes:\n```json\n{"title":"t","summary":"s","topics":[],"findings":[]}\n```\nHope that helps.',
    "k1",
    "server"
  );
  assert.equal(minutes.title, "t");
  assert.equal(minutes.summary, "s");
});

test("a reply with no JSON in it produces no minutes, not a JSON-shaped dump", () => {
  // The old fallback returned an object whose only content was the raw reply,
  // so the record claimed to have minutes and rendered escaped JSON.
  assert.equal(parseMinutesJson("I am not able to summarise this.", "k1", "server"), null);
  assert.equal(parseMinutesJson("", "k1", "server"), null);
});

console.log(`gateway/repairJson: ${passed} passed`);
