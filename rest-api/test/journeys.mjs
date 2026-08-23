// Journey (docs 20): CRUD, visibility/permission matrix, kelabo linking, the
// kelabos-table mirror, description versioning, and the purge guard on
// records.js. Two layers: direct calls into journeys.js for the permission
// matrix (fast, thorough), plus a handful of true HTTP-level calls through
// createApp to prove the routes in index.js are wired correctly.
import assert from "node:assert/strict";
import { createApp } from "../src/index.js";
import { createDb } from "./stubDb.js";
import { createSessions } from "../src/sessions.js";
import { createJourneys } from "../src/journeys.js";
import { createRecords } from "../src/records.js";

const config = {
  env: "test",
  region: "us-east-1",
  allowedEmailDomain: "example.com",
  cookieDomain: ".test.example.com",
  portalUrl: "https://test.example.com",
  gatewayBaseUrl: "https://gw.test.example.com",
  joinUrl: (id) => `https://test.example.com/join/${id}`,
  inviteUrl: (id) => `https://test.example.com/invite/${id}`,
  tableNames: { kelabos: "m", users: "u", otp: "o", refresh: "r", history: "h", mcp: "mc", contacts: "co", journeys: "j" },
  contacts: { external: false },
  archiveBucket: "bucket",
  archiveKeyPrefix: "archives",
  secrets: { cookieSigningKey: "cookie" },
  auth: { sessionTtlSeconds: 3600, refreshTtlDays: 60, participantTtlSeconds: 43200, agentTokenTtlDays: 90, socialProviders: [] },
  retentionDays: 30,
};

const secrets = { getCookieKey: async () => "test-signing-key" };

const db = createDb();
const sessions = createSessions({ config, db, secrets });

// The Gateway side of report generation (docs 20 §6) is tested on its own,
// offline, in gateway/test/journeys.mjs — here it is a stub the test can
// script to succeed or fail, proving rest-api's own half: creating the
// pending row, counting the ask, and handling an unreachable Gateway.
const internalCalls = [];
const internal = {
  gatewayUnreachable: false,
  requestJourneyReport: async (journeyId, { reportId, question }, identity) => {
    internalCalls.push({ journeyId, reportId, question, identity });
    if (internal.gatewayUnreachable) throw new Error("fetch failed");
    // Stands in for the Gateway's own generateJourneyReport writing the
    // finished row directly — see gateway/test/journeys.mjs for that half.
    await db.putJourneyReport(journeyId, {
      reportId,
      question,
      requestedBy: identity,
      requestedAt: Date.now(),
      status: "ready",
      answer: `Fake answer to: ${question}`,
      generatedAt: Date.now(),
    });
  },
};

const journeys = createJourneys({ config, db, internal });
const s3Objects = {};
const records = createRecords({
  config,
  db,
  s3: { send: async () => ({ Body: { transformToString: async () => "{}" } }) },
});

// Every other dep the route table references but these tests never exercise —
// left undefined on purpose, matching how a handler for an untouched route is
// never invoked and so never dereferences them.
const app = createApp({
  config,
  db,
  secrets,
  sessions,
  journeys,
  records,
  version: "test",
});

function cookieValue(cookies, name) {
  const c = (cookies || []).find((s) => s.startsWith(`${name}=`));
  return c ? decodeURIComponent(c.split(";")[0].slice(name.length + 1)) : null;
}

async function sessionFor(email) {
  const session = await sessions.establishSession(email);
  return { kelabo_session: cookieValue(session.cookies, "kelabo_session") };
}

async function call(method, path, { body, cookies = {} } = {}) {
  const [rawPath, qs] = path.split("?");
  const res = await app({
    requestContext: { http: { method, sourceIp: "1.2.3.4" } },
    rawPath,
    rawQueryString: qs || "",
    headers: {
      "content-type": "application/json",
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

// A minimal live kelabo, seeded directly (bypassing kelabos.js — journeys.js
// only ever reads META, host and participants). `host` is stamped as host
// and as the sole participant unless overridden, since linkKelabo requires
// the actor to be host-or-participant of the target.
async function seedKelabo({ kelaboId, host, participants = [], status = "active" }) {
  await db.createKelabo({
    kelaboId,
    status,
    title: `Kelabo ${kelaboId}`,
    hostIdentity: host,
    participants,
    tenantId: host.split("@")[1],
    tenantStatus: `${host.split("@")[1]}#${status}`,
    createdAt: Date.now(),
    startedAt: Date.now(),
  });
}

const OWNER = "alice@example.com";
const COLLEAGUE = "bob@example.com"; // same tenant (example.com)
const OUTSIDER = "carol@other.example"; // different tenant

// --- create / get / list, and the visibility split --------------------------

await test("create + get: owner always has full access", async () => {
  const j = await journeys.createJourney({ identity: OWNER, body: { title: "Q3 Launch", visibility: "private" } });
  assert.equal(j.status, "active");
  assert.equal(j.visibility, "private");
  const got = await journeys.getJourney({ journeyId: j.journeyId, identity: OWNER });
  assert.equal(got.myRole, "owner");
  assert.equal(got.title, "Q3 Launch");
});

await test("get: a private journey refuses a same-tenant stranger with no accessor grant", async () => {
  const j = await journeys.createJourney({ identity: OWNER, body: { title: "Private one", visibility: "private" } });
  await assert.rejects(
    journeys.getJourney({ journeyId: j.journeyId, identity: COLLEAGUE }),
    (e) => e.status === 403 && e.code === "forbidden",
  );
});

await test("get: a public journey grants full access to any same-tenant identity, none to another tenant", async () => {
  const j = await journeys.createJourney({ identity: OWNER, body: { title: "Public one", visibility: "public" } });
  const asColleague = await journeys.getJourney({ journeyId: j.journeyId, identity: COLLEAGUE });
  assert.equal(asColleague.myRole, "member");
  await assert.rejects(
    journeys.getJourney({ journeyId: j.journeyId, identity: OUTSIDER }),
    (e) => e.status === 403,
  );
});

await test("get: unknown journey is 404, not a 403 that leaks existence", async () => {
  await assert.rejects(
    journeys.getJourney({ journeyId: "nope", identity: OWNER }),
    (e) => e.status === 404 && e.code === "journey_not_found",
  );
});

await test("list: mine / accessible / public are three distinct, non-overlapping buckets", async () => {
  const pub = await journeys.createJourney({ identity: OWNER, body: { title: "Owned+public", visibility: "public" } });
  const priv = await journeys.createJourney({ identity: OWNER, body: { title: "Owned+private", visibility: "private" } });
  await journeys.addAccessor({ journeyId: priv.journeyId, identity: OWNER, body: { identity: COLLEAGUE } });

  const mine = await journeys.listJourneys({ identity: OWNER });
  assert.ok(mine.mine.some((m) => m.journeyId === pub.journeyId));
  assert.ok(mine.mine.some((m) => m.journeyId === priv.journeyId));
  assert.equal(mine.public.some((m) => m.journeyId === pub.journeyId), false, "own journey is not also listed as public");

  const colleague = await journeys.listJourneys({ identity: COLLEAGUE });
  assert.ok(colleague.public.some((m) => m.journeyId === pub.journeyId), "sees the owner's public journey");
  assert.ok(colleague.accessible.some((m) => m.journeyId === priv.journeyId), "sees the private one they were added to");
  assert.equal(colleague.mine.length, 0);
});

await test("list: a completed private journey never appears in `accessible`, even for an accessor who stays one", async () => {
  // `mine`/`public` cannot leak a completed journey by construction — the
  // GSI's own partition key (tenantStatus) makes it unreachable. `accessible`
  // has no such guarantee (accessor-index is keyed on identity alone), so
  // this is the one bucket that needs its own explicit filter.
  const priv = await journeys.createJourney({ identity: OWNER, body: { title: "Owned+private", visibility: "private" } });
  await journeys.addAccessor({ journeyId: priv.journeyId, identity: OWNER, body: { identity: COLLEAGUE } });
  const before = await journeys.listJourneys({ identity: COLLEAGUE });
  assert.ok(before.accessible.some((m) => m.journeyId === priv.journeyId), "visible while active");

  await journeys.completeJourney({ journeyId: priv.journeyId, identity: OWNER });
  // Completing never touches ACCESSOR# rows — COLLEAGUE is still one.
  const after = await journeys.listJourneys({ identity: COLLEAGUE });
  assert.equal(
    after.accessible.some((m) => m.journeyId === priv.journeyId),
    false,
    "a completed journey must never be offered as a link target, even to an accessor who never lost access",
  );
});

// --- patch (owner-only) ------------------------------------------------------

await test("patch: non-owner is refused even with member-level access", async () => {
  const j = await journeys.createJourney({ identity: OWNER, body: { title: "T", visibility: "public" } });
  await assert.rejects(
    journeys.patchJourney({ journeyId: j.journeyId, identity: COLLEAGUE, body: { title: "Hijacked" } }),
    (e) => e.status === 403 && e.code === "not_journey_owner",
  );
});

await test("patch: empty body is nothing_to_change", async () => {
  const j = await journeys.createJourney({ identity: OWNER, body: { title: "T", visibility: "public" } });
  await assert.rejects(
    journeys.patchJourney({ journeyId: j.journeyId, identity: OWNER, body: {} }),
    (e) => e.status === 400 && e.code === "nothing_to_change",
  );
});

await test("patch: owner can rename and flip visibility", async () => {
  const j = await journeys.createJourney({ identity: OWNER, body: { title: "T", visibility: "public" } });
  const updated = await journeys.patchJourney({ journeyId: j.journeyId, identity: OWNER, body: { title: "T2", visibility: "private" } });
  assert.equal(updated.title, "T2");
  assert.equal(updated.visibility, "private");
});

// --- complete / reopen (owner-only, idempotent, freezes writes) -------------

await test("complete: owner-only, idempotent, and freezes every member write", async () => {
  const j = await journeys.createJourney({ identity: OWNER, body: { title: "T", visibility: "public" } });
  await assert.rejects(
    journeys.completeJourney({ journeyId: j.journeyId, identity: COLLEAGUE }),
    (e) => e.status === 403 && e.code === "not_journey_owner",
  );
  const done = await journeys.completeJourney({ journeyId: j.journeyId, identity: OWNER });
  assert.equal(done.status, "completed");
  // Idempotent: a second click lands on the same state, not an error.
  const again = await journeys.completeJourney({ journeyId: j.journeyId, identity: OWNER });
  assert.equal(again.status, "completed");

  // Frozen: description edits, which a member could do while active, are
  // refused now for owner AND member alike.
  await assert.rejects(
    journeys.updateDescription({ journeyId: j.journeyId, identity: OWNER, body: { markdown: "x" } }),
    (e) => e.status === 409 && e.code === "journey_completed",
  );
  // patch (title/visibility) is owner-only and structural, not one of the
  // member-writes §3.1 freezes — it deliberately carries no requireActive
  // guard, so the owner can still rename or flip visibility while completed.
  const renamed = await journeys.patchJourney({ journeyId: j.journeyId, identity: OWNER, body: { title: "T3" } });
  assert.equal(renamed.title, "T3");
});

await test("reopen: owner-only, refuses on an already-active journey", async () => {
  const j = await journeys.createJourney({ identity: OWNER, body: { title: "T", visibility: "public" } });
  await journeys.completeJourney({ journeyId: j.journeyId, identity: OWNER });
  await assert.rejects(
    journeys.reopenJourney({ journeyId: j.journeyId, identity: COLLEAGUE }),
    (e) => e.status === 403,
  );
  const reopened = await journeys.reopenJourney({ journeyId: j.journeyId, identity: OWNER });
  assert.equal(reopened.status, "active");
  // Already active: idempotent, not an error.
  const again = await journeys.reopenJourney({ journeyId: j.journeyId, identity: OWNER });
  assert.equal(again.status, "active");
});

// --- accessors (private only, owner-only to manage) -------------------------

await test("accessors: owner-only to add/remove; refused entirely on a public journey", async () => {
  const pub = await journeys.createJourney({ identity: OWNER, body: { title: "T", visibility: "public" } });
  await assert.rejects(
    journeys.addAccessor({ journeyId: pub.journeyId, identity: OWNER, body: { identity: COLLEAGUE } }),
    (e) => e.status === 409 && e.code === "not_private",
  );

  const priv = await journeys.createJourney({ identity: OWNER, body: { title: "T", visibility: "private" } });
  await assert.rejects(
    journeys.addAccessor({ journeyId: priv.journeyId, identity: COLLEAGUE, body: { identity: COLLEAGUE } }),
    (e) => e.status === 403 && e.code === "not_journey_owner",
  );

  await journeys.addAccessor({ journeyId: priv.journeyId, identity: OWNER, body: { identity: COLLEAGUE } });
  const got = await journeys.getJourney({ journeyId: priv.journeyId, identity: COLLEAGUE });
  assert.equal(got.myRole, "member");

  await journeys.removeAccessor({ journeyId: priv.journeyId, identity: OWNER, target: COLLEAGUE });
  await assert.rejects(
    journeys.getJourney({ journeyId: priv.journeyId, identity: COLLEAGUE }),
    (e) => e.status === 403,
  );
});

// --- kelabo linking, the mirror, and the target-membership requirement ------

await test("linkKelabo: refused unless the actor is host/participant of the target kelabo", async () => {
  const j = await journeys.createJourney({ identity: OWNER, body: { title: "T", visibility: "public" } });
  await seedKelabo({ kelaboId: "k-not-mine", host: COLLEAGUE });
  await assert.rejects(
    journeys.linkKelabo({ journeyId: j.journeyId, identity: OWNER, kelaboId: "k-not-mine" }),
    (e) => e.status === 403 && e.code === "not_kelabo_member",
  );
});

await test("linkKelabo: succeeds for the kelabo's host, mirrors onto the kelabo's own partition, is idempotent, and unlink removes both sides", async () => {
  const j = await journeys.createJourney({ identity: OWNER, body: { title: "T", visibility: "public" } });
  await seedKelabo({ kelaboId: "k1", host: OWNER });

  const link1 = await journeys.linkKelabo({ journeyId: j.journeyId, identity: OWNER, kelaboId: "k1" });
  assert.equal(link1.linked, true);
  assert.equal((await db.listKelaboJourneyLinks("k1")).length, 1, "mirror written on the kelabo's own partition");
  assert.equal((await journeys.getJourney({ journeyId: j.journeyId, identity: OWNER })).kelaboCount, 1);

  // Idempotent: linking the same kelabo again lands on "linked", not an error.
  const link2 = await journeys.linkKelabo({ journeyId: j.journeyId, identity: OWNER, kelaboId: "k1" });
  assert.equal(link2.linked, true);

  const listed = await journeys.listLinkedKelabos({ journeyId: j.journeyId, identity: OWNER });
  assert.equal(listed.kelabos.length, 1);
  assert.equal(listed.kelabos[0].kelaboId, "k1");

  await journeys.unlinkKelabo({ journeyId: j.journeyId, identity: OWNER, kelaboId: "k1" });
  assert.equal((await db.listKelaboJourneyLinks("k1")).length, 0, "mirror removed");
  assert.equal((await journeys.listLinkedKelabos({ journeyId: j.journeyId, identity: OWNER })).kelabos.length, 0);
});

await test("linkKelabo: refused once the journey is completed", async () => {
  const j = await journeys.createJourney({ identity: OWNER, body: { title: "T", visibility: "public" } });
  await seedKelabo({ kelaboId: "k2", host: OWNER });
  await journeys.completeJourney({ journeyId: j.journeyId, identity: OWNER });
  await assert.rejects(
    journeys.linkKelabo({ journeyId: j.journeyId, identity: OWNER, kelaboId: "k2" }),
    (e) => e.status === 409 && e.code === "journey_completed",
  );
});

await test("linkKelabo: a participant (not the host) may also link", async () => {
  const j = await journeys.createJourney({ identity: OWNER, body: { title: "T", visibility: "public" } });
  await seedKelabo({ kelaboId: "k3", host: COLLEAGUE, participants: [{ identity: OWNER, displayName: "Alice", isGuest: false }] });
  const link = await journeys.linkKelabo({ journeyId: j.journeyId, identity: OWNER, kelaboId: "k3" });
  assert.equal(link.linked, true);
});

// --- description versioning --------------------------------------------------

await test("description: append-only versions, current version advances, history is readable", async () => {
  const j = await journeys.createJourney({ identity: OWNER, body: { title: "T", visibility: "public", description: "v1 text" } });
  const v2 = await journeys.updateDescription({ journeyId: j.journeyId, identity: OWNER, body: { markdown: "v2 text", changeNote: "clarified scope" } });
  assert.equal(v2.version, 2, "creation's description counts as version 1");
  const history = await journeys.getDescriptionHistory({ journeyId: j.journeyId, identity: OWNER });
  assert.equal(history.versions.length, 2);
  assert.equal(history.versions.some((v) => v.markdown === "v1 text"), true);
  assert.equal(history.versions.some((v) => v.markdown === "v2 text" && v.changeNote === "clarified scope"), true);
});

// --- delete: cascades journey-owned resources, kelabos survive --------------

await test("deleteJourney: owner-only, cascades DESC#/ACCESSOR#/LINK#/BOARDMSG#/DOC#, unmirrors every linked kelabo, and never touches the kelabo itself", async () => {
  const j = await journeys.createJourney({ identity: OWNER, body: { title: "T", visibility: "private", description: "d" } });
  await journeys.addAccessor({ journeyId: j.journeyId, identity: OWNER, body: { identity: COLLEAGUE } });
  await seedKelabo({ kelaboId: "k4", host: OWNER });
  await journeys.linkKelabo({ journeyId: j.journeyId, identity: OWNER, kelaboId: "k4" });
  await journeys.addBoardMessage({ journeyId: j.journeyId, identity: OWNER, body: { content: "pinned note" } });
  const doc4 = await journeys.addDocument({ journeyId: j.journeyId, identity: OWNER, body: { title: "spec", content: "text" } });
  assert.equal(db.__journeySize() > 0, true);

  await assert.rejects(
    journeys.deleteJourney({ journeyId: j.journeyId, identity: COLLEAGUE }),
    (e) => e.status === 403 && e.code === "not_journey_owner",
  );

  const result = await journeys.deleteJourney({ journeyId: j.journeyId, identity: OWNER });
  assert.equal(result.deleted, true);
  assert.equal(result.kelabosUnlinked, 1);

  await assert.rejects(
    journeys.getJourney({ journeyId: j.journeyId, identity: OWNER }),
    (e) => e.status === 404,
  );
  assert.equal((await db.listKelaboJourneyLinks("k4")).length, 0, "kelabo's mirror is gone");
  assert.ok(await db.getKelaboMeta("k4"), "the kelabo itself still exists — deleting a journey never deletes a kelabo");
  // Nothing of the journey's own partition survives — description, roster,
  // link, board message and document alike, not just META.
  assert.equal(await db.getJourneyMeta(j.journeyId), null);
  assert.equal((await db.listAccessors(j.journeyId)).length, 0);
  assert.equal((await db.listBoardMessageHeads(j.journeyId)).length, 0);
  assert.equal((await db.getDocument(j.journeyId, doc4.docId)), null);
});

// --- purge guard: a kelabo linked into a journey cannot be host-purged ------

await test("purge guard: a host-purge of a linked kelabo is refused with kelabo_in_journey; unlinking clears it", async () => {
  const j = await journeys.createJourney({ identity: OWNER, body: { title: "T", visibility: "public" } });
  await seedKelabo({ kelaboId: "k5", host: OWNER, status: "ended" });
  db.__putHistory({
    archiveId: "k5",
    kelaboId: "k5",
    host: OWNER,
    endedAt: Date.now(),
    participantIdentities: [OWNER],
  });
  await journeys.linkKelabo({ journeyId: j.journeyId, identity: OWNER, kelaboId: "k5" });

  await assert.rejects(
    records.deleteRecord({ identity: OWNER, archiveId: "k5" }),
    (e) => e.status === 409 && e.code === "kelabo_in_journey",
  );

  await journeys.unlinkKelabo({ journeyId: j.journeyId, identity: OWNER, kelaboId: "k5" });
  const result = await records.deleteRecord({ identity: OWNER, archiveId: "k5" });
  assert.equal(result.outcome, "purged");
});

await test("purge guard: does not affect a participant merely dropping their own copy", async () => {
  const j = await journeys.createJourney({ identity: OWNER, body: { title: "T", visibility: "public" } });
  await seedKelabo({ kelaboId: "k6", host: OWNER, status: "ended" });
  db.__putHistory({
    archiveId: "k6",
    kelaboId: "k6",
    host: OWNER,
    endedAt: Date.now(),
    participantIdentities: [OWNER, COLLEAGUE],
  });
  db.__putHistory({
    archiveId: `PARTICIPANT#${COLLEAGUE}#k6`,
    kelaboId: "k6",
    participantIdentity: COLLEAGUE,
    endedAt: Date.now(),
  });
  await journeys.linkKelabo({ journeyId: j.journeyId, identity: OWNER, kelaboId: "k6" });

  // The host is blocked (guarded above); a participant's own removal is not
  // the guarded path at all — it never reaches purgeOne.
  const result = await records.deleteRecord({ identity: COLLEAGUE, archiveId: "k6" });
  assert.equal(result.outcome, "removed_from_list");
});

// --- health/progress status --------------------------------------------------

await test("status: optional and absent by default; an update requires at least one field", async () => {
  const j = await journeys.createJourney({ identity: OWNER, body: { title: "T", visibility: "public" } });
  const fresh = await journeys.getJourney({ journeyId: j.journeyId, identity: OWNER });
  assert.equal(fresh.health, null);
  assert.equal(fresh.progress, null);
  await assert.rejects(
    journeys.updateStatus({ journeyId: j.journeyId, identity: OWNER, body: {} }),
    (e) => e.status === 400 && e.code === "nothing_to_change",
  );
});

await test("status: a partial update carries the omitted field forward from the cached META value", async () => {
  const j = await journeys.createJourney({ identity: OWNER, body: { title: "T", visibility: "public" } });
  await journeys.updateStatus({ journeyId: j.journeyId, identity: OWNER, body: { health: "yellow", progress: 30 } });
  await journeys.updateStatus({ journeyId: j.journeyId, identity: OWNER, body: { progress: 60 } });
  const got = await journeys.getJourney({ journeyId: j.journeyId, identity: OWNER });
  assert.equal(got.health, "yellow", "health carried forward, untouched by the progress-only update");
  assert.equal(got.progress, 60);

  const history = await journeys.getStatusHistory({ journeyId: j.journeyId, identity: OWNER });
  assert.equal(history.versions.length, 2);
  assert.equal(history.versions[0].health, "yellow");
  assert.equal(history.versions[1].health, "yellow", "version 2 still recorded the carried-forward health");
});

await test("status: null explicitly clears a field back to unset", async () => {
  const j = await journeys.createJourney({ identity: OWNER, body: { title: "T", visibility: "public" } });
  await journeys.updateStatus({ journeyId: j.journeyId, identity: OWNER, body: { health: "green", progress: 100 } });
  await journeys.updateStatus({ journeyId: j.journeyId, identity: OWNER, body: { health: null } });
  const got = await journeys.getJourney({ journeyId: j.journeyId, identity: OWNER });
  assert.equal(got.health, null);
  assert.equal(got.progress, 100, "progress is untouched by clearing health");
});

await test("status: a member (not just the owner) may set it; frozen once completed", async () => {
  const j = await journeys.createJourney({ identity: OWNER, body: { title: "T", visibility: "public" } });
  await journeys.updateStatus({ journeyId: j.journeyId, identity: COLLEAGUE, body: { progress: 10 } });
  await journeys.completeJourney({ journeyId: j.journeyId, identity: OWNER });
  await assert.rejects(
    journeys.updateStatus({ journeyId: j.journeyId, identity: OWNER, body: { progress: 20 } }),
    (e) => e.status === 409 && e.code === "journey_completed",
  );
});

// --- avatar re-roll (owner-only, via patch) ----------------------------------

await test("avatar: owner-only re-roll through patch; a member cannot set it", async () => {
  const j = await journeys.createJourney({ identity: OWNER, body: { title: "T", visibility: "public" } });
  await assert.rejects(
    journeys.patchJourney({ journeyId: j.journeyId, identity: COLLEAGUE, body: { avatarVariant: 7 } }),
    (e) => e.status === 403 && e.code === "not_journey_owner",
  );
  const updated = await journeys.patchJourney({ journeyId: j.journeyId, identity: OWNER, body: { avatarVariant: 7 } });
  assert.equal(updated.avatarVariant, 7);
});

// --- timeline: one row per mutation, backward cursor, type filter -----------

// A tiny real delay so successive writes land in different milliseconds —
// needed for these tests specifically because the timeline's sort key
// (docs 20 §9.1, `TL#<pad(at,13)>#<rand6>`) only orders same-millisecond
// entries by a random tie-breaker, exactly like `CONTRIB#` already does.
// Real usage is human-paced and never collides; a tight test loop with no
// delay at all genuinely can.
const tick = () => new Promise((r) => setTimeout(r, 2));

await test("timeline: description edits, status updates, and kelabo link/unlink each leave one entry", async () => {
  const j = await journeys.createJourney({ identity: OWNER, body: { title: "T", visibility: "public", description: "v1" } });
  await tick();
  await journeys.updateDescription({ journeyId: j.journeyId, identity: OWNER, body: { markdown: "v2" } });
  await tick();
  await journeys.updateStatus({ journeyId: j.journeyId, identity: OWNER, body: { progress: 50 } });
  await tick();
  await seedKelabo({ kelaboId: "k-tl", host: OWNER });
  await journeys.linkKelabo({ journeyId: j.journeyId, identity: OWNER, kelaboId: "k-tl" });
  await tick();
  await journeys.unlinkKelabo({ journeyId: j.journeyId, identity: OWNER, kelaboId: "k-tl" });

  const all = await journeys.getTimeline({ journeyId: j.journeyId, identity: OWNER });
  assert.equal(all.entries.length, 5, "creation-description, edit-description, status, linked, unlinked");
  const types = all.entries.map((e) => e.type);
  assert.deepEqual(types, ["kelabo_unlinked", "kelabo_linked", "status", "description", "description"], "newest first");

  const onlyStatus = await journeys.getTimeline({ journeyId: j.journeyId, identity: OWNER, type: "status" });
  assert.equal(onlyStatus.entries.length, 1);
  assert.equal(onlyStatus.entries[0].type, "status");

  // Re-linking the SAME kelabo again (idempotent branch) must not double-post.
  await journeys.linkKelabo({ journeyId: j.journeyId, identity: OWNER, kelaboId: "k-tl" });
  await journeys.linkKelabo({ journeyId: j.journeyId, identity: OWNER, kelaboId: "k-tl" });
  const linkedEntries = await journeys.getTimeline({ journeyId: j.journeyId, identity: OWNER, type: "kelabo_linked" });
  assert.equal(linkedEntries.entries.length, 2, "one for the first link, one for the re-link after unlinking — not three");
});

await test("timeline: backward pagination — `before` returns strictly older entries, and a stranger cannot read it", async () => {
  const j = await journeys.createJourney({ identity: OWNER, body: { title: "T", visibility: "private" } });
  for (let i = 0; i < 5; i++) {
    await tick();
    await journeys.updateStatus({ journeyId: j.journeyId, identity: OWNER, body: { progress: i * 10 } });
  }
  const page1 = await journeys.getTimeline({ journeyId: j.journeyId, identity: OWNER, limit: 2 });
  assert.equal(page1.entries.length, 2);
  assert.ok(page1.nextBefore);
  const page2 = await journeys.getTimeline({ journeyId: j.journeyId, identity: OWNER, limit: 2, before: page1.nextBefore });
  assert.equal(page2.entries.length, 2);
  assert.ok(page2.entries[0].at < page1.entries[page1.entries.length - 1].at);

  await assert.rejects(
    journeys.getTimeline({ journeyId: j.journeyId, identity: COLLEAGUE }),
    (e) => e.status === 403,
  );
});

// --- message board -----------------------------------------------------------

await test("board: add/edit/archive/unarchive, versioned, member-writable, archived message stays visible but frozen", async () => {
  const j = await journeys.createJourney({ identity: OWNER, body: { title: "T", visibility: "public" } });
  const added = await journeys.addBoardMessage({ journeyId: j.journeyId, identity: COLLEAGUE, body: { content: "Kickoff notes" } });
  assert.equal(added.version, 1);

  const edited = await journeys.editBoardMessage({ journeyId: j.journeyId, identity: OWNER, msgId: added.msgId, body: { content: "Kickoff notes (updated)" } });
  assert.equal(edited.version, 2);

  const listed = await journeys.listBoardMessages({ journeyId: j.journeyId, identity: OWNER });
  assert.equal(listed.messages.length, 1);
  assert.equal(listed.messages[0].content, "Kickoff notes (updated)");
  assert.equal(listed.messages[0].version, 2);
  assert.equal((await journeys.getJourney({ journeyId: j.journeyId, identity: OWNER })).boardMessageCount, 1);

  await journeys.archiveBoardMessage({ journeyId: j.journeyId, identity: COLLEAGUE, msgId: added.msgId });
  const afterArchive = await journeys.listBoardMessages({ journeyId: j.journeyId, identity: OWNER });
  assert.equal(afterArchive.messages.length, 1, "archived message stays visible (in the full list), marked archived — the SPA hides it by default, this endpoint does not");
  assert.equal(afterArchive.messages[0].archived, true);
  assert.equal(afterArchive.messages[0].content, "Kickoff notes (updated)", "content is untouched by archiving, unlike the old destructive-looking remove");
  assert.equal((await journeys.getJourney({ journeyId: j.journeyId, identity: OWNER })).boardMessageCount, 0, "the active count drops");

  // Frozen while archived: no edit until unarchived.
  await assert.rejects(
    journeys.editBoardMessage({ journeyId: j.journeyId, identity: OWNER, msgId: added.msgId, body: { content: "nope" } }),
    (e) => e.status === 409 && e.code === "already_archived",
  );
  // Archiving again is idempotent, not an error.
  const again = await journeys.archiveBoardMessage({ journeyId: j.journeyId, identity: OWNER, msgId: added.msgId });
  assert.equal(again.archived, true);

  // Reversible: unarchive brings it back, and re-enables editing.
  const unarchived = await journeys.unarchiveBoardMessage({ journeyId: j.journeyId, identity: OWNER, msgId: added.msgId });
  assert.equal(unarchived.archived, false);
  assert.equal((await journeys.getJourney({ journeyId: j.journeyId, identity: OWNER })).boardMessageCount, 1, "the active count is restored");
  const afterUnarchive = await journeys.listBoardMessages({ journeyId: j.journeyId, identity: OWNER });
  assert.equal(afterUnarchive.messages[0].archived, false);
  assert.equal(afterUnarchive.messages[0].archivedBy, undefined, "stale archive metadata is dropped, not left behind");
  await journeys.editBoardMessage({ journeyId: j.journeyId, identity: OWNER, msgId: added.msgId, body: { content: "editable again" } });
  // Unarchiving again is idempotent too.
  const againUnarchived = await journeys.unarchiveBoardMessage({ journeyId: j.journeyId, identity: OWNER, msgId: added.msgId });
  assert.equal(againUnarchived.archived, false);

  const history = await journeys.getBoardMessageHistory({ journeyId: j.journeyId, identity: OWNER, msgId: added.msgId });
  assert.deepEqual(
    history.versions.map((v) => v.action),
    ["edited", "unarchived", "archived", "edited", "created"],
    "every state change is kept, newest first",
  );
});

await test("board: only the message's own poster or the journey's lead may archive it", async () => {
  const j = await journeys.createJourney({ identity: OWNER, body: { title: "T", visibility: "public" } });
  const added = await journeys.addBoardMessage({ journeyId: j.journeyId, identity: COLLEAGUE, body: { content: "Kickoff notes" } });
  await assert.rejects(
    journeys.archiveBoardMessage({ journeyId: j.journeyId, identity: "dave@example.com", msgId: added.msgId }),
    (e) => e.status === 403 && e.code === "not_message_author_or_lead",
    "a same-tenant member who is neither the poster nor the lead cannot archive",
  );
  // The poster can archive their own message...
  const archived = await journeys.archiveBoardMessage({ journeyId: j.journeyId, identity: COLLEAGUE, msgId: added.msgId });
  assert.equal(archived.archived, true);
  await journeys.unarchiveBoardMessage({ journeyId: j.journeyId, identity: OWNER, msgId: added.msgId });
  // ...and so can the journey's lead, even for someone else's message.
  const archivedByLead = await journeys.archiveBoardMessage({ journeyId: j.journeyId, identity: OWNER, msgId: added.msgId });
  assert.equal(archivedByLead.archived, true);
});

await test("board: a stranger cannot read or write it; frozen once the journey is completed", async () => {
  const j = await journeys.createJourney({ identity: OWNER, body: { title: "T", visibility: "private" } });
  await assert.rejects(
    journeys.addBoardMessage({ journeyId: j.journeyId, identity: COLLEAGUE, body: { content: "x" } }),
    (e) => e.status === 403,
  );
  await journeys.completeJourney({ journeyId: j.journeyId, identity: OWNER });
  await assert.rejects(
    journeys.addBoardMessage({ journeyId: j.journeyId, identity: OWNER, body: { content: "x" } }),
    (e) => e.status === 409 && e.code === "journey_completed",
  );
});

// --- documents -----------------------------------------------------------------

await test("documents: add/remove, member-writable, no edit exists, removed document stays visible but content unreachable via a fresh get", async () => {
  const j = await journeys.createJourney({ identity: OWNER, body: { title: "T", visibility: "public" } });
  const added = await journeys.addDocument({ journeyId: j.journeyId, identity: COLLEAGUE, body: { title: "Spec v1", content: "the actual spec text" } });
  assert.ok(added.docId);

  const got = await journeys.getDocument({ journeyId: j.journeyId, identity: OWNER, docId: added.docId });
  assert.equal(got.title, "Spec v1");
  assert.equal(got.sizeBytes, Buffer.byteLength("the actual spec text", "utf8"));

  const listed = await journeys.listDocuments({ journeyId: j.journeyId, identity: OWNER });
  assert.equal(listed.documents.length, 1);
  assert.equal((await journeys.getJourney({ journeyId: j.journeyId, identity: OWNER })).documentCount, 1);

  await journeys.removeDocument({ journeyId: j.journeyId, identity: OWNER, docId: added.docId });
  const afterRemove = await journeys.getDocument({ journeyId: j.journeyId, identity: OWNER, docId: added.docId });
  assert.equal(afterRemove.removed, true, "the record itself is never erased");
  assert.equal(afterRemove.content, "the actual spec text", "content is retained, just flagged — this is a soft delete, not a wipe");
  assert.equal((await journeys.getJourney({ journeyId: j.journeyId, identity: OWNER })).documentCount, 0);

  // Idempotent re-removal.
  const again = await journeys.removeDocument({ journeyId: j.journeyId, identity: OWNER, docId: added.docId });
  assert.equal(again.removed, true);
});

await test("documents: only the document's own poster or the journey's lead may remove it", async () => {
  const j = await journeys.createJourney({ identity: OWNER, body: { title: "T", visibility: "public" } });
  const added = await journeys.addDocument({ journeyId: j.journeyId, identity: COLLEAGUE, body: { title: "Spec v1", content: "text" } });
  await assert.rejects(
    journeys.removeDocument({ journeyId: j.journeyId, identity: "dave@example.com", docId: added.docId }),
    (e) => e.status === 403 && e.code === "not_document_owner_or_lead",
    "a same-tenant member who is neither the poster nor the lead cannot remove",
  );
  // The poster can remove their own document...
  const removed = await journeys.removeDocument({ journeyId: j.journeyId, identity: COLLEAGUE, docId: added.docId });
  assert.equal(removed.removed, true);

  const added2 = await journeys.addDocument({ journeyId: j.journeyId, identity: COLLEAGUE, body: { title: "Spec v2", content: "text" } });
  // ...and so can the journey's lead, even for someone else's document.
  const removedByLead = await journeys.removeDocument({ journeyId: j.journeyId, identity: OWNER, docId: added2.docId });
  assert.equal(removedByLead.removed, true);
});

await test("documents: unknown id is 404; a stranger cannot add one", async () => {
  const j = await journeys.createJourney({ identity: OWNER, body: { title: "T", visibility: "private" } });
  await assert.rejects(
    journeys.getDocument({ journeyId: j.journeyId, identity: OWNER, docId: "nope" }),
    (e) => e.status === 404 && e.code === "document_not_found",
  );
  await assert.rejects(
    journeys.addDocument({ journeyId: j.journeyId, identity: COLLEAGUE, body: { title: "t", content: "c" } }),
    (e) => e.status === 403,
  );
});

// --- aiCanPost (owner-only gate, no enforcement point yet) --------------------

await test("aiCanPost: owner-only to toggle, off by default", async () => {
  const j = await journeys.createJourney({ identity: OWNER, body: { title: "T", visibility: "public" } });
  assert.equal((await journeys.getJourney({ journeyId: j.journeyId, identity: OWNER })).aiCanPost, false);
  await assert.rejects(
    journeys.patchJourney({ journeyId: j.journeyId, identity: COLLEAGUE, body: { aiCanPost: true } }),
    (e) => e.status === 403,
  );
  const updated = await journeys.patchJourney({ journeyId: j.journeyId, identity: OWNER, body: { aiCanPost: true } });
  assert.equal(updated.aiCanPost, true);
});

// --- reports (docs 20 §6) -----------------------------------------------------

await test("requestReport: creates a pending row immediately, then reads back what the Gateway wrote", async () => {
  const j = await journeys.createJourney({ identity: OWNER, body: { title: "T", visibility: "public" } });
  const req = await journeys.requestReport({ journeyId: j.journeyId, identity: COLLEAGUE, body: { question: "Where are we on the redesign?" } });
  assert.equal(req.status, "pending");
  assert.ok(req.reportId);

  const call = internalCalls.find((c) => c.reportId === req.reportId);
  assert.ok(call, "rest-api awaited the internal call to the Gateway");
  assert.equal(call.question, "Where are we on the redesign?");

  const got = await journeys.getReport({ journeyId: j.journeyId, identity: OWNER, reportId: req.reportId });
  assert.equal(got.status, "ready", "the stub Gateway already wrote the finished row by the time requestReport returns");
  assert.ok(got.answer.includes("Where are we on the redesign?"));

  const listed = await journeys.listReports({ journeyId: j.journeyId, identity: OWNER });
  assert.equal(listed.reports.length, 1);

  assert.equal((await journeys.getJourney({ journeyId: j.journeyId, identity: OWNER })).reportCount, 1);
});

await test("requestReport: an unreachable Gateway leaves the report failed, not stuck pending forever", async () => {
  const j = await journeys.createJourney({ identity: OWNER, body: { title: "T", visibility: "public" } });
  internal.gatewayUnreachable = true;
  try {
    const req = await journeys.requestReport({ journeyId: j.journeyId, identity: OWNER, body: { question: "q" } });
    const got = await journeys.getReport({ journeyId: j.journeyId, identity: OWNER, reportId: req.reportId });
    assert.equal(got.status, "failed");
    assert.equal(got.error, "gateway_unreachable");
  } finally {
    internal.gatewayUnreachable = false;
  }
});

await test("reports: a stranger cannot request or read one; unknown id is 404", async () => {
  const j = await journeys.createJourney({ identity: OWNER, body: { title: "T", visibility: "private" } });
  await assert.rejects(
    journeys.requestReport({ journeyId: j.journeyId, identity: COLLEAGUE, body: { question: "q" } }),
    (e) => e.status === 403,
  );
  await assert.rejects(
    journeys.getReport({ journeyId: j.journeyId, identity: OWNER, reportId: "nope" }),
    (e) => e.status === 404 && e.code === "report_not_found",
  );
});

// --- contributor stats (docs 20 §10) -------------------------------------------

await test("contributors: reportRequestCount bumps on every ask, including ones the Gateway will fail", async () => {
  const j = await journeys.createJourney({ identity: OWNER, body: { title: "T", visibility: "public" } });
  await journeys.requestReport({ journeyId: j.journeyId, identity: COLLEAGUE, body: { question: "q1" } });
  await journeys.requestReport({ journeyId: j.journeyId, identity: COLLEAGUE, body: { question: "q2" } });
  const { contributors } = await journeys.listContributors({ journeyId: j.journeyId, identity: OWNER });
  const mine = contributors.find((c) => c.contributorIdentity === COLLEAGUE);
  assert.equal(mine.reportRequestCount, 2);
});

await test("contributors: kelaboJoinCount settles immediately when linking an already-ended kelabo", async () => {
  const j = await journeys.createJourney({ identity: OWNER, body: { title: "T", visibility: "public" } });
  await seedKelabo({ kelaboId: "k-ended", host: OWNER, status: "ended" });
  db.__putHistory({
    archiveId: "k-ended",
    kelaboId: "k-ended",
    host: OWNER,
    endedAt: Date.now(),
    participantIdentities: [OWNER, COLLEAGUE],
  });
  await journeys.linkKelabo({ journeyId: j.journeyId, identity: OWNER, kelaboId: "k-ended" });

  const { contributors } = await journeys.listContributors({ journeyId: j.journeyId, identity: OWNER });
  assert.equal(contributors.find((c) => c.contributorIdentity === OWNER).kelaboJoinCount, 1);
  assert.equal(contributors.find((c) => c.contributorIdentity === COLLEAGUE).kelaboJoinCount, 1);
});

await test("contributors: linking a still-live kelabo does not (yet) settle kelaboJoinCount", async () => {
  const j = await journeys.createJourney({ identity: OWNER, body: { title: "T", visibility: "public" } });
  await seedKelabo({ kelaboId: "k-live", host: OWNER, status: "active" });
  await journeys.linkKelabo({ journeyId: j.journeyId, identity: OWNER, kelaboId: "k-live" });
  const { contributors } = await journeys.listContributors({ journeyId: j.journeyId, identity: OWNER });
  assert.equal(contributors.length, 0, "documented gap: settles only at kelabo-end, not built in this pass");
});

// --- a handful of true HTTP-level checks, to prove index.js wiring ----------

await test("HTTP: POST /journeys requires a session", async () => {
  const res = await call("POST", "/journeys", { body: { title: "T" } });
  assert.equal(res.statusCode, 401);
});

await test("HTTP: create then get round-trips through the real route table", async () => {
  const cookies = await sessionFor("dana@example.com");
  const created = await call("POST", "/journeys", { body: { title: "HTTP journey", visibility: "public" }, cookies });
  assert.equal(created.statusCode, 200);
  assert.ok(created.json.journeyId);

  const got = await call("GET", `/journeys/${created.json.journeyId}`, { cookies });
  assert.equal(got.statusCode, 200);
  assert.equal(got.json.title, "HTTP journey");
  assert.equal(got.json.myRole, "owner");

  const notFound = await call("GET", "/journeys/does-not-exist", { cookies });
  assert.equal(notFound.statusCode, 404);
  assert.equal(notFound.json.error, "journey_not_found");
});

await test("HTTP: status update + history + timeline round-trip through the real route table", async () => {
  const cookies = await sessionFor("erin@example.com");
  const created = await call("POST", "/journeys", { body: { title: "Status via HTTP", visibility: "public" }, cookies });
  const id = created.json.journeyId;

  const posted = await call("POST", `/journeys/${id}/status`, { body: { health: "green", progress: 80 }, cookies });
  assert.equal(posted.statusCode, 200);
  assert.equal(posted.json.version, 1);

  const history = await call("GET", `/journeys/${id}/status/history`, { cookies });
  assert.equal(history.statusCode, 200);
  assert.equal(history.json.versions.length, 1);

  const timeline = await call("GET", `/journeys/${id}/timeline?type=status`, { cookies });
  assert.equal(timeline.statusCode, 200);
  assert.equal(timeline.json.entries.length, 1);
  assert.equal(timeline.json.entries[0].type, "status");
});

await test("HTTP: board message and document round-trip through the real route table", async () => {
  const cookies = await sessionFor("frank@example.com");
  const created = await call("POST", "/journeys", { body: { title: "Board+docs via HTTP", visibility: "public" }, cookies });
  const id = created.json.journeyId;

  const msg = await call("POST", `/journeys/${id}/board`, { body: { content: "hello" }, cookies });
  assert.equal(msg.statusCode, 200);
  const edited = await call("PATCH", `/journeys/${id}/board/${msg.json.msgId}`, { body: { content: "hello, edited" }, cookies });
  assert.equal(edited.statusCode, 200);
  assert.equal(edited.json.version, 2);
  const archived = await call("POST", `/journeys/${id}/board/${msg.json.msgId}/archive`, { cookies });
  assert.equal(archived.statusCode, 200);
  const unarchived = await call("POST", `/journeys/${id}/board/${msg.json.msgId}/unarchive`, { cookies });
  assert.equal(unarchived.statusCode, 200);

  const doc = await call("POST", `/journeys/${id}/documents`, { body: { title: "d", content: "text" }, cookies });
  assert.equal(doc.statusCode, 200);
  const gotDoc = await call("GET", `/journeys/${id}/documents/${doc.json.docId}`, { cookies });
  assert.equal(gotDoc.statusCode, 200);
  assert.equal(gotDoc.json.title, "d");
});

await test("HTTP: report request + contributors round-trip through the real route table", async () => {
  const cookies = await sessionFor("gina@example.com");
  const created = await call("POST", "/journeys", { body: { title: "Reports via HTTP", visibility: "public" }, cookies });
  const id = created.json.journeyId;

  const req = await call("POST", `/journeys/${id}/reports`, { body: { question: "Any blockers?" }, cookies });
  assert.equal(req.statusCode, 200);
  assert.equal(req.json.status, "pending");

  const got = await call("GET", `/journeys/${id}/reports/${req.json.reportId}`, { cookies });
  assert.equal(got.statusCode, 200);
  assert.equal(got.json.status, "ready");

  const contributors = await call("GET", `/journeys/${id}/contributors`, { cookies });
  assert.equal(contributors.statusCode, 200);
  assert.equal(contributors.json.contributors[0].reportRequestCount, 1);
});

console.log(`\n${passed} passed`);
