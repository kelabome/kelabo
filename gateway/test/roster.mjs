// The live roster (`roster` SSE event): who is in a kelabo RIGHT NOW.
//
// This is not the kelabo META's `participants`, which is an append-only join
// ledger and only ever climbs, and it is not the call roster, which cannot see
// a board-only participant. It is derived from the SSE subscribers, so these
// tests drive real /caption/replies streams and assert the three things a
// second implementation gets wrong: tabs are one person, a reload does not make
// the number dip, and a genuine departure eventually does.
import http from "node:http";
import assert from "node:assert/strict";
import { createContainer } from "../src/container.js";
import { createGateway } from "../src/server.js";
import { signJwt } from "../src/cookies.js";

const KEY = "test-secret-key";
const NOW = Date.now();
// Long enough to observe as a grace window, short enough to wait out.
const GRACE_SECONDS = 0.4;

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
  rtc: { defaultMode: "sfu", meshMaxParticipants: 6, iceTtlSeconds: 3600, disconnectGraceSeconds: GRACE_SECONDS, video: false },
  llm: { provider: "fake", model: "fake", smallModel: "fake" },
  openaiBaseUrl: "http://unused",
  gateway: { agent: { maxConcurrentRuns: 1, sensitivity: "medium", maxContributionsPerMinute: 3, cooldownSeconds: 45, rollingWindowSize: 10, turnTimeoutSeconds: 0.1 } },
  retentionDays: 30,
};

const cookieFor = (kelaboId, identity) =>
  signJwt(
    { kind: "participant", kelaboId, identity, tenantId: "example.com", isGuest: false, exp: Math.floor(NOW / 1000) + 3600 },
    KEY,
  );

/** Open a /caption/replies stream and collect the `roster` events it receives. */
function connectSse(port, kelaboId, cookie) {
  return new Promise((resolve, reject) => {
    const r = http.request(
      {
        host: "127.0.0.1",
        port,
        path: `/caption/replies?kelaboId=${kelaboId}`,
        method: "GET",
        headers: { cookie: `kelabo_participant=${cookie}` },
      },
      (res) => {
        if (res.statusCode !== 200) return reject(new Error(`sse status ${res.statusCode}`));
        const roster = [];
        const notices = [];
        let buf = "";
        res.on("data", (d) => {
          buf += d.toString("utf8");
          let i;
          while ((i = buf.indexOf("\n\n")) >= 0) {
            const block = buf.slice(0, i);
            buf = buf.slice(i + 2);
            const ev = block.match(/^event: (.+)$/m)?.[1];
            const data = block.match(/^data: (.+)$/m)?.[1];
            if (ev === "roster" && data) roster.push(JSON.parse(data));
            if (ev === "notice" && data) notices.push(JSON.parse(data));
          }
        });
        resolve({ res, roster, notices, last: () => roster[roster.length - 1] });
      },
    );
    r.on("error", reject);
    r.end();
  });
}

const waitFor = async (fn, ms = 3000, step = 20) => {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > ms) throw new Error("waitFor timeout");
    await new Promise((r) => setTimeout(r, step));
  }
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
const ok = (msg) => { passed += 1; console.log("ok:", msg); };

async function main() {
  const c = await createContainer({ config, db, s3, secrets, skipRebuild: true });
  const server = createGateway(c);
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;

  const K = "m-roster";

  // The first stream is told the roster immediately — there is no other way for
  // a tab to learn the headcount, since the REST API runs in a Lambda and
  // cannot see this.
  const alice = await connectSse(port, K, cookieFor(K, "alice@example.com"));
  {
    const first = await waitFor(() => alice.last());
    assert.equal(first.count, 1);
    assert.deepEqual(first.participants, ["alice@example.com"]);
    ok("a subscriber is sent the roster on connect");
  }

  // A second person is fanned out to everyone, not just to themselves.
  const bob = await connectSse(port, K, cookieFor(K, "bob@example.com"));
  {
    await waitFor(() => alice.last()?.count === 2);
    const seen = await waitFor(() => bob.last());
    assert.deepEqual(seen.participants, ["alice@example.com", "bob@example.com"]);
    ok("a joiner raises the count for everyone already in the kelabo");
  }

  // A second TAB of the same person is the same person. This is the case the
  // META's participants list gets right and the tile count gets wrong.
  const aliceTab2 = await connectSse(port, K, cookieFor(K, "alice@example.com"));
  {
    await waitFor(() => aliceTab2.last());
    await sleep(50);
    assert.equal(alice.last().count, 2, "still two people");
    assert.equal(bob.roster.filter((r) => r.count === 3).length, 0, "nobody was told there were three");
    ok("a second tab is not a second participant");
  }

  // Closing one of two tabs changes nothing: the identity still has a stream.
  {
    const before = bob.roster.length;
    aliceTab2.res.destroy();
    await sleep(GRACE_SECONDS * 1000 + 150);
    assert.equal(bob.roster.length, before, "no roster event at all — nothing changed");
    assert.equal(bob.last().count, 2);
    ok("closing one tab of two does not change the count");
  }

  // A reload — the last stream closes and comes straight back — must not make
  // the number visibly dip. That is what the grace window is for.
  {
    const before = bob.roster.length;
    bob.res.destroy();
    await sleep(60);
    const bobAgain = await connectSse(port, K, cookieFor(K, "bob@example.com"));
    await waitFor(() => bobAgain.last());
    await sleep(GRACE_SECONDS * 1000 + 150);
    assert.equal(alice.roster.slice(before).some((r) => r.count === 1), false, "the count never dipped to 1");
    assert.equal(alice.last().count, 2);
    ok("a reload inside the grace window never lowers the count");
    bobAgain.res.destroy();
  }

  // A real departure does lower it, once the window expires.
  {
    await waitFor(() => alice.last()?.count === 1, 3000);
    assert.deepEqual(alice.last().participants, ["alice@example.com"]);
    ok("leaving lowers the count after the grace window");
  }

  // The notice channel: a room-level event fanned to every subscriber and
  // never persisted — no db write, no board contribution.
  {
    c.sseHub.notice(K, { scope: "assistant", reason: "clock" });
    await waitFor(() => alice.notices.length === 1);
    assert.deepEqual(alice.notices[0], { scope: "assistant", reason: "clock" });
    c.sseHub.notice("m-nobody-here", { scope: "sfu" }); // no subscribers: a no-op, not a crash
    ok("notice() fans an ephemeral event to the room's subscribers");
  }

  // Ending the kelabo closes every stream; the pending timers must not outlive
  // it and fire against a room nobody is in.
  {
    c.sseHub.ended(K);
    await sleep(GRACE_SECONDS * 1000 + 100);
    assert.deepEqual(c.sseHub.roster(K), { count: 0, participants: [] });
    ok("ending the kelabo clears the roster and its pending timers");
  }

  alice.res.destroy();
  server.close();
  await c.shutdown?.();
  console.log(`\n${passed} roster assertions passed`);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
