// One organisation, several email domains — and a public mailbox domain is
// never an organisation (issue #14).
//
// Driven through the real modules against the stub db, each built with an
// opConfig stub whose `effective()` can change between calls — the way a
// publish from /admin changes it — so "an alias added later takes effect on
// the next request / refresh" is exercised, not assumed.
import assert from "node:assert/strict";
import { createDb } from "./stubDb.js";
import { createTenancy } from "../src/tenancy.js";
import { createOtp } from "../src/otp.js";
import { createSessions } from "../src/sessions.js";
import { createKelabos } from "../src/kelabos.js";
import { createScheduling } from "../src/scheduling.js";
import { createContacts } from "../src/contacts.js";
import { createHuddle } from "../src/huddle.js";
import { createJourneys } from "../src/journeys.js";
import { createPeople } from "../src/people.js";

const base = {
  env: "test",
  cookieDomain: ".test.example.com",
  portalUrl: "https://test.example.com",
  joinUrl: (id) => `https://test.example.com/join/${id}`,
  inviteUrl: (id) => `https://test.example.com/invite/${id}`,
  auth: { sessionTtlSeconds: 3600, refreshTtlDays: 60, participantTtlSeconds: 43200, agentTokenTtlDays: 90 },
  rtc: { defaultMode: "sfu", meshMaxParticipants: 6, video: false },
  otp: {
    ttlSeconds: 600,
    maxAttempts: 5,
    resendSeconds: 0,
    perEmailWindowSeconds: 3600,
    perEmailMaxRequests: 50,
    perIpWindowSeconds: 3600,
    perIpMaxRequests: 300,
  },
  contacts: { external: false },
  retentionDays: 30,
};

/** An opConfig whose effective config is whatever `current` says right now. */
function liveConfig(initial) {
  const box = { current: { ...base, ...initial } };
  return { box, opConfig: { effective: async () => box.current } };
}

const secrets = { getCookieKey: async () => "test-signing-key" };
const codes = new Map();
const mailer = { sendOtp: async ({ to, code }) => codes.set(to, code), sendInvite: async () => {} };
const rung = [];
const internal = {
  ring: async (kelaboId, identity, { targets }) => (rung.push(...targets), { delivered: targets, offline: [] }),
  notifyKelabo: async () => {},
};

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

async function signIn(otp, email) {
  await otp.request({ email, ip: "1.2.3.4" });
  return otp.verify({ email, code: codes.get(email) });
}

// --- organisation with aliases -------------------------------------------------

{
  const { box, opConfig } = liveConfig({ allowedEmailDomain: "acme.com", emailDomainAliases: ["acme.io"] });
  const config = box.current;
  const db = createDb();
  const tenancy = createTenancy({ config, opConfig });
  const otp = createOtp({ config, db, mailer, opConfig, tenancy });
  const sessions = createSessions({ config, db, secrets, opConfig, tenancy });
  const people = createPeople({ db, ttlMs: 0 });
  const scheduling = createScheduling({ config, db, mailer, internal, opConfig, secrets, people, tenancy });
  const contacts = createContacts({ config, db, opConfig, people, tenancy });
  const kelabos = createKelabos({ config, db, internal, opConfig, tenancy });
  const huddle = createHuddle({ config, db, internal, kelabos, opConfig, tenancy });

  await test("every listed domain signs in; anything else is refused", async () => {
    assert.equal((await signIn(otp, "ann@acme.com")).tenantId, "acme.com");
    // An alias signs in, into the primary's tenant.
    assert.equal((await signIn(otp, "bob@acme.io")).tenantId, "acme.com");
    await assert.rejects(otp.request({ email: "eve@evil.com", ip: "1.2.3.4" }), (e) => e.code === "domain_not_allowed");
    await assert.rejects(otp.request({ email: "eve@gmail.com", ip: "1.2.3.4" }), (e) => e.code === "domain_not_allowed");
  });

  await test("people at the primary and the alias find each other by name", async () => {
    const fromAnn = await scheduling.suggestPeople({ identity: "ann@acme.com", prefix: "bob" });
    assert.deepEqual(fromAnn.suggestions.map((s) => s.email), ["bob@acme.io"]);
    const fromBob = await scheduling.suggestPeople({ identity: "bob@acme.io", prefix: "ann" });
    assert.deepEqual(fromBob.suggestions.map((s) => s.email), ["ann@acme.com"]);
  });

  await test("an alias colleague can be favourited and rung; an outsider cannot", async () => {
    await contacts.favourite({ identity: "ann@acme.com", email: "bob@acme.io" });
    await assert.rejects(
      contacts.favourite({ identity: "ann@acme.com", email: "eve@evil.com" }),
      (e) => e.code === "not_a_colleague"
    );
    assert.equal(await tenancy.sameOrg("ann@acme.com", "bob@acme.io"), true);
    await huddle.create({ identity: "ann@acme.com", displayName: "Ann", body: { invitees: ["bob@acme.io"] } });
    assert.deepEqual(rung, ["bob@acme.io"]);
    assert.equal(await tenancy.sameOrg("ann@acme.com", "eve@evil.com"), false);
    await assert.rejects(
      huddle.create({ identity: "ann@acme.com", displayName: "Ann", body: { invitees: ["eve@evil.com"] } }),
      (e) => e.code === "no_contact"
    );
  });

  await test("a kelabo created from an alias is in the organisation's live list", async () => {
    await kelabos.createKelabo({ identity: "bob@acme.io", body: { title: "From the alias" } });
    const { active } = await kelabos.listKelabos({ identity: "ann@acme.com" });
    assert.ok(active.some((k) => k.title === "From the alias"));
  });

  await test("an alias added later takes effect on the next refresh, user row included", async () => {
    // Carol signed in while acme.dev was not part of the organisation... which
    // the gate would have refused, so model the realistic case: the deployment
    // was open, then restricted with acme.dev as an alias.
    box.current = { ...box.current, allowedEmailDomain: "", emailDomainAliases: [] };
    const carol = await sessions.establishSession("carol@acme.dev", "Carol");
    assert.equal(carol.tenantId, "acme.dev");
    const refreshCookie = carol.cookies[1].split(";")[0].split("=").slice(1).join("=");

    box.current = { ...box.current, allowedEmailDomain: "acme.com", emailDomainAliases: ["acme.io", "acme.dev"] };
    const refreshed = await sessions.refresh(decodeURIComponent(refreshCookie));
    assert.equal(refreshed.tenantId, "acme.com");
    assert.equal((await db.getUser("carol@acme.dev")).tenantId, "acme.com", "search reads the user row");
    const found = await scheduling.suggestPeople({ identity: "ann@acme.com", prefix: "carol" });
    assert.deepEqual(found.suggestions.map((s) => s.email), ["carol@acme.dev"]);
  });

  await test("publishing gmail.com as an alias is ignored, not honoured", async () => {
    box.current = { ...box.current, allowedEmailDomain: "acme.com", emailDomainAliases: ["gmail.com"] };
    await assert.rejects(otp.request({ email: "eve@gmail.com", ip: "1.2.3.4" }), (e) => e.code === "domain_not_allowed");
    assert.equal(await tenancy.tenantOf("eve@gmail.com"), "gmail.com");
  });
}

// --- open registration: a public mailbox tenant has no colleagues --------------

{
  const { opConfig } = liveConfig({ allowedEmailDomain: "" });
  const config = { ...base, allowedEmailDomain: "" };
  const db = createDb();
  const tenancy = createTenancy({ config, opConfig });
  const otp = createOtp({ config, db, mailer, opConfig, tenancy });
  const people = createPeople({ db, ttlMs: 0 });
  const scheduling = createScheduling({ config, db, mailer, internal, opConfig, secrets, people, tenancy });
  const contacts = createContacts({ config, db, opConfig, people, tenancy });
  const kelabos = createKelabos({ config, db, internal, opConfig, tenancy });
  const huddle = createHuddle({ config, db, internal, kelabos, opConfig, tenancy });
  const journeys = createJourneys({ config, db, internal, opConfig, tenancy });

  for (const e of ["alice@gmail.com", "mallory@gmail.com", "dan@startup.io", "erin@startup.io"]) await signIn(otp, e);

  await test("gmail.com users cannot find each other; a company domain still can", async () => {
    assert.deepEqual((await scheduling.suggestPeople({ identity: "alice@gmail.com", prefix: "mal" })).suggestions, []);
    // The blank query used to list the tenant's first eight users outright.
    assert.deepEqual((await scheduling.suggestPeople({ identity: "alice@gmail.com", prefix: "" })).suggestions, []);
    const startup = await scheduling.suggestPeople({ identity: "dan@startup.io", prefix: "erin" });
    assert.deepEqual(startup.suggestions.map((s) => s.email), ["erin@startup.io"]);
  });

  await test("gmail.com users cannot see each other's live kelabos; their own stay listed", async () => {
    await kelabos.createKelabo({ identity: "mallory@gmail.com", body: { title: "Mallory's private chat" } });
    await kelabos.createKelabo({ identity: "alice@gmail.com", body: { title: "Alice's own" } });
    const { active, mine } = await kelabos.listKelabos({ identity: "alice@gmail.com" });
    assert.deepEqual(active.map((k) => k.title), ["Alice's own"]);
    assert.deepEqual(mine.map((k) => k.title), ["Alice's own"]);
    // A company tenant under open registration is still an organisation.
    await kelabos.createKelabo({ identity: "erin@startup.io", body: { title: "Standup" } });
    assert.ok((await kelabos.listKelabos({ identity: "dan@startup.io" })).active.some((k) => k.title === "Standup"));
  });

  await test("gmail.com users are not colleagues: no favourite, no ring", async () => {
    await assert.rejects(
      contacts.favourite({ identity: "alice@gmail.com", email: "mallory@gmail.com" }),
      (e) => e.code === "not_a_colleague"
    );
    await assert.rejects(
      huddle.create({ identity: "alice@gmail.com", displayName: "Alice", body: { invitees: ["mallory@gmail.com"] } }),
      (e) => e.code === "no_contact"
    );
  });

  await test("a 'public' journey at gmail.com is visible to its owner only", async () => {
    const { journeyId } = await journeys.createJourney({
      identity: "mallory@gmail.com",
      body: { title: "Mallory's plans", visibility: "public" },
    });
    const alice = await journeys.listJourneys({ identity: "alice@gmail.com" });
    assert.equal(alice.public.length, 0);
    await assert.rejects(journeys.getJourney({ journeyId, identity: "alice@gmail.com" }), (e) => e.status === 403 || e.status === 404);
    const mallory = await journeys.listJourneys({ identity: "mallory@gmail.com" });
    assert.deepEqual(mallory.mine.map((j) => j.title), ["Mallory's plans"]);
  });
}

console.log(`rest-api/tenancy: ${passed} passed`);
