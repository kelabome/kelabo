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
        const existing = items.get(k) || { PK: input.Key.PK, SK: input.Key.SK };
        const v = input.ExpressionAttributeValues || {};
        const expr = input.UpdateExpression;
        const item = { ...existing };
        // Only the shapes these handlers actually emit.
        if (/messageCount = if_not_exists/.test(expr)) {
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
  ]);
  const c = await createContainer({
    config,
    db,
    s3: { send: async () => ({}) },
    secrets: { send: async () => ({ SecretString: KEY }) },
    skipRebuild: true,
  });
  const server = createGateway(c);
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  const messages = `/journeys/${JOURNEY}/messages`;

  assert.equal((await call(port, "GET", messages)).status, 401);
  assert.equal((await call(port, "POST", messages, { body: { text: "hi" } })).status, 401);
  ok("no session cookie is refused");

  // A journey you may not read is indistinguishable from one that does not
  // exist, so an id cannot be probed for existence by watching the error.
  const stranger = await call(port, "GET", messages, { identity: "carol@example.com" });
  assert.equal(stranger.status, 404);
  assert.equal(stranger.body.error, "journey_not_found");
  const absent = await call(port, "GET", "/journeys/no-such-journey/messages", { identity: "alice@example.com" });
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

  const read = await call(port, "POST", `/journeys/${JOURNEY}/read`, {
    identity: "alice@example.com",
    body: { at: page.body.lastMessageAt, msgId },
  });
  assert.equal(read.status, 200);
  const after = await call(port, "GET", messages, { identity: "alice@example.com" });
  assert.equal(after.body.unreadCount, 0);
  // Reading is per identity, never shared.
  assert.equal((await call(port, "GET", messages, { identity: "bob@example.com" })).body.unreadCount, 1);
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
  assert.equal(afterDelete.body.messages.length, 1, "the tombstone keeps its place");
  assert.equal(afterDelete.body.messageCount, 1, "the counter never moves");
  ok("the lead may delete it, and the row survives as a tombstone");

  // Completing a journey freezes the channel and nothing else — this is the
  // whole of "the context stays as long as it has not ended".
  db.items.get(`${PK}|META`).status = "completed";
  const frozen = await call(port, "POST", messages, { identity: "bob@example.com", body: { text: "one more" } });
  assert.deepEqual([frozen.status, frozen.body.error], [409, "journey_completed"]);
  assert.equal((await call(port, "GET", messages, { identity: "bob@example.com" })).status, 200, "still readable");
  // Refusing this would leave a badge nobody could ever clear.
  assert.equal(
    (await call(port, "POST", `/journeys/${JOURNEY}/read`, { identity: "bob@example.com", body: { at: NOW } })).status,
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
  await call(port, "POST", `/journeys/${JOURNEY}/read`, {
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

  server.close();
  await c.shutdown?.();
  console.log(`\n${passed} passed`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
