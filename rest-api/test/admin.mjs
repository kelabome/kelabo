// Deployment administration: who may publish operational config, and what
// publishing does.
//
// This is the one module on master where a mistake is an access-control
// mistake rather than a wrong answer, so the tests are about refusals as much
// as about behaviour. Three properties carry the whole design and each has a
// test that fails loudly if it stops holding:
//
//   1. **It fails closed.** No root configured, an unreadable roster, an
//      unknown caller — every one of those resolves to "no", never to "yes".
//   2. **Root is not grantable.** A granted administrator who could grant would
//      be root after one hop, and one who could revoke could remove the
//      operator and then the record of having done so.
//   3. **Publishing appends.** A version is never edited, never deleted, and
//      two administrators publishing at the same instant cannot silently
//      overwrite one another.
import assert from "node:assert/strict";
import { createAdmin } from "../src/admin.js";
import { createOpConfig } from "../src/opconfig.js";
import { ADMIN_PK, OPCONFIG_PK } from "@kelabo/contracts/opconfig";
import { CREDENTIAL_SLOTS, credentialFieldKeys } from "@kelabo/contracts/credentials";

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
  } catch (err) {
    console.error(`FAIL ${name}`);
    throw err;
  }
}

/**
 * An in-memory stand-in for the config table's two partitions, with the same
 * conditional-put behaviour the real one has — that condition is the whole of
 * "append-only", so a stub without it would make the property untestable.
 */
function makeDb({ admins = [], versions = [], failRoster = false, hidden = [] } = {}) {
  const rows = new Map();
  // Versions that exist for the conditional write but are invisible to the
  // list. That is exactly what a concurrent publisher looks like from inside
  // one container: it read the partition before the other write landed, and
  // meets it only when it tries to claim the same key.
  const invisible = new Set(hidden);
  for (const a of admins) rows.set(`${ADMIN_PK}|${a.email}`, { PK: ADMIN_PK, SK: a.email, ...a });
  for (const v of versions) rows.set(`${OPCONFIG_PK}|${v.SK}`, { PK: OPCONFIG_PK, ...v });
  return {
    rows,
    async listAdmins() {
      if (failRoster) throw new Error("dynamo is down");
      return [...rows.values()].filter((r) => r.PK === ADMIN_PK);
    },
    async listOpConfigs() {
      return [...rows.values()].filter((r) => r.PK === OPCONFIG_PK && !invisible.has(r.SK));
    },
    async putOpConfig(item) {
      const key = `${OPCONFIG_PK}|${item.SK}`;
      if (rows.has(key)) {
        const e = new Error("The conditional request failed");
        e.name = "ConditionalCheckFailedException";
        throw e;
      }
      rows.set(key, item);
    },
    async putAdmin({ email, grantedBy, at }) {
      rows.set(`${ADMIN_PK}|${email}`, { PK: ADMIN_PK, SK: email, grantedBy, at });
    },
    async deleteAdmin(email) {
      rows.delete(`${ADMIN_PK}|${email}`);
    },
  };
}

const CONFIG = {
  rootAdminEmail: "root@example.com",
  llm: { provider: "anthropic", model: "claude-x" },
  mail: { provider: "mailersend", fromAddress: "no-reply@example.com" },
  allowedEmailDomain: "example.com",
};

function build({ config = CONFIG, db = makeDb(), internal, credentials, log, ttlMs = 0 } = {}) {
  // ttlMs 0 so a read always hits the stub: these tests are about what is
  // stored, not about the cache, which contracts/test/opconfig.mjs covers.
  const opConfig = createOpConfig({ config, db, ttlMs });
  const admin = createAdmin({ config, db, opConfig, credentials, internal, log });
  return { admin, opConfig, db, credentials };
}

// --- failing closed ---------------------------------------------------------

await test("with no root configured, nobody is an administrator", async () => {
  // The safe direction, and the one a config typo lands in. The alternative to
  // a mistyped address must never be an open console.
  const { admin } = build({ config: { ...CONFIG, rootAdminEmail: "" } });
  assert.equal(await admin.isAdmin("root@example.com"), false);
  assert.equal(await admin.isAdmin(""), false);
  await assert.rejects(() => admin.requireAdmin("anyone@example.com"), (e) => e.status === 403);
  // And nobody can grant their way in, either.
  await assert.rejects(
    () => admin.grantAdmin({ identity: "root@example.com", body: { email: "x@example.com" } }),
    (e) => e.status === 403,
  );
});

await test("an unreadable roster means not-an-admin, not an admin", async () => {
  // "We could not check" has to resolve to "no". Root still works, because
  // root does not need the table at all — which is also what keeps a
  // deployment recoverable when the table is unreachable.
  const { admin } = build({ db: makeDb({ failRoster: true }) });
  assert.equal(await admin.isAdmin("granted@example.com"), false);
  assert.equal(await admin.isAdmin("root@example.com"), true);
});

await test("root, a granted row, and a stranger", async () => {
  const { admin } = build({ db: makeDb({ admins: [{ email: "ops@example.com", grantedBy: "root@example.com" }] }) });
  assert.equal(await admin.isAdmin("root@example.com"), true);
  assert.equal(await admin.isAdmin("ops@example.com"), true);
  assert.equal(await admin.isAdmin("someone@example.com"), false);
  // Case and padding are normalised on both sides of the comparison; a capital
  // letter typed into config or into a grant form must not match nobody.
  assert.equal(await admin.isAdmin("  Root@Example.com "), true);
  assert.equal(await admin.isAdmin("OPS@EXAMPLE.COM"), true);
});

await test("whoami answers a non-admin instead of refusing them", async () => {
  // It is what the app asks on load to decide whether to show a menu entry. A
  // 403 here would be a 403 on every page load for every ordinary user.
  const { admin } = build();
  assert.deepEqual(await admin.whoami("nobody@example.com"), {
    admin: false,
    root: false,
    rootConfigured: true,
  });
  assert.deepEqual(await admin.whoami("root@example.com"), { admin: true, root: true, rootConfigured: true });
});

// --- the roster is root's alone ---------------------------------------------

await test("a granted admin may publish but may not change who else can", async () => {
  const { admin } = build({ db: makeDb({ admins: [{ email: "ops@example.com" }] }) });
  // They are an administrator...
  assert.equal(await admin.requireAdmin("ops@example.com"), "ops@example.com");
  // ...and that is where it stops. Otherwise one hop makes them root.
  await assert.rejects(
    () => admin.grantAdmin({ identity: "ops@example.com", body: { email: "friend@example.com" } }),
    (e) => e.status === 403,
  );
  await assert.rejects(
    () => admin.revokeAdmin({ identity: "ops@example.com", email: "ops@example.com" }),
    (e) => e.status === 403,
  );
  await assert.rejects(() => admin.listAdmins({ identity: "ops@example.com" }), (e) => e.status === 403);
});

await test("root grants and revokes; root itself is neither grantable nor revocable", async () => {
  const { admin, db } = build();
  await admin.grantAdmin({ identity: "root@example.com", body: { email: "  Ops@Example.com " } });
  const roster = await admin.listAdmins({ identity: "root@example.com" });
  assert.equal(roster.root, "root@example.com");
  assert.deepEqual(roster.admins.map((a) => a.email), ["ops@example.com"]);
  assert.equal(roster.admins[0].grantedBy, "root@example.com");

  // Root is root by deployment. A row for it would be a removable record of an
  // identity that cannot be removed, and a console offering to revoke it would
  // be lying.
  await assert.rejects(
    () => admin.grantAdmin({ identity: "root@example.com", body: { email: "root@example.com" } }),
    (e) => e.code === "already_root",
  );
  await assert.rejects(
    () => admin.revokeAdmin({ identity: "root@example.com", email: "root@example.com" }),
    (e) => e.code === "cannot_revoke_root",
  );

  await admin.revokeAdmin({ identity: "root@example.com", email: "ops@example.com" });
  assert.equal(db.rows.has(`${ADMIN_PK}|ops@example.com`), false);
});

await test("a grant needs something that is actually an address", async () => {
  const { admin } = build();
  await assert.rejects(
    () => admin.grantAdmin({ identity: "root@example.com", body: { email: "not-an-email" } }),
    (e) => e.code === "bad_email",
  );
  await assert.rejects(
    () => admin.grantAdmin({ identity: "root@example.com", body: {} }),
    (e) => e.code === "bad_email",
  );
});

// --- publishing -------------------------------------------------------------

await test("a non-admin can neither read nor publish configuration", async () => {
  const { admin } = build();
  await assert.rejects(() => admin.getConfig({ identity: "nobody@example.com" }), (e) => e.status === 403);
  await assert.rejects(
    () => admin.publishConfig({ identity: "nobody@example.com", body: { note: "n", config: {} } }),
    (e) => e.status === 403,
  );
});

await test("a publish without a note is refused", async () => {
  // A version chain of blank notes is an audit record that answers nothing.
  const { admin } = build();
  await assert.rejects(
    () => admin.publishConfig({ identity: "root@example.com", body: { config: {} } }),
    (e) => e.code === "note_required",
  );
  await assert.rejects(
    () => admin.publishConfig({ identity: "root@example.com", body: { note: "   ", config: {} } }),
    (e) => e.code === "note_required",
  );
});

await test("an invalid document is refused before the table is touched", async () => {
  // A rejected publish must leave the deployment exactly as it was: a
  // half-written version chain is not something an append-only design repairs.
  const { admin, db } = build();
  await assert.rejects(
    () =>
      admin.publishConfig({
        identity: "root@example.com",
        body: { note: "nonsense", config: { agent: { cooldownSeconds: "soon" } } },
      }),
    (e) => e.code === "invalid_config",
  );
  assert.equal([...db.rows.values()].filter((r) => r.PK === OPCONFIG_PK).length, 0);
});

await test("publishing appends a version and attributes it", async () => {
  const { admin, db } = build();
  const first = await admin.publishConfig({
    identity: "root@example.com",
    body: { note: "switch to deepseek", config: { llm: { provider: "deepseek", model: "deepseek-v4" } } },
  });
  assert.equal(first.version, 2, "the seeded default is v1, so the first published version is v2");
  assert.equal(first.publishedBy, "root@example.com");

  const second = await admin.publishConfig({
    identity: "root@example.com",
    body: { note: "slow it down", config: { agent: { cooldownSeconds: 90 } } },
  });
  assert.equal(second.version, 3);

  // Both are still there. Nothing is edited and nothing is removed — rolling
  // back is publishing the old value again, which records that act too.
  const stored = [...db.rows.values()].filter((r) => r.PK === OPCONFIG_PK);
  assert.equal(stored.length, 2);
  assert.deepEqual(stored.map((r) => r.SK).sort(), ["V#000002", "V#000003"]);

  const view = await admin.getConfig({ identity: "root@example.com" });
  assert.deepEqual(view.versions.map((v) => v.version), [3, 2], "newest first");
  assert.equal(view.versions[0].note, "slow it down");
});

await test("two administrators publishing at once: the loser is told, not overwritten", async () => {
  // The conditional write is what makes append-only true in fact rather than by
  // convention. Both containers read the partition, both computed the same next
  // version, both write. Without the condition the second would replace the
  // first, losing a change AND the record of who made it.
  //
  // `hidden` is the honest simulation: v2 is in the table (the other publisher
  // already wrote it) but not in what this container's read returned, so this
  // container computes v2 as the next version and collides on the write.
  const db = makeDb({
    versions: [{ SK: "V#000002", version: 2, effectiveFrom: 1, note: "theirs" }],
    hidden: ["V#000002"],
  });
  const { admin } = build({ db });
  await assert.rejects(
    () => admin.publishConfig({ identity: "root@example.com", body: { note: "mine", config: {} } }),
    (e) => e.status === 409 && e.code === "version_conflict",
  );
  assert.equal(db.rows.get(`${OPCONFIG_PK}|V#000002`).note, "theirs", "the other publisher's version survived");
});

await test("a published value is in effect immediately for this container", async () => {
  // Without the invalidate the operator would stare at the old value for up to
  // a minute after saving, which is indistinguishable from a failed save.
  const { admin, opConfig } = build({ ttlMs: 60_000 });
  assert.equal((await opConfig.resolved()).llm.provider, "anthropic", "the deployment's own value, to begin with");
  await admin.publishConfig({
    identity: "root@example.com",
    body: { note: "switch", config: { llm: { provider: "deepseek" } } },
  });
  assert.equal((await opConfig.resolved()).llm.provider, "deepseek");
  // And an untouched field still comes from the deployment.
  assert.equal((await opConfig.resolved()).llm.model, "claude-x");
});

await test("the console is shown published, fallback and effective — not just effective", async () => {
  // "Effective" alone cannot be edited safely: an operator seeing `mailersend`
  // has no way to tell whether they published it or whether it is the
  // deployment's default showing through.
  const { admin } = build();
  await admin.publishConfig({
    identity: "root@example.com",
    body: { note: "pin the model", config: { llm: { model: "deepseek-v4" } } },
  });
  const view = await admin.getConfig({ identity: "root@example.com" });
  assert.equal(view.published.llm.model, "deepseek-v4");
  assert.equal(view.published.llm.provider, "", "unpublished, and visibly so");
  assert.equal(view.effective.llm.provider, "anthropic", "the deployment's own value shows through");
  assert.equal(view.effective.llm.model, "deepseek-v4");
});

// --- the reload is best-effort ----------------------------------------------

await test("publishing asks the gateway to reload, and reports whether it did", async () => {
  const calls = [];
  const { admin } = build({ internal: { reloadConfig: async (by) => calls.push(by) } });
  const res = await admin.publishConfig({
    identity: "root@example.com",
    body: { note: "n", config: { llm: { provider: "deepseek" } } },
  });
  assert.deepEqual(calls, ["root@example.com"]);
  assert.equal(res.gatewayReloaded, true);
});

await test("a gateway that cannot be reached does not fail the publish", async () => {
  // The publish is already durable at this point, and the gateway converges on
  // its own within the cache TTL. Reporting an error for a change that WAS
  // saved is the worse failure: the operator publishes again, or worse, gives
  // up and edits the task definition.
  const db = makeDb();
  const { admin } = build({
    db,
    internal: {
      reloadConfig: async () => {
        throw new Error("connection refused");
      },
    },
  });
  const res = await admin.publishConfig({ identity: "root@example.com", body: { note: "n", config: {} } });
  assert.equal(res.version, 2);
  // Reported, not swallowed — so the console can say "the gateway will pick
  // this up within a minute" rather than implying it is already live.
  assert.equal(res.gatewayReloaded, false);
  assert.equal([...db.rows.values()].filter((r) => r.PK === OPCONFIG_PK).length, 1, "the version was still written");
});

await test("a deployment with no gateway wired still publishes", async () => {
  const { admin } = build({ internal: undefined });
  const res = await admin.publishConfig({ identity: "root@example.com", body: { note: "n", config: {} } });
  assert.equal(res.gatewayReloaded, false);
});

// --- supplier credentials ---------------------------------------------------

/** An in-memory credentials store with the module's real merge/status semantics. */
function makeCredentials(initial = {}) {
  const rows = new Map(Object.entries(initial).map(([slot, v]) => [slot, { ...v }]));
  const versions = new Map();
  return {
    rows,
    async get(slot) {
      return rows.has(slot) ? { ...rows.get(slot) } : null;
    },
    async put(slot, value, { by } = {}) {
      rows.set(slot, { ...value });
      const version = (versions.get(slot) ?? 0) + 1;
      versions.set(slot, version);
      return { slot, configured: true, version, rotatedBy: by, rotatedAt: 1, fields: {}, unknown: [] };
    },
    async describeAllFull() {
      return [...CREDENTIAL_SLOTS].map((slot) => ({
        slot,
        configured: rows.has(slot),
        version: versions.get(slot) ?? (rows.has(slot) ? 1 : 0),
        rotatedAt: null,
        rotatedBy: "",
        fields: Object.fromEntries(credentialFieldKeys(slot).map((k) => [k, !!rows.get(slot)?.[k]])),
        unknown: [],
      }));
    },
  };
}

await test("the real credentials module exposes everything admin.js calls on it", async () => {
  // The bug this exists for shipped: `describeFull`/`describeAllFull` were
  // written in `credentials.js` and never added to its `return`, so the
  // deployed console answered 500 with `describeAllFull is not a function` —
  // while every test here passed, because they run against a STUB that happened
  // to have the method the real module lacked.
  //
  // A stub is the right seam and is not going away; what was missing is anything
  // checking that it still resembles the thing it stands in for. So this reads
  // both: every `credentials.X` in admin.js must exist on the real module's
  // return, built for real against a stub db. It costs nothing and closes the
  // one gap a hand-written double always has.
  const { readFileSync } = await import("node:fs");
  const { createCredentials } = await import("../src/credentials.js");

  const real = createCredentials({
    db: { getCredential: async () => null, getCredentialStatus: async () => null, putCredential: async () => {} },
  });

  const src = readFileSync(new URL("../src/admin.js", import.meta.url), "utf8");
  const code = src.split("\n").filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join("\n");
  const called = [...code.matchAll(/\bcredentials\.(\w+)\s*\(/g)].map((m) => m[1]);
  assert.ok(called.length, "found no credentials calls in admin.js — this checker has gone blind");

  for (const name of new Set(called)) {
    assert.equal(typeof real[name], "function", `admin.js calls credentials.${name}(), which the real module does not export`);
  }

  // And the stub used by the tests below must cover the same set, or a test
  // passing here says nothing about production.
  const stub = makeCredentials();
  for (const name of new Set(called)) {
    assert.equal(typeof stub[name], "function", `the test stub is missing credentials.${name}() — it no longer stands in for the real module`);
  }
});

await test("a non-admin cannot read or write supplier keys", async () => {
  const credentials = makeCredentials();
  const { admin } = build({ credentials });
  await assert.rejects(() => admin.listCredentials({ identity: "nobody@example.com" }), (e) => e.status === 403);
  await assert.rejects(
    () => admin.saveCredential({ identity: "nobody@example.com", slot: "llm", body: { fields: { apiKey: "sk-x" } } }),
    (e) => e.status === 403,
  );
});

await test("the console is told what each slot takes, and whether it is filled — never the value", async () => {
  const credentials = makeCredentials({ llm: { apiKey: "sk-secret" } });
  const { admin } = build({ credentials });
  const { slots } = await admin.listCredentials({ identity: "root@example.com" });

  // Every slot this build supports, with its field descriptors from contracts —
  // so adding a supplier grows the form rather than needing a client change.
  assert.deepEqual(slots.map((s) => s.slot), [...CREDENTIAL_SLOTS]);
  const llm = slots.find((s) => s.slot === "llm");
  assert.equal(llm.configured, true);
  assert.equal(llm.fields.apiKey, true, "per-field state, so the console cannot claim a filled slot is empty");
  assert.ok(llm.spec.some((f) => f.key === "apiKey" && f.required));

  // The thing that must never appear. Checked over the whole serialised
  // response rather than field by field: a value could leak through any key
  // somebody adds later, and this catches that without being told where.
  assert.ok(!JSON.stringify(slots).includes("sk-secret"), "a credential value reached the console");
});

await test("saving one field of a slot leaves the others alone", async () => {
  // THE bug this merge exists to prevent. `stt` holds one key per engine; a
  // replacing write would delete the Deepgram key the moment anyone rotated the
  // Soniox one — silently, with the console reporting success, and
  // transcription failing on the next kelabo that used the other engine.
  const credentials = makeCredentials({ stt: { deepgram: "dg-old", soniox: "sx-old" } });
  const { admin } = build({ credentials });
  await admin.saveCredential({ identity: "root@example.com", slot: "stt", body: { fields: { soniox: "sx-new" } } });
  assert.deepEqual(credentials.rows.get("stt"), { deepgram: "dg-old", soniox: "sx-new" });
});

await test("an empty box means leave it alone, not blank it", async () => {
  // The form submits every field it renders, including the ones nobody typed
  // into. If empty meant "set to empty", opening the page and saving would
  // erase every key in the slot.
  const credentials = makeCredentials({ rtc: { sfuAppId: "app", sfuAppSecret: "sec" } });
  const { admin } = build({ credentials });
  await admin.saveCredential({
    identity: "root@example.com",
    slot: "rtc",
    body: { fields: { sfuAppId: "", sfuAppSecret: "", turnKeyId: "turn-1" } },
  });
  assert.deepEqual(credentials.rows.get("rtc"), { sfuAppId: "app", sfuAppSecret: "sec", turnKeyId: "turn-1" });
});

await test("a required field is judged against the merged slot, not the submission", async () => {
  // Rotating the optional half of a slot is not a failure to supply the
  // required half — that was supplied last week.
  const credentials = makeCredentials({ rtc: { sfuAppId: "app", sfuAppSecret: "sec" } });
  const { admin } = build({ credentials });
  await admin.saveCredential({ identity: "root@example.com", slot: "rtc", body: { fields: { turnKeyId: "t" } } });
  assert.equal(credentials.rows.get("rtc").turnKeyId, "t");

  // But a slot that has never been filled still has to be filled completely.
  const empty = makeCredentials();
  const fresh = build({ credentials: empty }).admin;
  await assert.rejects(
    () => fresh.saveCredential({ identity: "root@example.com", slot: "rtc", body: { fields: { turnKeyId: "t" } } }),
    (e) => e.code === "missing_field",
  );
  assert.equal(empty.rows.has("rtc"), false, "a refused save must not half-write the slot");
});

await test("a field the slot does not define is refused, not stored", async () => {
  // A typo'd key that persisted would read as configured while the supplier
  // refused every call, with nothing on the page to explain it.
  const credentials = makeCredentials();
  const { admin } = build({ credentials });
  await assert.rejects(
    () => admin.saveCredential({ identity: "root@example.com", slot: "llm", body: { fields: { apiKeyy: "sk-x" } } }),
    (e) => e.code === "unknown_field",
  );
  await assert.rejects(
    () => admin.saveCredential({ identity: "root@example.com", slot: "nope", body: { fields: {} } }),
    (e) => e.status === 404,
  );
  await assert.rejects(
    () => admin.saveCredential({ identity: "root@example.com", slot: "llm", body: { fields: {} } }),
    (e) => e.code === "no_fields",
  );
  assert.equal(credentials.rows.size, 0);
});

await test("a rotation is logged by field name, never by value", async () => {
  const lines = [];
  const credentials = makeCredentials();
  const { admin } = build({ credentials, log: (level, msg, extra) => lines.push({ level, msg, extra }) });
  await admin.saveCredential({
    identity: "root@example.com",
    slot: "llm",
    body: { fields: { apiKey: "sk-super-secret" } },
  });
  const entry = lines.find((l) => l.msg === "credential_rotated");
  assert.ok(entry, "a credential rotation must leave a record naming who did it");
  assert.equal(entry.extra.by, "root@example.com");
  assert.deepEqual(entry.extra.fields, ["apiKey"]);
  assert.ok(!JSON.stringify(lines).includes("sk-super-secret"), "a credential value reached the log");
});

await test("there is no route that returns a credential value", async () => {
  // The application-level limit that replaced the IAM attribute fence, and the
  // reason a stolen admin session can break this deployment without
  // exfiltrating the supplier keys it runs on. `credentials.getRaw` exists —
  // this asserts nothing in admin.js reaches for it.
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../src/admin.js", import.meta.url), "utf8");
  const code = src
    .split("\n")
    .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
    .join("\n");
  assert.ok(!/getRaw/.test(code), "admin.js reads a raw credential — there must be no reveal path");
});

// --- no dead knobs ----------------------------------------------------------

await test("every field the console publishes is one a consumer actually reads", async () => {
  // The failure this prevents is quiet and demoralising: the console renders a
  // field, the operator changes it, saves, and nothing happens — with no error
  // anywhere, because the value was published perfectly and simply nobody reads
  // it. That is strictly worse than the field not existing.
  //
  // Checked as text rather than by calling anything, because the defect is a
  // consumer that still reads `config.X` instead of the resolved value: it
  // cannot be observed from outside, only from the source. Each entry names a
  // published group and the module that must have stopped reading `config`
  // directly for it.
  const { readFileSync } = await import("node:fs");
  const src = (f) => readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8");

  const wired = [
    ["otp.js", /config\.otp\b/, "otp limits"],
    ["otp.js", /config\.allowedEmailDomain\b/, "the sign-in domain"],
    ["oidc.js", /config\.allowedEmailDomain\b/, "the sign-in domain, on the social path"],
    ["joinCode.js", /config\.joinCode\.\w/, "join-code limits"],
    ["sessions.js", /config\.auth\.\w/, "session lifetimes"],
    ["agent.js", /config\.auth\.\w/, "the agent token lifetime"],
    ["join.js", /config\.auth\.\w/, "the guest participant lifetime"],
    ["join.js", /config\.rtc\.\w/, "the conference default"],
    ["kelabos.js", /config\.rtc\.\w/, "conference defaults"],
    ["kelabos.js", /config\.retentionDays\b/, "retention"],
    ["scheduling.js", /config\.rtc\.\w/, "the conference default"],
    ["scheduling.js", /config\.retentionDays\b/, "retention"],
    ["contacts.js", /config\.contacts\?\.external/, "external contacts"],
    ["stt/index.js", /config\.stt\.\w/, "the transcription engine"],
  ];

  for (const [file, direct, what] of wired) {
    const text = src(file);
    // The fallback expression is allowed and expected — it is what keeps a
    // deployment with no config table working — so only *uses* outside it
    // count. Every wired module resolves through a local helper first.
    const offending = text
      .split("\n")
      .filter((line) => direct.test(line) && !/opConfig \? /.test(line) && !/^\s*(\*|\/\/)/.test(line));
    assert.equal(
      offending.length,
      0,
      `${file} still reads ${what} straight off config — publishing it would do nothing:\n  ${offending.join("\n  ")}`,
    );
  }
});

console.log(`rest-api/admin: ${passed} passed`);
