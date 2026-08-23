// Conference-audio signalling tests (docs 15). Offline: the Cloudflare Realtime
// client is replaced with a recording stub, so nothing leaves the machine and
// no credentials are needed. Exercises the real HTTP routes through the real
// container, the same way test/smoke.mjs does.
import http from "node:http";
import assert from "node:assert/strict";
import { createContainer } from "../src/container.js";
import { createGateway } from "../src/server.js";
import { createCloudflareRtc } from "../src/rtc/cloudflare.js";
import { signJwt } from "../src/cookies.js";

const KEY = "test-secret-key";
const NOW = Date.now();
const MESH_MAX = 3;

// Two kelabos, so a pull can be aimed across the boundary between them.
const METAS = {
  "m-sfu": { rtcMode: "sfu" },
  "m-other": { rtcMode: "sfu" },
  "m-mesh": { rtcMode: "mesh" },
  // Demotion (docs 15 §1.1): one room small enough for mesh to carry, one not.
  "m-demote": { rtcMode: "sfu" },
  "m-big": { rtcMode: "sfu" },
  // Exactly its second META read fails — the shape of a DynamoDB blip landing
  // between the route's own getMeta and the room's modeFor.
  "m-flaky": { rtcMode: "mesh" },
};

let flakyReads = 0;

function metaItem(kelaboId) {
  return {
    PK: `KELABO#${kelaboId}`,
    SK: "META",
    kelaboId,
    status: "active",
    title: kelaboId,
    hostIdentity: "alice@example.com",
    startedAt: NOW - 60_000,
    rtcMode: METAS[kelaboId].rtcMode,
    participants: [
      { identity: "alice@example.com", displayName: "Alice", isGuest: false },
      { identity: "bob@example.com", displayName: "Bob", isGuest: false },
      { identity: "carol@example.com", displayName: "Carol", isGuest: false },
      { identity: "dave@example.com", displayName: "Dave", isGuest: false },
    ],
    tenantId: "example.com",
  };
}

// Every META write, so a demotion can be checked for having made itself
// durable — an in-process mode change alone is undone by the next restart.
const metaWrites = [];

const db = {
  send: async (cmd) => {
    const name = cmd.constructor.name;
    if (name === "UpdateCommand") metaWrites.push(cmd.input);
    if (name === "GetCommand") {
      const pk = String(cmd.input.Key.PK ?? "");
      const id = pk.startsWith("KELABO#") ? pk.slice("KELABO#".length) : "";
      if (id === "m-flaky" && cmd.input.Key.SK === "META") {
        flakyReads += 1;
        // Exactly the second read fails: the route's own getMeta succeeds, the
        // room's modeFor read hits the blip. Later reads succeed again.
        if (flakyReads === 2) throw new Error("dynamo blinked");
        return { Item: metaItem(id) };
      }
      if (METAS[id] && cmd.input.Key.SK === "META") return { Item: metaItem(id) };
      return {};
    }
    if (name === "QueryCommand") return { Items: [] };
    return {};
  },
};
const secrets = { send: async () => ({ SecretString: KEY }) };

const config = {
  env: "test",
  region: "us-east-1",
  tenantId: "example.com",
  allowedEmailDomain: "example.com",
  portalUrl: "http://portal.test",
  tableNames: { kelabos: "t-kelabos", history: "t-history", mcp: "t-mcp" },
  archiveBucket: "t-bucket",
  archiveKeyPrefix: "archives",
  secrets: { llm: "t/llm", cookieSigningKey: "t/cookie", mcpPrefix: "t/mcp/", cloudflareRealtime: "t/cf" },
  rtcApiBase: "http://rtc.test/v1",
  // Grace 0 keeps the eviction tests immediate; the grace-window behaviour has
  // its own container below.
  rtc: { defaultMode: "sfu", meshMaxParticipants: MESH_MAX, iceTtlSeconds: 3600, disconnectGraceSeconds: 0, video: false },
  llm: { provider: "fake", model: "fake", smallModel: "fake" },
  openaiBaseUrl: "http://unused",
  gateway: { agent: { maxConcurrentRuns: 1, sensitivity: "medium", maxContributionsPerMinute: 3, cooldownSeconds: 45, rollingWindowSize: 10, turnTimeoutSeconds: 0.1 } },
  retentionDays: 30,
};

// Recording stand-in for gateway/src/rtc/cloudflare.js.
function createRtcStub() {
  const calls = [];
  let seq = 0;
  return {
    calls,
    async newSession(sessionDescription) {
      calls.push({ op: "newSession", sessionDescription });
      return { sessionId: `cf-${++seq}`, sessionDescription: { type: "answer", sdp: "v=0 answer" } };
    },
    // `rejectTrackNames` reproduces the shape that matters most here: Cloudflare
    // reports a refused track *inside* a 200, per track, with an empty mid.
    rejectTrackNames: new Set(),
    async newTracks(sessionId, body) {
      calls.push({ op: "newTracks", sessionId, body });
      const tracks = body.tracks.map((t) =>
        this.rejectTrackNames.has(t.trackName)
          ? { ...t, mid: "", errorCode: "not_found_track_error", errorDescription: "Track not found on remote peer" }
          : t,
      );
      return { requiresImmediateRenegotiation: false, tracks };
    },
    async renegotiate(sessionId, sessionDescription) {
      calls.push({ op: "renegotiate", sessionId, sessionDescription });
      return {};
    },
    async closeTracks(sessionId, body) {
      calls.push({ op: "closeTracks", sessionId, body });
      return { tracks: body.tracks };
    },
    // Settable per test: a slow Cloudflare API must not delay the roster.
    getSessionDelayMs: 0,
    async getSession(sessionId) {
      calls.push({ op: "getSession", sessionId });
      if (this.getSessionDelayMs) await new Promise((r) => setTimeout(r, this.getSessionDelayMs));
      return { tracks: [{ mid: "0", trackName: "mic" }] };
    },
    async iceServers(ttl) {
      calls.push({ op: "iceServers", ttl });
      return { iceServers: [{ urls: ["stun:stun.cloudflare.com:3478"] }], relay: true };
    },
  };
}

const cookieFor = (kelaboId, identity) =>
  signJwt(
    { kind: "participant", kelaboId, identity, tenantId: "example.com", isGuest: false, exp: Math.floor(NOW / 1000) + 3600 },
    KEY,
  );

function req(port, { method = "POST", path, cookie, body } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request(
      {
        host: "127.0.0.1",
        port,
        path,
        method,
        headers: { ...(cookie ? { cookie: `kelabo_participant=${cookie}` } : {}), "content-type": "application/json" },
      },
      (res) => {
        const chunks = [];
        res.on("data", (d) => chunks.push(d));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json = null;
          try { json = text ? JSON.parse(text) : null; } catch {}
          resolve({ status: res.statusCode, body: json, text });
        });
      },
    );
    r.on("error", reject);
    r.write(JSON.stringify(body ?? {}));
    r.end();
  });
}

// An SSE subscriber that records the `rtc` events it receives, so we can assert
// both fan-out (everyone) and targeted delivery (exactly one peer).
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
        const rtc = [];
        let buf = "";
        res.on("data", (d) => {
          buf += d.toString("utf8");
          let i;
          while ((i = buf.indexOf("\n\n")) >= 0) {
            const block = buf.slice(0, i);
            buf = buf.slice(i + 2);
            const ev = block.match(/^event: (.+)$/m)?.[1];
            const data = block.match(/^data: (.+)$/m)?.[1];
            if (ev === "rtc" && data) rtc.push(JSON.parse(data));
          }
        });
        resolve({ res, rtc });
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

let passed = 0;
const ok = (msg) => { passed += 1; console.log("ok:", msg); };

// The route tests below stub the Cloudflare client out entirely, so these
// exercise the real one against a fake fetch — the wire shape is the part that
// only the live API can contradict.
async function testCloudflareClient() {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url, init });
    return { ok: true, status: 200, text: async () => JSON.stringify({ sessionId: "cf-1" }) };
  };
  const client = createCloudflareRtc({
    apiBase: "http://rtc.test/v1",
    getCreds: async () => ({ sfuAppId: "app", sfuAppSecret: "sec", turnKeyId: "k", turnKeyApiToken: "kt" }),
    fetchImpl,
  });

  await client.newSession();
  const bare = seen.at(-1);
  // Cloudflare validates the body whenever one is present, so a session created
  // without an offer must send NO body — `{}` is rejected in production with
  // `decoding_error: sessionDescription`.
  assert.equal(bare.init.body, undefined, "sessions/new without an offer sends no body");
  assert.equal(bare.init.headers["Content-Type"], undefined, "and no Content-Type either");
  assert.equal(bare.init.headers.Authorization, "Bearer sec");
  ok("sessions/new with no offer sends no body at all (Cloudflare rejects `{}`)");

  await client.newSession({ type: "offer", sdp: "v=0" });
  const withOffer = seen.at(-1);
  assert.deepEqual(JSON.parse(withOffer.init.body), { sessionDescription: { type: "offer", sdp: "v=0" } });
  assert.equal(withOffer.init.headers["Content-Type"], "application/json");
  ok("sessions/new with an offer sends it as sessionDescription");

  // TURN is a different key and a different token — mixing them up would fail
  // only at runtime, on the network.
  await client.iceServers(3600);
  const ice = seen.at(-1);
  assert.match(ice.url, /\/turn\/keys\/k\/credentials\/generate-ice-servers$/);
  assert.equal(ice.init.headers.Authorization, "Bearer kt", "TURN uses the TURN key token, not the app secret");
  ok("iceServers uses the TURN key id + token, not the SFU app credentials");

  await client.newTracks("cf-1", { tracks: [{ location: "local", trackName: "mic", mid: "0" }] });
  assert.equal(seen.at(-1).init.method, "POST");
  await client.renegotiate("cf-1", { type: "answer", sdp: "v=0" });
  assert.equal(seen.at(-1).init.method, "PUT");
  ok("tracks/new is POST and renegotiate is PUT");
}

async function main() {
  await testCloudflareClient();

  const rtc = createRtcStub();
  const c = await createContainer({ config, db, s3: { send: async () => ({}) }, secrets, rtc, skipRebuild: true });
  const server = createGateway(c);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;

  const aliceSfu = cookieFor("m-sfu", "alice@example.com");
  const bobSfu = cookieFor("m-sfu", "bob@example.com");

  // --- SFU: join, roster fan-out --------------------------------------------
  const aliceStream = await connectSse(port, "m-sfu", aliceSfu);

  {
    const res = await req(port, { path: "/rtc/join", cookie: aliceSfu, body: { kelaboId: "m-sfu" } });
    assert.equal(res.status, 200);
    assert.equal(res.body.mode, "sfu");
    assert.equal(res.body.self.displayName, "Alice");
    assert.deepEqual(res.body.peers, []);
    assert.ok(res.body.iceServers.length > 0, "ICE servers handed to the client");
    assert.equal(res.body.ttlSeconds, 3600, "the client schedules its own TURN re-mint from this");
    ok("POST /rtc/join → mode from META, own peer, empty roster, ICE servers + TTL");
  }

  {
    const res = await req(port, { path: "/rtc/join", cookie: bobSfu, body: { kelaboId: "m-sfu" } });
    assert.equal(res.status, 200);
    assert.equal(res.body.peers.length, 1);
    assert.equal(res.body.peers[0].participantId, "alice@example.com");
    const ev = await waitFor(() => aliceStream.rtc.find((e) => e.kind === "peer_joined" && e.peer.participantId === "bob@example.com"));
    assert.ok(ev);
    ok("a second join → joiner sees the roster, the room gets peer_joined");
  }

  {
    const res = await req(port, { path: "/rtc/join", cookie: cookieFor("m-sfu", "alice@example.com"), body: { kelaboId: "m-other" } });
    assert.equal(res.status, 403);
    ok("a body kelaboId that disagrees with the cookie → 403");
  }

  // --- SFU: session binding + publish ----------------------------------------
  let aliceSession;
  let bobSession;
  {
    const res = await req(port, {
      path: "/rtc/sfu/session",
      cookie: aliceSfu,
      body: { kelaboId: "m-sfu", sessionDescription: { type: "offer", sdp: "v=0 alice" } },
    });
    assert.equal(res.status, 200);
    aliceSession = res.body.sessionId;
    assert.ok(aliceSession);
    assert.equal(c.rtcRoom.peer("m-sfu", "alice@example.com").sfuSessionId, aliceSession);
    ok("POST /rtc/sfu/session → Cloudflare session bound to the caller's peer record");

    const bob = await req(port, { path: "/rtc/sfu/session", cookie: bobSfu, body: { kelaboId: "m-sfu" } });
    bobSession = bob.body.sessionId;
  }

  {
    const res = await req(port, {
      path: "/rtc/sfu/tracks",
      cookie: aliceSfu,
      body: {
        kelaboId: "m-sfu",
        sessionDescription: { type: "offer", sdp: "v=0 alice pub" },
        tracks: [{ location: "local", trackName: "mic", mid: "0", kind: "audio" }],
      },
    });
    assert.equal(res.status, 200);
    const call = rtc.calls.filter((x) => x.op === "newTracks").at(-1);
    assert.equal(call.sessionId, aliceSession, "proxied against the caller's own session");
    assert.equal(call.body.tracks[0].kind, undefined, "our `kind` field is stripped before Cloudflare sees it");
    assert.deepEqual(c.rtcRoom.peer("m-sfu", "alice@example.com").tracks, { audio: "mic" });
    const ev = await waitFor(() => aliceStream.rtc.find((e) => e.kind === "tracks" && e.peer.participantId === "alice@example.com"));
    assert.equal(ev.peer.tracks.audio, "mic");
    ok("publishing a local track records it on the peer and announces it to the room");
  }

  {
    // A track Cloudflare refuses must not reach the roster. Announcing it
    // anyway is what had every other participant spend the kelabo pulling a
    // track that was never published — the failure was reported in a 200 body
    // and nothing read it.
    rtc.rejectTrackNames.add("cam");
    const res = await req(port, {
      path: "/rtc/sfu/tracks",
      cookie: aliceSfu,
      body: {
        kelaboId: "m-sfu",
        sessionDescription: { type: "offer", sdp: "v=0 alice cam" },
        tracks: [{ location: "local", trackName: "cam", mid: "1", kind: "video" }],
      },
    });
    assert.equal(res.status, 200, "the proxy still reports what Cloudflare said");
    assert.deepEqual(
      c.rtcRoom.peer("m-sfu", "alice@example.com").tracks,
      { audio: "mic" },
      "the refused camera is absent from the roster",
    );
    rtc.rejectTrackNames.delete("cam");
    ok("a track Cloudflare rejects inside a 200 is not announced to the room");
  }

  {
    // Rebuilding a session — after a reload, or after Cloudflare declared the
    // old one disconnected — leaves every track that was published on it
    // nowhere. The roster only ever added before, so peers went on pulling
    // tracks that existed on a session nobody held any more, once per reconcile
    // tick, for the rest of the kelabo.
    const before = c.rtcRoom.peer("m-sfu", "alice@example.com").sfuSessionId;
    const res = await req(port, {
      path: "/rtc/sfu/session",
      cookie: aliceSfu,
      body: { kelaboId: "m-sfu", sessionDescription: { type: "offer", sdp: "v=0 alice again" } },
    });
    assert.equal(res.status, 200);
    assert.notEqual(res.body.sessionId, before, "a rebuild is a genuinely new session");
    assert.deepEqual(
      c.rtcRoom.peer("m-sfu", "alice@example.com").tracks,
      {},
      "the old session's tracks are forgotten with it",
    );
    const ev = await waitFor(() =>
      aliceStream.rtc.find(
        (e) => e.kind === "tracks" && e.peer.participantId === "alice@example.com" && !e.peer.tracks.audio,
      ),
    );
    assert.equal(ev.peer.sfuSessionId, res.body.sessionId, "peers are told which session to pull from now");
    ok("rebinding a peer to a new SFU session retracts the tracks the old one published");

    // Put alice back the way the rest of the suite expects her.
    aliceSession = res.body.sessionId;
    await req(port, {
      path: "/rtc/sfu/tracks",
      cookie: aliceSfu,
      body: {
        kelaboId: "m-sfu",
        sessionDescription: { type: "offer", sdp: "v=0 alice republish" },
        tracks: [{ location: "local", trackName: "mic", mid: "0", kind: "audio" }],
      },
    });
  }

  {
    const res = await req(port, {
      path: "/rtc/sfu/tracks",
      cookie: bobSfu,
      body: {
        kelaboId: "m-sfu",
        tracks: [{ location: "remote", trackName: "mic", sessionId: aliceSession, kind: "audio" }],
      },
    });
    assert.equal(res.status, 200);
    ok("pulling a peer's track in the same kelabo is allowed");
  }

  {
    // Naming the publisher instead of their session is what stops a stale
    // roster reading as a permission failure: two people reloading seconds
    // apart left one holding a session id the other had already replaced, and
    // an ordinary reconnect logged a 403.
    const res = await req(port, {
      path: "/rtc/sfu/tracks",
      cookie: bobSfu,
      body: {
        kelaboId: "m-sfu",
        tracks: [{ location: "remote", trackName: "mic", participantId: "alice@example.com", kind: "audio" }],
      },
    });
    assert.equal(res.status, 200);
    const call = rtc.calls.filter((x) => x.op === "newTracks").at(-1);
    assert.equal(call.body.tracks[0].sessionId, aliceSession, "resolved from the roster, not the request");
    assert.equal(call.body.tracks[0].participantId, undefined, "our field never reaches Cloudflare");
    ok("a remote pull may name the publisher and have the Gateway resolve their session");
  }

  {
    const res = await req(port, {
      path: "/rtc/sfu/tracks",
      cookie: bobSfu,
      body: {
        kelaboId: "m-sfu",
        tracks: [{ location: "remote", trackName: "mic", participantId: "nobody@example.com", kind: "audio" }],
      },
    });
    assert.equal(res.status, 403, "a participant who is not on this call is still refused");
    ok("naming a participant outside the kelabo → 403");
  }

  {
    // Mute and camera state is the one thing about a call that cannot be read
    // from the media: `track.enabled = false` never reaches the wire, and a
    // camera switched off is a sender that stopped sending on a transceiver
    // that is still there.
    const res = await req(port, {
      path: "/rtc/media",
      cookie: aliceSfu,
      body: { kelaboId: "m-sfu", audio: false, video: true },
    });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.media, { audio: false, video: true, screen: false });
    const ev = await waitFor(() =>
      aliceStream.rtc.find((e) => e.kind === "media" && e.peer.participantId === "alice@example.com"),
    );
    assert.equal(ev.peer.media.audio, false, "the room is told, not just the caller");
    ok("POST /rtc/media records mic/camera state and fans it to the room");

    // Reporting the same thing twice is not a roster change. Without this a
    // client that re-reports on every render would fan an event per keystroke.
    const before = aliceStream.rtc.length;
    await req(port, {
      path: "/rtc/media",
      cookie: aliceSfu,
      body: { kelaboId: "m-sfu", audio: false },
    });
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(aliceStream.rtc.length, before, "an unchanged report fans nothing");
    ok("re-reporting unchanged media state does not churn the room");
  }

  {
    // The single most important check: an attacker holding a session id from
    // somewhere else must not be able to subscribe to it.
    const res = await req(port, {
      path: "/rtc/sfu/tracks",
      cookie: bobSfu,
      body: {
        kelaboId: "m-sfu",
        tracks: [{ location: "remote", trackName: "mic", sessionId: "cf-not-in-this-kelabo", kind: "audio" }],
      },
    });
    assert.equal(res.status, 403);
    assert.equal(res.body.error, "forbidden");
    ok("pulling a session that belongs to no peer of this kelabo → 403");
  }

  {
    const before = rtc.calls.length;
    const res = await req(port, {
      method: "PUT",
      path: "/rtc/sfu/renegotiate",
      cookie: bobSfu,
      // A hostile client cannot even express "renegotiate someone else's
      // session" — the schema has no sessionId, and the route resolves it from
      // the caller's peer record.
      body: { kelaboId: "m-sfu", sessionId: aliceSession, sessionDescription: { type: "answer", sdp: "v=0 bob" } },
    });
    assert.equal(res.status, 200);
    const call = rtc.calls.slice(before).find((x) => x.op === "renegotiate");
    assert.equal(call.sessionId, bobSession, "renegotiate always targets the caller's own session");
    ok("PUT /rtc/sfu/renegotiate ignores a body-supplied session id");
  }

  {
    const res = await req(port, {
      method: "PUT",
      path: "/rtc/sfu/tracks/close",
      cookie: bobSfu,
      body: { kelaboId: "m-sfu", tracks: [{ mid: "0" }] },
    });
    assert.equal(res.status, 200);
    assert.equal(rtc.calls.filter((x) => x.op === "closeTracks").at(-1).sessionId, bobSession);
    ok("PUT /rtc/sfu/tracks/close targets the caller's own session");
  }

  {
    const res = await req(port, { path: "/rtc/sfu/session", cookie: cookieFor("m-sfu", "carol@example.com"), body: { kelaboId: "m-sfu" } });
    assert.equal(res.status, 409);
    assert.equal(res.body.error, "peer_not_found");
    ok("SFU calls before /rtc/join → 409 peer_not_found");
  }

  // --- SFU: leaving ----------------------------------------------------------
  {
    const res = await req(port, { path: "/rtc/leave", cookie: bobSfu, body: { kelaboId: "m-sfu" } });
    assert.equal(res.status, 200);
    const ev = await waitFor(() => aliceStream.rtc.find((e) => e.kind === "peer_left" && e.participantId === "bob@example.com"));
    assert.equal(ev.reason, "left");
    assert.equal(c.rtcRoom.peer("m-sfu", "bob@example.com"), null);
    ok("POST /rtc/leave drops the peer and fans out peer_left");
  }

  {
    // The roster hears about a departure before the Cloudflare cleanup, not
    // after: those calls carry 10s timeouts each, and awaiting them first held
    // everyone's roster hostage to a slow third-party API.
    rtc.getSessionDelayMs = 300;
    const t0 = Date.now();
    const pending = req(port, { path: "/rtc/leave", cookie: aliceSfu, body: { kelaboId: "m-sfu" } });
    await waitFor(() =>
      aliceStream.rtc.find((e) => e.kind === "peer_left" && e.participantId === "alice@example.com"),
    );
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 250, `peer_left fanned before the slow Cloudflare cleanup (${elapsed}ms)`);
    await pending;
    rtc.getSessionDelayMs = 0;
    ok("peer_left is broadcast before the best-effort Cloudflare session cleanup");
  }

  // --- Mesh: signalling is point-to-point ------------------------------------
  const aliceMesh = cookieFor("m-mesh", "alice@example.com");
  const bobMesh = cookieFor("m-mesh", "bob@example.com");
  const carolMesh = cookieFor("m-mesh", "carol@example.com");

  const meshStreams = {
    alice: await connectSse(port, "m-mesh", aliceMesh),
    bob: await connectSse(port, "m-mesh", bobMesh),
    carol: await connectSse(port, "m-mesh", carolMesh),
  };

  for (const [cookie, who] of [[aliceMesh, "alice"], [bobMesh, "bob"], [carolMesh, "carol"]]) {
    const res = await req(port, { path: "/rtc/join", cookie, body: { kelaboId: "m-mesh" } });
    assert.equal(res.status, 200, `${who} joins mesh`);
    assert.equal(res.body.mode, "mesh");
  }
  ok("a mesh kelabo reports mode=mesh from its META, not the env default");

  {
    const res = await req(port, {
      path: "/rtc/signal",
      cookie: aliceMesh,
      body: { kelaboId: "m-mesh", to: "bob@example.com", signal: { type: "offer", sdp: "v=0 alice->bob" } },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.delivered, true);

    const got = await waitFor(() => meshStreams.bob.rtc.find((e) => e.kind === "signal"));
    assert.equal(got.from, "alice@example.com");
    assert.equal(got.signal.sdp, "v=0 alice->bob");
    // Carol is in the same room and must not see another pair's negotiation.
    assert.equal(meshStreams.carol.rtc.filter((e) => e.kind === "signal").length, 0);
    assert.equal(meshStreams.alice.rtc.filter((e) => e.kind === "signal").length, 0);
    ok("POST /rtc/signal reaches only the addressed peer");
  }

  {
    const res = await req(port, {
      path: "/rtc/signal",
      cookie: aliceMesh,
      body: { kelaboId: "m-mesh", to: "nobody@example.com", signal: { type: "bye" } },
    });
    assert.equal(res.status, 404);
    ok("signalling a participant who is not on the call → 404");
  }

  // --- Mesh: the cap is a refusal, never a downgrade -------------------------
  {
    const res = await req(port, { path: "/rtc/join", cookie: cookieFor("m-mesh", "dave@example.com"), body: { kelaboId: "m-mesh" } });
    assert.equal(res.status, 409);
    assert.equal(res.body.error, "mesh_room_full");
    assert.equal(res.body.meshMax, MESH_MAX);
    // The room must still be mesh — no silent promotion to the SFU.
    assert.equal(c.state.rtcRooms.get("m-mesh").mode, "mesh");
    ok(`joining a full mesh room (> ${MESH_MAX}) → 409 mesh_room_full, mode unchanged`);
  }

  {
    // Rejoining a seat you already hold is not a new participant.
    const res = await req(port, { path: "/rtc/join", cookie: carolMesh, body: { kelaboId: "m-mesh" } });
    assert.equal(res.status, 200);
    ok("rejoining an existing seat in a full mesh room still succeeds");
  }

  // --- Losing the event stream removes you from the call ---------------------
  {
    meshStreams.carol.res.destroy();
    await waitFor(() => c.rtcRoom.peer("m-mesh", "carol@example.com") === null);
    const ev = await waitFor(() => meshStreams.bob.rtc.find((e) => e.kind === "peer_left" && e.participantId === "carol@example.com"));
    assert.equal(ev.reason, "disconnected");
    ok("a dropped SSE stream removes the peer and fans out peer_left");
  }

  // --- A reconnecting stream must not evict a present participant ------------
  {
    // EventSource reconnects on its own, and the old connection's close often
    // lands *after* the replacement has subscribed. Evicting on that close
    // removed a participant who was sitting right there — which is what left
    // one person missing from everyone else's roster.
    const bobMesh2 = cookieFor("m-mesh", "bob@example.com");
    const second = await connectSse(port, "m-mesh", bobMesh2);
    await waitFor(() => c.state.sseSubscribers.get("m-mesh")?.size >= 3);

    // Close the ORIGINAL stream while the replacement is live.
    meshStreams.bob.res.destroy();
    await new Promise((r) => setTimeout(r, 150));

    assert.ok(c.rtcRoom.peer("m-mesh", "bob@example.com"), "bob survives losing one of two streams");
    assert.equal(
      meshStreams.alice.rtc.filter((e) => e.kind === "peer_left" && e.participantId === "bob@example.com").length,
      0,
      "no spurious peer_left was fanned out",
    );

    // Closing the last one is a genuine departure.
    second.res.destroy();
    await waitFor(() => c.rtcRoom.peer("m-mesh", "bob@example.com") === null);
    ok("a reconnecting stream does not evict the participant; the last close does");
  }

  // --- Mesh: screen shares occupy capacity units -----------------------------
  // The cap is participants PLUS active screen shares: a share is one more
  // uplink to every peer, which is the cost the cap exists to bound. In mesh
  // mode the Gateway never sees the media, so the `screen` flag on /rtc/media
  // is the admission gate.
  {
    // The room currently holds only alice. Bob rejoins: 2 units.
    const res = await req(port, { path: "/rtc/join", cookie: bobMesh, body: { kelaboId: "m-mesh" } });
    assert.equal(res.status, 200);

    // Alice starts sharing: 3 units — the room is now full at MESH_MAX=3.
    const share = await req(port, { path: "/rtc/media", cookie: aliceMesh, body: { kelaboId: "m-mesh", screen: true } });
    assert.equal(share.status, 200);
    assert.equal(share.body.media.screen, true);
    const ev = await waitFor(() =>
      meshStreams.alice.rtc.find((e) => e.kind === "media" && e.peer.participantId === "alice@example.com" && e.peer.media.screen === true),
    );
    assert.ok(ev, "the share is fanned to the room like any media change");
    ok("a mesh screen share is admitted and announced while there is room");
  }

  {
    // Two participants + one share = 3 units: a third PARTICIPANT is refused.
    const res = await req(port, { path: "/rtc/join", cookie: cookieFor("m-mesh", "dave@example.com"), body: { kelaboId: "m-mesh" } });
    assert.equal(res.status, 409);
    assert.equal(res.body.error, "mesh_room_full");
    assert.equal(res.body.meshMax, MESH_MAX);
    ok("a screen share counts against the mesh cap: a joiner past it → 409");
  }

  {
    // ...and a second SHARE is refused the same way.
    const res = await req(port, { path: "/rtc/media", cookie: bobMesh, body: { kelaboId: "m-mesh", screen: true } });
    assert.equal(res.status, 409);
    assert.equal(res.body.error, "mesh_room_full");
    assert.equal(res.body.meshMax, MESH_MAX);
    assert.equal(c.rtcRoom.peer("m-mesh", "bob@example.com").media.screen, false, "the refused share is not recorded");
    ok("a screen share past the cap → 409 mesh_room_full, nothing recorded");
  }

  {
    // Stopping the share frees its unit immediately.
    const stop = await req(port, { path: "/rtc/media", cookie: aliceMesh, body: { kelaboId: "m-mesh", screen: false } });
    assert.equal(stop.status, 200);
    const res = await req(port, { path: "/rtc/join", cookie: cookieFor("m-mesh", "dave@example.com"), body: { kelaboId: "m-mesh" } });
    assert.equal(res.status, 200, "the freed unit admits the joiner");
    // Full again (3 participants): no share fits any more.
    const share = await req(port, { path: "/rtc/media", cookie: aliceMesh, body: { kelaboId: "m-mesh", screen: true } });
    assert.equal(share.status, 409);
    ok("stopping a share frees a unit; a full room of participants admits no share");
  }

  {
    // A rejoin onto a seat that already holds a share keeps both units and is
    // never refused — same rule as a plain rejoin.
    await req(port, { path: "/rtc/leave", cookie: cookieFor("m-mesh", "dave@example.com"), body: { kelaboId: "m-mesh" } });
    const share = await req(port, { path: "/rtc/media", cookie: aliceMesh, body: { kelaboId: "m-mesh", screen: true } });
    assert.equal(share.status, 200);
    const rejoin = await req(port, { path: "/rtc/join", cookie: aliceMesh, body: { kelaboId: "m-mesh" } });
    assert.equal(rejoin.status, 200);
    assert.equal(c.rtcRoom.peer("m-mesh", "alice@example.com").media.screen, true, "the share survives the rejoin");
    ok("rejoining while sharing neither double-counts nor drops the share");
  }

  // --- Roster snapshot -------------------------------------------------------
  {
    const res = await req(port, { path: "/rtc/roster", cookie: aliceMesh, body: { kelaboId: "m-mesh" } });
    assert.equal(res.status, 200);
    const ids = res.body.peers.map((p) => p.participantId).sort();
    assert.deepEqual(ids, ["alice@example.com", "bob@example.com"]);
    const alice = res.body.peers.find((p) => p.participantId === "alice@example.com");
    assert.equal(alice.media.screen, true, "the snapshot carries media state");
    const cross = await req(port, { path: "/rtc/roster", cookie: aliceMesh, body: { kelaboId: "m-sfu" } });
    assert.equal(cross.status, 403, "kelabo scope still rides the cookie");
    ok("POST /rtc/roster returns the authoritative membership snapshot");
  }

  // --- A META read failure never guesses the mode ----------------------------
  {
    // The db stub fails every second META read of m-flaky: the route's own
    // getMeta succeeds, the room's modeFor read fails. The old code fell back
    // to the default mode — `sfu` — silently revoking the peer-to-peer
    // guarantee of a mesh kelabo. It must refuse instead, retryably.
    const res = await req(port, { path: "/rtc/join", cookie: cookieFor("m-flaky", "alice@example.com"), body: { kelaboId: "m-flaky" } });
    assert.equal(res.status, 503);
    assert.equal(res.body.error, "rtc_mode_unavailable");
    assert.equal(c.state.rtcRooms.get("m-flaky"), undefined, "no room was created on a guess");
    const retry = await req(port, { path: "/rtc/join", cookie: cookieFor("m-flaky", "alice@example.com"), body: { kelaboId: "m-flaky" } });
    assert.equal(retry.status, 200);
    assert.equal(retry.body.mode, "mesh", "once the META is readable the true mode wins");
    ok("a META read failure refuses the join (503) instead of guessing sfu");
  }

  // --- Demotion: sfu -> mesh, mid-call (docs 15 §1.1) ------------------------
  const demoteStream = await connectSse(port, "m-demote", cookieFor("m-demote", "alice@example.com"));
  {
    for (const who of ["alice", "bob"]) {
      const res = await req(port, {
        path: "/rtc/join",
        cookie: cookieFor("m-demote", `${who}@example.com`),
        body: { kelaboId: "m-demote" },
      });
      assert.equal(res.body.mode, "sfu");
    }
    const sess = await req(port, {
      path: "/rtc/sfu/session",
      cookie: cookieFor("m-demote", "alice@example.com"),
      body: { kelaboId: "m-demote", sessionDescription: { type: "offer", sdp: "v=0 alice" } },
    });
    assert.ok(sess.body.sessionId);
    assert.ok(c.rtcRoom.peer("m-demote", "alice@example.com").sfuSessionId);

    const closesBefore = rtc.calls.filter((x) => x.op === "closeTracks").length;
    const res = await c.rtcRoom.demote("m-demote", { reason: "test" });
    assert.deepEqual(res, { ok: true, peers: 2 });

    assert.equal(c.state.rtcRooms.get("m-demote").mode, "mesh");
    // The abandoned session is off the roster in the same breath. Leaving it
    // there makes every peer pull tracks that no longer exist for the rest of
    // the kelabo — and, on a metered deployment, keeps counting seat-seconds
    // for a call nobody is routing.
    assert.equal(c.rtcRoom.peer("m-demote", "alice@example.com").sfuSessionId, undefined);
    assert.deepEqual(c.rtcRoom.peer("m-demote", "alice@example.com").tracks, {});

    const ev = await waitFor(() => demoteStream.rtc.find((e) => e.kind === "mode"));
    assert.equal(ev.mode, "mesh");
    assert.equal(ev.reason, "test");

    const write = metaWrites.find((w) => w.Key.PK === "KELABO#m-demote");
    assert.ok(write, "the new mode is written to META");
    assert.equal(Object.values(write.ExpressionAttributeNames)[0], "rtcMode");
    assert.equal(Object.values(write.ExpressionAttributeValues)[0], "mesh");

    await waitFor(() => rtc.calls.filter((x) => x.op === "closeTracks").length > closesBefore);
    ok("demote() moves a live sfu room to mesh: roster, META, mode event, Cloudflare teardown");
  }

  {
    // A joiner arriving after the demotion gets the new transport, not the one
    // the META was created with.
    const res = await req(port, {
      path: "/rtc/join",
      cookie: cookieFor("m-demote", "carol@example.com"),
      body: { kelaboId: "m-demote" },
    });
    assert.equal(res.body.mode, "mesh");
    assert.deepEqual(await c.rtcRoom.demote("m-demote"), { ok: true, peers: 3, already: true });
    ok("after a demotion a fresh join is mesh, and demoting again is a no-op");
  }

  {
    // Mesh is N-1 uplinks per participant, not a cheaper SFU. A room bigger
    // than the cap is REFUSED rather than degraded — the caller wanted a
    // working call, and half a room is not one.
    for (const who of ["alice", "bob", "carol", "dave"]) {
      const res = await req(port, {
        path: "/rtc/join",
        cookie: cookieFor("m-big", `${who}@example.com`),
        body: { kelaboId: "m-big" },
      });
      assert.equal(res.status, 200);
    }
    const res = await c.rtcRoom.demote("m-big", { reason: "test" });
    assert.deepEqual(res, { ok: false, code: "mesh_too_small", detail: { meshMax: MESH_MAX, units: 4 } });
    assert.equal(c.state.rtcRooms.get("m-big").mode, "sfu", "a refused demotion changes nothing");
    ok(`a room of 4 will not demote under meshMax ${MESH_MAX} — refused, not degraded`);
  }

  {
    assert.deepEqual(await c.rtcRoom.demote("m-nobody"), { ok: false, code: "rtc_no_room" });
    ok("demoting a room with no live call is refused, not invented");
  }

  // --- Auth ------------------------------------------------------------------
  {
    const res = await req(port, { path: "/rtc/join", body: { kelaboId: "m-sfu" } });
    assert.equal(res.status, 401);
    ok("no participant cookie → 401");
  }

  demoteStream.res.destroy();
  aliceStream.res.destroy();
  meshStreams.alice.res.destroy();
  meshStreams.bob.res.destroy();
  server.close();
  await c.shutdown();

  await testDisconnectGrace();
  console.log(`\n${passed} rtc tests passed`);
}

// --- The disconnect grace window -------------------------------------------
// A dropped SSE stream no longer evicts on the spot: the seat is held for
// rtc.disconnectGraceSeconds (`peer_away` fanned), a resubscribe cancels the
// eviction (`peer_back`), and only the window expiring is a real departure.
// Its own container: the main suite runs with grace 0 so eviction is
// immediate there.
async function testDisconnectGrace() {
  const GRACE_S = 0.25;
  const rtc = createRtcStub();
  const c = await createContainer({
    config: { ...config, rtc: { ...config.rtc, disconnectGraceSeconds: GRACE_S } },
    db,
    s3: { send: async () => ({}) },
    secrets,
    rtc,
    skipRebuild: true,
  });
  const server = createGateway(c);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;

  const alice = cookieFor("m-mesh", "alice@example.com");
  const bob = cookieFor("m-mesh", "bob@example.com");
  const aliceStream = await connectSse(port, "m-mesh", alice);
  let bobStream = await connectSse(port, "m-mesh", bob);
  for (const cookie of [alice, bob]) {
    const res = await req(port, { path: "/rtc/join", cookie, body: { kelaboId: "m-mesh" } });
    assert.equal(res.status, 200);
  }

  {
    bobStream.res.destroy();
    const away = await waitFor(() =>
      aliceStream.rtc.find((e) => e.kind === "peer_away" && e.participantId === "bob@example.com"),
    );
    assert.ok(away);
    assert.ok(c.rtcRoom.peer("m-mesh", "bob@example.com"), "the seat is held through the window");
    ok("a dropped stream fans peer_away and holds the seat");
  }

  {
    bobStream = await connectSse(port, "m-mesh", bob);
    const back = await waitFor(() =>
      aliceStream.rtc.find((e) => e.kind === "peer_back" && e.participantId === "bob@example.com"),
    );
    assert.ok(back);
    // Outlast the original window: the cancelled eviction must never fire.
    await new Promise((r) => setTimeout(r, GRACE_S * 1000 + 200));
    assert.ok(c.rtcRoom.peer("m-mesh", "bob@example.com"), "bob survived his blip");
    assert.equal(
      aliceStream.rtc.filter((e) => e.kind === "peer_left" && e.participantId === "bob@example.com").length,
      0,
      "no peer_left was fanned for a peer who came back",
    );
    ok("a resubscribe inside the window cancels the eviction and fans peer_back");
  }

  {
    bobStream.res.destroy();
    const gone = await waitFor(() =>
      aliceStream.rtc.find((e) => e.kind === "peer_left" && e.participantId === "bob@example.com"),
    );
    assert.equal(gone.reason, "disconnected");
    assert.equal(c.rtcRoom.peer("m-mesh", "bob@example.com"), null);
    ok("a stream that stays gone past the window is a real departure");
  }

  aliceStream.res.destroy();
  server.close();
  await c.shutdown();
}

main().catch((err) => {
  console.error("RTC TEST FAILED:", err);
  process.exit(1);
});
