// The bridge end to end, offline: a fake Gateway speaking the real KAP frames, a
// stub adapter standing in for a coding agent, and the real tunnel, binding and
// tool layer in between.
//
// The adapter is a stub on purpose. Everything above contract C must work
// identically for every runtime, so the test that proves the contract must not
// depend on opencode or Claude Code being installed.
import assert from "node:assert/strict";
import { WebSocketServer } from "ws";
import { createTunnel } from "../src/tunnel.js";
import { createBinding } from "../src/binding.js";
import { createTools } from "../src/tools.js";

const KELABO = "m-1";
const SCHEDULED = "m-sched";

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`ok - ${name}`);
  } catch (e) {
    console.error(`FAIL - ${name}`);
    console.error(e);
    process.exitCode = 1;
  }
}

const waitFor = async (fn, ms = 3000, step = 10) => {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, step));
  }
  throw new Error("waitFor timeout");
};

// --- fake Gateway -----------------------------------------------------------

const received = [];
let gatewaySocket = null;
let historyAsks = 0;
let journeyPostAsks = 0;
const wss = new WebSocketServer({ port: 0 });
const port = await new Promise((r) => wss.on("listening", () => r(wss.address().port)));

wss.on("connection", (ws) => {
  gatewaySocket = ws;
  ws.on("message", (raw) => {
    const frame = JSON.parse(raw.toString());
    received.push(frame);
    if (frame.type === "register") {
      ws.send(JSON.stringify({ type: "registered", agentId: "a-1", kelaboId: "" }));
    }
    if (frame.type === "attach") {
      const scheduled = frame.kelaboId === SCHEDULED;
      ws.send(
        JSON.stringify({
          type: "briefing",
          kelaboId: frame.kelaboId,
          status: scheduled ? "scheduled" : "active",
          title: scheduled ? "Retry policy review" : "Standup",
          host: "bob@example.com",
          ...(scheduled ? { scheduledAt: Date.now() + 3_600_000, durationMinutes: 30, note: "bring the numbers" } : { startedAt: Date.now() - 60_000 }),
          invitees: [{ displayName: "Bob", response: "accepted", isHost: true }],
          participants: [],
        })
      );
    }
    if (frame.type === "board_request") {
      ws.send(
        JSON.stringify({
          type: "board",
          requestId: frame.requestId,
          kelaboId: frame.kelaboId,
          contributions: [{ id: "c1", title: "Earlier finding", to: "all", markdown: "Retries cap at 5", author: "assistant", at: 1000 }],
        })
      );
    }
    if (frame.type === "history_request") {
      // First ask: the host never opted in. Every later ask: one past kelabo.
      const enabled = historyAsks++ > 0;
      ws.send(
        JSON.stringify({
          type: "history",
          requestId: frame.requestId,
          kelaboId: frame.kelaboId,
          enabled,
          entries: enabled
            ? [{ kelaboId: "past1", title: "Sprint planning", endedAt: 1722300000000, summary: "We picked the blue design.", decisions: ["Blue, not green"], actionItems: ["Ship it (bo)"] }]
            : [],
        })
      );
    }
    if (frame.type === "journey_info_request") {
      if (frame.journeyId === "ambi") {
        ws.send(JSON.stringify({
          type: "journey_info", requestId: frame.requestId, kelaboId: frame.kelaboId,
          resolved: "ambiguous", journeys: [{ journeyId: "j1", title: "Q3 Launch" }, { journeyId: "j2", title: "Q4 Launch" }],
        }));
      } else if (frame.journeyId === "bogus") {
        ws.send(JSON.stringify({ type: "journey_info", requestId: frame.requestId, kelaboId: frame.kelaboId, resolved: "journey_not_found", journeys: [] }));
      } else {
        ws.send(JSON.stringify({
          type: "journey_info", requestId: frame.requestId, kelaboId: frame.kelaboId, resolved: "ok", journeys: [],
          journeyId: "j1", title: "Q3 Launch", visibility: "public", status: "active", description: "Ship the redesign.",
          health: "yellow", progress: 40,
          counts: { kelaboCount: 2, documentCount: 1, reportCount: 0, boardMessageCount: 3, accessorCount: 0 },
        }));
      }
    }
    if (frame.type === "journey_timeline_request") {
      ws.send(JSON.stringify({
        type: "journey_timeline", requestId: frame.requestId, kelaboId: frame.kelaboId, resolved: "ok", journeys: [],
        entries: [{ type: "report", summary: "Report requested: Where are we?", actor: "alice@example.com", at: 1722400000000 }],
      }));
    }
    if (frame.type === "journey_board_request") {
      ws.send(JSON.stringify({
        type: "journey_board", requestId: frame.requestId, kelaboId: frame.kelaboId, resolved: "ok", journeys: [],
        messages: [{ msgId: "m1", content: "Freeze is Friday" }],
      }));
    }
    if (frame.type === "journey_report_submit") {
      ws.send(JSON.stringify({ type: "journey_report_submitted", requestId: frame.requestId, kelaboId: frame.kelaboId, resolved: "ok", journeys: [], reportId: "r-1" }));
    }
    if (frame.type === "journey_post") {
      // First ask: the owner has not turned aiCanPost on. Later asks: on,
      // matching the historyAsks toggle above.
      const enabled = journeyPostAsks++ > 0;
      if (!enabled) {
        ws.send(JSON.stringify({ type: "journey_posted", requestId: frame.requestId, kelaboId: frame.kelaboId, resolved: "ai_posting_disabled", journeys: [] }));
      } else if (frame.msgId === "missing") {
        ws.send(JSON.stringify({ type: "journey_posted", requestId: frame.requestId, kelaboId: frame.kelaboId, resolved: "message_not_found", journeys: [] }));
      } else if (frame.msgId === "archived-msg") {
        ws.send(JSON.stringify({ type: "journey_posted", requestId: frame.requestId, kelaboId: frame.kelaboId, resolved: "already_archived", journeys: [] }));
      } else {
        ws.send(JSON.stringify({
          type: "journey_posted", requestId: frame.requestId, kelaboId: frame.kelaboId, resolved: "ok", journeys: [],
          msgId: frame.msgId || "new-msg-1", version: frame.msgId ? 2 : 1,
        }));
      }
    }
  });
});
const send = (frame) => gatewaySocket.send(JSON.stringify(frame));
const sent = (pred) => received.find(pred);

// --- stub adapter -----------------------------------------------------------

const injected = [];
let ready = true;
const adapter = {
  runtime: "stub",
  attach: async () => ({ sessionRef: "s-1", workspace: "/repo" }),
  inject: async (text, opts) => {
    injected.push({ text, ...opts });
  },
  ready: () => ready,
  start: async () => {},
  detach: async () => {},
};

// --- wiring -----------------------------------------------------------------

const tunnel = createTunnel({
  gatewayUrl: `ws://127.0.0.1:${port}`,
  getToken: async () => "token-1",
  agent: { runtime: "stub", label: "test agent" },
  heartbeatMs: 60_000,
});
const binding = createBinding({ tunnel, adapter, maxBacklog: 5 });
const api = {
  joinableKelabos: async () => [
    { kelaboId: KELABO, title: "Standup", status: "active", isHost: true, startedAt: Date.now() - 60_000 },
    { kelaboId: SCHEDULED, title: "Retry policy review", status: "scheduled", isHost: false, scheduledAt: Date.now() + 3_600_000 },
  ],
};
const tools = createTools({ tunnel, binding, adapter, api });

tunnel.connect();
await waitFor(() => sent((f) => f.type === "register"));

// --- tests ------------------------------------------------------------------

await test("register announces the runtime, not a jwt", () => {
  const reg = sent((f) => f.type === "register");
  assert.equal(reg.token, "token-1");
  assert.equal(reg.agent.runtime, "stub");
  assert.ok(reg.agent.version, "the bridge reports its own version");
});

await test("kelabo_join with no kelabo lists what is available, live first", async () => {
  const out = await tools.join({});
  assert.match(out, new RegExp(KELABO));
  assert.match(out, /live, started/);
  assert.match(out, /scheduled in 1 hour/);
  // The list has to teach the model what the two states mean, or it treats a
  // scheduled kelabo as a broken live one.
  assert.match(out, /no transcript/);
});

await test("kelabo_join on a scheduled kelabo returns the briefing as the tool result", async () => {
  const out = await tools.join({ kelaboId: SCHEDULED });
  assert.match(out, /status="scheduled"/);
  assert.match(out, /Agenda note from the host: bring the numbers/);
  assert.match(out, /kelabo_post/);
  const attach = sent((f) => f.type === "attach" && f.kelaboId === SCHEDULED);
  assert.equal(attach.sessionRef, "s-1");
  assert.equal(attach.workspace, "/repo");
});

await test("the briefing is injected silently — loading context costs no turn", async () => {
  const brief = await waitFor(() => injected.find((i) => i.text.includes("kelabo-briefing")));
  assert.equal(brief.silent, true);
});

await test("kelabo_post before the kelabo says where the post went", async () => {
  const out = await tools.post({ markdown: "Retries cap at 5", title: "Retry cap" });
  assert.match(out, /has not started/);
  const con = await waitFor(() => sent((f) => f.type === "contribution"));
  assert.equal(con.kelaboId, SCHEDULED);
  assert.equal(con.markdown, "Retries cap at 5");
  assert.ok(con.ref, "every post carries an idempotency ref");
});

await test("posting with nothing attached is refused with an actionable message", async () => {
  await tools.leave();
  await assert.rejects(() => tools.post({ markdown: "x" }), /kelabo_join/);
});

await test("kelabo_join on a live kelabo switches the binding", async () => {
  const out = await tools.join({ kelaboId: KELABO });
  assert.match(out, /status="active"/);
  assert.match(out, /is live/);
});

await test("transcript is batched, wrapped and marked untrusted", async () => {
  const before = injected.length;
  send({ type: "transcript", kelaboId: KELABO, messageId: "m1", seq: 0, speaker: "Alice", text: "what is the retry policy?", at: Date.now(), final: true, human: false });
  const evt = await waitFor(() => injected.slice(before).find((i) => i.text.includes("kelabo-transcript")));
  assert.match(evt.text, /untrusted="true"/);
  assert.match(evt.text, /Alice: what is the retry policy\?/);
  assert.equal(evt.silent, false, "transcript must be able to provoke a turn");
});

await test("transcript arriving while the agent is busy coalesces into one batch", async () => {
  ready = false;
  const before = injected.length;
  for (let i = 2; i <= 4; i++) {
    send({ type: "transcript", kelaboId: KELABO, messageId: `m${i}`, seq: 0, speaker: "Bob", text: `line ${i}`, at: Date.now(), final: true, human: false });
  }
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(injected.length, before, "nothing is injected while the agent is blocked");

  // The developer answers the permission prompt.
  ready = true;
  binding.notifyReady();
  const batch = await waitFor(() => injected.slice(before).find((i) => i.text.includes("kelabo-transcript")));
  assert.match(batch.text, /line 2/);
  assert.match(batch.text, /line 3/);
  assert.match(batch.text, /line 4/);
  assert.equal(injected.length, before + 1, "one batch, not three turns");
});

await test("a redelivered transcript frame is not injected twice", async () => {
  const before = injected.length;
  send({ type: "transcript", kelaboId: KELABO, messageId: "m1", seq: 0, speaker: "Alice", text: "what is the retry policy?", at: Date.now(), final: true, human: false });
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(injected.length, before);
});

await test("kelabo_board reads what an earlier session posted", async () => {
  const out = await tools.board();
  assert.match(out, /Earlier finding/);
  assert.match(out, /Retries cap at 5/);
});

await test("kelabo_history tells opt-in-off apart from an empty record", async () => {
  const off = await tools.history();
  assert.match(off, /has not shared past kelabos/);
  const on = await tools.history();
  assert.match(on, /RECORD OF THE PAST/, "the framing travels with the entries");
  assert.match(on, /Sprint planning \(2024-07-30\)/);
  assert.match(on, /We picked the blue design\./);
  assert.match(on, /Decisions: Blue, not green/);
  assert.match(on, /Action items: Ship it \(bo\)/);
});

await test("kelabo_journey_info renders the resolved journey, or asks to disambiguate", async () => {
  const out = await tools.journeyInfo({});
  assert.match(out, /Q3 Launch — public, active/);
  assert.match(out, /Ship the redesign\./);
  assert.match(out, /Health: yellow  Progress: 40%/);
  assert.match(out, /journeyId: j1/);

  const ambiguous = await tools.journeyInfo({ journeyId: "ambi" });
  assert.match(ambiguous, /linked to more than one journey/);
  assert.match(ambiguous, /j1  Q3 Launch/);
  assert.match(ambiguous, /j2  Q4 Launch/);
  assert.match(ambiguous, /Call again with journeyId/);

  const bogus = await tools.journeyInfo({ journeyId: "bogus" });
  assert.match(bogus, /not one this kelabo is linked to/);
});

await test("kelabo_journey_timeline and kelabo_journey_board render the resolved payload", async () => {
  const timeline = await tools.journeyTimeline({});
  assert.match(timeline, /report/);
  assert.match(timeline, /Report requested: Where are we\?/);
  assert.match(timeline, /alice@example\.com/);

  const board = await tools.journeyBoard({});
  assert.match(board, /Freeze is Friday/);
});

await test("kelabo_journey_report_submit requires both fields and reports the stored reportId", async () => {
  await assert.rejects(() => tools.journeyReportSubmit({ answer: "a" }), /question is required/);
  await assert.rejects(() => tools.journeyReportSubmit({ question: "q" }), /answer is required/);
  const out = await tools.journeyReportSubmit({ question: "Where are we?", answer: "On track." });
  assert.match(out, /reportId: r-1/);
});

await test("kelabo_journey_post is refused while aiCanPost is off, then succeeds once it is on", async () => {
  const off = await tools.journeyPost({ content: "Freeze is Friday" });
  assert.match(off, /has not turned on assistant posting/);

  const posted = await tools.journeyPost({ content: "Freeze is Friday" });
  assert.match(posted, /Posted to the journey's board \(msgId: new-msg-1\)/);

  const edited = await tools.journeyPost({ content: "Freeze moved", msgId: "m1" });
  assert.match(edited, /edited \(version 2\)/);

  const missing = await tools.journeyPost({ content: "x", msgId: "missing" });
  assert.match(missing, /may have been archived or never existed/);

  // Previously untested: the agent bridge can never archive or unarchive a
  // message itself, but must still be told plainly when it tries to edit
  // one that already is.
  const archived = await tools.journeyPost({ content: "x", msgId: "archived-msg" });
  assert.match(archived, /is archived and cannot be edited until it is unarchived/);
});

await test("kelabo_working puts an in-progress card up before there is an answer", async () => {
  // The whole point: the room sees the question was taken, during the minutes
  // the lookup actually takes. Without it, working and ignoring look identical.
  const before = received.length;
  const out = await tools.working({ title: "Retry policy in the gateway", progress: "Searching the repo" });
  const card = out.match(/Card reference: (\S+)/)?.[1];
  assert.ok(card, "the reference is handed back to the model");
  const frame = await waitFor(() => received.slice(before).find((f) => f.type === "contribution"));
  assert.equal(frame.status, "working");
  assert.equal(frame.card, card);
  assert.equal(frame.title, "Retry policy in the gateway");
  assert.equal(frame.progress, "Searching the repo");
  assert.ok(!frame.markdown, "there is nothing to say yet");
});

await test("the answer replaces that card instead of adding a second one", async () => {
  const opened = await tools.working({ title: "Cache TTL" });
  const card = opened.match(/Card reference: (\S+)/)[1];

  const out = await tools.post({ card, markdown: "It is 60 seconds.", title: "Cache TTL" });
  assert.match(out, /replacing the in-progress card/);
  const frame = await waitFor(() =>
    received.find((f) => f.type === "contribution" && f.card === card && f.status === "done")
  );
  assert.equal(frame.markdown, "It is 60 seconds.");
  // One card, two frames: the placeholder and the answer, under one reference.
  const forCard = received.filter((f) => f.type === "contribution" && f.card === card);
  assert.deepEqual(forCard.map((f) => f.status), ["working", "done"]);

  // And it is finished: answering the same card twice would be a second answer
  // overwriting the first on everyone's board.
  await assert.rejects(() => tools.post({ card, markdown: "again" }), /No open card/);
});

await test("a card reference the bridge never issued is refused", async () => {
  await assert.rejects(() => tools.post({ card: "c9invented", markdown: "x" }), /No open card/);
  await assert.rejects(() => tools.working({ card: "c9invented", title: "x" }), /No open card/);
});

await test("progress updates keep one card rather than stacking new ones", async () => {
  const opened = await tools.working({ title: "Long lookup" });
  const card = opened.match(/Card reference: (\S+)/)[1];
  await tools.working({ card, title: "Long lookup", progress: "Reading gateway/src" });
  const frame = await waitFor(() =>
    received.find((f) => f.type === "contribution" && f.card === card && f.progress === "Reading gateway/src")
  );
  assert.equal(frame.status, "working");
  const forCard = received.filter((f) => f.type === "contribution" && f.card === card);
  assert.equal(forCard.length, 2, "an update, not a new card");
  // Leave it open — the next test is about what happens to exactly this.
});

await test("a summary request asks for a turn, and kelabo_minutes answers it", async () => {
  const before = injected.length;
  send({ type: "request", kind: "summary", requestId: "r-1", kelaboId: KELABO });
  const ask = await waitFor(() => injected.slice(before).find((i) => i.text.includes("kelabo_minutes")));
  // Producing the minutes is the work, so this one is not silent.
  assert.equal(ask.silent, false);

  const out = await tools.minutes({ minutes: '{"topics":[]}' });
  assert.match(out, /not posted to the board/);
  const reply = await waitFor(() => sent((f) => f.type === "summary"));
  assert.equal(reply.requestId, "r-1");
  assert.equal(reply.text, '{"topics":[]}');
});

await test("submitting minutes nobody asked for is refused, not silently dropped", async () => {
  await assert.rejects(() => tools.minutes({ minutes: "{}" }), /did not ask/);
});

await test("an archive request is deliberately left unanswered", async () => {
  const before = received.length;
  send({ type: "request", kind: "archive", requestId: "r-2", kelaboId: KELABO });
  await new Promise((r) => setTimeout(r, 150));
  // The Gateway's own transcript and board are complete; replying with a
  // reconstruction is what used to overwrite the real kelabo title.
  assert.equal(received.slice(before).some((f) => f.type === "archive"), false);
});

await test("kelabo.started is informational — attending stays a deliberate act", async () => {
  const before = injected.length;
  send({ type: "kelabo", kelaboId: SCHEDULED, event: "started" });
  const notice = await waitFor(() => injected.slice(before).find((i) => i.text.includes("kelabo-notice")));
  assert.match(notice.text, /kelabo_join again/);
  assert.match(notice.text, /stay out/);
});

await test("a reconnect re-announces the attachment without the developer redoing /kstart", async () => {
  const before = received.length;
  gatewaySocket.close();
  await waitFor(() => received.slice(before).some((f) => f.type === "register"), 8000);
  const reattach = await waitFor(() => received.slice(before).find((f) => f.type === "attach"), 8000);
  assert.equal(reattach.kelaboId, KELABO);
});

await test("leaving lands the cards still in flight instead of leaving them spinning", async () => {
  // Two cards are still open from earlier tests. Every one of them has to be
  // landed: after the detach there is no way to say the answer is not coming.
  const before = received.length;
  await tools.leave();
  const tail = await waitFor(() => {
    const slice = received.slice(before);
    const skipped = slice.filter((f) => f.type === "contribution" && f.status === "skipped");
    return skipped.length >= 2 && slice.some((f) => f.type === "detach") ? slice : null;
  });

  const skipped = tail.filter((f) => f.type === "contribution" && f.status === "skipped");
  const titles = skipped.map((f) => f.title);
  assert.ok(titles.includes("Long lookup"), `expected the open cards, got ${JSON.stringify(titles)}`);
  assert.ok(titles.includes("Retry policy in the gateway"));
  for (const f of skipped) assert.match(f.reason, /left the kelabo/);

  // Order matters: the Gateway drops a contribution from a connection that is
  // no longer attached, so landing them after the detach would silently do
  // nothing and leave the spinners up.
  assert.ok(
    tail.findIndex((f) => f.type === "detach") > tail.lastIndexOf(skipped[skipped.length - 1]),
    "landed while still attached, not after the detach"
  );
});

tunnel.stop();
wss.close();
console.log(`\n${passed} tests passed${process.exitCode ? " (with failures)" : ""}`);
process.exit(process.exitCode || 0);
