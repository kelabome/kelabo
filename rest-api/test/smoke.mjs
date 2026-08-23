import assert from "node:assert/strict";
import { createApp, originSecretMatches, ORIGIN_SECRET_HEADER } from "../src/index.js";
import { createDb } from "./stubDb.js";
import { createOtp } from "../src/otp.js";
import { createSessions } from "../src/sessions.js";
import { createOidc } from "../src/oidc.js";
import { createMcpOauth } from "../src/mcpOauth.js";
import { createAuthProvider } from "../src/authProvider.js";
import { createKelabos } from "../src/kelabos.js";
import { createScheduling } from "../src/scheduling.js";
import { createContacts } from "../src/contacts.js";
import { createHuddle } from "../src/huddle.js";
import { createJoin } from "../src/join.js";
import { createJoinCodes, generateJoinCode, normalizeJoinCode } from "../src/joinCode.js";
import { createRecords } from "../src/records.js";
import { cutoffFromAge } from "@kelabo/contracts/retention";
import { createSttToken } from "../src/stt/index.js";
import { createAgent } from "../src/agent.js";

const config = {
  env: "test",
  region: "us-east-1",
  allowedEmailDomain: "example.com",
  cookieDomain: ".test.example.com",
  portalUrl: "https://test.example.com",
  gatewayBaseUrl: "https://gw.test.example.com",
  joinUrl: (id) => `https://test.example.com/join/${id}`,
  inviteUrl: (id) => `https://test.example.com/invite/${id}`,
  tableNames: { kelabos: "m", users: "u", otp: "o", refresh: "r", history: "h", mcp: "mc", contacts: "co" },
  contacts: { external: false },
  archiveBucket: "bucket",
  archiveKeyPrefix: "archives",
  secrets: { stt: "stt-secret", cookieSigningKey: "cookie", oidcGoogle: "g", oidcApple: "a", mcpPrefix: "t/mcp/" },
  auth: { sessionTtlSeconds: 3600, refreshTtlDays: 60, participantTtlSeconds: 43200, agentTokenTtlDays: 90, socialProviders: ["google", "apple"] },
  stt: {
    provider: "deepgram",
    language: "en",
    providers: { deepgram: { model: "nova-3", diarizeModel: "latest", tokenTtlSeconds: 60 } },
  },
  rtc: { defaultMode: "sfu", meshMaxParticipants: 6, video: false },
  mail: { provider: "ses", fromAddress: "otp@test.example.com", ses: {}, mailersend: {} },
  otp: {
    ttlSeconds: 600,
    maxAttempts: 5,
    resendSeconds: 0,
    perEmailWindowSeconds: 3600,
    perEmailMaxRequests: 5,
    perIpWindowSeconds: 3600,
    perIpMaxRequests: 30,
  },
  joinCode: {
    ttlSeconds: 120,
    mintPerKelaboPerHour: 20,
    redeemPerIpWindowSeconds: 3600,
    redeemPerIpMaxRequests: 20,
  },
  retentionDays: 30,
};

const mcpSecretCalls = [];
const secrets = {
  getCookieKey: async () => "test-signing-key",
  getSttKey: async () => "stt-api-key",
  putMcpSecret: async (config, identity, name, token) => mcpSecretCalls.push({ op: "put", identity, name, token }),
  deleteMcpSecret: async (config, identity, name) => mcpSecretCalls.push({ op: "delete", identity, name }),
};
const sentEmails = [];
const sentInvites = [];
const sentCancellations = [];
const sentReschedules = [];
const sentUninvites = [];
// Stands in for `createMailer` — the same four methods, no transport. `from` is
// no longer passed by the callers (the mailer defaults it), so it arrives
// undefined here and the assertions below are about `to` and the content.
const mailer = {
  sendOtp: async ({ to, code, from }) => {
    sentEmails.push({ to, code, from });
  },
  sendInvite: async (msg) => {
    // One address is made to fail so the "a bad address does not lose the
    // schedule" path is exercised rather than assumed.
    if (msg.to === "bounce@example.com") throw new Error("MessageRejected");
    sentInvites.push(msg);
  },
  sendCancellation: async (msg) => {
    sentCancellations.push(msg);
  },
  sendReschedule: async (msg) => {
    sentReschedules.push(msg);
  },
  sendUninvite: async (msg) => {
    sentUninvites.push(msg);
  },
};
const internalCalls = [];
// Which identities the fake gateway considers "online" for ring delivery.
const onlineSet = new Set();
const internal = {
  // Set to make the fake gateway unreachable, the way a closed ALB made the
  // real one (docs 07 `allowIps`).
  endUnreachable: false,
  endKelabo: async (kelaboId, identity, { retry = false } = {}) => {
    internalCalls.push({ op: "end", kelaboId, identity, ...(retry ? { retry } : {}) });
    if (internal.endUnreachable) throw new TypeError("fetch failed");
    return { ok: true, archived: true };
  },
  requestMinutes: async (kelaboId, identity) => internalCalls.push({ op: "minutes", kelaboId, identity }),
  cancelKelabo: async (kelaboId, identity) => internalCalls.push({ op: "cancel", kelaboId, identity }),
  rescheduleKelabo: async (kelaboId, identity) => internalCalls.push({ op: "reschedule", kelaboId, identity }),
  ring: async (kelaboId, identity, { targets }) => {
    internalCalls.push({ op: "ring", kelaboId, identity, targets });
    const rung = targets.filter((t) => onlineSet.has(t));
    const offline = targets.filter((t) => !onlineSet.has(t));
    return { rung, offline };
  },
  ringCancel: async (kelaboId, identity) => internalCalls.push({ op: "ringCancel", kelaboId, identity }),
  ringAnswer: async (kelaboId, identity, { response }) => internalCalls.push({ op: "ringAnswer", kelaboId, identity, response }),
};

// A fake MCP server + its authorization server, exercising the whole
// MCP-authorization discovery chain: 401 challenge -> RFC 9728 protected
// resource metadata -> RFC 8414 AS metadata -> RFC 7591 dynamic registration ->
// token exchange. Everything here is offline.
const asCalls = [];
const RES = (status, body, headers = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: (k) => headers[k.toLowerCase()] ?? null },
  text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
});
const mcpFetch = async (url, init = {}) => {
  const u = String(url);
  asCalls.push({ url: u, method: init.method || "GET", body: init.body ?? null });
  if (u === "https://mcp.acme.test/mcp" && init.method === "POST") {
    return RES(401, { error: "unauthorized" }, {
      "www-authenticate":
        'Bearer realm="mcp", resource_metadata="https://mcp.acme.test/.well-known/oauth-protected-resource/mcp"',
    });
  }
  if (u === "https://mcp.acme.test/.well-known/oauth-protected-resource/mcp") {
    return RES(200, {
      resource: "https://mcp.acme.test/mcp",
      authorization_servers: ["https://auth.acme.test"],
      scopes_supported: ["read:jira", "write:jira"],
    });
  }
  if (u === "https://auth.acme.test/.well-known/oauth-authorization-server") {
    return RES(200, {
      issuer: "https://auth.acme.test",
      authorization_endpoint: "https://auth.acme.test/authorize",
      token_endpoint: "https://auth.acme.test/token",
      registration_endpoint: "https://auth.acme.test/register",
      code_challenge_methods_supported: ["S256"],
    });
  }
  // A server implementing the OLDER (2025-03-26) discovery: 401 with no
  // resource_metadata, no protected-resource document, AS metadata served at its
  // own origin. This is what Atlassian's production server actually does.
  if (u === "https://legacy.acme.test/mcp" && init.method === "POST") {
    return RES(401, { error: "unauthorized" }, { "www-authenticate": 'Bearer realm="OAuth", error="invalid_token"' });
  }
  if (u === "https://legacy.acme.test/.well-known/oauth-authorization-server") {
    return RES(200, {
      issuer: "https://legacy.acme.test",
      authorization_endpoint: "https://legacy.acme.test/authorize",
      token_endpoint: "https://legacy.acme.test/token",
      registration_endpoint: "https://legacy.acme.test/register",
    });
  }
  if (u === "https://auth.acme.test/register") {
    return RES(201, { client_id: "dyn-client-1", client_secret: null });
  }
  if (u === "https://auth.acme.test/token") {
    const form = new URLSearchParams(init.body);
    if (form.get("code_verifier") === undefined || !form.get("code_verifier")) {
      return RES(400, { error: "invalid_request", error_description: "PKCE required" });
    }
    return RES(200, {
      access_token: "at-1",
      refresh_token: "rt-1",
      token_type: "Bearer",
      expires_in: 3600,
      scope: "read:jira write:jira",
    });
  }
  return RES(404, { error: "not_found" });
};

const db = createDb();
const otp = createOtp({ config, db, mailer });
const sessions = createSessions({ config, db, secrets });
const oidc = createOidc({ config, secrets, fetchImpl: async () => ({ ok: false }) });
const auth = createAuthProvider({ otp, oidc, sessions });
const kelabos = createKelabos({ config, db, internal });
const scheduling = createScheduling({ config, db, mailer, internal });
const contacts = createContacts({ config, db });
const huddle = createHuddle({ config, db, internal, kelabos });
const join = createJoin({ config, db, secrets });
const joinCodes = createJoinCodes({ config, db });
const s3Deletes = [];
const s3Objects = {}; // key -> JSON string served by the GetObject stub
const records = createRecords({
  config,
  db,
  s3: {
    send: async (cmd) => {
      if (cmd?.constructor?.name === "DeleteObjectCommand") {
        s3Deletes.push(cmd.input.Key);
        return {};
      }
      return { Body: { transformToString: async () => s3Objects[cmd.input?.Key] ?? "{}" } };
    },
  },
});
const sttToken = createSttToken({ config, db, secrets, fetchImpl: async () => ({ ok: false, status: 500 }) });

const mcpOauth = createMcpOauth({ config, db, secrets, fetchImpl: mcpFetch });

const agent = createAgent({ config, db, secrets });

const app = createApp({ config, db, secrets, mailer, sessions, auth, kelabos, join, joinCodes, records, sttToken, internal, mcpOauth, scheduling, contacts, huddle, agent, version: "test" });

function cookieValue(res, name) {
  const c = (res.cookies || []).find((s) => s.startsWith(`${name}=`));
  return c ? decodeURIComponent(c.split(";")[0].slice(name.length + 1)) : null;
}

async function call(method, path, { body, cookies = {}, ip = "1.2.3.4", bearer } = {}) {
  const [rawPath, qs] = path.split("?");
  const res = await app({
    requestContext: { http: { method, sourceIp: ip } },
    rawPath,
    rawQueryString: qs || "",
    headers: {
      "content-type": "application/json",
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      ...(Object.keys(cookies).length
        ? { cookie: Object.entries(cookies).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("; ") }
        : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { ...res, json: res.body && res.headers["Content-Type"]?.includes("json") ? JSON.parse(res.body) : null };
}

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

await test("GET /health", async () => {
  const res = await call("GET", "/health");
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json, { ok: true, version: "test" });
});

await test("otp request rejects disallowed domain", async () => {
  const res = await call("POST", "/auth/otp/request", { body: { email: "eve@gmail.com" } });
  assert.equal(res.statusCode, 403);
  assert.equal(res.json.error, "domain_not_allowed");
});

await test("empty allow-list = open registration, tenant from the email's own domain", async () => {
  // The multi-domain mode: no allow-list configured, every org lands in its
  // own tenant. Built from the same modules with only the config differing.
  const { createOtp } = await import("../src/otp.js");
  const openOtp = createOtp({ config: { ...config, allowedEmailDomain: "" }, db, mailer });
  await openOtp.request({ email: "sam@anywhere.io" });
  // pop, not peek: the next test counts sentEmails from empty.
  const sent = sentEmails.pop();
  assert.equal(sent.to, "sam@anywhere.io");
  const out = await openOtp.verify({ email: "sam@anywhere.io", code: sent.code });
  assert.equal(out.tenantId, "anywhere.io");
});

await test("otp request/verify happy path sets session+refresh cookies", async () => {
  const req = await call("POST", "/auth/otp/request", { body: { email: "alice@example.com" } });
  assert.equal(req.statusCode, 200);
  assert.equal(req.json.ok, true);
  assert.equal(sentEmails.length, 1);
  assert.equal(sentEmails[0].to, "alice@example.com");
  // The sender is the mailer's business, not this route's. Every call site
  // used to pass `config.ses.fromAddress` by hand, which is one more thing to
  // forget and a silent provider rejection when someone does — `test/mail.mjs`
  // asserts the mailer supplies it.
  assert.equal(sentEmails[0].from, undefined, "a caller is naming the sender again");
  const code = sentEmails[0].code;
  assert.match(code, /^\d{6}$/);

  const bad = await call("POST", "/auth/otp/verify", { body: { email: "alice@example.com", code: code === "000000" ? "000001" : "000000" } });
  assert.equal(bad.statusCode, 401);
  assert.equal(bad.json.error, "invalid_code");

  const ver = await call("POST", "/auth/otp/verify", { body: { email: "alice@example.com", code } });
  assert.equal(ver.statusCode, 200);
  assert.equal(ver.json.identity.email, "alice@example.com");
  assert.equal(ver.json.tenantId, "example.com");
  assert.ok(cookieValue(ver, "kelabo_session"));
  assert.ok(cookieValue(ver, "kelabo_refresh"));
});

const sessionCookies = {};
await test("session cookie works for /me and kelabo creation", async () => {
  await call("POST", "/auth/otp/request", { body: { email: "host@example.com" } });
  const code = sentEmails.at(-1).code;
  const ver = await call("POST", "/auth/otp/verify", { body: { email: "host@example.com", code } });
  sessionCookies.kelabo_session = cookieValue(ver, "kelabo_session");
  sessionCookies.kelabo_refresh = cookieValue(ver, "kelabo_refresh");

  const me = await call("GET", "/me", { cookies: sessionCookies });
  assert.equal(me.statusCode, 200);
  assert.equal(me.json.identity.email, "host@example.com");

  const anon = await call("GET", "/me");
  assert.equal(anon.statusCode, 401);
  assert.equal(anon.json.error, "unauthenticated");
});

let kelaboId;
await test("POST /kelabos creates kelabo with one-active guard", async () => {
  const res = await call("POST", "/kelabos", { body: { title: "Standup" }, cookies: sessionCookies });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json.status, "active");
  assert.equal(res.json.joinUrl, `https://test.example.com/join/${res.json.kelaboId}`);
  kelaboId = res.json.kelaboId;

  // Multiple live kelabos per host are allowed (the HOSTACTIVE guard is
  // gone) — the second create is a genuinely new kelabo, not a bounce.
  const again = await call("POST", "/kelabos", { body: { title: "Second" }, cookies: sessionCookies });
  assert.equal(again.statusCode, 200);
  assert.equal(again.json.status, "active");
  assert.notEqual(again.json.kelaboId, kelaboId);
  // End it so later tests see the single kelabo they expect.
  await db.updateKelaboMeta(again.json.kelaboId, { status: "ended", tenantStatus: null });
});

let participantCookies = {};
let guestIdentity = "";
await test("POST /kelabos/:id/join as guest mints participant cookie", async () => {
  const bad = await call("POST", `/kelabos/${kelaboId}/join`, { body: { displayName: "", mode: "board-only" } });
  assert.equal(bad.statusCode, 400);
  assert.equal(bad.json.error, "name_required");

  const res = await call("POST", `/kelabos/${kelaboId}/join`, { body: { displayName: "Bob", mode: "board-only" } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json.gatewayBaseUrl, "https://gw.test.example.com");
  assert.equal(res.json.participant.isGuest, true);
  assert.match(res.json.participant.identity, /^guest:/);
  guestIdentity = res.json.participant.identity;
  participantCookies.kelabo_participant = cookieValue(res, "kelabo_participant");
  assert.ok(participantCookies.kelabo_participant);

  const meta = await db.getKelaboMeta(kelaboId);
  assert.equal(meta.participants.length, 1);
  assert.equal(meta.participants[0].displayName, "Bob");
});

// --- join codes (rest-api/src/joinCode.js) ----------------------------------
// The two-minute spoken stand-in for a kelabo URL. Everything here is about a
// code surviving the trip through a phone call and a stranger's keyboard, and
// about being worthless the moment it should be.

// Letters minus I/L/O, digits minus 0/1, strictly alternating.
const CODE_RE = /^([A-HJKMNP-Z][2-9]){3}$/;

await test("join code: shape is the promise — no I/L/O, no 0/1, letter-digit x3", async () => {
  // The exclusions are the whole reason the alphabet is not A-Z0-9: someone
  // reads "1" aloud and someone else types "l", and neither ever finds out why
  // it did not work. Generated directly and in bulk — a sampling bug that only
  // shows up one code in a thousand is exactly the kind this has to catch.
  const seen = new Set();
  for (let i = 0; i < 2000; i += 1) {
    const code = generateJoinCode();
    assert.match(code, CODE_RE, `bad code: ${code}`);
    assert.equal(/[ILO01]/.test(code), false, `ambiguous glyph in ${code}`);
    seen.add(code);
  }
  // Nothing stuck: a generator returning a handful of values would still pass
  // every assertion above.
  assert.ok(seen.size > 1900, `only ${seen.size} distinct codes in 2000 draws`);
});

await test("join code: normalizing accepts what a human types, rejects what we never issue", async () => {
  assert.equal(normalizeJoinCode("A5B4C7"), "A5B4C7");
  assert.equal(normalizeJoinCode("a5b4c7"), "A5B4C7", "case is the typist's");
  assert.equal(normalizeJoinCode(" a5 b4-c7 "), "A5B4C7", "so are spaces and dashes");
  // The alternating shape is ours, so a string without it cannot be one of ours
  // and is refused before it costs a lookup.
  assert.equal(normalizeJoinCode("AAAAAA"), "");
  assert.equal(normalizeJoinCode("555555"), "");
  assert.equal(normalizeJoinCode("A5B4C"), "", "too short");
  assert.equal(normalizeJoinCode("A5B4C77"), "", "too long");
  // The excluded glyphs are excluded on the way in too, so "I" is never
  // silently accepted as a letter we would not have printed.
  assert.equal(normalizeJoinCode("I5B4C7"), "");
  assert.equal(normalizeJoinCode("A0B4C7"), "");
  assert.equal(normalizeJoinCode("A1B4C7"), "");
  assert.equal(normalizeJoinCode(""), "");
  assert.equal(normalizeJoinCode(null), "");
});

await test("join code: minting needs the participant cookie, not a session", async () => {
  // Being in the room is the authority. It is the right one — you can only give
  // away a way in to a kelabo you are already in — and the only one a guest
  // with no account can hold.
  const anon = await call("POST", `/kelabos/${kelaboId}/join-code`);
  assert.equal(anon.statusCode, 401);
  assert.equal(anon.json.error, "unauthenticated");

  // A session for the host is not a participant cookie for this kelabo.
  const sessionOnly = await call("POST", `/kelabos/${kelaboId}/join-code`, { cookies: sessionCookies });
  assert.equal(sessionOnly.statusCode, 401);

  const ok = await call("POST", `/kelabos/${kelaboId}/join-code`, { cookies: participantCookies });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.json.expiresInSeconds, 120);
  assert.ok(ok.json.expiresAt > Date.now());
});

await test("join code: redeeming resolves to the kelabo, however it was typed", async () => {
  const mint = await call("POST", `/kelabos/${kelaboId}/join-code`, { cookies: participantCookies });
  const code = mint.json.code;

  // Exactly what someone repeats back down a phone: lower case, with spaces.
  const typed = `${code.slice(0, 2)} ${code.slice(2, 4)} ${code.slice(4)}`.toLowerCase();
  const res = await call("POST", "/join-code/redeem", { body: { code: typed } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json.kelaboId, kelaboId);
  assert.equal(res.json.title, "Standup", "so they can see they reached the right room");
  assert.equal(res.json.joinUrl, `https://test.example.com/join/${kelaboId}`);

  // Redeeming resolves and stops: no cookie is minted here, because joining is
  // /kelabos/:id/join and there must be exactly one way in.
  assert.equal(cookieValue(res, "kelabo_participant"), null);
});

await test("join code: one code, several people — it is not burned on first use", async () => {
  // You read a code to three people. If the first use burned it, the second
  // person's failure would be indistinguishable from a typo.
  const mint = await call("POST", `/kelabos/${kelaboId}/join-code`, { cookies: participantCookies });
  for (let i = 0; i < 3; i += 1) {
    const res = await call("POST", "/join-code/redeem", { body: { code: mint.json.code }, ip: `5.5.5.${i}` });
    assert.equal(res.statusCode, 200, `redeem ${i + 1} should still work`);
    assert.equal(res.json.kelaboId, kelaboId);
  }
});

await test("join code: an unknown code and a malformed one are the same answer", async () => {
  // A guesser must not be able to tell "wrong shape" from "no such code" —
  // that difference is a free oracle over a 7.1M space.
  const unknown = await call("POST", "/join-code/redeem", { body: { code: "A5B4C7" }, ip: "6.6.6.1" });
  const malformed = await call("POST", "/join-code/redeem", { body: { code: "ZZZZZZ" }, ip: "6.6.6.2" });
  assert.equal(unknown.statusCode, 404);
  assert.equal(unknown.json.error, "join_code_invalid");
  assert.equal(malformed.statusCode, unknown.statusCode);
  assert.equal(malformed.json.error, unknown.json.error);
});

await test("join code: two minutes and it is gone", async () => {
  const mint = await call("POST", `/kelabos/${kelaboId}/join-code`, { cookies: participantCookies });
  const item = await db.getJoinCode(mint.json.code);
  // Correctness rests on the millisecond clock, never on DynamoDB's sweeper —
  // TTL deletion is best-effort and can lag by two days.
  item.expiresAt = Date.now() - 1;

  const res = await call("POST", "/join-code/redeem", { body: { code: mint.json.code }, ip: "6.6.6.3" });
  assert.equal(res.statusCode, 410);
  assert.equal(res.json.error, "join_code_expired");
  assert.equal(await db.getJoinCode(mint.json.code), null, "an expired code is deleted, not left to rot");
});

await test("join code: a code for a kelabo that has ended does not let anyone in", async () => {
  const mint = await call("POST", `/kelabos/${kelaboId}/join-code`, { cookies: participantCookies });
  await db.updateKelaboMeta(kelaboId, { status: "ended" });
  const res = await call("POST", "/join-code/redeem", { body: { code: mint.json.code }, ip: "6.6.6.4" });
  assert.equal(res.statusCode, 410);
  assert.equal(res.json.error, "kelabo_ended");

  // Nor can one be minted for it.
  const again = await call("POST", `/kelabos/${kelaboId}/join-code`, { cookies: participantCookies });
  assert.equal(again.statusCode, 410);
  assert.equal(again.json.error, "kelabo_ended");
  await db.updateKelaboMeta(kelaboId, { status: "active" });
});

await test("join code: guessing is bounded per IP, malformed guesses included", async () => {
  // The per-code attempt counter the OTP uses would never see this attacker:
  // they are not attacking one code, they are fishing for any code live
  // anywhere. The IP counter is the control that does.
  const ip = "7.7.7.7";
  let limited = 0;
  for (let i = 0; i < 25; i += 1) {
    // Deliberately malformed — a guesser who could spend those for free would
    // spend those.
    const res = await call("POST", "/join-code/redeem", { body: { code: "!!!!!!" }, ip });
    if (res.statusCode === 429) limited += 1;
  }
  assert.ok(limited > 0, "the cap never engaged");
  const after = await call("POST", "/join-code/redeem", { body: { code: "A5B4C7" }, ip });
  assert.equal(after.statusCode, 429, "a spent budget stays spent");
  assert.equal(after.json.error, "rate_limited");
});

await test("join code: one room cannot hold unlimited live codes", async () => {
  // Every extra live code multiplies the guess surface, so minting is capped
  // per kelabo per hour even though the minter is already inside the room.
  const counter = await db.bumpJoinCodeCounter(`k:${kelaboId}`, 3600);
  counter.count = 0;
  let limited = 0;
  for (let i = 0; i < 25; i += 1) {
    const res = await call("POST", `/kelabos/${kelaboId}/join-code`, { cookies: participantCookies });
    if (res.statusCode === 429) limited += 1;
  }
  assert.ok(limited > 0, "the mint cap never engaged");
  counter.count = 0;
});

await test("the host's join stamps their language on the kelabo", async () => {
  // The Gateway writes the minutes in the host's language but cannot read the
  // users table, so join is where that setting crosses over. Guests joining
  // must not touch it.
  await db.putUserSettings("host@example.com", { sttLang: "zh" }, Date.now());
  const before = await db.getKelaboMeta(kelaboId);
  assert.equal(before.hostLang, undefined, "not set by the guest join above");

  const res = await call("POST", `/kelabos/${kelaboId}/join`, {
    body: { displayName: "Alex", mode: "board-only" },
    cookies: sessionCookies,
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json.participant.isGuest, false);
  const after = await db.getKelaboMeta(kelaboId);
  assert.equal(after.hostLang, "zh");
});

await test("GET /kelabos/:id public vs participant views", async () => {
  const pub = await call("GET", `/kelabos/${kelaboId}`);
  assert.equal(pub.statusCode, 200);
  assert.deepEqual(Object.keys(pub.json).sort(), ["hostIdentity", "hostJoinedAt", "kelaboId", "startedAt", "status", "title"]);

  const full = await call("GET", `/kelabos/${kelaboId}`, { cookies: participantCookies });
  assert.equal(full.json.hostIdentity, "host@example.com");
  assert.equal(full.json.gatewayBaseUrl, "https://gw.test.example.com");
  // Bob (guest) and the host, who joined in the test above.
  assert.equal(full.json.participants.length, 2);
  // A guest has no email, so the SPA cannot identify its own fanned-out
  // utterances from the signed-in identity — it has none. Without `me` every
  // guest saw their own speech echoed back as a second speaker, while hosts
  // (always signed in) were unaffected, which is what hid the bug.
  assert.equal(full.json.me, guestIdentity, "participant-scoped view reports the caller's own identity");
  // The capability map (docs 19 §3): stated to participants so the client
  // renders absence instead of discovering it by failing. The stub wires no
  // secrets module, and everything short of a definitive "secret missing"
  // must read as on — the permissive default.
  assert.deepEqual(Object.keys(full.json.capabilities).sort(), ["assistant", "rtc", "stt", "video"]);
  assert.equal(full.json.capabilities.stt.on, true);
  assert.equal(full.json.capabilities.assistant.on, true);
  assert.equal(full.json.capabilities.rtc.mode, full.json.rtcMode);
  assert.equal(pub.json.capabilities, undefined, "capabilities are participant-scoped");

  const missing = await call("GET", "/kelabos/nope");
  assert.equal(missing.statusCode, 404);
  assert.equal(missing.json.error, "kelabo_not_found");
});

await test("GET /kelabos/:id/board backfill (limit + since)", async () => {
  const base = Date.now() - 60_000;
  for (let i = 1; i <= 5; i++) {
    await db._putContribution(kelaboId, {
      id: `c${i}`,
      kelaboId,
      tag: "LLM_CON",
      kind: "answer",
      title: `t${i}`,
      to: "all",
      markdown: `m${i}`,
      author: "assistant",
      at: base + i * 1000,
    });
  }
  const anon = await call("GET", `/kelabos/${kelaboId}/board`);
  assert.equal(anon.statusCode, 401);

  const res = await call("GET", `/kelabos/${kelaboId}/board?limit=3`, { cookies: participantCookies });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json.contributions.length, 3);
  assert.deepEqual(res.json.contributions.map((c) => c.id), ["c3", "c4", "c5"]);
  assert.equal(res.json.nextSince, base + 5000);

  const since = await call("GET", `/kelabos/${kelaboId}/board?since=${base + 2000}`, { cookies: participantCookies });
  assert.deepEqual(since.json.contributions.map((c) => c.id), ["c3", "c4", "c5"]);

  // The cursor is a *string* comparison on the sort key, so the reader's zero
  // padding has to match the Gateway's writer exactly. Padding wider made
  // `SK > :sk` true for everything, and reconnect backfill silently replayed the
  // board from the beginning while missing the newest cards. Asserting the tail
  // specifically, because returning "everything" also happens to contain them.
  const tail = await call("GET", `/kelabos/${kelaboId}/board?since=${base + 4000}`, { cookies: participantCookies });
  assert.deepEqual(tail.json.contributions.map((c) => c.id), ["c5"]);

  const caughtUp = await call("GET", `/kelabos/${kelaboId}/board?since=${base + 5000}`, { cookies: participantCookies });
  assert.deepEqual(caughtUp.json.contributions, []);
});

await test("POST /kelabos/:id/end (host only) signals gateway", async () => {
  const notHost = await call("POST", `/kelabos/${kelaboId}/end`, { cookies: participantCookies });
  assert.equal(notHost.statusCode, 401);

  const res = await call("POST", `/kelabos/${kelaboId}/end`, { cookies: sessionCookies });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json, { kelaboId, status: "ended", archived: true });
  assert.deepEqual(internalCalls, [{ op: "end", kelaboId, identity: "host@example.com" }]);

  const gone = await call("GET", `/kelabos/${kelaboId}`);
  assert.equal(gone.statusCode, 410);
  assert.equal(gone.json.error, "kelabo_ended");

  const again = await call("POST", `/kelabos/${kelaboId}/end`, { cookies: sessionCookies });
  assert.equal(again.statusCode, 409);
  assert.equal(again.json.error, "already_ended");
});

// The failure that cost a whole deployment its records: `allowIps` closed the
// Gateway's ALB to this Lambda, every internal call died with "fetch failed",
// and this side ended the kelabo anyway and said nothing. The kelabo must still
// end — an unreachable Gateway cannot leave it live forever — but it must say
// the record is missing, and it must be possible to ask again.
await test("an end the gateway never received is flagged, and can be retried", async () => {
  const created = await call("POST", "/kelabos", { cookies: sessionCookies, body: { title: "unreachable" } });
  const id = created.json.kelaboId;
  internalCalls.length = 0;

  internal.endUnreachable = true;
  const failed = await call("POST", `/kelabos/${id}/end`, { cookies: sessionCookies });
  assert.equal(failed.statusCode, 200, "the kelabo ends regardless");
  assert.equal(failed.json.archived, false, "but the caller is told there is no record");
  assert.equal((await db.getKelaboMeta(id)).archivePending, true);

  // Ending again is a resume, not a second end: no 409, and the gateway is told
  // so it does not 409 on the status this side wrote.
  internal.endUnreachable = false;
  const retried = await call("POST", `/kelabos/${id}/end`, { cookies: sessionCookies });
  assert.equal(retried.statusCode, 200);
  assert.equal(retried.json.archived, true);
  assert.deepEqual(internalCalls.at(-1), { op: "end", kelaboId: id, identity: "host@example.com", retry: true });
  assert.equal((await db.getKelaboMeta(id)).archivePending, undefined, "the flag is removed, not nulled");

  // And once archived it is an ordinary ended kelabo again.
  const third = await call("POST", `/kelabos/${id}/end`, { cookies: sessionCookies });
  assert.equal(third.statusCode, 409);
});

await test("POST /auth/refresh rotates refresh token", async () => {
  const res = await call("POST", "/auth/refresh", { cookies: { kelabo_refresh: sessionCookies.kelabo_refresh } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json.identity.email, "host@example.com");
  const rotated = cookieValue(res, "kelabo_refresh");
  assert.ok(rotated);
  assert.notEqual(rotated, sessionCookies.kelabo_refresh);

  const reuse = await call("POST", "/auth/refresh", { cookies: { kelabo_refresh: sessionCookies.kelabo_refresh } });
  assert.equal(reuse.statusCode, 401);
  assert.equal(reuse.json.error, "refresh_invalid");

  const theft = await call("POST", "/auth/refresh", { cookies: { kelabo_refresh: rotated } });
  assert.equal(theft.statusCode, 401, "chain revoked after reuse of rotated token");
});

await test("MCP servers: upsert/list/toggle/delete (host scope)", async () => {
  const anon = await call("GET", "/me/mcp");
  assert.equal(anon.statusCode, 401);

  const bad = await call("PUT", "/me/mcp", { body: { name: "bad name!", url: "https://mcp.example.com/x" }, cookies: sessionCookies });
  assert.equal(bad.statusCode, 400);

  const put = await call("PUT", "/me/mcp", { body: { name: "jira", url: "https://mcp.example.com/jira", secret: "tok123" }, cookies: sessionCookies });
  assert.equal(put.statusCode, 200);
  assert.equal(put.json.server.name, "jira");
  assert.equal(put.json.server.secretRef, undefined, "secretRef is an internal path, never returned");
  assert.equal(put.json.server.hasSecret, true);
  assert.equal(put.json.server.authType, "bearer", "a pasted token implies bearer auth");
  assert.deepEqual(mcpSecretCalls, [{ op: "put", identity: "host@example.com", name: "jira", token: "tok123" }]);

  const list = await call("GET", "/me/mcp", { cookies: sessionCookies });
  assert.equal(list.json.servers.length, 1);
  assert.equal(list.json.servers[0].name, "jira");
  assert.equal(list.json.servers[0].enabled, true);
  assert.equal(list.json.servers[0].hasSecret, true);
  assert.equal(list.json.servers[0].secret, undefined, "token never returned");
  assert.equal(list.json.servers[0].secretRef, undefined, "secret path never returned");
  assert.equal(list.json.servers[0].connected, false, "no OAuth token for a bearer server");

  // Toggle off without a secret: existing secretRef must survive.
  const off = await call("PUT", "/me/mcp", { body: { name: "jira", url: "https://mcp.example.com/jira", enabled: false }, cookies: sessionCookies });
  assert.equal(off.json.server.enabled, false);
  assert.equal(off.json.server.hasSecret, true, "existing secret survives a toggle");
  assert.equal(mcpSecretCalls.length, 1, "no secret rewrite on toggle");

  const del = await call("DELETE", "/me/mcp/jira", { cookies: sessionCookies });
  assert.equal(del.statusCode, 200);
  assert.deepEqual(mcpSecretCalls.at(-1), { op: "delete", identity: "host@example.com", name: "jira" });
  const gone = await call("GET", "/me/mcp", { cookies: sessionCookies });
  assert.equal(gone.json.servers.length, 0);

  const delAgain = await call("DELETE", "/me/mcp/jira", { cookies: sessionCookies });
  assert.equal(delAgain.statusCode, 404);
});

await test("MCP OAuth: probe -> start -> callback (discovery + DCR + PKCE)", async () => {
  // 1. Probe an unsaved URL: the SPA uses this to decide between "Connect" and
  //    an auth-token field.
  const probe = await call("POST", "/me/mcp/probe", {
    body: { url: "https://mcp.acme.test/mcp" },
    cookies: sessionCookies,
  });
  assert.equal(probe.statusCode, 200);
  assert.equal(probe.json.authType, "oauth");
  assert.equal(probe.json.dynamicRegistration, true, "AS advertises a registration_endpoint");
  assert.equal(probe.json.resource, "https://mcp.acme.test/mcp");

  await call("PUT", "/me/mcp", {
    body: { name: "acme", url: "https://mcp.acme.test/mcp", authType: "oauth" },
    cookies: sessionCookies,
  });

  // 2. Start: 302 to the authorization server, with PKCE + RFC 8707 `resource`.
  const start = await call("GET", "/me/mcp/acme/oauth/start", { cookies: sessionCookies });
  assert.equal(start.statusCode, 302);
  const authorizeUrl = new URL(start.headers.Location);
  assert.equal(authorizeUrl.origin + authorizeUrl.pathname, "https://auth.acme.test/authorize");
  assert.equal(authorizeUrl.searchParams.get("response_type"), "code");
  assert.equal(authorizeUrl.searchParams.get("client_id"), "dyn-client-1", "client_id came from DCR");
  assert.equal(authorizeUrl.searchParams.get("code_challenge_method"), "S256");
  assert.ok(authorizeUrl.searchParams.get("code_challenge"), "PKCE challenge present");
  assert.equal(authorizeUrl.searchParams.get("resource"), "https://mcp.acme.test/mcp", "RFC 8707 resource bound");
  assert.equal(
    authorizeUrl.searchParams.get("redirect_uri"),
    `${config.portalUrl}/api/me/mcp/oauth/callback`,
    "one fixed redirect URI for every server and user"
  );
  const state = authorizeUrl.searchParams.get("state");
  const stash = cookieValue(start, "kelabo_mcp_oauth");
  assert.ok(stash, "PKCE verifier stashed in a signed cookie, not a DB row");

  // 3. A mismatched state must be rejected (open-redirect / code-injection guard).
  const bad = await call("GET", `/me/mcp/oauth/callback?code=abc&state=wrong`, {
    cookies: { ...sessionCookies, kelabo_mcp_oauth: stash },
  });
  assert.equal(bad.statusCode, 302);
  assert.match(bad.headers.Location, /mcp_error=state_mismatch/);

  // 4. Real callback: exchanges the code and stores the tokens.
  const cb = await call("GET", `/me/mcp/oauth/callback?code=abc&state=${encodeURIComponent(state)}`, {
    cookies: { ...sessionCookies, kelabo_mcp_oauth: stash },
  });
  assert.equal(cb.statusCode, 302);
  assert.match(cb.headers.Location, /mcp_connected=acme/);

  const tokenExchange = asCalls.filter((c) => c.url === "https://auth.acme.test/token").at(-1);
  const form = new URLSearchParams(tokenExchange.body);
  assert.equal(form.get("grant_type"), "authorization_code");
  assert.equal(form.get("resource"), "https://mcp.acme.test/mcp", "resource replayed on the token request");
  assert.ok(form.get("code_verifier"), "PKCE verifier replayed");

  // 5. The list endpoint reports connected, and never leaks token material.
  const list = await call("GET", "/me/mcp", { cookies: sessionCookies });
  const acme = list.json.servers.find((s) => s.name === "acme");
  assert.equal(acme.authType, "oauth");
  assert.equal(acme.connected, true);
  assert.equal(acme.accessToken, undefined);
  assert.equal(acme.refreshToken, undefined);
  const stored = await db.getMcpToken("host#host@example.com", "acme");
  assert.equal(stored.accessToken, "at-1");
  assert.equal(stored.refreshToken, "rt-1");
  assert.ok(stored.expiresAt > Date.now(), "expires_in converted to an absolute deadline");

  // 6. Disconnect forgets the grant but keeps the server configured.
  const off = await call("DELETE", "/me/mcp/acme/oauth", { cookies: sessionCookies });
  assert.equal(off.statusCode, 200);
  assert.equal(await db.getMcpToken("host#host@example.com", "acme"), null);
  const after = await call("GET", "/me/mcp", { cookies: sessionCookies });
  assert.ok(after.json.servers.find((s) => s.name === "acme"), "server survives a disconnect");
});

await test("MCP OAuth: falls back to origin discovery when there is no RFC 9728 metadata", async () => {
  // Verified against the real https://mcp.atlassian.com, which answers 401 with
  // no resource_metadata and serves RFC 8414 metadata at its origin.
  const probe = await call("POST", "/me/mcp/probe", {
    body: { url: "https://legacy.acme.test/mcp" },
    cookies: sessionCookies,
  });
  assert.equal(probe.statusCode, 200);
  assert.equal(probe.json.authType, "oauth", "still connectable without protected-resource metadata");
  assert.equal(probe.json.via, "origin");
  assert.equal(probe.json.dynamicRegistration, true);
  // With no metadata to say otherwise, the MCP URL itself is the RFC 8707
  // resource identifier.
  assert.equal(probe.json.resource, "https://legacy.acme.test/mcp");
});

await test("MCP OAuth: a stale flow cannot be redeemed by another user", async () => {
  await call("PUT", "/me/mcp", {
    body: { name: "acme2", url: "https://mcp.acme.test/mcp", authType: "oauth" },
    cookies: sessionCookies,
  });
  const start = await call("GET", "/me/mcp/acme2/oauth/start", { cookies: sessionCookies });
  const stash = cookieValue(start, "kelabo_mcp_oauth");
  const state = new URL(start.headers.Location).searchParams.get("state");

  // No session at all -> bounced back to the UI, never a JSON 401 on a
  // top-level browser navigation.
  const anon = await call("GET", `/me/mcp/oauth/callback?code=abc&state=${encodeURIComponent(state)}`, {
    cookies: { kelabo_mcp_oauth: stash },
  });
  assert.equal(anon.statusCode, 302);
  assert.match(anon.headers.Location, /mcp_error=unauthenticated/);

  // The user declined at the provider.
  const denied = await call("GET", "/me/mcp/oauth/callback?error=access_denied", {
    cookies: { ...sessionCookies, kelabo_mcp_oauth: stash },
  });
  assert.equal(denied.statusCode, 302);
  assert.match(denied.headers.Location, /mcp_error=access_denied/);
});

await test("cutoffFromAge uses calendar arithmetic for months and years", async () => {
  const at = (s) => new Date(s).getTime();
  // 30-day approximations drift; these must land on the same day-of-month.
  assert.equal(cutoffFromAge(1, "months", at("2026-03-15T00:00:00Z")), at("2026-02-15T00:00:00Z"));
  assert.equal(cutoffFromAge(12, "months", at("2026-03-15T00:00:00Z")), at("2025-03-15T00:00:00Z"));
  assert.equal(cutoffFromAge(1, "years", at("2026-03-15T00:00:00Z")), at("2025-03-15T00:00:00Z"));
  // Day-of-month overflow clamps DOWN, never rolls forward into the next month
  // (rolling forward would shorten the window and delete more than asked).
  assert.equal(cutoffFromAge(1, "months", at("2026-03-31T00:00:00Z")), at("2026-02-28T00:00:00Z"));
  // Leap year.
  assert.equal(cutoffFromAge(1, "years", at("2028-02-29T00:00:00Z")), at("2027-02-28T00:00:00Z"));
  assert.equal(cutoffFromAge(2, "weeks", at("2026-03-15T00:00:00Z")), at("2026-03-01T00:00:00Z"));
  assert.equal(cutoffFromAge(3, "days", at("2026-03-15T00:00:00Z")), at("2026-03-12T00:00:00Z"));
  assert.throws(() => cutoffFromAge(0, "days"), /invalid retention value/);
  assert.throws(() => cutoffFromAge(100, "days"), /invalid retention value/, "capped at 99 regardless of unit");
  assert.equal(typeof cutoffFromAge(99, "years"), "number", "99 itself is still allowed");
  assert.throws(() => cutoffFromAge(1, "fortnights"), /invalid retention unit/);
});

await test("GET /records/search matches titles, and minutes full text with a snippet", async () => {
  const now = Date.now();
  db.__putHistory({
    archiveId: "sr-title", kelaboId: "sr-title", title: "Quarterly roadmap", host: "host@example.com",
    endedAt: now - 1000, participantIdentities: ["host@example.com"], hasMinutes: false,
  });
  db.__putHistory({
    archiveId: "PARTICIPANT#host@example.com#sr-title", participantIdentity: "host@example.com",
    kelaboId: "sr-title", title: "Quarterly roadmap", host: "host@example.com", endedAt: now - 1000,
  });
  db.__putHistory({
    archiveId: "sr-min", kelaboId: "sr-min", title: "Untitled kelabo", host: "host@example.com",
    endedAt: now - 2000, participantIdentities: ["host@example.com"], hasMinutes: true,
    s3Key: "archives/host@example.com/sr-min.json",
  });
  db.__putHistory({
    archiveId: "PARTICIPANT#host@example.com#sr-min", participantIdentity: "host@example.com",
    kelaboId: "sr-min", title: "Untitled kelabo", host: "host@example.com", endedAt: now - 2000, hasMinutes: true,
  });
  s3Objects["archives/host@example.com/sr-min.json"] = JSON.stringify({
    minutes: { summary: "We agreed to adopt the zebra retry protocol.", topics: [{ title: "Retries", detail: "Backoff caps at 30s." }] },
  });

  const byTitle = await call("GET", "/records/search?q=roadmap", { cookies: sessionCookies });
  assert.equal(byTitle.statusCode, 200);
  assert.deepEqual(byTitle.json.results.map((r) => r.archiveId), ["sr-title"]);
  assert.equal(byTitle.json.results[0].matched, "title");

  const byMinutes = await call("GET", "/records/search?q=zebra%20retry", { cookies: sessionCookies });
  assert.equal(byMinutes.statusCode, 200);
  const hit = byMinutes.json.results.find((r) => r.archiveId === "sr-min");
  assert.ok(hit, "minutes text matched");
  assert.equal(hit.matched, "minutes");
  assert.match(hit.snippet, /zebra retry/);

  // Below the minimum query length nothing is scanned.
  const tiny = await call("GET", "/records/search?q=z", { cookies: sessionCookies });
  assert.deepEqual(tiny.json.results, []);

  // Leave no trace — the purge test below asserts the exact record list.
  for (const id of ["sr-title", "PARTICIPANT#host@example.com#sr-title", "sr-min", "PARTICIPANT#host@example.com#sr-min"]) {
    await db.deleteHistoryRow(id);
  }
  delete s3Objects["archives/host@example.com/sr-min.json"];
});

await test("POST /records/purge: dry run reports without deleting", async () => {
  const DAY = 86400000;
  const now = Date.now();
  // Hosted by us and old -> full purge.
  db.__putHistory({
    archiveId: "old-hosted", kelaboId: "old-hosted", title: "Old hosted", host: "host@example.com",
    startedAt: now - 400 * DAY, endedAt: now - 400 * DAY, s3Key: "archives/host@example.com/old-hosted.json",
    participantIdentities: ["host@example.com", "other@example.com"],
  });
  db.__putHistory({
    archiveId: "PARTICIPANT#host@example.com#old-hosted", participantIdentity: "host@example.com",
    kelaboId: "old-hosted", title: "Old hosted", host: "host@example.com", endedAt: now - 400 * DAY,
  });
  db.__putKelaboItem("old-hosted", "META", { kelaboId: "old-hosted" });
  db.__putKelaboItem("old-hosted", "UTT#001", { text: "hello" });
  db.__putKelaboItem("old-hosted", "CONTRIB#001", { title: "c" });
  db.__putKelaboItem("old-hosted", "MINUTES", { title: "m" });

  // Attended only, old -> should leave the host's copy alone.
  db.__putHistory({
    archiveId: "old-attended", kelaboId: "old-attended", title: "Old attended", host: "someone@example.com",
    startedAt: now - 400 * DAY, endedAt: now - 400 * DAY, s3Key: "archives/someone@example.com/old-attended.json",
    participantIdentities: ["someone@example.com", "host@example.com"],
  });
  db.__putHistory({
    archiveId: "PARTICIPANT#host@example.com#old-attended", participantIdentity: "host@example.com",
    kelaboId: "old-attended", title: "Old attended", host: "someone@example.com", endedAt: now - 400 * DAY,
  });

  // Recent -> must survive.
  db.__putHistory({
    archiveId: "recent", kelaboId: "recent", title: "Recent", host: "host@example.com",
    startedAt: now - 2 * DAY, endedAt: now - 2 * DAY, participantIdentities: ["host@example.com"],
  });
  db.__putHistory({
    archiveId: "PARTICIPANT#host@example.com#recent", participantIdentity: "host@example.com",
    kelaboId: "recent", title: "Recent", host: "host@example.com", endedAt: now - 2 * DAY,
  });

  const before = db.__historySize();
  const dry = await call("POST", "/records/purge", { body: { value: 1, unit: "months", dryRun: true }, cookies: sessionCookies });
  assert.equal(dry.statusCode, 200);
  assert.equal(dry.json.dryRun, true);
  assert.equal(dry.json.matched, 2, "only the two 400-day-old records match");
  assert.deepEqual(dry.json.purged.map((r) => r.archiveId), ["old-hosted"], "hosted -> full purge");
  assert.deepEqual(dry.json.removedFromList.map((r) => r.archiveId), ["old-attended"], "attended -> list only");
  assert.equal(db.__historySize(), before, "dry run deletes nothing");
  assert.equal(db.__kelaboItemCount("old-hosted"), 4);
  assert.equal(s3Deletes.length, 0);
});

await test("POST /records/purge: hosted records are fully deleted, attended ones only unlinked", async () => {
  const res = await call("POST", "/records/purge", { body: { value: 1, unit: "months" }, cookies: sessionCookies });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json.purged.length, 1);
  assert.equal(res.json.failed.length, 0);

  // Hosted: archive object, whole kelabos partition, participant rows and the
  // authoritative row all gone.
  assert.deepEqual(s3Deletes, ["archives/host@example.com/old-hosted.json"]);
  assert.equal(db.__kelaboItemCount("old-hosted"), 0, "META + UTT + CONTRIB + MINUTES all removed");
  assert.equal(await db.getHistory("old-hosted"), null);
  assert.equal(await db.getHistory("PARTICIPANT#host@example.com#old-hosted"), null);
  assert.equal(await db.getHistory("PARTICIPANT#other@example.com#old-hosted"), null, "other participants unlinked too");

  // Attended: our link is gone, the host's record is untouched.
  assert.equal(await db.getHistory("PARTICIPANT#host@example.com#old-attended"), null);
  assert.ok(await db.getHistory("old-attended"), "someone else's record survives");
  assert.equal(s3Deletes.includes("archives/someone@example.com/old-attended.json"), false);

  // Recent record untouched.
  assert.ok(await db.getHistory("recent"));

  const after = await call("GET", "/records", { cookies: sessionCookies });
  assert.deepEqual(after.json.records.map((r) => r.archiveId), ["recent"]);
});

await test("POST /records/purge: validation and auth", async () => {
  const anon = await call("POST", "/records/purge", { body: { value: 1, unit: "days" } });
  assert.equal(anon.statusCode, 401);
  for (const body of [{ value: 0, unit: "days" }, { value: 100, unit: "days" }, { value: 1, unit: "fortnights" }, { value: 1.5, unit: "days" }, {}]) {
    const bad = await call("POST", "/records/purge", { body, cookies: sessionCookies });
    assert.equal(bad.statusCode, 400, `rejects ${JSON.stringify(body)}`);
  }
});

await test("POST /records/purge: never touches a kelabo that has not ended", async () => {
  const now = Date.now();
  db.__putHistory({
    archiveId: "live", kelaboId: "live", title: "Live", host: "host@example.com",
    startedAt: now - 400 * 86400000, endedAt: undefined, participantIdentities: ["host@example.com"],
  });
  db.__putHistory({
    archiveId: "PARTICIPANT#host@example.com#live", participantIdentity: "host@example.com",
    kelaboId: "live", title: "Live", host: "host@example.com", startedAt: now - 400 * 86400000,
  });
  db.__putKelaboItem("live", "META", { kelaboId: "live" });

  const res = await call("POST", "/records/purge", { body: { value: 1, unit: "days" }, cookies: sessionCookies });
  assert.deepEqual(res.json.skipped.map((r) => r.archiveId), ["live"]);
  assert.equal(res.json.purged.some((r) => r.archiveId === "live"), false);
  assert.equal(db.__kelaboItemCount("live"), 1, "an unfinished kelabo is never purged");
  assert.ok(await db.getHistory("live"), "its history row survives too");
});

await test("DELETE /records/:id: host purges, participant only unlinks", async () => {
  const DAY = 86400000;
  const now = Date.now();

  // Hosted by us.
  db.__putHistory({
    archiveId: "del-hosted", kelaboId: "del-hosted", title: "Del hosted", host: "host@example.com",
    startedAt: now - 3 * DAY, endedAt: now - 3 * DAY, s3Key: "archives/host@example.com/del-hosted.json",
    participantIdentities: ["host@example.com", "other@example.com"],
  });
  db.__putHistory({
    archiveId: "PARTICIPANT#host@example.com#del-hosted", participantIdentity: "host@example.com",
    kelaboId: "del-hosted", title: "Del hosted", host: "host@example.com", endedAt: now - 3 * DAY,
  });
  db.__putKelaboItem("del-hosted", "META", { kelaboId: "del-hosted" });
  db.__putKelaboItem("del-hosted", "UTT#001", { text: "hello" });

  // Attended only — deleting must not destroy the host's copy.
  db.__putHistory({
    archiveId: "del-attended", kelaboId: "del-attended", title: "Del attended", host: "someone@example.com",
    startedAt: now - 3 * DAY, endedAt: now - 3 * DAY, s3Key: "archives/someone@example.com/del-attended.json",
    participantIdentities: ["someone@example.com", "host@example.com"],
  });
  db.__putHistory({
    archiveId: "PARTICIPANT#host@example.com#del-attended", participantIdentity: "host@example.com",
    kelaboId: "del-attended", title: "Del attended", host: "someone@example.com", endedAt: now - 3 * DAY,
  });

  s3Deletes.length = 0;

  const hosted = await call("DELETE", "/records/del-hosted", { cookies: sessionCookies });
  assert.equal(hosted.statusCode, 200);
  assert.equal(hosted.json.outcome, "purged");
  assert.deepEqual(s3Deletes, ["archives/host@example.com/del-hosted.json"]);
  assert.equal(db.__kelaboItemCount("del-hosted"), 0);
  assert.equal(await db.getHistory("del-hosted"), null);
  assert.equal(await db.getHistory("PARTICIPANT#other@example.com#del-hosted"), null, "co-participants unlinked");

  s3Deletes.length = 0;
  const attended = await call("DELETE", "/records/del-attended", { cookies: sessionCookies });
  assert.equal(attended.statusCode, 200);
  assert.equal(attended.json.outcome, "removed_from_list");
  assert.equal(await db.getHistory("PARTICIPANT#host@example.com#del-attended"), null, "our link is gone");
  assert.ok(await db.getHistory("del-attended"), "the host's record survives");
  assert.deepEqual(s3Deletes, [], "a guest never destroys the archive object");
});

await test("DELETE /records/:id: rejects anonymous, strangers and live kelabos", async () => {
  const now = Date.now();
  db.__putHistory({
    archiveId: "del-live", kelaboId: "del-live", title: "Del live", host: "host@example.com",
    startedAt: now - 3600000, endedAt: undefined, participantIdentities: ["host@example.com"],
  });
  db.__putKelaboItem("del-live", "META", { kelaboId: "del-live" });
  // Someone else's record, with us not on the participant list.
  db.__putHistory({
    archiveId: "del-theirs", kelaboId: "del-theirs", title: "Theirs", host: "someone@example.com",
    startedAt: now - 86400000, endedAt: now - 86400000, participantIdentities: ["someone@example.com"],
  });

  const anon = await call("DELETE", "/records/del-live");
  assert.equal(anon.statusCode, 401);

  const stranger = await call("DELETE", "/records/del-theirs", { cookies: sessionCookies });
  assert.equal(stranger.statusCode, 403, "not a participant -> forbidden");
  assert.ok(await db.getHistory("del-theirs"), "and it is still there");

  const live = await call("DELETE", "/records/del-live", { cookies: sessionCookies });
  assert.equal(live.statusCode, 409, "an unfinished kelabo cannot be deleted as a record");
  assert.equal(db.__kelaboItemCount("del-live"), 1);

  const missing = await call("DELETE", "/records/does-not-exist", { cookies: sessionCookies });
  assert.equal(missing.statusCode, 404);
});

await test("POST /kelabos persists mcpEnabled opt-out", async () => {
  const res = await call("POST", "/kelabos", { body: { title: "No-MCP sync", mcpEnabled: false }, cookies: sessionCookies });
  assert.equal(res.statusCode, 200);
  const meta = await db.getKelaboMeta(res.json.kelaboId);
  assert.equal(meta.mcpEnabled, false);
  await db.updateKelaboMeta(res.json.kelaboId, { status: "ended", tenantStatus: null });
  await db.deleteHostGuard("host@example.com");
});

// --- scheduling -------------------------------------------------------------

await test("scheduling requires a session — a guest cannot mail the tenant", async () => {
  const res = await call("POST", "/kelabos/schedule", {
    body: { title: "Sprint review", scheduledAt: Date.now() + 86400000 },
  });
  assert.equal(res.statusCode, 401);
  assert.equal(res.json.error, "unauthenticated");
});

let scheduledId;
await test("POST /kelabos/schedule creates a scheduled kelabo, invites and a shareable link", async () => {
  const at = Date.now() + 86400000;
  const res = await call("POST", "/kelabos/schedule", {
    body: {
      title: "Sprint review",
      scheduledAt: at,
      durationMinutes: 45,
      invitees: ["Matt@example.com", "matt@example.com", "bounce@example.com"],
      note: "Bring the pen-test numbers",
    },
    cookies: sessionCookies,
  });
  assert.equal(res.statusCode, 200);
  scheduledId = res.json.kelaboId;
  assert.match(res.json.inviteUrl, /\/invite\//);
  assert.match(res.json.joinUrl, /\/join\//);

  const meta = await db.getKelaboMeta(scheduledId);
  assert.equal(meta.status, "scheduled");
  assert.equal(meta.scheduledAt, at);

  // `status-index` sorts on `startedAt` as a Number and DynamoDB will not index
  // an item whose key attribute is null or absent — a scheduled kelabo written
  // that way is readable by id and invisible in every list.
  assert.equal(typeof meta.startedAt, "number", "scheduled kelabos must stay in status-index");

  const invites = await db.listInvites(scheduledId);
  const keys = invites.map((i) => i.inviteKey).sort();
  // Case-folded and de-duplicated: "Matt@" and "matt@" are one person.
  assert.deepEqual(keys, ["bounce@example.com", "host@example.com", "matt@example.com"]);
  assert.equal(invites.find((i) => i.inviteKey === "host@example.com").response, "accepted");
  assert.equal(invites.find((i) => i.inviteKey === "matt@example.com").response, "pending");

  // A rejected address is reported, not fatal — the kelabo still exists.
  assert.deepEqual(res.json.failed, ["bounce@example.com"]);
  assert.ok(sentInvites.some((m) => m.to === "matt@example.com" && m.inviteUrl === res.json.inviteUrl));
});

await test("suggestions are the registered users at your own domain", async () => {
  // Someone at another domain, and a colleague at this one.
  await db.upsertUser({ email: "maria@example.com", displayName: "Maria Diaz", tenantId: "example.com" });
  await db.upsertUser({ email: "mallory@other.com", displayName: "Mallory", tenantId: "other.com" });

  const res = await call("GET", "/people/search?q=ma", { cookies: sessionCookies });
  assert.equal(res.statusCode, 200);
  // Each suggestion now carries favourite state so a result can be pinned in
  // place (docs 18 §4.1a); nobody is favourited yet here.
  assert.deepEqual(res.json.suggestions, [{ email: "maria@example.com", displayName: "Maria Diaz", favourited: false, avatarVariant: 0 }]);

  // Prefix search, not substring: "aria" is not how anyone types an address.
  const none = await call("GET", "/people/search?q=zz", { cookies: sessionCookies });
  assert.deepEqual(none.json.suggestions, []);
});

await test("suggestions never leak across email domains, and never suggest you", async () => {
  const all = await call("GET", "/people/search", { cookies: sessionCookies });
  const emails = all.json.suggestions.map((s) => s.email);
  assert.ok(!emails.some((e) => e.endsWith("@other.com")), "another domain is invisible");
  assert.ok(!emails.includes("host@example.com"), "you are already in your own kelabo");
  const anon = await call("GET", "/people/search?q=ma");
  assert.equal(anon.statusCode, 401, "and it needs a session at all");
});

// --- contacts: favourites (docs 18 §4) -------------------------------------

await test("favourite a colleague → appears in /contacts, marked on search, removable", async () => {
  // Empty to start; external contacts are off in self-host mode.
  const empty = await call("GET", "/contacts", { cookies: sessionCookies });
  assert.equal(empty.statusCode, 200);
  assert.deepEqual(empty.json.favourites, []);
  assert.equal(empty.json.externalEnabled, false);

  // Favourite Maria (a colleague seeded above).
  const fav = await call("POST", "/contacts/favourites", { body: { email: "maria@example.com" }, cookies: sessionCookies });
  assert.equal(fav.statusCode, 200);
  assert.equal(fav.json.favourited, true);

  // She is now in the list, resolved to her display name.
  const list = await call("GET", "/contacts", { cookies: sessionCookies });
  assert.deepEqual(list.json.favourites, [{ email: "maria@example.com", displayName: "Maria Diaz", avatarVariant: 0 }]);

  // And search reflects the favourite state so it can be toggled from a result.
  const search = await call("GET", "/people/search?q=maria", { cookies: sessionCookies });
  assert.equal(search.json.suggestions.find((s) => s.email === "maria@example.com").favourited, true);

  // Favouriting again is idempotent, not an error.
  const again = await call("POST", "/contacts/favourites", { body: { email: "maria@example.com" }, cookies: sessionCookies });
  assert.equal(again.statusCode, 200);

  // Unfavourite: silent 204, gone from the list, and idempotent.
  const del = await call("DELETE", "/contacts/favourites/maria%40example.com", { cookies: sessionCookies });
  assert.equal(del.statusCode, 204);
  const after = await call("GET", "/contacts", { cookies: sessionCookies });
  assert.deepEqual(after.json.favourites, []);
  const delAgain = await call("DELETE", "/contacts/favourites/maria%40example.com", { cookies: sessionCookies });
  assert.equal(delAgain.statusCode, 204);
});

await test("you cannot favourite someone outside your org, or yourself", async () => {
  const outside = await call("POST", "/contacts/favourites", { body: { email: "mallory@other.com" }, cookies: sessionCookies });
  assert.equal(outside.statusCode, 409);
  assert.equal(outside.json.error, "not_a_colleague");

  const self = await call("POST", "/contacts/favourites", { body: { email: "host@example.com" }, cookies: sessionCookies });
  assert.equal(self.statusCode, 400);
});

await test("contacts routes need a session", async () => {
  assert.equal((await call("GET", "/contacts")).statusCode, 401);
  assert.equal((await call("POST", "/contacts/favourites", { body: { email: "maria@example.com" } })).statusCode, 401);
});

// --- huddle / ring (docs 18 §6) --------------------------------------------

await test("POST /huddles starts a kelabo and rings online colleagues; offline reported", async () => {
  await db.deleteHostGuard("host@example.com"); // start clean
  onlineSet.clear();
  onlineSet.add("maria@example.com"); // online colleague
  // mallory is offline (and at another domain — see next test)
  const res = await call("POST", "/huddles", { body: { invitees: ["maria@example.com"], title: "Sync" }, cookies: sessionCookies });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json.status, "active");
  assert.match(res.json.joinUrl, /\/join\//);
  assert.deepEqual(res.json.rung, ["maria@example.com"]);
  assert.deepEqual(res.json.offline, []);
  // The kelabo is real and active, with an INVITE row for the target.
  const meta = await db.getKelaboMeta(res.json.kelaboId);
  assert.equal(meta.status, "active");
  assert.ok(await db.getInvite(res.json.kelaboId, "maria@example.com"));
  assert.ok(internalCalls.some((c) => c.op === "ring" && c.kelaboId === res.json.kelaboId));
  await db.updateKelaboMeta(res.json.kelaboId, { status: "ended", tenantStatus: null });
  await db.deleteHostGuard("host@example.com");
});

await test("you cannot huddle someone who is neither a colleague nor an accepted contact", async () => {
  const res = await call("POST", "/huddles", { body: { invitees: ["mallory@other.com"] }, cookies: sessionCookies });
  assert.equal(res.statusCode, 403);
  assert.equal(res.json.error, "no_contact");
});

await test("ring into a live kelabo requires being in it; answer requires an invite", async () => {
  await db.deleteHostGuard("host@example.com");
  onlineSet.clear();
  onlineSet.add("maria@example.com");
  const created = await call("POST", "/kelabos", { body: { title: "Live" }, cookies: sessionCookies });
  const kelaboId = created.json.kelaboId;

  const ring = await call("POST", `/kelabos/${kelaboId}/ring`, { body: { invitees: ["maria@example.com"] }, cookies: sessionCookies });
  assert.equal(ring.statusCode, 200);
  assert.deepEqual(ring.json.rung, ["maria@example.com"]);

  // Maria answering needs her invite row (the ring created it) — she has one.
  // Someone with no invite cannot answer.
  const answer = await call("POST", `/kelabos/${kelaboId}/ring/answer`, { body: { response: "accepted" }, cookies: sessionCookies });
  // The host has no INVITE row (they are the ringer), so answering is refused.
  assert.equal(answer.statusCode, 403);
  assert.equal(answer.json.error, "not_invited");

  // Cancel by the host works.
  const cancel = await call("POST", `/kelabos/${kelaboId}/ring/cancel`, { cookies: sessionCookies });
  assert.equal(cancel.statusCode, 200);
  assert.ok(internalCalls.some((c) => c.op === "ringCancel" && c.kelaboId === kelaboId));

  await db.updateKelaboMeta(kelaboId, { status: "ended", tenantStatus: null });
  await db.deleteHostGuard("host@example.com");
});

await test("huddle needs a session", async () => {
  assert.equal((await call("POST", "/huddles", { body: { invitees: ["maria@example.com"] } })).statusCode, 401);
});

await test("a private huddle is unlisted for colleagues but visible to its host", async () => {
  await db.deleteHostGuard("host@example.com");
  onlineSet.clear();
  onlineSet.add("maria@example.com");
  const res = await call("POST", "/huddles", {
    body: { invitees: ["maria@example.com"], private: true },
    cookies: sessionCookies,
  });
  assert.equal(res.statusCode, 200);
  const kelaboId = res.json.kelaboId;
  assert.equal((await db.getKelaboMeta(kelaboId)).unlisted, true);

  // The host still sees their own call in both lists…
  const hostList = await call("GET", "/kelabos", { cookies: sessionCookies });
  assert.equal(hostList.statusCode, 200);
  assert.ok(hostList.json.active.some((m) => m.kelaboId === kelaboId));
  assert.ok(hostList.json.mine.some((m) => m.kelaboId === kelaboId));

  // …a colleague who is not in it sees nothing. The join link is the only way in.
  await call("POST", "/auth/otp/request", { body: { email: "maria@example.com" } });
  const ver = await call("POST", "/auth/otp/verify", {
    body: { email: "maria@example.com", code: sentEmails.at(-1).code },
  });
  const mariaCookies = {
    kelabo_session: cookieValue(ver, "kelabo_session"),
    kelabo_refresh: cookieValue(ver, "kelabo_refresh"),
  };
  const mariaList = await call("GET", "/kelabos", { cookies: mariaCookies });
  assert.equal(mariaList.statusCode, 200);
  assert.ok(!mariaList.json.active.some((m) => m.kelaboId === kelaboId));

  // An ordinary huddle stays listed — private is opt-in.
  await db.updateKelaboMeta(kelaboId, { status: "ended", tenantStatus: null });
  await db.deleteHostGuard("host@example.com");
  const open = await call("POST", "/huddles", { body: { invitees: ["maria@example.com"] }, cookies: sessionCookies });
  assert.equal(open.statusCode, 200);
  const openList = await call("GET", "/kelabos", { cookies: mariaCookies });
  assert.ok(openList.json.active.some((m) => m.kelaboId === open.json.kelaboId));

  await db.updateKelaboMeta(open.json.kelaboId, { status: "ended", tenantStatus: null });
  await db.deleteHostGuard("host@example.com");
});

await test("an invitation is readable without an account, and asks a guest for a name", async () => {
  const res = await call("GET", `/kelabos/${scheduledId}/invitation`);
  assert.equal(res.statusCode, 200);
  assert.equal(res.json.title, "Sprint review");
  assert.equal(res.json.needsName, true);
  assert.equal(res.json.myResponse, null);
  // An invitee is told how many are coming, never who — that is not their business.
  assert.equal(typeof res.json.going, "number");
  assert.equal(res.json.invites, undefined);
});

await test("a signed-in invitee never types their name", async () => {
  const res = await call("GET", `/kelabos/${scheduledId}/invitation`, { cookies: sessionCookies });
  assert.equal(res.json.needsName, false);
  assert.equal(res.json.myResponse, "accepted", "the host is attending their own kelabo");
});

await test("a guest RSVP needs a name, then is remembered by cookie", async () => {
  const noName = await call("POST", `/kelabos/${scheduledId}/rsvp`, { body: { response: "accepted" } });
  assert.equal(noName.statusCode, 400);
  assert.equal(noName.json.error, "name_required");

  const first = await call("POST", `/kelabos/${scheduledId}/rsvp`, {
    body: { response: "accepted", displayName: "Sam" },
  });
  assert.equal(first.statusCode, 200);
  assert.equal(first.json.isGuest, true);
  const rsvpCookie = cookieValue(first, "kelabo_rsvp");
  assert.ok(rsvpCookie, "a guest gets a cookie so they can change their mind");

  // Changing the answer updates the same row rather than inventing a second
  // guest, and does not demand the name again.
  const second = await call("POST", `/kelabos/${scheduledId}/rsvp`, {
    body: { response: "declined" },
    cookies: { kelabo_rsvp: rsvpCookie },
  });
  assert.equal(second.statusCode, 200);
  assert.equal(second.json.displayName, "Sam");

  const invites = await db.listInvites(scheduledId);
  const guests = invites.filter((i) => i.isGuest);
  assert.equal(guests.length, 1, "one guest, not two");
  assert.equal(guests[0].response, "declined");
});

await test("a signed-in invitee RSVPs under their address, no name needed", async () => {
  const res = await call("POST", `/kelabos/${scheduledId}/rsvp`, {
    body: { response: "declined" },
    cookies: sessionCookies,
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json.isGuest, false);
  const invite = await db.getInvite(scheduledId, "host@example.com");
  assert.equal(invite.response, "declined");
  // Declining is a signal, not a lock: the invitation is still readable.
  const still = await call("GET", `/kelabos/${scheduledId}/invitation`, { cookies: sessionCookies });
  assert.equal(still.statusCode, 200);
  assert.equal(still.json.myResponse, "declined");
});

await test("the host sees who replied; an outsider sees nothing", async () => {
  const res = await call("GET", `/kelabos/${scheduledId}/scheduled`, { cookies: sessionCookies });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json.isHost, true);
  assert.ok(res.json.invites.length >= 3);
  assert.ok(res.json.invites.some((i) => i.isGuest && i.displayName === "Sam"));
  const anon = await call("GET", `/kelabos/${scheduledId}/scheduled`);
  assert.equal(anon.statusCode, 401);
});

await test("scheduled kelabos are listed for the rail, soonest first", async () => {
  const later = await call("POST", "/kelabos/schedule", {
    body: { title: "Later thing", scheduledAt: Date.now() + 3 * 86400000 },
    cookies: sessionCookies,
  });
  assert.equal(later.statusCode, 200);
  const res = await call("GET", "/kelabos/scheduled", { cookies: sessionCookies });
  assert.equal(res.statusCode, 200);
  const titles = res.json.scheduled.map((m) => m.title);
  assert.deepEqual(titles, ["Sprint review", "Later thing"]);
  assert.equal(res.json.scheduled[0].isHost, true);
  assert.ok(res.json.scheduled[0].rsvp.accepted >= 0);
});

await test("only the host can start a scheduled kelabo, and starting is idempotent", async () => {
  const anon = await call("POST", `/kelabos/${scheduledId}/start-scheduled`);
  assert.equal(anon.statusCode, 401);

  const res = await call("POST", `/kelabos/${scheduledId}/start-scheduled`, { cookies: sessionCookies });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json.status, "active");
  const meta = await db.getKelaboMeta(scheduledId);
  assert.equal(meta.status, "active");
  assert.ok(meta.startedAt > 0);
  // The link shared a week ago is the link that now works.
  assert.equal(res.json.joinUrl, `https://test.example.com/join/${scheduledId}`);

  const again = await call("POST", `/kelabos/${scheduledId}/start-scheduled`, { cookies: sessionCookies });
  assert.equal(again.statusCode, 200, "a second click lands you in the kelabo, not on an error");
  assert.equal(again.json.status, "active");
});

await test("a host already running a kelabo can start a second one", async () => {
  // The one-live-per-host guard is gone: starting a scheduled kelabo while
  // another is live is an ordinary start, not a clash.
  const other = await call("POST", "/kelabos/schedule", {
    body: { title: "Concurrent", scheduledAt: Date.now() + 600000 },
    cookies: sessionCookies,
  });
  const res = await call("POST", `/kelabos/${other.json.kelaboId}/start-scheduled`, { cookies: sessionCookies });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json.status, "active");

  await db.updateKelaboMeta(other.json.kelaboId, { status: "ended", tenantStatus: null });
  await db.updateKelaboMeta(scheduledId, { status: "ended", tenantStatus: null });
});

// --- cancel / reschedule (docs 18 §2, §3) ----------------------------------

async function scheduleFresh(overrides = {}) {
  const res = await call("POST", "/kelabos/schedule", {
    body: { title: "Standup", scheduledAt: Date.now() + 86400000, invitees: ["matt@example.com"], ...overrides },
    cookies: sessionCookies,
  });
  return res.json.kelaboId;
}

await test("POST /kelabos/:id/cancel — host only, scheduled only, sets TTL, emails invitees", async () => {
  const id = await scheduleFresh();
  const before = sentCancellations.length;

  const anon = await call("POST", `/kelabos/${id}/cancel`);
  assert.equal(anon.statusCode, 401);

  const res = await call("POST", `/kelabos/${id}/cancel`, { body: { reason: "clashes" }, cookies: sessionCookies });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json.status, "cancelled");

  const meta = await db.getKelaboMeta(id);
  assert.equal(meta.status, "cancelled");
  assert.equal(meta.tenantStatus, "example.com#cancelled");
  assert.equal(typeof meta.ttl, "number", "a cancelled kelabo must self-expire");
  assert.equal(meta.cancelReason, "clashes");

  // The prep-bound agent is told, and the invitee (not the host) is emailed.
  assert.ok(internalCalls.some((c) => c.op === "cancel" && c.kelaboId === id));
  assert.equal(sentCancellations.length, before + 1);
  assert.equal(sentCancellations.at(-1).to, "matt@example.com");

  // It does not appear in the scheduled list any more (index moved to #cancelled).
  const list = await call("GET", "/kelabos/scheduled", { cookies: sessionCookies });
  assert.equal(list.json.scheduled.some((m) => m.kelaboId === id), false);
});

await test("cancel is refused on a live or already-cancelled kelabo", async () => {
  const id = await scheduleFresh();
  await call("POST", `/kelabos/${id}/cancel`, { cookies: sessionCookies });
  const again = await call("POST", `/kelabos/${id}/cancel`, { cookies: sessionCookies });
  assert.equal(again.statusCode, 409);
  assert.equal(again.json.error, "kelabo_cancelled");

  // A started kelabo cannot be cancelled — it is ended, not cancelled.
  const live = await scheduleFresh();
  await call("POST", `/kelabos/${live}/start-scheduled`, { cookies: sessionCookies });
  const res = await call("POST", `/kelabos/${live}/cancel`, { cookies: sessionCookies });
  assert.equal(res.statusCode, 409);
  assert.equal(res.json.error, "already_active");
  await db.updateKelaboMeta(live, { status: "ended", tenantStatus: null });
  await db.deleteHostGuard("host@example.com");
});

await test("an RSVP to a cancelled kelabo is refused (was silently accepted)", async () => {
  const id = await scheduleFresh();
  await call("POST", `/kelabos/${id}/cancel`, { cookies: sessionCookies });
  const rsvp = await call("POST", `/kelabos/${id}/rsvp`, { body: { response: "accepted" }, cookies: sessionCookies });
  assert.equal(rsvp.statusCode, 409);
  assert.equal(rsvp.json.error, "kelabo_cancelled");
});

await test("POST /kelabos/:id/reschedule — time change resets RSVPs and emails; title-only does not", async () => {
  const id = await scheduleFresh();
  // Set Matt's response directly (guest RSVP cookie plumbing is covered
  // elsewhere); this is the row the schedule already created.
  await db.putInvite(id, { inviteKey: "matt@example.com", email: "matt@example.com", isGuest: false, response: "accepted", invitedAt: Date.now(), respondedAt: Date.now() });

  const rBefore = sentReschedules.length;
  // Title-only: no reset, no email.
  const titleOnly = await call("POST", `/kelabos/${id}/reschedule`, { body: { title: "Standup (renamed)" }, cookies: sessionCookies });
  assert.equal(titleOnly.statusCode, 200);
  assert.equal(titleOnly.json.rsvpsReset, false);
  assert.equal(sentReschedules.length, rBefore);
  assert.equal((await db.getInvite(id, "matt@example.com")).response, "accepted");

  // Time change: reset + email.
  const newAt = Date.now() + 2 * 86400000;
  const moved = await call("POST", `/kelabos/${id}/reschedule`, { body: { scheduledAt: newAt }, cookies: sessionCookies });
  assert.equal(moved.statusCode, 200);
  assert.equal(moved.json.rsvpsReset, true);
  assert.equal(moved.json.scheduledAt, newAt);

  const meta = await db.getKelaboMeta(id);
  assert.equal(meta.scheduledAt, newAt);
  assert.equal(typeof meta.previousScheduledAt, "number", "the old time is recorded");
  assert.equal((await db.getInvite(id, "matt@example.com")).response, "pending", "a moved time invalidates the RSVP");
  // The host stays accepted.
  assert.equal((await db.getInvite(id, "host@example.com")).response, "accepted");
  assert.equal(sentReschedules.length, rBefore + 1);
  assert.ok(internalCalls.some((c) => c.op === "reschedule" && c.kelaboId === id));

  await db.updateKelaboMeta(id, { status: "ended", tenantStatus: null });
});

await test("reschedule with an empty body is nothing_to_change", async () => {
  const id = await scheduleFresh();
  const res = await call("POST", `/kelabos/${id}/reschedule`, { body: {}, cookies: sessionCookies });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json.error, "nothing_to_change");
  await db.updateKelaboMeta(id, { status: "ended", tenantStatus: null });
});

// --- add/remove invitees (docs 18 §3.5) ------------------------------------

await test("POST /kelabos/:id/invitees — adds new addresses, emails only them", async () => {
  const id = await scheduleFresh(); // matt@example.com already invited
  const before = sentInvites.length;

  const anon = await call("POST", `/kelabos/${id}/invitees`, { body: { invitees: ["matt@example.com"] } });
  assert.equal(anon.statusCode, 401);

  const res = await call("POST", `/kelabos/${id}/invitees`, {
    body: { invitees: ["matt@example.com", "priya@example.com"] },
    cookies: sessionCookies,
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json.removed, []);
  assert.equal(res.json.added.length, 1);
  assert.equal(res.json.added[0].email, "priya@example.com");
  assert.equal(res.json.added[0].sent, true);
  assert.equal(res.json.failed.length, 0);

  // Matt was already invited — no second email to him, only Priya's.
  assert.equal(sentInvites.length, before + 1);
  assert.equal(sentInvites.at(-1).to, "priya@example.com");
  assert.equal((await db.getInvite(id, "priya@example.com")).response, "pending");
});

await test("POST /kelabos/:id/invitees — removes an address, emails the removed person, not the kelabo", async () => {
  const id = await scheduleFresh(); // matt@example.com invited
  const before = sentUninvites.length;

  const res = await call("POST", `/kelabos/${id}/invitees`, { body: { invitees: [] }, cookies: sessionCookies });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json.added, []);
  assert.equal(res.json.removed.length, 1);
  assert.equal(res.json.removed[0].email, "matt@example.com");

  assert.equal(sentUninvites.length, before + 1);
  assert.equal(sentUninvites.at(-1).to, "matt@example.com");
  assert.equal(await db.getInvite(id, "matt@example.com"), null, "the invite row is gone, not just marked");

  // The kelabo itself is untouched.
  const meta = await db.getKelaboMeta(id);
  assert.equal(meta.status, "scheduled");
  // The host's own auto-RSVP survives a removal request that never named it.
  assert.equal((await db.getInvite(id, "host@example.com")).response, "accepted");
});

await test("POST /kelabos/:id/invitees — add and remove in the same call", async () => {
  const id = await scheduleFresh(); // matt@example.com invited
  const res = await call("POST", `/kelabos/${id}/invitees`, {
    body: { invitees: ["priya@example.com"] }, // drops matt, adds priya
    cookies: sessionCookies,
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json.added.length, 1);
  assert.equal(res.json.removed.length, 1);
  assert.equal(res.json.added[0].email, "priya@example.com");
  assert.equal(res.json.removed[0].email, "matt@example.com");
});

await test("POST /kelabos/:id/invitees — the same list back is nothing_to_change", async () => {
  const id = await scheduleFresh();
  const res = await call("POST", `/kelabos/${id}/invitees`, {
    body: { invitees: ["matt@example.com"] },
    cookies: sessionCookies,
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json.error, "nothing_to_change");
});

await test("POST /kelabos/:id/invitees — the host's own address is never added or removed through here", async () => {
  const id = await scheduleFresh();
  const res = await call("POST", `/kelabos/${id}/invitees`, {
    // Matt dropped, host's own email listed (as if a client echoed it back) —
    // neither adds nor removes the host, who was never in the diff's domain.
    body: { invitees: ["host@example.com"] },
    cookies: sessionCookies,
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json.removed.length, 1);
  assert.equal(res.json.removed[0].email, "matt@example.com");
  assert.equal((await db.getInvite(id, "host@example.com")).response, "accepted", "host's own row is untouched");
});

await test("POST /kelabos/:id/invitees — a guest's link RSVP is not something this route can remove", async () => {
  const id = await scheduleFresh();
  // A guest answered the link directly — no email the host ever typed.
  await db.putInvite(id, { inviteKey: "g:abc123", displayName: "Guest Gary", isGuest: true, response: "accepted", invitedAt: Date.now() });
  const res = await call("POST", `/kelabos/${id}/invitees`, {
    body: { invitees: ["matt@example.com"] }, // unchanged from what scheduleFresh already set
    cookies: sessionCookies,
  });
  assert.equal(res.statusCode, 400, "matt is unchanged and the guest row is outside this diff, so there is nothing to change");
  assert.equal(res.json.error, "nothing_to_change");
  assert.notEqual(await db.getInvite(id, "g:abc123"), null, "the guest's RSVP survives untouched");
});

await test("POST /kelabos/:id/invitees — not the host is forbidden", async () => {
  const id = await scheduleFresh();

  // A second, genuinely different signed-in identity — not the host, and not
  // an invitee either, which is what makes 403 the right answer rather than
  // some read-only view.
  await call("POST", "/auth/otp/request", { body: { email: "colleague@example.com" } });
  const code = sentEmails.at(-1).code;
  const ver = await call("POST", "/auth/otp/verify", { body: { email: "colleague@example.com", code } });
  const otherCookies = { kelabo_session: cookieValue(ver, "kelabo_session"), kelabo_refresh: cookieValue(ver, "kelabo_refresh") };

  const res = await call("POST", `/kelabos/${id}/invitees`, { body: { invitees: [] }, cookies: otherCookies });
  assert.equal(res.statusCode, 403);
  assert.equal(res.json.error, "not_host");
});

await test("POST /kelabos/:id/invitees — refused once live, refused once cancelled", async () => {
  const live = await scheduleFresh();
  await call("POST", `/kelabos/${live}/start-scheduled`, { cookies: sessionCookies });
  const onLive = await call("POST", `/kelabos/${live}/invitees`, { body: { invitees: [] }, cookies: sessionCookies });
  assert.equal(onLive.statusCode, 409);
  assert.equal(onLive.json.error, "already_active");
  await db.updateKelaboMeta(live, { status: "ended", tenantStatus: null });
  await db.deleteHostGuard("host@example.com");

  const cancelled = await scheduleFresh();
  await call("POST", `/kelabos/${cancelled}/cancel`, { cookies: sessionCookies });
  const onCancelled = await call("POST", `/kelabos/${cancelled}/invitees`, { body: { invitees: [] }, cookies: sessionCookies });
  assert.equal(onCancelled.statusCode, 409);
  assert.equal(onCancelled.json.error, "kelabo_cancelled");
});

// --- cross-tenant invite visibility (docs 18 §2.8) --------------------------
//
// A kelabo's tenantStatus names its HOST's tenant — status-index, which every
// list above reads, can therefore never surface a kelabo to someone invited
// from a different domain: no query on the invitee's own tenant reaches a
// row indexed under someone else's. invitee-index is the other half,
// identity-keyed rather than tenant-keyed, so a colleague-only default
// cannot silently exclude the one person a specific INVITE# row names.

// Via sessions.establishSession directly, not the HTTP OTP flow: this file's
// `config.allowedEmailDomain` is "example.com" (line 23), which the real OTP
// gate would refuse these addresses under — a fixture detail of this test
// file, unrelated to what cross-tenant visibility is about. `sessions` is the
// same module the OTP flow itself calls once a code is verified.
async function sessionFor(email) {
  const session = await sessions.establishSession(email);
  return {
    kelabo_session: cookieValue({ cookies: session.cookies }, "kelabo_session"),
    kelabo_refresh: cookieValue({ cookies: session.cookies }, "kelabo_refresh"),
  };
}

await test("GET /kelabos/scheduled — an invitee at a different domain than the host still sees it", async () => {
  const outsideCookies = await sessionFor("outside@other-domain.example");
  const id = await scheduleFresh({ invitees: ["outside@other-domain.example"] });

  // Accept, exactly the route the emailed link's page uses.
  const rsvp = await call("POST", `/kelabos/${id}/rsvp`, { body: { response: "accepted" }, cookies: outsideCookies });
  assert.equal(rsvp.statusCode, 200);

  const mine = await call("GET", "/kelabos/scheduled", { cookies: outsideCookies });
  assert.equal(mine.statusCode, 200);
  const found = mine.json.scheduled.find((m) => m.kelaboId === id);
  assert.ok(found, "the outside invitee's own list does not contain the kelabo they accepted");
  assert.equal(found.isHost, false);
  assert.equal(found.myResponse, "accepted");

  // The host's own list is unaffected by any of this.
  const hostList = await call("GET", "/kelabos/scheduled", { cookies: sessionCookies });
  assert.ok(hostList.json.scheduled.some((m) => m.kelaboId === id));
});

await test("GET /kelabos/scheduled — someone at another domain who was never invited still sees nothing", async () => {
  const strangerCookies = await sessionFor("stranger@another-domain.example");
  const id = await scheduleFresh();
  const list = await call("GET", "/kelabos/scheduled", { cookies: strangerCookies });
  assert.equal(list.json.scheduled.some((m) => m.kelaboId === id), false);
});

await test("GET /kelabos — a cross-tenant invitee (rung into a live kelabo) sees it before joining", async () => {
  const outsideCookies = await sessionFor("rung@elsewhere.example");
  const res = await call("POST", "/kelabos", { body: { title: "Standup" }, cookies: sessionCookies });
  const id = res.json.kelaboId;
  // The same write huddle.ringInto makes for an outside target — one
  // INVITE# row, before they have joined or become a participant.
  await db.putInvite(id, {
    inviteKey: "rung@elsewhere.example",
    email: "rung@elsewhere.example",
    isGuest: false,
    response: "pending",
    invitedAt: Date.now(),
  });

  const list = await call("GET", "/kelabos", { cookies: outsideCookies });
  assert.equal(list.statusCode, 200);
  assert.ok(list.json.active.some((m) => m.kelaboId === id), "the rung outsider's own list does not contain it");
  assert.equal(list.json.mine.some((m) => m.kelaboId === id), false, "it is not theirs to have started");

  await db.updateKelaboMeta(id, { status: "ended", tenantStatus: null });
  await db.deleteHostGuard("host@example.com");
});

await test("GET /agent/kelabos — the same cross-tenant reach, for the agent bridge", async () => {
  const id = await scheduleFresh({ invitees: ["agentside@far-domain.example"] });
  const { kelabos: joinable } = await agent.joinableKelabos({ identity: "agentside@far-domain.example" });
  assert.ok(joinable.some((k) => k.kelaboId === id), "the agent bridge's own list does not reach a cross-tenant invite");
  await db.updateKelaboMeta(id, { status: "ended", tenantStatus: null });
});

// --- agent bridge pairing (docs 16 §6) -------------------------------------

let agentToken = null;

/** Drive the whole device flow for an arbitrary identity, so tests that only
 *  need "a bridge belonging to X" do not restate it. */
async function mintAgentTokenFor(identity) {
  const start = await call("POST", "/agent/device/code", { body: { runtime: "opencode" } });
  await agent.approve({
    userCode: start.json.userCode,
    identity,
    tenantId: identity.split("@")[1],
  });
  const got = await call("POST", "/agent/device/token", { body: { deviceCode: start.json.deviceCode } });
  return got.json.agentToken;
}

await test("device pairing: a code is minted, approved by a signed-in human, then redeemed once", async () => {
  const start = await call("POST", "/agent/device/code", { body: { runtime: "opencode", label: "laptop" } });
  assert.equal(start.statusCode, 200);
  assert.match(start.json.userCode, /^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  assert.equal(start.json.verificationUri, "https://test.example.com/pair");
  assert.ok(start.json.deviceCode.length > 20);
  // The user code must not be derivable from the device code or vice versa:
  // one is short enough to guess, the other is the actual secret.
  assert.equal(start.json.deviceCode.includes(start.json.userCode.replace("-", "")), false);

  // Polling before approval is a real "not yet", not an error the bridge should
  // give up on.
  const pending = await call("POST", "/agent/device/token", { body: { deviceCode: start.json.deviceCode } });
  assert.equal(pending.statusCode, 428);
  assert.equal(pending.json.error, "authorization_pending");

  // Approving requires a session — the whole point is that a signed-in human
  // authorizes the delegation.
  const anon = await call("POST", "/agent/device/approve", { body: { userCode: start.json.userCode } });
  assert.equal(anon.statusCode, 401);

  // The portal shows what is being authorized before the human confirms.
  const shown = await call("GET", `/agent/device/pending?code=${start.json.userCode}`, { cookies: sessionCookies });
  assert.equal(shown.statusCode, 200);
  assert.equal(shown.json.runtime, "opencode");
  assert.equal(shown.json.label, "laptop");
  assert.equal(shown.json.approved, false);

  // Typed by a human: lowercase, spaced, no dash. All of it is accepted.
  const typed = start.json.userCode.replace("-", " ").toLowerCase();
  const ok = await call("POST", "/agent/device/approve", { body: { userCode: typed }, cookies: sessionCookies });
  assert.equal(ok.statusCode, 200);

  const got = await call("POST", "/agent/device/token", { body: { deviceCode: start.json.deviceCode } });
  assert.equal(got.statusCode, 200);
  assert.equal(got.json.identity, "host@example.com");
  assert.equal(got.json.tenantId, "example.com");
  assert.equal(got.json.gatewayBaseUrl, "https://gw.test.example.com");
  assert.ok(got.json.agentToken);
  agentToken = got.json.agentToken;

  // One code, one token. A leaked device code that was already redeemed is worth
  // nothing.
  const replay = await call("POST", "/agent/device/token", { body: { deviceCode: start.json.deviceCode } });
  assert.equal(replay.statusCode, 404);
});

await test("an approved code cannot be approved twice", async () => {
  const start = await call("POST", "/agent/device/code", { body: { runtime: "claude-code" } });
  await call("POST", "/agent/device/approve", { body: { userCode: start.json.userCode }, cookies: sessionCookies });
  const again = await call("POST", "/agent/device/approve", {
    body: { userCode: start.json.userCode },
    cookies: sessionCookies,
  });
  assert.equal(again.statusCode, 409);
});

await test("the agent token carries the agent audience, not the session's", async () => {
  const [, payloadB64] = agentToken.split(".");
  const payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
  assert.equal(payload.aud, "kelabo-agent");
  assert.equal(payload.role, "dev");
  assert.equal(payload.sub, "host@example.com");
  assert.ok(payload.jti);
  // Three token families share one signing key, so `aud` is the only thing that
  // keeps them apart. A session cookie must not pass as an agent token.
  const asSession = await call("GET", "/agent/kelabos", { bearer: sessionCookies.kelabo_session });
  assert.equal(asSession.statusCode, 401);
});

await test("GET /agent/kelabos lists active and scheduled, host or invitee", async () => {
  const unauth = await call("GET", "/agent/kelabos");
  assert.equal(unauth.statusCode, 401);

  const scheduled = await call("POST", "/kelabos/schedule", {
    body: {
      title: "Retry policy review",
      scheduledAt: Date.now() + 3600_000,
      invitees: ["bob@example.com"],
      note: "bring the gateway numbers",
    },
    cookies: sessionCookies,
  });
  assert.equal(scheduled.statusCode, 200);

  const res = await call("GET", "/agent/kelabos", { bearer: agentToken });
  assert.equal(res.statusCode, 200);
  const found = res.json.kelabos.find((m) => m.kelaboId === scheduled.json.kelaboId);
  assert.ok(found, "the host sees the kelabo they scheduled");
  assert.equal(found.status, "scheduled");
  assert.equal(found.isHost, true);
  // Preparing for a kelabo you were invited to is the ordinary case: an
  // invitee's own agent must see it too.
  const bobToken = await mintAgentTokenFor("bob@example.com");
  const bobRes = await call("GET", "/agent/kelabos", { bearer: bobToken });
  assert.equal(bobRes.statusCode, 200);
  const bobFound = bobRes.json.kelabos.find((m) => m.kelaboId === scheduled.json.kelaboId);
  assert.ok(bobFound, "an invitee sees the kelabo");
  assert.equal(bobFound.isHost, false);
  // A stranger at the same tenant sees neither.
  const eveToken = await mintAgentTokenFor("eve@example.com");
  const eveRes = await call("GET", "/agent/kelabos", { bearer: eveToken });
  assert.equal(eveRes.json.kelabos.some((m) => m.kelaboId === scheduled.json.kelaboId), false);
});

await test("revoking an agent token takes effect immediately", async () => {
  const list = await call("GET", "/agent/tokens", { cookies: sessionCookies });
  assert.equal(list.statusCode, 200);
  const mine = list.json.agents.find((a) => a.runtime === "opencode");
  assert.ok(mine);
  assert.equal(mine.label, "laptop");

  const gone = await call("DELETE", `/agent/tokens/${mine.jti}`, { cookies: sessionCookies });
  assert.equal(gone.statusCode, 200);

  // The JWT is still perfectly valid and unexpired; the revocation row is what
  // stops it, which is why it is checked on every verify.
  const after = await call("GET", "/agent/kelabos", { bearer: agentToken });
  assert.equal(after.statusCode, 401);

  const relist = await call("GET", "/agent/tokens", { cookies: sessionCookies });
  assert.equal(relist.json.agents.some((a) => a.jti === mine.jti), false);
});

await test("one developer cannot revoke another's agent token", async () => {
  await mintAgentTokenFor("bob@example.com");
  const bobRows = await db.listAgentTokensByIdentity(
    (await import("../src/jwt.js")).sha256("bob@example.com")
  );
  const res = await call("DELETE", `/agent/tokens/${bobRows[0].jti}`, { cookies: sessionCookies });
  // 404, not 403: whether someone else's jti exists is not this caller's business.
  assert.equal(res.statusCode, 404);
});

await test("unknown route -> 404 json", async () => {
  const res = await call("GET", "/nope");
  assert.equal(res.statusCode, 404);
  assert.equal(res.json.error, "not_found");
});

// ---------------------------------------------------------------------------
// The origin gate. API Gateway answers on its own execute-api URL as well as
// through CloudFront, and that URL passes neither the distribution nor the WAF
// — so `allowIps` protects the portal and the Gateway while leaving the whole
// control plane open. The gate is the only thing that closes it, which is why
// its failure modes are pinned here rather than discovered in production.
const ORIGIN_VALUE = "s3cret-origin-value";

function gatedApp({ secretValue = ORIGIN_VALUE, throws = false } = {}) {
  return createApp({
    config: { ...config, api: { requireOriginSecret: true }, secrets: { ...config.secrets, apiOrigin: "api-origin" } },
    db,
    secrets: {
      ...secrets,
      getApiOriginSecret: async () => {
        if (throws) throw new Error("AccessDeniedException");
        return secretValue;
      },
    },
    mailer, sessions, auth, kelabos, join, joinCodes, records, sttToken,
    internal, mcpOauth, scheduling, contacts, huddle, agent, version: "test",
  });
}

async function callApp(target, { header } = {}) {
  const res = await target({
    requestContext: { http: { method: "GET", sourceIp: "9.9.9.9" } },
    rawPath: "/health",
    rawQueryString: "",
    headers: { "content-type": "application/json", ...(header !== undefined ? { [ORIGIN_SECRET_HEADER]: header } : {}) },
  });
  return { ...res, json: res.body ? JSON.parse(res.body) : null };
}

await test("origin gate off (the default) — no header needed", async () => {
  // `app` is built from a config with no `api` block at all, which is what an
  // existing deployment looks like the moment this code ships.
  const res = await call("GET", "/health");
  assert.equal(res.statusCode, 200);
});

await test("origin gate on — a request with no header is refused", async () => {
  const res = await callApp(gatedApp());
  assert.equal(res.statusCode, 403);
  assert.equal(res.json.error, "forbidden");
  // The reply names neither the header nor the reason.
  assert.equal(Object.keys(res.json).length, 1);
});

await test("origin gate on — a wrong header is refused", async () => {
  assert.equal((await callApp(gatedApp(), { header: "not-it" })).statusCode, 403);
  assert.equal((await callApp(gatedApp(), { header: "" })).statusCode, 403);
  // Same length as the real value, so this fails on content rather than size.
  assert.equal((await callApp(gatedApp(), { header: "x".repeat(ORIGIN_VALUE.length) })).statusCode, 403);
});

await test("origin gate on — the right header passes through to routing", async () => {
  const res = await callApp(gatedApp(), { header: ORIGIN_VALUE });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json.ok, true);
});

await test("origin gate fails CLOSED when the secret cannot be read", async () => {
  // A gate that opens when it cannot read its own secret is not a gate. This
  // takes the API down, which is the correct direction to fail.
  const res = await callApp(gatedApp({ throws: true }), { header: ORIGIN_VALUE });
  assert.equal(res.statusCode, 403);
});

await test("originSecretMatches: only an exact match, and never on absence", async () => {
  assert.equal(originSecretMatches("abc", "abc"), true);
  assert.equal(originSecretMatches("abc", "abd"), false);
  assert.equal(originSecretMatches("ab", "abc"), false, "shorter must not pass");
  assert.equal(originSecretMatches("abcd", "abc"), false, "longer must not pass");
  // An unset expectation must never be satisfiable — this is the case that
  // would silently disable the gate.
  assert.equal(originSecretMatches("", ""), false);
  assert.equal(originSecretMatches("abc", ""), false);
  assert.equal(originSecretMatches("abc", null), false);
  assert.equal(originSecretMatches("abc", undefined), false);
  assert.equal(originSecretMatches(undefined, "abc"), false);
  assert.equal(originSecretMatches(null, "abc"), false);
  assert.equal(originSecretMatches(["abc"], "abc"), false, "a non-string must not pass");
});

// A purpose-built kelabo store: these tests are about the provider boundary,
// not about persistence, and every one of them needs exactly one live kelabo.
const sttDb = {
  getKelaboMeta: async (id) =>
    id.startsWith("stt-")
      ? { kelaboId: id, status: "active", hostIdentity: "host@example.com", participants: [] }
      : null,
};

// --- the STT provider boundary ----------------------------------------------
//
// The mint is the ONE thing standing between a kelabo's audio and somebody
// else's bill: the browser streams straight to the provider, so a credential
// handed out here is used without Kelabo seeing another byte of it. Until now
// `fetchImpl` was stubbed to fail on every call, so the happy path — the
// `params` a browser is told to forward verbatim to a third party — had no
// coverage at all.

await test("stt: a session carries the provider, the socket url and server-chosen params", async () => {
  const calls = [];
  const mint = createSttToken({
    config,
    db: sttDb,
    secrets,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return { ok: true, status: 200, json: async () => ({ access_token: "tok-123", expires_in: 60 }) };
    },
  });

  const session = await mint.mint({
    kelaboId: "stt-1",
    participant: { identity: "host@example.com" },
    opts: { language: "ja", diarize: true },
  });

  assert.equal(session.provider, "deepgram", "the client resolves its adapter with this");
  assert.ok(session.url.startsWith("wss://"), "a browser has to be able to open it");
  assert.equal(session.token, "tok-123");
  assert.equal(session.expiresInSeconds, 60);

  // Server-chosen, and the reason the client is not trusted to build them: a
  // browser that picked its own model or feature flags would be picking the
  // bill. `sample_rate` is deliberately absent — it is the one value the device
  // knows and the server does not.
  assert.equal(session.params.model, "nova-2", "ja is not a nova-3 language");
  assert.equal(session.params.language, "ja");
  assert.equal(session.params.diarize_model, "latest", "diarize:true was asked for");
  assert.equal(session.params.sample_rate, undefined);

  assert.equal(calls.length, 1);
  assert.match(calls[0].init.headers.Authorization, /^Token /);
});

await test("stt: the deployment language is used when the client asks for none", async () => {
  const mint = createSttToken({
    config, db: sttDb, secrets,
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ access_token: "t" }) }),
  });
  const session = await mint.mint({ kelaboId: "stt-2", participant: { identity: "host@example.com" } });
  assert.equal(session.params.language, config.stt.language);
  assert.equal(session.params.diarize_model, undefined, "diarization is opt-in, not the default");
  // Falls back to the configured ttl when the provider does not state one.
  assert.equal(session.expiresInSeconds, config.stt.providers.deepgram.tokenTtlSeconds);
});

await test("stt: a provider this build does not carry degrades, it does not 500", async () => {
  const mint = createSttToken({
    config: { ...config, stt: { ...config.stt, provider: "not-a-provider" } },
    db: sttDb, secrets,
    fetchImpl: async () => { throw new Error("must not be called"); },
  });
  // Reached before the secret is read and before the network: an operator's
  // config mistake must not spend a Secrets Manager call, let alone a provider one.
  await assert.rejects(
    () => mint.mint({ kelaboId: "stt-3", participant: { identity: "host@example.com" } }),
    (e) => e.status === 502 && e.code === "stt_unavailable",
  );
});

await test("stt: authorization happens before the key is ever read", async () => {
  let keyReads = 0;
  const mint = createSttToken({
    config, db: sttDb,
    secrets: { ...secrets, getSttKey: async () => { keyReads++; return "k"; } },
    fetchImpl: async () => { throw new Error("must not be called"); },
  });
  await assert.rejects(
    () => mint.mint({ kelaboId: "stt-4", participant: { identity: "stranger@example.com" } }),
    (e) => e.status === 403,
  );
  await assert.rejects(
    () => mint.mint({ kelaboId: "nope", participant: { identity: "host@example.com" } }),
    (e) => e.status === 404,
  );
  assert.equal(keyReads, 0, "a stranger asking must never reach the secret");
});

await test("stt: a provider returning an unusable session fails here, not in the browser", async () => {
  // The failure this guards against has no symptom on the client: a socket
  // opens against `undefined`, audio streams, nothing is transcribed, and
  // nothing anywhere raises an error.
  const mint = createSttToken({
    config, db: sttDb, secrets,
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({}) }),
  });
  await assert.rejects(
    () => mint.mint({ kelaboId: "stt-5", participant: { identity: "host@example.com" } }),
    (e) => e.status === 502 && e.code === "stt_unavailable",
  );
});

await test("stt: soniox mints a restricted temporary key, not the long-lived one", async () => {
  const calls = [];
  const sonioxConfig = {
    ...config,
    stt: {
      ...config.stt,
      provider: "soniox",
      providers: { soniox: { model: "stt-rt-v5", maxSessionSeconds: 14400 } },
    },
  };
  const mint = createSttToken({
    config: sonioxConfig,
    db: sttDb,
    secrets: { ...secrets, getSttKey: async () => "long-lived-secret" },
    fetchImpl: async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body), headers: init.headers });
      return {
        ok: true, status: 201,
        json: async () => ({ api_key: "temp:ABC", expires_at: new Date(Date.now() + 60_000).toISOString() }),
      };
    },
  });

  const session = await mint.mint({
    kelaboId: "stt-6",
    participant: { identity: "host@example.com" },
    opts: { language: "ja", diarize: false },
  });

  // The credential a browser gets is short-lived, one-shot and duration-capped.
  // Each of these is the difference between a leaked key costing nothing and a
  // leaked key costing whatever someone cares to spend.
  const body = calls[0].body;
  assert.equal(body.usage_type, "transcribe_websocket");
  // MUST be false. The client opens a separate Soniox stream per utterance —
  // which is what keeps a silent participant free — and one connection carries
  // exactly one stream, so a single-use key would authenticate the first thing
  // somebody says and 401 everything after it.
  assert.equal(body.single_use, false, "one key opens many streams, by design");
  assert.ok(body.expires_in_seconds > 0 && body.expires_in_seconds <= 3600);
  assert.equal(body.max_session_duration_seconds, 14400);
  assert.equal(body.client_reference_id, "stt-6", "usage logs attribute cost per kelabo");
  assert.match(calls[0].headers.Authorization, /^Bearer /);
  assert.notEqual(session.token, "long-lived-secret", "the long-lived key must never leave the server");
  assert.equal(session.token, "temp:ABC");

  // Soniox has one model for every language, so a hint — not a model table.
  assert.equal(session.params.model, "stt-rt-v5");
  assert.deepEqual(session.params.language_hints, ["ja"]);
  assert.equal(session.params.audio_format, "pcm_s16le");
  assert.equal(session.params.num_channels, 1);
  // Always on: it costs nothing extra and one microphone is several people.
  assert.equal(session.params.enable_speaker_diarization, true, "diarization is not opt-in here");
  assert.equal(session.params.api_key, undefined, "the key rides its own field, not the params");
  assert.equal(session.params.sample_rate, undefined, "only the device knows that");

  // Endpoint tuning, measured against stt-rt-v5 and inside the ranges Soniox
  // accepts — an out-of-range value is a 400 that takes transcription down.
  assert.ok(session.params.max_endpoint_delay_ms >= 500 && session.params.max_endpoint_delay_ms <= 3000);
  assert.ok(session.params.endpoint_latency_adjustment_level >= 0 && session.params.endpoint_latency_adjustment_level <= 3);
  assert.ok(session.params.endpoint_sensitivity >= -1 && session.params.endpoint_sensitivity <= 1);
});

await test("stt: soniox key ttl is long enough to refresh off the critical path", async () => {
  // Minting costs ~470ms. A 60s key would have to be re-minted constantly, and
  // sooner or later that lands on the onset of an utterance — which is the
  // whole latency budget the pooled design exists to protect.
  const mint = createSttToken({
    config: { ...config, stt: { ...config.stt, provider: "soniox", providers: {} } },
    db: sttDb, secrets,
    fetchImpl: async (url, init) => {
      const body = JSON.parse(init.body);
      assert.ok(body.expires_in_seconds >= 300, `ttl ${body.expires_in_seconds}s is too short to refresh between utterances`);
      return { ok: true, status: 201, json: async () => ({ api_key: "t" }) };
    },
  });
  await mint.mint({ kelaboId: "stt-10", participant: { identity: "host@example.com" } });
});

await test("stt: turning endpoint detection off removes its tuning too", async () => {
  // Soniox rejects the tuning parameters when the feature is off, and a 400
  // here means no transcription at all.
  const mint = createSttToken({
    config: {
      ...config,
      stt: { ...config.stt, provider: "soniox", providers: { soniox: { endpointDetection: false } } },
    },
    db: sttDb, secrets,
    fetchImpl: async () => ({ ok: true, status: 201, json: async () => ({ api_key: "t" }) }),
  });
  const session = await mint.mint({ kelaboId: "stt-11", participant: { identity: "host@example.com" } });
  assert.equal(session.params.enable_endpoint_detection, false);
  assert.equal(session.params.max_endpoint_delay_ms, undefined);
  assert.equal(session.params.endpoint_latency_adjustment_level, undefined);
  assert.equal(session.params.endpoint_sensitivity, undefined);
});

await test("stt: 'multi' means no language hint, which is soniox's native mode", async () => {
  const mint = createSttToken({
    config: { ...config, stt: { ...config.stt, provider: "soniox", language: "multi", providers: {} } },
    db: sttDb, secrets,
    fetchImpl: async () => ({ ok: true, status: 201, json: async () => ({ api_key: "t" }) }),
  });
  const session = await mint.mint({ kelaboId: "stt-7", participant: { identity: "host@example.com" } });
  assert.equal(session.params.language_hints, undefined, "hinting every language is not a hint");
  assert.equal(session.params.enable_endpoint_detection, true, "on unless a room turns it off");
});

await test("stt: endpoint detection is a knob, because it trades against diarization", async () => {
  const mint = createSttToken({
    config: {
      ...config,
      stt: { ...config.stt, provider: "soniox", providers: { soniox: { endpointDetection: false } } },
    },
    db: sttDb, secrets,
    fetchImpl: async () => ({ ok: true, status: 201, json: async () => ({ api_key: "t" }) }),
  });
  const session = await mint.mint({ kelaboId: "stt-8", participant: { identity: "host@example.com" } });
  assert.equal(session.params.enable_endpoint_detection, false);
});

await test("stt: both providers answer the same interface", async () => {
  // The point of the registry: the core dispatches without knowing either of
  // them, and what comes back is the same shape whoever produced it.
  for (const [provider, response] of [
    ["deepgram", { access_token: "d" }],
    ["soniox", { api_key: "s" }],
  ]) {
    const mint = createSttToken({
      config: { ...config, stt: { ...config.stt, provider } },
      db: sttDb, secrets,
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => response }),
    });
    const session = await mint.mint({
      kelaboId: "stt-9", participant: { identity: "host@example.com" },
    });
    assert.equal(session.provider, provider);
    assert.ok(session.url.startsWith("wss://"));
    assert.ok(session.token);
    assert.ok(session.expiresInSeconds > 0);
    assert.equal(typeof session.params, "object");
  }
});

console.log(`\n${passed} tests passed${process.exitCode ? " (with failures)" : ""}`);
