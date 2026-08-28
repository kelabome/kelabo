// The journey channel's HTTP surface (docs 20 §19), driven against a real
// server over real sockets — the same style test/presence.mjs uses for the
// other session-cookie stream.
//
// The unit-level behaviour (paging cursors, soft delete, cursor arithmetic)
// is asserted directly in test/journeys.mjs. What is only reachable here is
// everything between the socket and those functions: route matching for a
// pattern rather than a fixed path, the SESSION cookie boundary (this is the
// second surface on the Gateway to use it, and the first to write through
// it), and the deliberate choice to answer 404 rather than 403 to a
// non-member.
import http from "node:http";
import assert from "node:assert/strict";
import { createContainer } from "../src/container.js";
import { createGateway } from "../src/server.js";
import { signJwt } from "../src/cookies.js";

const KEY = "test-secret-key";
const NOW = Date.now();
const JOURNEY = "j-http";
const PK = `JOURNEY#${JOURNEY}`;
const T = "general";

/** A journeys table just wide enough for the handlers: point reads, a
 *  prefix/range query, puts, and the two conditional updates. */
function makeDb(seed) {
  const items = new Map(seed.map((i) => [`${i.PK}|${i.SK}`, i]));
  return {
    items,
    send: async (cmd) => {
      const name = cmd.constructor.name;
      const input = cmd.input;
      if (name === "GetCommand") return { Item: items.get(`${input.Key.PK}|${input.Key.SK}`) };
      if (name === "PutCommand") {
        items.set(`${input.Item.PK}|${input.Item.SK}`, { ...input.Item });
        return {};
      }
      if (name === "QueryCommand") {
        const v = input.ExpressionAttributeValues;
        let out = [...items.values()].filter((i) =>
          i.PK !== v[":pk"]
            ? false
            : v[":lo"] !== undefined
            ? String(i.SK) >= v[":lo"] && String(i.SK) <= v[":hi"]
            : String(i.SK).startsWith(v[":sk"])
        );
        out.sort((a, b) => (a.SK < b.SK ? -1 : a.SK > b.SK ? 1 : 0));
        if (input.ScanIndexForward === false) out.reverse();
        return { Items: input.Limit ? out.slice(0, input.Limit) : out };
      }
      if (name === "UpdateCommand") {
        const k = `${input.Key.PK}|${input.Key.SK}`;
        // UpdateItem CREATES the item it was asked to update, which is why
        // every write that must not conjure a row carries this condition. A
        // fake that ignored it would let a rename of a missing thread succeed
        // here and 404 in production — or worse, invent the thread.
        if (input.ConditionExpression === "attribute_exists(SK)" && !items.has(k)) {
          const e = new Error("ConditionalCheckFailedException");
          e.name = "ConditionalCheckFailedException";
          throw e;
        }
        const existing = items.get(k) || { PK: input.Key.PK, SK: input.Key.SK };
        const v = input.ExpressionAttributeValues || {};
        const expr = input.UpdateExpression;
        const item = { ...existing };
        // Only the shapes these handlers actually emit.
        if (/title = :title/.test(expr)) {
          item.title = v[":title"];
        } else if (/messageCountAtRead = if_not_exists/.test(expr)) {
          // The author's own message cancelling itself out of their badge.
          // Listed before the `messageCount` branch would be tempting, but the
          // two are distinguished by the attribute name, not by order —
          // `messageCount = ` does not appear in `messageCountAtRead = `.
          item.messageCountAtRead = (existing.messageCountAtRead || 0) + 1;
          item.threadId = existing.threadId ?? v[":tid"];
        } else if (/messageCount = if_not_exists/.test(expr)) {
          item.messageCount = (existing.messageCount || 0) + 1;
          item.lastMessageAt = v[":at"];
        } else if (/mentionCount = if_not_exists/.test(expr)) {
          item.mentionCount = (existing.mentionCount || 0) + 1;
        } else if (/boardMessageCount = if_not_exists/.test(expr)) {
          item.boardMessageCount = (existing.boardMessageCount || 0) + 1;
        } else {
          for (const [name_, attr] of Object.entries(input.ExpressionAttributeNames || {})) {
            if (new RegExp(`REMOVE.*${name_}`).test(expr)) delete item[attr];
          }
          if (v[":text"] !== undefined) item.text = v[":text"];
          if (v[":board"] !== undefined) item.pinnedAs = v[":board"];
          if (/editedAt = :at/.test(expr)) item.editedAt = v[":at"];
          if (/deletedAt = :at/.test(expr)) item.deletedAt = v[":at"];
          if (/lastReadAt = :at/.test(expr)) {
            item.lastReadAt = v[":at"];
            item.messageCountAtRead = v[":count"];
            item.mentionCountAtRead = v[":mentions"];
          }
        }
        items.set(k, item);
        return {};
      }
      throw new Error(`unhandled ${name}`);
    },
  };
}

const config = {
  env: "test",
  region: "us-east-1",
  tenantId: "example.com",
  allowedEmailDomain: "example.com",
  portalUrl: "http://portal.test",
  tableNames: { kelabos: "t-kelabos", journeys: "t-journeys", history: "t-history" },
  contacts: { external: false },
  archiveBucket: "t-bucket",
  archiveKeyPrefix: "archives",
  secrets: { cookieSigningKey: "t/cookie" },
  rtc: { defaultMode: "sfu", meshMaxParticipants: 6 },
  llm: { provider: "fake", model: "fake", smallModel: "fake" },
  openaiBaseUrl: "http://unused",
  retentionDays: 30,
};

const sessionCookie = (identity, tenantId = "example.com") =>
  signJwt({ kind: "identity", identity, tenantId, exp: Math.floor(NOW / 1000) + 3600 }, KEY);

function call(port, method, path, { identity, tenant, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const headers = {};
    if (identity) headers.cookie = `kelabo_session=${sessionCookie(identity, tenant)}`;
    if (payload) headers["content-type"] = "application/json";
    const r = http.request({ host: "127.0.0.1", port, path, method, headers }, (res) => {
      const chunks = [];
      res.on("data", (d) => chunks.push(d));
      res.on("end", () =>
        resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") })
      );
    });
    r.on("error", reject);
    if (payload) r.write(payload);
    r.end();
  });
}

// A stub model. Counting the calls is how the loop guard is asserted: the
// interesting claim is not what the assistant says, it is how many times it is
// asked. Its answer deliberately contains "@kelabo", which is exactly the
// shape that would make a naive dispatcher answer itself forever.
let llmCalls = 0;
const llm = {
  async completeRaw() {
    llmCalls++;
    return { text: "A stub answer, and @kelabo is in it on purpose.", usage: null };
  },
};

/** Open a /presence/stream and collect parsed `presence` events — the same
 *  helper test/presence.mjs uses, because this is the same stream. */
function connectPresence(port, identity, tenantId = "example.com") {
  return new Promise((resolve, reject) => {
    const r = http.request(
      {
        host: "127.0.0.1",
        port,
        path: "/presence/stream",
        method: "GET",
        headers: { cookie: `kelabo_session=${sessionCookie(identity, tenantId)}` },
      },
      (res) => {
        if (res.statusCode !== 200) return reject(new Error(`presence status ${res.statusCode}`));
        const events = [];
        let buf = "";
        res.on("data", (d) => {
          buf += d.toString("utf8");
          let i;
          while ((i = buf.indexOf("\n\n")) >= 0) {
            const block = buf.slice(0, i);
            buf = buf.slice(i + 2);
            const ev = block.match(/^event: (.+)$/m)?.[1];
            const data = block.match(/^data: (.+)$/m)?.[1];
            if (ev === "presence" && data) events.push(JSON.parse(data));
          }
        });
        resolve({ res, events });
      }
    );
    r.on("error", reject);
    r.end();
  });
}

const waitFor = async (fn, ms = 3000, step = 25) => {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, step));
  }
  throw new Error("waitFor timeout");
};

let passed = 0;
const ok = (name) => {
  console.log("ok:", name);
  passed++;
};

async function main() {
  const db = makeDb([
    {
      PK: PK,
      SK: "META",
      journeyId: JOURNEY,
      title: "Q3 Launch",
      tenantId: "example.com",
      ownerIdentity: "alice@example.com",
      visibility: "private",
      status: "active",
    },
    { PK: PK, SK: "ACCESSOR#bob@example.com", identity: "bob@example.com" },
    { PK: PK, SK: `THREAD#${T}`, threadId: T, title: "General", createdAt: 1, messageCount: 0, lastMessageAt: 0, archived: false },
  ]);
  const c = await createContainer({
    config,
    db,
    s3: { send: async () => ({}) },
    secrets: { send: async () => ({ SecretString: KEY }) },
    llm,
    skipRebuild: true,
  });
  const server = createGateway(c);
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  const threads = `/journeys/${JOURNEY}/threads`;
  const messages = `${threads}/${T}/messages`;

  assert.equal((await call(port, "GET", messages)).status, 401);
  assert.equal((await call(port, "POST", messages, { body: { text: "hi" } })).status, 401);
  ok("no session cookie is refused");

  // A journey you may not read is indistinguishable from one that does not
  // exist, so an id cannot be probed for existence by watching the error.
  const stranger = await call(port, "GET", messages, { identity: "carol@example.com" });
  assert.equal(stranger.status, 404);
  assert.equal(stranger.body.error, "journey_not_found");
  const absent = await call(port, "GET", "/journeys/no-such-journey/threads/general/messages", { identity: "alice@example.com" });
  assert.deepEqual([absent.status, absent.body.error], [404, "journey_not_found"]);
  ok("a non-member and a missing journey give the same answer");

  const crossTenant = await call(port, "GET", messages, { identity: "dave@other.com", tenant: "other.com" });
  assert.equal(crossTenant.status, 404);
  ok("another tenant cannot read the channel");

  const posted = await call(port, "POST", messages, { identity: "bob@example.com", body: { text: "morning all" } });
  assert.equal(posted.status, 201);
  assert.equal(posted.body.message.text, "morning all");
  assert.equal(posted.body.message.author, "bob@example.com");
  const msgId = posted.body.message.msgId;
  ok("an accessor on a private journey can post");

  assert.equal((await call(port, "POST", messages, { identity: "bob@example.com", body: { text: "" } })).status, 400);
  assert.equal((await call(port, "POST", messages, { identity: "bob@example.com", body: {} })).status, 400);
  ok("an empty or malformed body is rejected before anything is written");

  const page = await call(port, "GET", messages, { identity: "alice@example.com" });
  assert.equal(page.status, 200);
  assert.equal(page.body.messages.length, 1);
  assert.equal(page.body.messageCount, 1);
  // The reader's own cursor rides the same response: a second round trip to
  // find out where you had got to would render the whole channel unread for
  // a frame on every open.
  assert.equal(page.body.unreadCount, 1);
  assert.equal(page.body.lastReadAt, 0);
  ok("the owner reads the page, and their unread position comes with it");

  const read = await call(port, "POST", `${threads}/${T}/read`, {
    identity: "alice@example.com",
    body: { at: page.body.lastMessageAt, msgId },
  });
  assert.equal(read.status, 200);
  const after = await call(port, "GET", messages, { identity: "alice@example.com" });
  assert.equal(after.body.unreadCount, 0);
  // Bob's own count is already 0 — he wrote that message, and your own is
  // never news to you — so proving the cursor is per identity needs somebody
  // else to speak. Alice does, and now the two disagree in the right
  // direction.
  assert.equal((await call(port, "GET", messages, { identity: "bob@example.com" })).body.unreadCount, 0);
  await call(port, "POST", messages, { identity: "alice@example.com", body: { text: "and one from me" } });
  assert.equal((await call(port, "GET", messages, { identity: "bob@example.com" })).body.unreadCount, 1);
  assert.equal((await call(port, "GET", messages, { identity: "alice@example.com" })).body.unreadCount, 0);
  ok("advancing the cursor clears the badge, for that identity alone");

  // The id is a path segment — this is why it is hyphen-separated rather
  // than using the `#` every other sort key in the partition uses.
  const edited = await call(port, "PATCH", `${messages}/${msgId}`, {
    identity: "bob@example.com",
    body: { text: "morning everyone" },
  });
  assert.equal(edited.status, 200);
  assert.equal(edited.body.message.text, "morning everyone");
  assert.ok(edited.body.message.editedAt >= edited.body.message.at, "never edited before it was sent");
  ok("a message id round-trips through a URL path");

  const notMine = await call(port, "PATCH", `${messages}/${msgId}`, {
    identity: "alice@example.com",
    body: { text: "words in your mouth" },
  });
  assert.deepEqual([notMine.status, notMine.body.error], [403, "not_message_author"]);
  ok("the lead may not edit somebody else's message");

  const gone = await call(port, "DELETE", `${messages}/${msgId}`, { identity: "alice@example.com" });
  assert.equal(gone.status, 200);
  assert.equal(gone.body.message.text, "");
  const afterDelete = await call(port, "GET", messages, { identity: "alice@example.com" });
  assert.equal(afterDelete.body.messages.length, 2, "the tombstone keeps its place");
  assert.equal(afterDelete.body.messageCount, 2, "the counter never moves");
  ok("the lead may delete it, and the row survives as a tombstone");

  // Completing a journey freezes the channel and nothing else — this is the
  // whole of "the context stays as long as it has not ended".
  db.items.get(`${PK}|META`).status = "completed";
  const frozen = await call(port, "POST", messages, { identity: "bob@example.com", body: { text: "one more" } });
  assert.deepEqual([frozen.status, frozen.body.error], [409, "journey_completed"]);
  assert.equal((await call(port, "GET", messages, { identity: "bob@example.com" })).status, 200, "still readable");
  // Refusing this would leave a badge nobody could ever clear.
  assert.equal(
    (await call(port, "POST", `${threads}/${T}/read`, { identity: "bob@example.com", body: { at: NOW } })).status,
    200,
    "still markable as read"
  );
  ok("a completed journey is read-only, but its badge can still be cleared");

  // --- mentions and pinning (docs 20 §19.7, §19.8) --------------------------

  db.items.get(`${PK}|META`).status = "active";

  const mentioned = await call(port, "POST", messages, {
    identity: "alice@example.com",
    body: { text: "@bob can you take this? cc bob@example.com" },
  });
  assert.equal(mentioned.status, 201);
  assert.deepEqual(mentioned.body.message.mentions, ["bob@example.com"]);
  // The bare address in the same sentence must not add a second copy, and on
  // its own would add none at all — the client never supplies this list.
  ok("mentions are resolved server-side, and prose email addresses are not mentions");

  const bobsView = await call(port, "GET", messages, { identity: "bob@example.com" });
  const mine = bobsView.body.messages.find(m => m.msgId === mentioned.body.message.msgId);
  assert.equal(mine.mentionsMe, true);
  assert.equal(bobsView.body.unreadMentions, 1);
  const aliceView = await call(port, "GET", messages, { identity: "alice@example.com" });
  assert.equal(aliceView.body.messages.find(m => m.msgId === mine.msgId).mentionsMe, undefined);
  assert.equal(aliceView.body.unreadMentions, 0);
  ok("mentionsMe and the mention badge are per reader");

  // The regression that made this worth an HTTP test: being mentioned creates
  // the READ# row before it has ever been read, and a guard that did not
  // tolerate the missing lastReadAt left the badge stuck forever.
  await call(port, "POST", `${threads}/${T}/read`, {
    identity: "bob@example.com",
    body: { at: bobsView.body.lastMessageAt, msgId: mine.msgId },
  });
  const cleared = await call(port, "GET", messages, { identity: "bob@example.com" });
  assert.equal(cleared.body.unreadMentions, 0);
  assert.equal(cleared.body.unreadCount, 0);
  ok("a cursor first created by a mention can still be advanced");

  const pinned = await call(port, "POST", `${messages}/${mine.msgId}/pin`, { identity: "alice@example.com" });
  assert.equal(pinned.status, 201);
  const board = db.items.get(`${PK}|BOARDMSG#${pinned.body.boardMsgId}`);
  assert.equal(board.content, mine.text);
  assert.equal(board.createdBy, "alice@example.com");
  assert.equal(board.pinnedFrom, mine.msgId);
  assert.equal(db.items.get(`${PK}|META`).boardMessageCount, 1);
  // Idempotent, and it says so with 200 rather than a second 201.
  const twice = await call(port, "POST", `${messages}/${mine.msgId}/pin`, { identity: "alice@example.com" });
  assert.equal(twice.status, 200);
  assert.equal(twice.body.boardMsgId, pinned.body.boardMsgId);
  assert.equal(db.items.get(`${PK}|META`).boardMessageCount, 1);
  ok("pinning puts an ordinary board message up, once");

  assert.equal((await call(port, "POST", `${messages}/${mine.msgId}/pin`)).status, 401);
  assert.equal(
    (await call(port, "POST", `${messages}/${mine.msgId}/pin`, { identity: "carol@example.com" })).status,
    404,
    "a non-member cannot pin, and is not told the journey exists"
  );
  ok("pinning is behind the same membership check as everything else");

  // --- threads (docs 20 §19) ------------------------------------------------

  const list = await call(port, "GET", threads, { identity: "bob@example.com" });
  assert.equal(list.status, 200);
  assert.equal(list.body.threads.length, 1);
  assert.equal(list.body.threads[0].threadId, T);
  // The reader's own position rides the list, so it never renders every thread
  // bold for a frame while a second call is in flight.
  assert.equal(typeof list.body.threads[0].unread, "number");
  ok("the thread list carries each reader's own unread count");

  const made = await call(port, "POST", threads, { identity: "bob@example.com", body: { title: "Rollout" } });
  assert.equal(made.status, 201);
  const second = made.body.thread.threadId;
  assert.notEqual(second, T, "a person's thread gets a uuid, not the fixed default id");
  assert.equal((await call(port, "POST", threads, { identity: "bob@example.com", body: { title: "" } })).status, 400);
  ok("a member can create a named thread");

  const renamed = await call(port, "PATCH", `${threads}/${second}`, {
    identity: "bob@example.com",
    body: { title: "Rollout plan" },
  });
  assert.equal(renamed.status, 200);
  assert.equal(
    (await call(port, "PATCH", `${threads}/nope`, { identity: "bob@example.com", body: { title: "x" } })).status,
    404
  );
  ok("threads can be renamed, and a missing one is a 404");

  // A message in one thread must not appear in another, and must not move the
  // other's badge.
  await call(port, "POST", `${threads}/${second}/messages`, { identity: "bob@example.com", body: { text: "over here" } });
  const inSecond = await call(port, "GET", `${threads}/${second}/messages`, { identity: "alice@example.com" });
  assert.equal(inSecond.body.messages.length, 1);
  assert.equal(inSecond.body.messages[0].text, "over here");
  const both = await call(port, "GET", threads, { identity: "alice@example.com" });
  const byId = Object.fromEntries(both.body.threads.map(t => [t.threadId, t]));
  assert.equal(byId[second].unread, 1);
  // Zero, and worth being precise about why: everything added to the default
  // thread since Alice last marked it read was written by Alice.
  assert.equal(byId[T].unread, 0, "her own messages are not unread to her");
  ok("threads are isolated, and unread is counted per thread");

  assert.equal((await call(port, "GET", `${threads}/nope/messages`, { identity: "bob@example.com" })).status, 404);
  assert.equal(
    (await call(port, "POST", `${threads}/nope/messages`, { identity: "bob@example.com", body: { text: "x" } })).status,
    404
  );
  ok("posting to a thread that does not exist is refused, not silently created");

  // --- @kelabo (docs 20 §19.10) ---------------------------------------------

  const asked = await call(port, "POST", `${threads}/${second}/messages`, {
    identity: "bob@example.com",
    body: { text: "@kelabo what did we decide?" },
  });
  assert.equal(asked.status, 201, "the asker gets their message back immediately");
  // The answer is dispatched after the response, so it lands a tick later.
  const answer = await waitFor(async () => {
    const page = await call(port, "GET", `${threads}/${second}/messages`, { identity: "bob@example.com" });
    return page.body.messages.find(m => m.kind === "assistant");
  });
  assert.equal(answer.author, "kelabo");
  assert.ok(answer.text.includes("stub answer"), answer.text);
  ok("@kelabo is answered, in the thread it was asked in");

  // The guard that matters most: the assistant's own reply contains the string
  // "@kelabo" — quoting the question back is the obvious way for it to do so —
  // and dispatching on that is an unbounded loop that bills for every turn.
  const before = llmCalls;
  await new Promise(r => setTimeout(r, 250));
  assert.equal(llmCalls, before, "the assistant's own message never triggers another answer");
  const settled = await call(port, "GET", `${threads}/${second}/messages`, { identity: "bob@example.com" });
  assert.equal(settled.body.messages.filter(m => m.kind === "assistant").length, 1);
  ok("an assistant reply that mentions @kelabo does not answer itself");

  const quiet = llmCalls;
  await call(port, "POST", `${threads}/${second}/messages`, { identity: "bob@example.com", body: { text: "no mention here" } });
  await new Promise(r => setTimeout(r, 150));
  assert.equal(llmCalls, quiet, "an ordinary message costs no model call");
  ok("only an explicit mention reaches the model");

  // --- realtime fan-out (docs 20 §19.9) -------------------------------------
  //
  // Driven over a real /presence/stream, because the interesting claims are
  // who receives an event and who does not, and both are decided by code that
  // only runs on a live connection.

  const bobStream = await connectPresence(port, "bob@example.com");
  const strangerStream = await connectPresence(port, "carol@example.com");
  await new Promise(r => setTimeout(r, 60));

  await call(port, "POST", messages, { identity: "alice@example.com", body: { text: "realtime please" } });
  const evt = await waitFor(() => bobStream.events.find(e => e.kind === "journey_message"));
  assert.equal(evt.journeyId, JOURNEY);
  assert.equal(evt.threadId, T);
  // The whole message rides the event, so a client already reading the thread
  // renders it without a round trip. That is the difference between realtime
  // and a fast poll.
  assert.equal(evt.message.text, "realtime please");
  assert.equal(evt.message.author, "alice@example.com");
  assert.ok(evt.message.msgId);
  ok("a message reaches a member's presence stream, whole");

  // Carol is signed in and holding a stream, but is not on this private
  // journey's roster. A fan-out that reached her would be a disclosure bug,
  // not a noisy badge.
  assert.equal(strangerStream.events.some(e => e.kind === "journey_message"), false);
  ok("a non-member holding a presence stream is not told anything");

  // The author's other tabs get it too — the tab that posted merges by msgId
  // into the copy it already applied, so including them costs nothing and
  // leaving them out would desync a second window.
  const aliceStream = await connectPresence(port, "alice@example.com");
  await new Promise(r => setTimeout(r, 60));
  await call(port, "POST", messages, { identity: "alice@example.com", body: { text: "second window" } });
  const own = await waitFor(() => aliceStream.events.find(e => e.kind === "journey_message"));
  assert.equal(own.message.text, "second window");
  ok("the author's own other tabs are told as well");

  for (const s of [bobStream, strangerStream, aliceStream]) s.res.destroy();

  {
    // --- the sender never badges themselves --------------------------------

    const fresh = await call(port, "POST", threads, { identity: "alice@example.com", body: { title: "Quiet" } });
    const quietId = fresh.body.thread.threadId;
    const quietPath = `${threads}/${quietId}`;

    await call(port, "POST", `${quietPath}/messages`, { identity: "alice@example.com", body: { text: "just me" } });
    const mine = await call(port, "GET", `${quietPath}/messages`, { identity: "alice@example.com" });
    assert.equal(mine.body.unreadCount, 0, "the sender sees no badge for their own message");
    const theirs = await call(port, "GET", `${quietPath}/messages`, { identity: "bob@example.com" });
    assert.equal(theirs.body.unreadCount, 1, "everyone else does");
    // And the thread list agrees with the thread — they are the two places the
    // same number is rendered, and they are computed by different code.
    const aliceThreads = await call(port, "GET", threads, { identity: "alice@example.com" });
    assert.equal(aliceThreads.body.threads.find(t => t.threadId === quietId).unread, 0);
    ok("posting raises no badge on the sender, at the thread or in the list");

    await call(port, "POST", `${quietPath}/messages`, { identity: "bob@example.com", body: { text: "one" } });
    await call(port, "POST", `${quietPath}/messages`, { identity: "bob@example.com", body: { text: "two" } });
    const beforeReply = await call(port, "GET", `${quietPath}/messages`, { identity: "alice@example.com" });
    assert.equal(beforeReply.body.unreadCount, 2);
    await call(port, "POST", `${quietPath}/messages`, { identity: "alice@example.com", body: { text: "replying" } });
    const after = await call(port, "GET", `${quietPath}/messages`, { identity: "alice@example.com" });
    assert.equal(after.body.unreadCount, 2, "replying does not mark Bob's messages read for her");
    ok("posting cancels your own message without swallowing anyone else's");
  }

  server.close();
  await c.shutdown?.();
  console.log(`\n${passed} passed`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
