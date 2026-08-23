// Kelabo Agent Protocol frame round-trips (docs 16 §2.A).
//
// The frames are the seam between the Gateway and code that does not live in
// this repo, so the things worth asserting are the ones a second implementation
// would get wrong: which fields are required, what the defaults are, and that a
// frame naming an unknown type is rejected rather than half-parsed.
import assert from "node:assert/strict";
import {
  parseUpFrame,
  parseDownFrame,
  upFrameSchema,
  downFrameSchema,
} from "../src/frames.js";

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

const up = (obj) => parseUpFrame(JSON.stringify(obj));
const down = (obj) => parseDownFrame(JSON.stringify(obj));

// --- envelope ---------------------------------------------------------------

test("non-JSON is invalid_json, not a crash", () => {
  const r = parseUpFrame("{not json");
  assert.equal(r.ok, false);
  assert.equal(r.error, "invalid_json");
});

test("unknown type is rejected", () => {
  assert.equal(up({ type: "caption_reply", kelaboId: "m", text: "x" }).ok, false);
  assert.equal(down({ type: "caption", speaker: "A", text: "x", at: 1 }).ok, false);
});

test("a down frame is not accepted as an up frame", () => {
  assert.equal(up({ type: "ping" }).ok, false);
});

// --- register ---------------------------------------------------------------

test("register requires a token and agent info", () => {
  assert.equal(up({ type: "register", token: "" , agent: { runtime: "opencode" } }).ok, false);
  assert.equal(up({ type: "register", token: "t" }).ok, false);
  const r = up({ type: "register", token: "t", agent: { runtime: "opencode" } });
  assert.equal(r.ok, true);
  assert.equal(r.frame.agent.version, "");
  assert.equal(r.frame.agent.label, "");
});

// --- attach -----------------------------------------------------------------

test("attach accepts an empty sessionRef", () => {
  // A Claude Code channel pushes into "the session that spawned me" and has no
  // id to give. The previous protocol required a non-empty opencodeSessionId,
  // opencodeProjectId and opencodeDirectory, so such a frame was silently
  // dropped as a bad frame.
  const r = up({ type: "attach", kelaboId: "m1", runtime: "claude-code" });
  assert.equal(r.ok, true);
  assert.equal(r.frame.sessionRef, "");
  assert.equal(r.frame.workspace, "");
});

test("attach requires a kelabo", () => {
  assert.equal(up({ type: "attach", kelaboId: "", runtime: "opencode" }).ok, false);
  assert.equal(up({ type: "attach", runtime: "opencode" }).ok, false);
});

// --- contribution -----------------------------------------------------------

test("contribution defaults to/title/kind, and to a finished card", () => {
  const r = up({ type: "contribution", kelaboId: "m1", markdown: "hello" });
  assert.equal(r.ok, true);
  assert.equal(r.frame.to, "all");
  assert.equal(r.frame.title, "");
  assert.equal(r.frame.kind, "answer");
  // No `status` on the wire means an ordinary post, so an agent written against
  // the older tool surface keeps working.
  assert.equal(r.frame.status, "done");
  assert.equal(r.frame.card, undefined);
});

test("contribution rejects unknown kinds and statuses", () => {
  assert.equal(up({ type: "contribution", kelaboId: "m1", markdown: "x", kind: "minutes" }).ok, false);
  assert.equal(up({ type: "contribution", kelaboId: "m1", markdown: "x", status: "pending" }).ok, false);
});

test("a working card is allowed to have no body yet", () => {
  // This is why `markdown` is no longer `.min(1)`. The rule it used to carry —
  // a *finished* card must say something — is enforced at the Gateway instead,
  // because a discriminated-union member cannot express a cross-field rule.
  const r = up({ type: "contribution", kelaboId: "m1", status: "working", title: "Retry policy" });
  assert.equal(r.ok, true);
  assert.equal(r.frame.markdown, "");
  assert.equal(r.frame.status, "working");
});

test("a card reference, progress and steps survive the wire", () => {
  const r = up({
    type: "contribution",
    kelaboId: "m1",
    card: "c1a2b3",
    status: "working",
    title: "Retry policy",
    progress: "Reading gateway/src",
    steps: ["Searching the repo", "Reading gateway/src"],
  });
  assert.equal(r.ok, true);
  assert.equal(r.frame.card, "c1a2b3");
  assert.equal(r.frame.progress, "Reading gateway/src");
  assert.deepEqual(r.frame.steps, ["Searching the repo", "Reading gateway/src"]);
});

test("a skipped card carries the reason it is not coming", () => {
  const r = up({ type: "contribution", kelaboId: "m1", card: "c1", status: "skipped", reason: "The agent left." });
  assert.equal(r.ok, true);
  assert.equal(r.frame.reason, "The agent left.");
});

test("an empty card reference is refused rather than treated as absent", () => {
  // "" would silently mean "no card", and the agent's update would land as a
  // brand new card on the board instead of replacing its placeholder.
  assert.equal(up({ type: "contribution", kelaboId: "m1", markdown: "x", card: "" }).ok, false);
});

test("contribution carries sources and an idempotency ref", () => {
  const r = up({
    type: "contribution",
    kelaboId: "m1",
    markdown: "x",
    sources: [{ title: "RFC", url: "https://example.com" }, { title: "notes" }],
    ref: "abc",
  });
  assert.equal(r.ok, true);
  assert.equal(r.frame.sources.length, 2);
  assert.equal(r.frame.sources[1].url, undefined);
  assert.equal(r.frame.ref, "abc");
});

// --- summary / archive correlation ------------------------------------------

test("summary and archive carry a requestId", () => {
  assert.equal(up({ type: "summary", kelaboId: "m1", text: "{}" }).ok, false);
  assert.equal(up({ type: "summary", requestId: "r1", kelaboId: "m1", text: "" }).ok, true);
});

// --- detach -----------------------------------------------------------------

test("detach may omit the kelabo", () => {
  assert.equal(up({ type: "detach" }).ok, true);
  assert.equal(up({ type: "detach", kelaboId: "m1" }).ok, true);
});

// --- briefing ---------------------------------------------------------------

test("briefing defaults every optional list", () => {
  const r = down({ type: "briefing", kelaboId: "m1", status: "scheduled" });
  assert.equal(r.ok, true);
  assert.deepEqual(r.frame.invitees, []);
  assert.deepEqual(r.frame.participants, []);
  assert.equal(r.frame.note, "");
  assert.equal(r.frame.title, "");
});

test("briefing status is scheduled or active only", () => {
  assert.equal(down({ type: "briefing", kelaboId: "m1", status: "ended" }).ok, false);
});

test("briefing invitees default to pending and non-host", () => {
  const r = down({
    type: "briefing",
    kelaboId: "m1",
    status: "scheduled",
    invitees: [{ displayName: "Bob" }],
  });
  assert.equal(r.ok, true);
  assert.equal(r.frame.invitees[0].response, "pending");
  assert.equal(r.frame.invitees[0].isHost, false);
});

// --- transcript -------------------------------------------------------------

test("transcript defaults final and human", () => {
  const r = down({ type: "transcript", kelaboId: "m1", speaker: "Alice", text: "hi", at: 5 });
  assert.equal(r.ok, true);
  assert.equal(r.frame.final, true);
  assert.equal(r.frame.human, false);
  assert.equal(r.frame.messageId, "");
  assert.equal(r.frame.seq, 0);
});

// --- kelabo / request ------------------------------------------------------

test("kelabo event is a closed set", () => {
  assert.equal(down({ type: "kelabo", kelaboId: "m1", event: "started" }).ok, true);
  assert.equal(down({ type: "kelabo", kelaboId: "m1", event: "paused" }).ok, false);
});

test("kelabo event carries cancelled and rescheduled (docs 18)", () => {
  assert.equal(down({ type: "kelabo", kelaboId: "m1", event: "cancelled" }).ok, true);
  const r = down({ type: "kelabo", kelaboId: "m1", event: "rescheduled", scheduledAt: 123 });
  assert.equal(r.ok, true);
  assert.equal(r.frame.scheduledAt, 123);
});

test("request kind is a closed set and carries a requestId", () => {
  assert.equal(down({ type: "request", kind: "summary", requestId: "r", kelaboId: "m" }).ok, true);
  assert.equal(down({ type: "request", kind: "summary", kelaboId: "m" }).ok, false);
  assert.equal(down({ type: "request", kind: "minutes", requestId: "r", kelaboId: "m" }).ok, false);
});

test("history is requestId-correlated and distinguishes off from empty", () => {
  assert.equal(up({ type: "history_request", requestId: "r", kelaboId: "m" }).ok, true);
  assert.equal(up({ type: "history_request", kelaboId: "m" }).ok, false);
  const off = down({ type: "history", requestId: "r", kelaboId: "m", enabled: false });
  assert.equal(off.ok, true);
  assert.equal(off.frame.enabled, false);
  assert.deepEqual(off.frame.entries, []);
  const full = down({
    type: "history",
    requestId: "r",
    kelaboId: "m",
    entries: [{ kelaboId: "k1", title: "Sprint review", endedAt: 1722400000000, summary: "s", decisions: ["d"], actionItems: ["a (bo)"] }],
  });
  assert.equal(full.ok, true);
  assert.equal(full.frame.enabled, true, "enabled defaults to true when entries are served");
  assert.equal(full.frame.entries[0].decisions[0], "d");
});

// --- journey pull tools (docs 20 §12.2) --------------------------------------

test("journey_*_request frames require a requestId and kelaboId but not a journeyId", () => {
  assert.equal(up({ type: "journey_info_request", requestId: "r", kelaboId: "m" }).ok, true);
  assert.equal(up({ type: "journey_info_request", kelaboId: "m" }).ok, false);
  assert.equal(up({ type: "journey_info_request", requestId: "r" }).ok, false);
  const withId = up({ type: "journey_info_request", requestId: "r", kelaboId: "m", journeyId: "j1" });
  assert.equal(withId.ok, true);
  assert.equal(withId.frame.journeyId, "j1");
});

test("journey_timeline_request's entryType is distinct from the frame's own type", () => {
  const r = up({ type: "journey_timeline_request", requestId: "r", kelaboId: "m", entryType: "report", before: 5, limit: 10 });
  assert.equal(r.ok, true);
  assert.equal(r.frame.type, "journey_timeline_request");
  assert.equal(r.frame.entryType, "report");
});

test("journey_report_submit requires both question and answer", () => {
  assert.equal(up({ type: "journey_report_submit", requestId: "r", kelaboId: "m", question: "q" }).ok, false);
  assert.equal(up({ type: "journey_report_submit", requestId: "r", kelaboId: "m", question: "q", answer: "a" }).ok, true);
});

test("journey_post requires content; msgId is optional (present means edit)", () => {
  assert.equal(up({ type: "journey_post", requestId: "r", kelaboId: "m" }).ok, false);
  const post = up({ type: "journey_post", requestId: "r", kelaboId: "m", content: "note" });
  assert.equal(post.ok, true);
  assert.equal(post.frame.msgId, undefined);
  const edit = up({ type: "journey_post", requestId: "r", kelaboId: "m", content: "note", msgId: "msg1" });
  assert.equal(edit.frame.msgId, "msg1");
});

test("journey resolution responses distinguish ok/no_journey/ambiguous/journey_not_found", () => {
  const none = down({ type: "journey_info", requestId: "r", kelaboId: "m", resolved: "no_journey" });
  assert.equal(none.ok, true);
  assert.deepEqual(none.frame.journeys, []);
  const ambiguous = down({
    type: "journey_info",
    requestId: "r",
    kelaboId: "m",
    resolved: "ambiguous",
    journeys: [{ journeyId: "j1", title: "Q3 Launch" }, { journeyId: "j2", title: "Q4 Launch" }],
  });
  assert.equal(ambiguous.ok, true);
  assert.equal(ambiguous.frame.journeys.length, 2);
  const ok = down({
    type: "journey_info",
    requestId: "r",
    kelaboId: "m",
    resolved: "ok",
    journeyId: "j1",
    title: "Q3 Launch",
    visibility: "public",
    status: "active",
    health: "yellow",
    progress: 40,
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.frame.description, "", "description defaults to empty, not undefined");
  assert.equal(ok.frame.health, "yellow");
  assert.equal(down({ type: "journey_info", requestId: "r", kelaboId: "m", resolved: "not_a_real_reason" }).ok, false);
});

test("journey_posted carries the aiCanPost gate and edit-target failures as resolved outcomes, not errors", () => {
  assert.equal(down({ type: "journey_posted", requestId: "r", kelaboId: "m", resolved: "ai_posting_disabled" }).ok, true);
  assert.equal(down({ type: "journey_posted", requestId: "r", kelaboId: "m", resolved: "message_not_found" }).ok, true);
  assert.equal(down({ type: "journey_posted", requestId: "r", kelaboId: "m", resolved: "already_archived" }).ok, true);
  const ok = down({ type: "journey_posted", requestId: "r", kelaboId: "m", resolved: "ok", msgId: "msg1", version: 2 });
  assert.equal(ok.ok, true);
  assert.equal(ok.frame.version, 2);
});

// --- union completeness -----------------------------------------------------

test("every declared frame type parses", () => {
  const upTypes = new Set(upFrameSchema.options.map((o) => o.shape.type.value));
  const downTypes = new Set(downFrameSchema.options.map((o) => o.shape.type.value));
  assert.deepEqual([...upTypes].sort(), [
    "archive", "attach", "board_request", "contribution", "detach", "heartbeat", "history_request",
    "journey_board_request", "journey_info_request", "journey_post", "journey_report_submit",
    "journey_timeline_request", "register", "rename", "summary",
  ]);
  assert.deepEqual([...downTypes].sort(), [
    "board", "briefing", "history", "journey_board", "journey_info", "journey_posted",
    "journey_report_submitted", "journey_timeline", "kelabo", "ping", "registered", "rejected", "request",
    "transcript",
  ]);
  // No type may appear in both directions: the bridge and the Gateway each
  // parse exactly one union, so an overlap would be ambiguous at one end.
  for (const t of upTypes) assert.equal(downTypes.has(t), false, `${t} in both unions`);
});

console.log(`contracts/frames: ${passed} passed`);
