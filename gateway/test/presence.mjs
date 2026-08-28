// Contact presence (docs 18 §5). The gateway's first non-kelabo-scoped browser
// stream. These tests drive real /presence/stream connections against a real
// server and assert the online/offline fan-out and the multi-tab reference
// count — the two things a second implementation would get wrong.
import http from "node:http";
import assert from "node:assert/strict";
import { createContainer } from "../src/container.js";
import { createGateway } from "../src/server.js";
import { signJwt } from "../src/cookies.js";

const KEY = "test-secret-key";
const NOW = Date.now();

const db = { send: async () => ({ Items: [] }) };
const s3 = { send: async () => ({}) };
const secrets = { send: async () => ({ SecretString: KEY }) };

const config = {
  env: "test",
  region: "us-east-1",
  tenantId: "example.com",
  allowedEmailDomain: "example.com",
  portalUrl: "http://portal.test",
  tableNames: { kelabos: "t-kelabos", history: "t-history", mcp: "t-mcp", refresh: "t-refresh", contacts: "t-contacts" },
  contacts: { external: false },
  archiveBucket: "t-bucket",
  archiveKeyPrefix: "archives",
  secrets: { cookieSigningKey: "t/cookie" },
  rtcApiBase: "http://rtc.test/v1",
  rtc: { defaultMode: "sfu", meshMaxParticipants: 6, iceTtlSeconds: 3600, video: false },
  llm: { provider: "fake", model: "fake", smallModel: "fake" },
  openaiBaseUrl: "http://unused",
  gateway: { agent: { maxConcurrentRuns: 2, sensitivity: "medium", maxContributionsPerMinute: 3, cooldownSeconds: 45, rollingWindowSize: 10, turnTimeoutSeconds: 0.1 } },
  retentionDays: 30,
};

function sessionCookie(identity, tenantId = "example.com") {
  return signJwt({ kind: "identity", identity, tenantId, exp: Math.floor(NOW / 1000) + 3600 }, KEY);
}

/** Open a /presence/stream and collect parsed `presence` events. Returns a
 *  handle with `.events`, `.res` (to close the tab), and `.waitFor`. */
function connectPresence(port, identity, tenantId) {
  return new Promise((resolve, reject) => {
    const r = http.request(
      { host: "127.0.0.1", port, path: "/presence/stream", method: "GET", headers: { cookie: `kelabo_session=${sessionCookie(identity, tenantId)}` } },
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
            if (ev && data) events.push(JSON.parse(data));
          }
        });
        resolve({ res, events, req: r });
      }
    );
    r.on("error", reject);
    r.end();
  });
}

function statusOf(port, path, cookie) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: "127.0.0.1", port, path, method: "GET", headers: cookie ? { cookie } : {} }, (res) => {
      res.on("data", () => {});
      res.on("end", () => resolve(res.statusCode));
    });
    r.on("error", reject);
    r.end();
  });
}

/** Raw bytes off a presence stream, with the ping interval shortened so the
 *  keepalive lands inside the test rather than 25 seconds later. */
function rawPresenceFrames(port, identity, ms = 250) {
  return new Promise((resolve, reject) => {
    const r = http.request(
      { host: "127.0.0.1", port, path: "/presence/stream", method: "GET", headers: { cookie: `kelabo_session=${sessionCookie(identity)}` } },
      (res) => {
        let buf = "";
        res.on("data", (d) => { buf += d.toString("utf8"); });
        res.on("error", () => {});
        setTimeout(() => { r.destroy(); resolve(buf); }, ms);
      }
    );
    // Tearing down mid-stream is the point of this helper, so the reset it
    // provokes is expected rather than a failure.
    r.on("error", () => {});
    r.end();
  });
}

const internalJwt = (sub) => signJwt({ sub, aud: "gateway-internal", iat: Math.floor(NOW / 1000), exp: Math.floor(NOW / 1000) + 300 }, KEY);

function internalPost(port, path, sub, body = {}) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const r = http.request(
      { host: "127.0.0.1", port, path, method: "POST", headers: { authorization: `Bearer ${internalJwt(sub)}`, "content-type": "application/json" } },
      (res) => {
        const chunks = [];
        res.on("data", (d) => chunks.push(d));
        res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") }));
      }
    );
    r.on("error", reject);
    r.write(payload);
    r.end();
  });
}

const waitFor = async (fn, ms = 3000, step = 15) => {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const v = fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, step));
  }
  throw new Error("waitFor timeout");
};

let passed = 0;
function ok(name) { console.log("ok:", name); passed++; }

async function main() {
  const c = await createContainer({ config, db, s3, secrets, skipRebuild: true, presencePingMs: 60 });
  const server = createGateway(c);
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;

  // Unauthenticated is refused.
  {
    const s = await statusOf(port, "/presence/stream");
    assert.equal(s, 401);
    ok("/presence/stream requires a session cookie");
  }

  // Alice connects first, alone → her snapshot is empty (nobody else online).
  const alice = await connectPresence(port, "alice@example.com");
  await waitFor(() => alice.events.find((e) => e.kind === "snapshot"));
  {
    const snap = alice.events.find((e) => e.kind === "snapshot");
    assert.deepEqual(snap.online, []);
    ok("first subscriber gets an empty snapshot");
  }

  // Bob connects → his snapshot lists Alice (same tenant), and Alice is told Bob
  // came online.
  const bob = await connectPresence(port, "bob@example.com");
  await waitFor(() => bob.events.find((e) => e.kind === "snapshot"));
  {
    const snap = bob.events.find((e) => e.kind === "snapshot");
    assert.deepEqual(snap.online.map((o) => o.identity), ["alice@example.com"]);
    ok("a later subscriber's snapshot lists who is already online in the tenant");
  }
  await waitFor(() => alice.events.find((e) => e.kind === "online" && e.identity === "bob@example.com"));
  ok("an existing subscriber is told when a colleague comes online");

  // Carol at another tenant sees nobody here, and nobody here hears about her.
  const carol = await connectPresence(port, "carol@other.com", "other.com");
  await waitFor(() => carol.events.find((e) => e.kind === "snapshot"));
  {
    const snap = carol.events.find((e) => e.kind === "snapshot");
    assert.deepEqual(snap.online, []);
    // Give any (erroneous) cross-tenant fan-out a moment to arrive.
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(alice.events.some((e) => e.identity === "carol@other.com"), false);
    ok("presence never crosses a tenant boundary");
  }
  carol.res.destroy();

  // Alice opens a SECOND tab. Bob must NOT get a second "online" for her, and
  // closing the second tab must NOT mark her offline — she still has the first.
  const bobOnlineBefore = bob.events.filter((e) => e.kind === "online" && e.identity === "alice@example.com").length;
  const alice2 = await connectPresence(port, "alice@example.com");
  await waitFor(() => alice2.events.find((e) => e.kind === "snapshot"));
  await new Promise((r) => setTimeout(r, 50));
  {
    const now = bob.events.filter((e) => e.kind === "online" && e.identity === "alice@example.com").length;
    assert.equal(now, bobOnlineBefore, "a second tab does not re-announce online");
    ok("a second tab does not fire a duplicate online");
  }
  alice2.res.destroy();
  await new Promise((r) => setTimeout(r, 80));
  {
    assert.equal(bob.events.some((e) => e.kind === "offline" && e.identity === "alice@example.com"), false,
      "closing one of two tabs must not mark her offline");
    ok("closing one tab of two does not fire offline");
  }

  // --- ring (docs 18 §6) ---------------------------------------------------
  // Bob rings Alice (online) and Dave (offline). Alice gets ring_incoming; Dave
  // is reported offline.
  {
    const base = alice.events.length;
    const res = await internalPost(port, `/internal/kelabos/huddle-1/ring`, "bob@example.com", {
      targets: ["alice@example.com", "dave@example.com"],
      title: "Quick sync",
      fromName: "Bob",
    });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.rung, ["alice@example.com"]);
    assert.deepEqual(res.body.offline, ["dave@example.com"]);
    const inc = await waitFor(() => alice.events.slice(base).find((e) => e.kind === "ring_incoming"));
    assert.equal(inc.kelaboId, "huddle-1");
    assert.equal(inc.from, "bob@example.com");
    assert.equal(inc.fromName, "Bob");
    ok("ring reaches an online target and reports an offline one");
  }

  // Alice answers → Bob gets ring_answer; Alice's own devices get ring_cancelled.
  {
    const bobBase = bob.events.length;
    const aliceBase = alice.events.length;
    await internalPost(port, `/internal/kelabos/huddle-1/ring/answer`, "alice@example.com", { response: "accepted" });
    const ans = await waitFor(() => bob.events.slice(bobBase).find((e) => e.kind === "ring_answer"));
    assert.equal(ans.from, "alice@example.com");
    assert.equal(ans.response, "accepted");
    await waitFor(() => alice.events.slice(aliceBase).find((e) => e.kind === "ring_cancelled"));
    ok("answering relays to the ringer and stops the callee's ring");
  }

  // A fresh ring can be cancelled by the ringer.
  {
    await internalPost(port, `/internal/kelabos/huddle-2/ring`, "bob@example.com", { targets: ["alice@example.com"], fromName: "Bob" });
    await waitFor(() => alice.events.find((e) => e.kind === "ring_incoming" && e.kelaboId === "huddle-2"));
    const base = alice.events.length;
    await internalPost(port, `/internal/kelabos/huddle-2/ring/cancel`, "bob@example.com");
    await waitFor(() => alice.events.slice(base).find((e) => e.kind === "ring_cancelled" && e.kelaboId === "huddle-2"));
    ok("the ringer can cancel and the callee's ring stops");
  }

  // Now close Alice's last tab → Bob gets offline for her.
  alice.res.destroy();
  await waitFor(() => bob.events.find((e) => e.kind === "offline" && e.identity === "alice@example.com"));
  ok("closing the last tab fires offline to watchers");

  // The keepalive is a NAMED event, not the SSE comment it used to be.
  // A comment keeps the TCP connection warm but is invisible to EventSource,
  // so the client cannot tell a quiet stream from a half-open socket — and
  // with leg messages riding this stream (docs 20 §19.9), a dead socket
  // means a person silently stops being told anything. The client's watchdog
  // is built on seeing this event, so its name is part of the contract.
  {
    const raw = await rawPresenceFrames(port, "alice@example.com");
    assert.ok(raw.includes("event: ping"), `expected a named ping frame, got: ${JSON.stringify(raw.slice(0, 200))}`);
    assert.ok(!/^: ping/m.test(raw), "the invisible comment form must not come back");
    ok("the keepalive is a named event the client can actually see");
  }

  bob.res.destroy();
  await new Promise((r) => setTimeout(r, 30));
  await new Promise((r) => server.close(r));
  await c.shutdown?.();

  console.log(`\n${passed} presence tests passed`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
