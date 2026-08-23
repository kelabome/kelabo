import http from "node:http";
import assert from "node:assert/strict";
import { WebSocket } from "ws";
import { createContainer } from "../src/container.js";
import { createGateway } from "../src/server.js";
import { signJwt } from "../src/cookies.js";

const KEY = "test-secret-key";
const KELABO = "m-test-1";
const NOW = Date.now();

const metaItem = {
  PK: `KELABO#${KELABO}`,
  SK: "META",
  status: "active",
  title: "Smoke Kelabo",
  hostIdentity: "alice@example.com",
  startedAt: NOW - 60_000,
  participants: [{ identity: "alice@example.com", displayName: "Alice", isGuest: false }],
  tenantId: "example.com",
};

// A scheduled kelabo the developer was invited to but does not host — the
// prep-mode case (docs 16 §5). Same partition shape as the live one, because a
// scheduled kelabo is the same kelabo in an earlier state.
const SCHEDULED = "m-sched-1";
const scheduledMeta = {
  PK: `KELABO#${SCHEDULED}`,
  SK: "META",
  status: "scheduled",
  title: "Retry policy review",
  hostIdentity: "bob@example.com",
  scheduledAt: NOW + 3_600_000,
  durationMinutes: 30,
  note: "bring the gateway numbers",
  participants: [],
  tenantId: "example.com",
};
const invites = {
  [SCHEDULED]: [
    { SK: "INVITE#bob@example.com", inviteKey: "bob@example.com", displayName: "Bob", isHost: true, response: "accepted" },
    { SK: "INVITE#alice@example.com", inviteKey: "alice@example.com", displayName: "Alice", response: "pending" },
  ],
};
// A kelabo at the same tenant that the developer has nothing to do with.
const FOREIGN = "m-foreign-1";
const foreignMeta = { ...scheduledMeta, PK: `KELABO#${FOREIGN}`, hostIdentity: "carol@example.com", title: "Not yours" };

const AGENT_JTI = "jti-1";
const agentTokenRow = { PK: `AGT#${AGENT_JTI}`, jti: AGENT_JTI, revoked: false, expiresAt: NOW + 86_400_000 };

// A journey the live kelabo is linked to (docs 20 §12.2's pull tools). Kept
// mutable so one test can add a second link to exercise "ambiguous".
const JOURNEY = "j-smoke";
const JOURNEY2 = "j-smoke-2";
const journeyMetaItem = {
  PK: `JOURNEY#${JOURNEY}`,
  SK: "META",
  journeyId: JOURNEY,
  title: "Smoke Journey",
  visibility: "public",
  status: "active",
  aiCanPost: false,
  kelaboCount: 1,
};
const journeyMetaItem2 = {
  PK: `JOURNEY#${JOURNEY2}`,
  SK: "META",
  journeyId: JOURNEY2,
  title: "Second Journey",
  visibility: "private",
  status: "active",
};
let kelaboJourneyLinks = [
  { PK: `KELABO#${KELABO}`, SK: `JOURNEY#${JOURNEY}`, journeyId: JOURNEY, journeyTitleSnapshot: "Smoke Journey" },
];

const calls = { puts: [], updates: [], deletes: [], s3Puts: [] };
const db = {
  send: async (cmd) => {
    const name = cmd.constructor.name;
    const input = cmd.input;
    if (name === "GetCommand") {
      if (input.Key.PK === `KELABO#${KELABO}` && input.Key.SK === "META") return { Item: metaItem };
      if (input.Key.PK === `KELABO#${SCHEDULED}` && input.Key.SK === "META") return { Item: scheduledMeta };
      if (input.Key.PK === `KELABO#${FOREIGN}` && input.Key.SK === "META") return { Item: foreignMeta };
      if (input.Key.PK === "KELABO#past1" && input.Key.SK === "MINUTES") {
        return { Item: { title: "Sprint planning", summary: "We picked the blue design.", decisions: ["Blue, not green"], actionItems: [{ text: "Ship it", owner: "bo" }] } };
      }
      if (input.Key.PK === `AGT#${AGENT_JTI}`) return { Item: agentTokenRow };
      if (input.Key.PK === `JOURNEY#${JOURNEY}` && input.Key.SK === "META") return { Item: journeyMetaItem };
      if (input.Key.PK === `JOURNEY#${JOURNEY2}` && input.Key.SK === "META") return { Item: journeyMetaItem2 };
      return {};
    }
    if (name === "QueryCommand") {
      const pk = input.ExpressionAttributeValues?.[":pk"];
      const sk = input.ExpressionAttributeValues?.[":sk"];
      if (sk === "INVITE#" && typeof pk === "string") {
        return { Items: invites[pk.slice("KELABO#".length)] ?? [] };
      }
      if (sk === "JOURNEY#" && pk === `KELABO#${KELABO}`) return { Items: kelaboJourneyLinks };
      if ((sk === "TL#" || sk === "BOARDMSG#") && typeof pk === "string" && pk.startsWith("JOURNEY#")) {
        return { Items: [] };
      }
      // Serve transcript queries from what the test actually persisted, so the
      // history endpoint reads exactly the rows the caption handler wrote —
      // honouring the cursor, sort direction and limit the way DynamoDB would,
      // so the pagination test exercises real behaviour.
      if (sk === "UTT#" && pk === `KELABO#${KELABO}`) {
        const before = input.ExpressionAttributeValues?.[":before"];
        let items = calls.puts
          .filter((p) => p.TableName === "t-kelabos" && String(p.Item.SK).startsWith("UTT#"))
          .map((p) => p.Item)
          .filter((i) => !before || i.SK <= before)
          .sort((a, b) => (a.SK < b.SK ? -1 : 1));
        if (input.ScanIndexForward === false) items.reverse();
        if (input.Limit) items = items.slice(0, input.Limit);
        return { Items: items };
      }
      if (input.IndexName === "participant-index" && input.ExpressionAttributeValues?.[":p"] === "alice@example.com") {
        return { Items: [{ kelaboId: "past1", title: "Sprint planning", endedAt: 1722300000000, participantIdentity: "alice@example.com" }] };
      }
      return { Items: [] };
    }
    if (name === "PutCommand") { calls.puts.push(input); return {}; }
    if (name === "UpdateCommand") { calls.updates.push(input); return {}; }
    if (name === "DeleteCommand") { calls.deletes.push(input); return {}; }
    return {};
  },
};
const s3 = { send: async (cmd) => { calls.s3Puts.push(cmd.input); return {}; } };
const secrets = { send: async () => ({ SecretString: KEY }) };

const config = {
  env: "test",
  region: "us-east-1",
  tenantId: "example.com",
  allowedEmailDomain: "example.com",
  portalUrl: "http://portal.test",
  tableNames: { kelabos: "t-kelabos", history: "t-history", mcp: "t-mcp", refresh: "t-refresh", journeys: "t-journeys" },
  archiveBucket: "t-bucket",
  archiveKeyPrefix: "archives",
  secrets: { llm: "t/llm", cookieSigningKey: "t/cookie", mcpPrefix: "t/mcp/", cloudflareRealtime: "t/cf" },
  rtcApiBase: "http://rtc.test/v1",
  rtc: { defaultMode: "sfu", meshMaxParticipants: 6, iceTtlSeconds: 3600, video: false },
  // The hosted-deployment posture, so the entitlement machinery is what gets
  // tested: guests must receive typed messages only. (Public default is true.)
  guestTranscriptAccess: false,
  llm: { provider: "fake", model: "fake", smallModel: "fake" },
  openaiBaseUrl: "http://unused",
  gateway: { agent: { maxConcurrentRuns: 2, sensitivity: "medium", maxContributionsPerMinute: 3, cooldownSeconds: 45, rollingWindowSize: 10, turnTimeoutSeconds: 0.1 } },
  retentionDays: 30,
};

const participantCookie = signJwt(
  { kind: "participant", kelaboId: KELABO, identity: "alice@example.com", tenantId: "example.com", isGuest: false, exp: Math.floor(NOW / 1000) + 3600 },
  KEY
);
const guestCookie = signJwt(
  { kind: "participant", kelaboId: KELABO, identity: "guest-1", tenantId: "example.com", isGuest: true, exp: Math.floor(NOW / 1000) + 3600 },
  KEY
);
const agentToken = signJwt(
  {
    sub: "alice@example.com",
    tenant: "example.com",
    role: "dev",
    aud: "kelabo-agent",
    jti: AGENT_JTI,
    label: "alice's opencode",
    iat: Math.floor(NOW / 1000),
    exp: Math.floor(NOW / 1000) + 3600,
  },
  KEY
);
// Correctly signed and unexpired, but minted for the wrong audience: three token
// families share this key, so `aud` is the only thing keeping them apart.
const wrongAudToken = signJwt(
  { sub: "alice@example.com", tenant: "example.com", role: "dev", aud: "gateway-internal", jti: AGENT_JTI, iat: Math.floor(NOW / 1000), exp: Math.floor(NOW / 1000) + 3600 },
  KEY
);
const internalJwt = signJwt({ sub: "rest-lambda", aud: "gateway-internal", iat: Math.floor(NOW / 1000), exp: Math.floor(NOW / 1000) + 300 }, KEY);

function req(port, { method = "GET", path, headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request(
      { host: "127.0.0.1", port, path, method, headers: { ...headers, ...(body ? { "content-type": "application/json" } : {}) } },
      (res) => {
        const chunks = [];
        res.on("data", (d) => chunks.push(d));
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
      }
    );
    r.on("error", reject);
    if (body) r.write(JSON.stringify(body));
    r.end();
  });
}

function connectSse(port, kelaboId, cookie = participantCookie) {
  return new Promise((resolve, reject) => {
    const r = http.request(
      { host: "127.0.0.1", port, path: `/caption/replies?kelaboId=${kelaboId}`, method: "GET", headers: { cookie: `kelabo_participant=${cookie}` } },
      (res) => {
        if (res.statusCode !== 200) return reject(new Error(`sse status ${res.statusCode}`));
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
            if (ev && data) events.push({ event: ev, data: JSON.parse(data) });
          }
        });
        resolve({ res, events });
      }
    );
    r.on("error", reject);
    r.end();
  });
}

const waitFor = async (fn, ms = 5000, step = 25) => {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, step));
  }
  throw new Error("waitFor timeout");
};

async function main() {
  const c = await createContainer({ config, db, s3, secrets, skipRebuild: true });
  const server = createGateway(c);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  console.log(`server on :${port}`);

  {
    const res = await req(port, { path: "/health" });
    assert.equal(res.status, 200);
    console.log("ok: GET /health");
  }
  {
    const res = await req(port, { path: "/nope" });
    assert.equal(res.status, 404);
    console.log("ok: unknown route 404");
  }
  {
    const res = await req(port, { method: "OPTIONS", path: "/caption" });
    assert.equal(res.status, 204);
    assert.equal(res.headers["access-control-allow-origin"], "http://portal.test");
    assert.equal(res.headers["access-control-allow-credentials"], "true");
    console.log("ok: CORS preflight");
  }

  const sse = await connectSse(port, KELABO);
  console.log("ok: SSE subscribed");

  {
    const res = await req(port, {
      method: "POST",
      path: "/caption",
      headers: { cookie: `kelabo_participant=${participantCookie}` },
      body: { kelaboId: KELABO, text: "remember to ship Friday", isFinal: true, tStart: 1000, tEnd: 2000, human: true },
    });
    assert.equal(res.status, 202);
    const utt = calls.puts.find((p) => p.TableName === "t-kelabos" && String(p.Item.SK).startsWith("UTT#"));
    assert.ok(utt, "UTT appended");
    // No `displayName` was sent, so this is the identity fallback — and it is
    // the local part, not the address. The persisted label is what the language
    // model and any attached agent receive (`speakerLabel`), so an address here
    // would be a disclosure to a third party nobody in the room chose.
    assert.equal(utt.Item.speaker, "alice");
    const note = await waitFor(() => sse.events.find((e) => e.event === "contribution" && e.data.tag === "note"));
    // The board author is a different field and stays the full identity: it is
    // shown to participants, who are entitled to know who posted, and it never
    // goes to a supplier.
    assert.equal(note.data.author, "alice@example.com");
    assert.equal(note.data.markdown, "remember to ship Friday");
    const contrib = calls.puts.find((p) => String(p.Item.SK).startsWith("CONTRIB#"));
    assert.ok(contrib, "note persisted as CONTRIB");
    console.log("ok: POST /caption human note → UTT + SSE note + CONTRIB persist");
  }

  {
    const res = await req(port, {
      method: "POST",
      path: "/caption",
      headers: { cookie: `kelabo_participant=${participantCookie}` },
      body: { kelaboId: "other-kelabo", text: "x", isFinal: true, tStart: 0, tEnd: 1 },
    });
    assert.equal(res.status, 403);
    const bad = await req(port, { method: "POST", path: "/caption", body: { kelaboId: KELABO, text: "x", isFinal: true, tStart: 0, tEnd: 1 } });
    assert.equal(bad.status, 401);
    console.log("ok: caption auth guards (403 mismatch, 401 no cookie)");
  }

  {
    // Live fragments keep the room current while the speaker is still talking;
    // the sealed message is the only thing persisted or handed to the agent.
    const putsBefore = calls.puts.length;
    const frag = await req(port, {
      method: "POST",
      path: "/caption",
      headers: { cookie: `kelabo_participant=${participantCookie}` },
      body: { kelaboId: KELABO, text: "so the plan is", isFinal: true, ephemeral: true, messageId: "m-1", tStart: 3000, tEnd: 4000 },
    });
    assert.equal(frag.status, 202);
    const live = await waitFor(() => sse.events.find((e) => e.event === "utterance" && e.data.text === "so the plan is"));
    assert.equal(live.data.partial, true, "fragment is marked partial for the room");
    assert.equal(live.data.messageId, "m-1", "fragment carries the speaker's message id");
    assert.equal(
      calls.puts.length,
      putsBefore,
      "a fragment is never persisted — only the sealed message reaches the transcript",
    );
    console.log("ok: ephemeral fragment fans out live, persists nothing");
  }

  {
    // The regression that motivated the ephemeral path: a one-fragment message
    // has exactly the same text as its own sealed post, so if fragments went
    // through the duplicate cache every short message would suppress itself and
    // never reach the LLM.
    const text = "ship it on Friday";
    const frag = await req(port, {
      method: "POST",
      path: "/caption",
      headers: { cookie: `kelabo_participant=${participantCookie}` },
      body: { kelaboId: KELABO, text, isFinal: true, ephemeral: true, messageId: "m-2", tStart: 5000, tEnd: 6000 },
    });
    assert.equal(frag.status, 202);
    await waitFor(() => sse.events.find((e) => e.event === "utterance" && e.data.messageId === "m-2"));
    const sealed = await req(port, {
      method: "POST",
      path: "/caption",
      headers: { cookie: `kelabo_participant=${participantCookie}` },
      body: { kelaboId: KELABO, text, isFinal: true, turnComplete: true, messageId: "m-2", tStart: 5000, tEnd: 6000 },
    });
    assert.equal(sealed.status, 202);
    assert.notEqual(sealed.body && JSON.parse(sealed.body).duplicate, true, "sealed post is not suppressed by its own fragment");
    const utt = calls.puts.find((p) => String(p.Item.SK).startsWith("UTT#") && p.Item.text === text);
    assert.ok(utt, "sealed message is persisted");
    // The sealed message IS fanned out, carrying the same message id: receivers
    // replace their provisional text with it and close the bubble at exactly the
    // point the speaker did. Without it a listener has no boundary at all and
    // every fragment piles into one ever-growing message.
    const sealedEvent = await waitFor(() =>
      sse.events.find((e) => e.event === "utterance" && e.data.messageId === "m-2" && e.data.partial === false),
    );
    assert.equal(sealedEvent.data.text, text, "the sealed fan-out carries the authoritative full text");
    console.log("ok: sealed message persists, dispatches, and fans out with the speaker's message id");
  }

  {
    // A typed message keeps its provenance all the way into the transcript row:
    // the record view and its download tell a typed line from a transcribed one
    // by this attribute, so losing it at persistence is losing it everywhere.
    const text = "typing this rather than saying it";
    const res = await req(port, {
      method: "POST",
      path: "/caption",
      headers: { cookie: `kelabo_participant=${participantCookie}` },
      body: { kelaboId: KELABO, text, isFinal: true, turnComplete: true, kind: "sealed", source: "typed", messageId: "m-typed", tStart: 7000, tEnd: 7000 },
    });
    assert.equal(res.status, 202);
    const typedUtt = calls.puts.find((p) => String(p.Item.SK).startsWith("UTT#") && p.Item.text === text);
    assert.ok(typedUtt, "typed message is persisted");
    assert.equal(typedUtt.Item.source, "typed", "persisted row records that it was typed");
    const typedEvent = await waitFor(() =>
      sse.events.find((e) => e.event === "utterance" && e.data.messageId === "m-typed" && e.data.partial === false),
    );
    assert.equal(typedEvent.data.source, "typed", "fan-out marks the line as typed for the room");
    // Spoken rows say nothing: absence is "speech", exactly like every row
    // written before the attribute existed.
    const spokenUtt = calls.puts.find((p) => String(p.Item.SK).startsWith("UTT#") && p.Item.text === "ship it on Friday");
    assert.ok(spokenUtt && spokenUtt.Item.source === undefined, "a spoken row carries no source attribute");
    console.log("ok: typed message persists source=typed; spoken rows stay bare");
  }

  {
    // Isolation: on a deployment that withholds the transcript from guests
    // (guestTranscriptAccess: false above), a guest must never receive speech —
    // not live over SSE, and not from the history backfill. Typed messages
    // reach them on both paths: those are the room's chat.
    const guestSse = await connectSse(port, KELABO, guestCookie);

    const spokenText = "the quarterly numbers look fine";
    const spoken = await req(port, {
      method: "POST",
      path: "/caption",
      headers: { cookie: `kelabo_participant=${participantCookie}` },
      body: { kelaboId: KELABO, text: spokenText, isFinal: true, turnComplete: true, kind: "sealed", messageId: "m-spk-1", tStart: 8000, tEnd: 9000 },
    });
    assert.equal(spoken.status, 202);
    await waitFor(() => sse.events.find((e) => e.event === "utterance" && e.data.messageId === "m-spk-1"));

    const typedGuest = await req(port, {
      method: "POST",
      path: "/caption",
      headers: { cookie: `kelabo_participant=${guestCookie}` },
      body: { kelaboId: KELABO, text: "typed by the guest", isFinal: true, turnComplete: true, kind: "sealed", source: "typed", messageId: "m-typed-guest", tStart: 9500, tEnd: 9500 },
    });
    assert.equal(typedGuest.status, 202);
    // The typed message reaching the guest proves their stream is live and has
    // processed everything up to and past the speech they must not have.
    await waitFor(() => guestSse.events.find((e) => e.event === "utterance" && e.data.messageId === "m-typed-guest"));
    assert.ok(
      !guestSse.events.some((e) => e.event === "utterance" && e.data.messageId === "m-spk-1"),
      "speech never reached the unentitled guest's stream"
    );
    assert.ok(
      sse.events.find((e) => e.event === "utterance" && e.data.messageId === "m-typed-guest"),
      "the guest's typed message reached the entitled participant"
    );

    // The history backfill applies the same entitlement, in the same place.
    const full = await req(port, { path: `/caption/history?kelaboId=${KELABO}`, headers: { cookie: `kelabo_participant=${participantCookie}` } });
    assert.equal(full.status, 200);
    const fullBody = JSON.parse(full.body);
    assert.equal(fullBody.transcriptAccess, true);
    assert.ok(fullBody.utterances.some((u) => u.messageId === "m-spk-1"), "entitled history has speech");
    assert.ok(fullBody.utterances.some((u) => u.messageId === "m-typed-guest" && u.source === "typed"), "entitled history has typed messages");

    const guestHist = await req(port, { path: `/caption/history?kelaboId=${KELABO}`, headers: { cookie: `kelabo_participant=${guestCookie}` } });
    assert.equal(guestHist.status, 200);
    const guestBody = JSON.parse(guestHist.body);
    assert.equal(guestBody.transcriptAccess, false);
    assert.ok(guestBody.utterances.length > 0, "guest history is not empty");
    assert.ok(guestBody.utterances.every((u) => u.source === "typed"), "guest history is typed-only");

    const noAuth = await req(port, { path: `/caption/history?kelaboId=${KELABO}` });
    assert.equal(noAuth.status, 401);

    guestSse.res.destroy();
    console.log("ok: transcript isolation — guest SSE and history are typed-only, entitled see everything");
  }

  {
    // Backward paging: newest page first, `nextBefore` walks older, pages never
    // overlap, and the walk terminates with hasMore=false at the oldest row.
    const fetchPage = async (before) => {
      const q = `kelaboId=${KELABO}&limit=2${before ? `&before=${encodeURIComponent(before)}` : ""}`;
      const res = await req(port, { path: `/caption/history?${q}`, headers: { cookie: `kelabo_participant=${participantCookie}` } });
      assert.equal(res.status, 200);
      return JSON.parse(res.body);
    };

    const total = calls.puts.filter((p) => p.TableName === "t-kelabos" && String(p.Item.SK).startsWith("UTT#")).length;
    const seen = [];
    let page = await fetchPage();
    let hops = 0;
    while (true) {
      for (const u of page.utterances) {
        assert.ok(!seen.includes(u.messageId), `page overlap on ${u.messageId}`);
        seen.push(u.messageId);
      }
      assert.ok(page.utterances.length <= 2, "page respects the limit");
      if (!page.hasMore) break;
      assert.ok(page.nextBefore, "a further page implies a cursor");
      page = await fetchPage(page.nextBefore);
      hops += 1;
      assert.ok(hops < 20, "pagination terminates");
    }
    assert.equal(seen.length, total, "walking the cursor visits every persisted row exactly once");
    assert.ok(hops >= 1, "the fixture is big enough to actually paginate");
    console.log(`ok: history pages backwards — ${total} rows over ${hops + 1} pages, no overlap, clean end`);
  }

  {
    const res = await req(port, {
      method: "POST",
      path: "/caption",
      headers: { cookie: `kelabo_participant=${participantCookie}` },
      body: { kelaboId: KELABO, text: "we should refactor the retry logic", isFinal: true, tStart: 3000, tEnd: 4000 },
    });
    assert.equal(res.status, 202);
    await waitFor(() => c.state.agentWorkers.get(KELABO)?.rehydrated);
    console.log("ok: server-mode caption → agent worker context (fake gate, no fan-out)");
  }

  const ws = new WebSocket(`ws://127.0.0.1:${port}/rig`);
  const frames = [];
  const waiters = [];
  const pushFrame = (f) => {
    frames.push(f);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].pred(f)) {
        waiters[i].resolve(f);
        waiters.splice(i, 1);
      }
    }
  };
  const nextFrame = (pred, ms = 5000, fromIndex = 0) => {
    const found = frames.slice(fromIndex).find(pred);
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      waiters.push({ pred: (f) => frames.indexOf(f) >= fromIndex && pred(f), resolve });
      setTimeout(() => reject(new Error("frame timeout")), ms).unref();
    });
  };
  ws.on("message", (raw) => pushFrame(JSON.parse(raw.toString())));
  await new Promise((r) => ws.on("open", r));

  {
    // A token for the wrong audience must be refused even though its signature,
    // role and expiry are all fine.
    const bad = new WebSocket(`ws://127.0.0.1:${port}/rig`);
    const rejected = new Promise((resolve) => bad.on("message", (raw) => resolve(JSON.parse(raw.toString()))));
    await new Promise((r) => bad.on("open", r));
    bad.send(JSON.stringify({ type: "register", token: wrongAudToken, agent: { runtime: "opencode" } }));
    const frame = await rejected;
    assert.equal(frame.type, "rejected");
    assert.equal(frame.reason, "invalid_token");
    bad.close();
    console.log("ok: /rig rejects a token minted for another audience");
  }

  ws.send(JSON.stringify({
    type: "register",
    token: agentToken,
    agent: { runtime: "opencode", version: "1.0", label: "alice's opencode" },
  }));
  const registered = await nextFrame((f) => f.type === "registered");
  assert.ok(registered.agentId);
  // Register no longer guesses a kelabo: which one to work on is the
  // developer's choice, made with an explicit attach.
  assert.equal(registered.kelaboId, "");
  console.log("ok: /rig register → registered, no kelabo guessed");

  {
    // Prep mode: a scheduled kelabo the developer was invited to but does not
    // host. It must never enter tunnelByKelabo.
    const base = frames.length;
    ws.send(JSON.stringify({ type: "attach", kelaboId: SCHEDULED, runtime: "opencode", sessionRef: "ocs-1", workspace: "/home/dev/repo" }));
    const briefing = await nextFrame((f) => f.type === "briefing" && f.kelaboId === SCHEDULED, 5000, base);
    assert.equal(briefing.status, "scheduled");
    assert.equal(briefing.note, "bring the gateway numbers");
    assert.equal(briefing.invitees.length, 2);
    assert.equal(briefing.invitees.find((i) => i.isHost).displayName, "Bob");
    assert.equal(c.state.prepByKelabo.has(SCHEDULED), true);
    assert.equal(c.state.tunnelByKelabo.has(SCHEDULED), false, "a prep binding must not receive transcript");
    console.log("ok: attach to a scheduled kelabo → prep binding + briefing, no transcript route");
  }

  {
    // A prep agent may still post: that is the whole point. It persists with no
    // subscribers and is on the board when the kelabo opens.
    const before = calls.puts.filter((p) => String(p.Item.SK).startsWith("CONTRIB#")).length;
    ws.send(JSON.stringify({ type: "contribution", kelaboId: SCHEDULED, markdown: "Retries are capped at 5", title: "Retry cap" }));
    await waitFor(() => calls.puts.filter((p) => String(p.Item.SK).startsWith("CONTRIB#")).length > before);
    const stored = calls.puts.filter((p) => String(p.Item.SK).startsWith("CONTRIB#")).at(-1).Item;
    assert.equal(stored.markdown, "Retries are capped at 5");
    assert.equal(stored.origin, "local");
    assert.equal(stored.runtime, "opencode");
    assert.equal(stored.agentLabel, "alice's opencode");
    console.log("ok: a preparing agent posts to the board before the kelabo starts");
  }

  {
    // Cancel (docs 18 §2.4): the prep-bound agent is told, and the prep binding
    // is dropped — the one map endKelabo never clears.
    assert.equal(c.state.prepByKelabo.has(SCHEDULED), true);
    const base = frames.length;
    const res = await req(port, {
      method: "POST",
      path: `/internal/kelabos/${SCHEDULED}/cancel`,
      headers: { authorization: `Bearer ${internalJwt}` },
    });
    assert.equal(res.status, 200);
    const evt = await nextFrame((f) => f.type === "kelabo" && f.event === "cancelled" && f.kelaboId === SCHEDULED, 5000, base);
    assert.equal(evt.event, "cancelled");
    assert.equal(c.state.prepByKelabo.has(SCHEDULED), false, "cancel clears the prep binding");
    console.log("ok: internal cancel → prep agent notified, prep binding dropped");
  }

  {
    const base = frames.length;
    ws.send(JSON.stringify({ type: "attach", kelaboId: FOREIGN, runtime: "opencode" }));
    const rejected = await nextFrame((f) => f.type === "rejected", 5000, base);
    assert.equal(rejected.reason, "not_invited");
    console.log("ok: attaching to a kelabo you neither host nor were invited to is refused");
  }

  {
    const base = frames.length;
    ws.send(JSON.stringify({ type: "attach", kelaboId: KELABO, runtime: "opencode", sessionRef: "ocs-1", workspace: "/home/dev/repo" }));
    await nextFrame((f) => f.type === "briefing" && f.kelaboId === KELABO, 5000, base);
    await waitFor(() => calls.puts.find((p) => p.Item.SK === "PROMOTION"));
    await waitFor(() => calls.updates.find((u) => u.ExpressionAttributeNames && Object.values(u.ExpressionAttributeNames).includes("mode")));
    const promotion = calls.puts.find((p) => p.Item.SK === "PROMOTION").Item;
    // Runtime-agnostic: no opencode nouns are persisted any more.
    assert.equal(promotion.runtime, "opencode");
    assert.equal(promotion.sessionRef, "ocs-1");
    assert.equal(promotion.opencodeSessionId, undefined);
    const presence = await waitFor(() => sse.events.find((e) => e.event === "agent"));
    assert.equal(presence.data.attached, true);
    assert.equal(presence.data.runtime, "opencode");
    console.log("ok: attach to a live kelabo → PROMOTION, META mode=dev, agent presence on SSE");
  }

  {
    const res = await req(port, {
      method: "POST",
      path: "/caption",
      headers: { cookie: `kelabo_participant=${participantCookie}` },
      body: { kelaboId: KELABO, text: "what is the retry limit", isFinal: true, tStart: 5000, tEnd: 6000, speaker: "B", diarized: true, messageId: "msg-9" },
    });
    assert.equal(res.status, 202);
    const t = await nextFrame((f) => f.type === "transcript" && f.text === "what is the retry limit");
    assert.equal(t.speaker, "B");
    assert.equal(t.messageId, "msg-9");
    assert.equal(t.human, false);
    console.log("ok: caption → transcript frame carrying the speaker's message id");
  }

  {
    ws.send(JSON.stringify({ type: "contribution", kelaboId: KELABO, markdown: "Retry limit is 5", title: "Retry limit is 5", ref: "r1" }));
    const con = await waitFor(() => sse.events.find((e) => e.event === "contribution" && e.data.markdown === "Retry limit is 5"));
    assert.equal(con.data.origin, "local");
    assert.equal(con.data.runtime, "opencode");
    console.log("ok: contribution → SSE LLM_CON contribution");

    // Replaying the same ref after a dropped socket must not double-post.
    const before = sse.events.filter((e) => e.data?.markdown === "Retry limit is 5").length;
    ws.send(JSON.stringify({ type: "contribution", kelaboId: KELABO, markdown: "Retry limit is 5", title: "Retry limit is 5", ref: "r1" }));
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(sse.events.filter((e) => e.data?.markdown === "Retry limit is 5").length, before);
    console.log("ok: a replayed contribution ref is ignored");
  }

  {
    // A dev agent uses the same card lifecycle the in-ECS agent publishes: the
    // board shows the question was taken, then the same card becomes the answer.
    ws.send(
      JSON.stringify({
        type: "contribution",
        kelaboId: KELABO,
        card: "k1",
        status: "working",
        title: "Cache TTL",
        progress: "Reading the config",
        ref: "w1",
      })
    );
    const working = await waitFor(() => sse.events.find((e) => e.event === "contribution" && e.data.status === "working"));
    assert.equal(working.data.title, "Cache TTL");
    assert.equal(working.data.progress, "Reading the config");
    assert.ok(working.data.id, "a working card still gets a real contribution id");
    console.log("ok: dev-mode working card reaches the board");

    ws.send(
      JSON.stringify({
        type: "contribution",
        kelaboId: KELABO,
        card: "k1",
        markdown: "Sixty seconds.",
        title: "Cache TTL",
        ref: "w2",
      })
    );
    const answer = await waitFor(() => sse.events.find((e) => e.event === "contribution" && e.data.markdown === "Sixty seconds."));
    assert.equal(answer.data.status, "done");
    assert.equal(
      answer.data.id,
      working.data.id,
      "same id, so the board replaces the card rather than stacking a second one"
    );
    console.log("ok: the answer updates that card in place");

    // An empty `done` card is the SSE hub's "remove this card" marker, so
    // letting one through would delete the card instead of finishing it.
    const seen = sse.events.length;
    ws.send(JSON.stringify({ type: "contribution", kelaboId: KELABO, card: "k1", markdown: "   ", ref: "w3" }));
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(sse.events.length, seen, "an empty finished card is dropped, not fanned out");
    console.log("ok: a finished card with no body is refused");

    // Distinct references stay distinct cards — an agent running several
    // background lookups at once has several open, and collapsing them would
    // make each answer overwrite the last.
    ws.send(
      JSON.stringify({ type: "contribution", kelaboId: KELABO, card: "k2", markdown: "Second lookup", title: "x", ref: "w4" })
    );
    const second = await waitFor(() => sse.events.find((e) => e.event === "contribution" && e.data.markdown === "Second lookup"));
    assert.notEqual(second.data.id, working.data.id, "a different reference is a different card");
    console.log("ok: parallel lookups get one card each");

    // And a contribution with no reference at all behaves exactly as it did
    // before cards existed: a fresh card every time.
    ws.send(JSON.stringify({ type: "contribution", kelaboId: KELABO, markdown: "Plain post", title: "x", ref: "w5" }));
    const plain = await waitFor(() => sse.events.find((e) => e.event === "contribution" && e.data.markdown === "Plain post"));
    assert.ok(plain.data.id && plain.data.id !== working.data.id && plain.data.id !== second.data.id);
    assert.equal(plain.data.status, "done");
    console.log("ok: a post with no card reference is unchanged");
  }

  {
    const base = frames.length;
    ws.send(JSON.stringify({ type: "board_request", requestId: "b1", kelaboId: KELABO }));
    const board = await nextFrame((f) => f.type === "board" && f.requestId === "b1", 5000, base);
    assert.equal(board.kelaboId, KELABO);
    assert.ok(Array.isArray(board.contributions));
    console.log("ok: board_request → board, no participant cookie needed");
  }

  {
    // History is gated on the host's opt-in. This kelabo's META carries no
    // `historyEnabled`, so the answer is a real "off", not an error or an
    // empty list the agent could mistake for "nothing recorded".
    const base = frames.length;
    ws.send(JSON.stringify({ type: "history_request", requestId: "h1", kelaboId: KELABO }));
    const off = await nextFrame((f) => f.type === "history" && f.requestId === "h1", 5000, base);
    assert.equal(off.enabled, false);
    assert.deepEqual(off.entries, []);
    console.log("ok: history_request without the host opt-in → enabled:false");

    // With the opt-in, the host's past kelabos arrive reduced to their
    // minutes — the same record the in-ECS agent pins into its prompt.
    metaItem.historyEnabled = true;
    ws.send(JSON.stringify({ type: "history_request", requestId: "h2", kelaboId: KELABO }));
    const hist = await nextFrame((f) => f.type === "history" && f.requestId === "h2", 5000, base);
    delete metaItem.historyEnabled;
    assert.equal(hist.enabled, true);
    assert.equal(hist.entries.length, 1);
    assert.equal(hist.entries[0].kelaboId, "past1");
    assert.equal(hist.entries[0].summary, "We picked the blue design.");
    assert.deepEqual(hist.entries[0].decisions, ["Blue, not green"]);
    assert.deepEqual(hist.entries[0].actionItems, ["Ship it (bo)"]);
    console.log("ok: history_request with the opt-in → the host's past kelabos, minutes only");
  }

  {
    // journey_info_request: this kelabo has exactly one linked journey, so no
    // journeyId is needed at all (docs 20 §12.2's "enumerate rather than
    // guess" only kicks in once there is something to disambiguate).
    const base = frames.length;
    ws.send(JSON.stringify({ type: "journey_info_request", requestId: "ji1", kelaboId: KELABO }));
    const info = await nextFrame((f) => f.type === "journey_info" && f.requestId === "ji1", 5000, base);
    assert.equal(info.resolved, "ok");
    assert.equal(info.journeyId, JOURNEY);
    assert.equal(info.title, "Smoke Journey");
    assert.equal(info.visibility, "public");
    console.log("ok: journey_info_request → the kelabo's one linked journey, no journeyId needed");

    // An explicit journeyId this kelabo is not actually linked to is refused,
    // not trusted — an attached agent must not be able to read an arbitrary
    // journey in the deployment by guessing an id.
    const badBase = frames.length;
    ws.send(JSON.stringify({ type: "journey_info_request", requestId: "ji2", kelaboId: KELABO, journeyId: "not-linked" }));
    const bad = await nextFrame((f) => f.type === "journey_info" && f.requestId === "ji2", 5000, badBase);
    assert.equal(bad.resolved, "journey_not_found");
    console.log("ok: journey_info_request with an unlinked journeyId → journey_not_found, never trusted");
  }

  {
    // journey_post is gated by the owner-controlled aiCanPost (docs 20 §7),
    // off by default here — a real refusal, not a silently dropped write.
    const base = frames.length;
    ws.send(JSON.stringify({ type: "journey_post", requestId: "jp1", kelaboId: KELABO, content: "Freeze is Friday" }));
    const off = await nextFrame((f) => f.type === "journey_posted" && f.requestId === "jp1", 5000, base);
    assert.equal(off.resolved, "ai_posting_disabled");
    assert.equal(calls.puts.find((p) => p.TableName === "t-journeys" && String(p.Item.SK).startsWith("BOARDMSG#")), undefined);
    console.log("ok: journey_post refuses with ai_posting_disabled while the owner has not turned it on");

    journeyMetaItem.aiCanPost = true;
    const base2 = frames.length;
    ws.send(JSON.stringify({ type: "journey_post", requestId: "jp2", kelaboId: KELABO, content: "Freeze is Friday" }));
    const on = await nextFrame((f) => f.type === "journey_posted" && f.requestId === "jp2", 5000, base2);
    delete journeyMetaItem.aiCanPost;
    assert.equal(on.resolved, "ok");
    assert.equal(on.version, 1);
    assert.ok(on.msgId);
    const written = calls.puts.find((p) => p.TableName === "t-journeys" && String(p.Item.SK) === `BOARDMSG#${on.msgId}`);
    assert.equal(written.Item.content, "Freeze is Friday");
    console.log("ok: journey_post writes a BOARDMSG# item once aiCanPost is on");
  }

  {
    // Linking a second journey makes the kelabo's journey ambiguous: no
    // journeyId means enumerate the candidates rather than guess one.
    kelaboJourneyLinks = [
      ...kelaboJourneyLinks,
      { PK: `KELABO#${KELABO}`, SK: `JOURNEY#${JOURNEY2}`, journeyId: JOURNEY2, journeyTitleSnapshot: "Second Journey" },
    ];
    const base = frames.length;
    ws.send(JSON.stringify({ type: "journey_board_request", requestId: "jb1", kelaboId: KELABO }));
    const ambiguous = await nextFrame((f) => f.type === "journey_board" && f.requestId === "jb1", 5000, base);
    assert.equal(ambiguous.resolved, "ambiguous");
    assert.equal(ambiguous.journeys.length, 2);
    assert.ok(ambiguous.journeys.some((j) => j.journeyId === JOURNEY));
    assert.ok(ambiguous.journeys.some((j) => j.journeyId === JOURNEY2));

    // Naming one resolves it.
    const base2 = frames.length;
    ws.send(JSON.stringify({ type: "journey_board_request", requestId: "jb2", kelaboId: KELABO, journeyId: JOURNEY2 }));
    const resolved = await nextFrame((f) => f.type === "journey_board" && f.requestId === "jb2", 5000, base2);
    assert.equal(resolved.resolved, "ok");
    console.log("ok: two linked journeys → ambiguous without a journeyId, resolved with one");
    kelaboJourneyLinks = kelaboJourneyLinks.slice(0, 1); // back to one link for the tests below
  }

  {
    const pending = req(port, {
      method: "POST",
      path: `/internal/kelabos/${KELABO}/minutes`,
      headers: { authorization: `Bearer ${internalJwt}` },
    });
    // Correlated by requestId, not "whatever board post arrives next": a
    // contribution sent at this moment used to silently become the minutes.
    const request = await nextFrame((f) => f.type === "request" && f.kind === "summary");
    assert.ok(request.requestId);
    ws.send(JSON.stringify({
      type: "summary",
      requestId: request.requestId,
      kelaboId: KELABO,
      text: JSON.stringify({ topics: ["retries"], decisions: ["ship Friday"], actionItems: [{ text: "cut release", owner: "Alice" }], openQuestions: [], findings: [] }),
    }));
    const res = await pending;
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    // A dev-mode (opencode) summary in the old string-array shape is normalized
    // into the same document the server agent produces.
    assert.deepEqual(body.minutes.topics, [{ title: "retries" }]);
    assert.deepEqual(body.minutes.decisions, [{ text: "ship Friday" }]);
    assert.ok(calls.puts.find((p) => p.Item.SK === "MINUTES"), "MINUTES item stored");
    assert.ok(!sse.events.find((e) => e.data?.kind === "minutes"), "minutes never fanned to SSE");
    console.log("ok: internal minutes (dev mode) → MINUTES stored, not fanned");
  }

  {
    const unauth = await req(port, { method: "POST", path: `/internal/kelabos/${KELABO}/end` });
    assert.equal(unauth.status, 401);
    console.log("ok: internal end requires internal JWT");
  }

  {
    const archive = {
      archiveId: KELABO,
      kelaboId: KELABO,
      title: "Smoke Kelabo",
      host: "alice@example.com",
      participants: [{ identity: "alice@example.com", displayName: "Alice", isGuest: false }],
      startedAt: NOW - 60_000,
      endedAt: Date.now(),
      transcript: [{ kelaboId: KELABO, clientId: "c1", speaker: "A", text: "hello", tStart: 0, tEnd: 1, isFinal: true }],
      board: [],
    };
    const base = frames.length;
    const pending = req(port, {
      method: "POST",
      path: `/internal/kelabos/${KELABO}/end`,
      headers: { authorization: `Bearer ${internalJwt}` },
    });
    // Archive request comes first (synchronous): reply with the session archive.
    const archiveReq = await nextFrame((f) => f.type === "request" && f.kind === "archive", 5000, base);
    ws.send(JSON.stringify({ type: "archive", requestId: archiveReq.requestId, archive }));
    // End returns immediately (summary/minutes generated asynchronously).
    const res = await pending;
    assert.equal(res.status, 200);
    assert.ok(calls.s3Puts.find((p) => p.Key === `archives/alice@example.com/${KELABO}.json`), "archive JSON to S3");
    assert.ok(calls.puts.find((p) => p.TableName === "t-history" && p.Item.archiveId === KELABO), "history row");
    assert.ok(calls.puts.find((p) => String(p.Item.archiveId).startsWith("PARTICIPANT#alice@example.com")), "participant-index companion");
    const endedEvt = await waitFor(() => sse.events.find((e) => e.event === "ended"));
    assert.equal(endedEvt.data.reason, "ended");
    // Async summary: tunnel is still open; reply to the summary request, then the
    // minutes are persisted, then the session closes.
    const summaryReq = await nextFrame((f) => f.type === "request" && f.kind === "summary", 5000, base);
    ws.send(JSON.stringify({
      type: "summary",
      requestId: summaryReq.requestId,
      kelaboId: KELABO,
      text: JSON.stringify({ topics: ["wrap"], decisions: [], actionItems: [], openQuestions: [], findings: [] }),
    }));
    await waitFor(() => calls.puts.find((p) => p.Item.SK === "MINUTES"));
    // The socket stays open past `ended` so the summary can still arrive; the
    // kelabo event is how the bridge learns to stop.
    await nextFrame((f) => f.type === "kelabo" && f.event === "ended", 5000, base);
    console.log("ok: internal end (dev mode) → fast end + archive request, S3 + history + participant-index, SSE ended, async minutes, kelabo ended");
  }

  {
    // A kelabo can be "ended" here and still have no record: the control plane
    // marks it ended whether or not this call landed, so an unreachable Gateway
    // does not strand it live. `retry` is how it asks again — but only for a
    // kelabo the control plane itself flagged. `retry` alone must not reopen an
    // archived kelabo, or a replayed end would rewrite a record.
    metaItem.status = "ended";
    const headers = { authorization: `Bearer ${internalJwt}` };
    const again = await req(port, { method: "POST", path: `/internal/kelabos/${KELABO}/end`, headers });
    assert.equal(again.status, 409);

    const retryUnflagged = await req(port, {
      method: "POST",
      path: `/internal/kelabos/${KELABO}/end`,
      headers,
      body: { retry: true },
    });
    assert.equal(retryUnflagged.status, 409, "retry is not a bypass; archivePending is the permission");
    console.log("ok: a second end is a conflict, and `retry` alone does not reopen an archived kelabo");
  }

  server.close();
  await c.shutdown();
  console.log("\nSMOKE TEST PASSED");
  process.exit(0);
}

main().catch((err) => {
  console.error("SMOKE TEST FAILED:", err);
  process.exit(1);
});
