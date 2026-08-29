// Operational configuration, published from /admin instead of deployed.
//
// What is worth testing here is not the schema — it is mostly optional fields —
// but the fold. `resolveOpConfig` is the single place that decides whether a
// running deployment uses the value someone just published or the one baked
// into its task definition, and every interesting failure mode is a value that
// looks unset but is not: `0` for "unlimited", `false` for "audio only", `[]`
// for "no social sign-in". A falsiness check passes every other test in this
// file and silently discards all three.
import assert from "node:assert/strict";
import {
  ADMIN_PK,
  DEFAULT_OPCONFIG,
  OPCONFIG_PK,
  adminSk,
  opConfigItem,
  opConfigSchema,
  opConfigSk,
  opConfigVersionFromSk,
  parseOpConfig,
  pickOpConfig,
  resolveOpConfig,
  createOpConfigCache,
} from "../src/opconfig.js";

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

// A deployment's own config, in the shape the two services actually hold it.
const BOOTSTRAP = {
  llm: { provider: "anthropic", model: "claude-x", smallModel: "claude-s", baseUrl: "https://api.anthropic.com" },
  stt: { provider: "deepgram", language: "en", providers: { deepgram: { model: "nova" }, soniox: { model: "stt-rt" } } },
  mail: { provider: "mailersend", fromAddress: "no-reply@example.com" },
  gateway: { agent: { maxConcurrentRuns: 4, sensitivity: "low", turnDeadlineSeconds: 180 } },
  rtc: { defaultMode: "sfu", meshMaxParticipants: 5, video: true },
  otp: { ttlSeconds: 600, maxAttempts: 5 },
  joinCode: { ttlSeconds: 120 },
  auth: { sessionTtlSeconds: 3600, socialProviders: ["google"] },
  allowedEmailDomain: "example.com",
  contacts: { external: true },
  retentionDays: 30,
};

const publish = (fields) => opConfigSchema.parse({ version: 2, effectiveFrom: 0, ...fields });

// --- addressing -------------------------------------------------------------

await test("versions sort by sort key, and the key is authoritative", () => {
  assert.equal(opConfigSk(1), "V#000001");
  assert.equal(opConfigSk(42), "V#000042");
  // Padded so a string sort is a version sort: without it V#10 precedes V#9.
  assert.ok(opConfigSk(9) < opConfigSk(10));
  assert.equal(opConfigVersionFromSk("V#000042"), 42);
  assert.ok(Number.isNaN(opConfigVersionFromSk("META")));

  // A row whose `version` attribute drifted from its key is read by its key.
  const drifted = parseOpConfig({ PK: OPCONFIG_PK, SK: "V#000007", version: 3, effectiveFrom: 0 });
  assert.equal(drifted.version, 7);
});

await test("the config and the roster are separate partitions of one table", () => {
  assert.equal(OPCONFIG_PK, "OPCONFIG");
  assert.equal(ADMIN_PK, "ADMIN");
  assert.notEqual(OPCONFIG_PK, ADMIN_PK);
  // Lower-cased once, here, because every comparison downstream lower-cases the
  // caller's identity — a capital in a grant form would match nobody.
  assert.equal(adminSk("  Root@Example.COM "), "root@example.com");
});

await test("a stored item carries its keys and validates on the way back", () => {
  const item = opConfigItem({ version: 3, effectiveFrom: 1000, publishedBy: "a@b.c", note: "why" });
  assert.equal(item.PK, OPCONFIG_PK);
  assert.equal(item.SK, "V#000003");
  const back = parseOpConfig(item);
  assert.equal(back.version, 3);
  assert.equal(back.publishedBy, "a@b.c");
  assert.equal(back.note, "why");
});

await test("the seeded default is publishable-shaped and sets nothing", () => {
  // It has to be constructable without an author or a note: the seeded version
  // has nobody to attribute and no change to explain.
  assert.equal(DEFAULT_OPCONFIG.publishedBy, "");
  assert.equal(DEFAULT_OPCONFIG.llm.provider, "");
  assert.equal(DEFAULT_OPCONFIG.agent.maxConcurrentRuns, null);
  assert.equal(DEFAULT_OPCONFIG.rtc.video, null);
  assert.equal(DEFAULT_OPCONFIG.auth.socialProviders, null);
  assert.equal(DEFAULT_OPCONFIG.retentionDays, null);
});

// --- the fold ---------------------------------------------------------------

await test("nothing published means the deployment behaves exactly as before", () => {
  // The property that makes this safe to ship: an existing deployment upgrading
  // into op-config changes nothing at all until someone publishes.
  const r = resolveOpConfig(BOOTSTRAP, DEFAULT_OPCONFIG);
  assert.equal(r.llm.provider, "anthropic");
  assert.equal(r.llm.model, "claude-x");
  assert.equal(r.stt.provider, "deepgram");
  assert.equal(r.mail.provider, "mailersend");
  assert.equal(r.agent.maxConcurrentRuns, 4);
  assert.equal(r.agent.sensitivity, "low");
  assert.equal(r.rtc.video, true);
  assert.equal(r.otp.ttlSeconds, 600);
  assert.equal(r.auth.sessionTtlSeconds, 3600);
  assert.deepEqual(r.auth.socialProviders, ["google"]);
  assert.equal(r.org.allowedEmailDomain, "example.com");
  assert.equal(r.contacts.external, true);
  assert.equal(r.retentionDays, 30);
});

await test("a published value wins, field by field and not all at once", () => {
  const r = resolveOpConfig(BOOTSTRAP, publish({ llm: { provider: "deepseek", model: "deepseek-v4" } }));
  assert.equal(r.llm.provider, "deepseek");
  assert.equal(r.llm.model, "deepseek-v4");
  // Untouched fields of the same group still come from the deployment.
  assert.equal(r.llm.smallModel, "claude-s");
  assert.equal(r.llm.baseUrl, "https://api.anthropic.com");
  // And an untouched group is wholly the deployment's.
  assert.equal(r.mail.provider, "mailersend");
});

await test("0 is a published value, not an empty one", () => {
  // THE bug this fold exists to avoid. `maxConcurrentRuns: 0` means unlimited
  // and `turnDeadlineSeconds: 0` means no deadline; a falsiness check would
  // throw both away and restore the deployment's 4 and 180 — the exact
  // opposite of what the operator just asked for, with nothing in any log.
  const r = resolveOpConfig(BOOTSTRAP, publish({ agent: { maxConcurrentRuns: 0, turnDeadlineSeconds: 0 } }));
  assert.equal(r.agent.maxConcurrentRuns, 0);
  assert.equal(r.agent.turnDeadlineSeconds, 0);
});

await test("false is a published value, not an empty one", () => {
  // Same bug, boolean shape: publishing "audio only" over a video deployment.
  const r = resolveOpConfig(BOOTSTRAP, publish({ rtc: { video: false }, contacts: { external: false } }));
  assert.equal(r.rtc.video, false);
  assert.equal(r.contacts.external, false);
});

await test("an empty list turns social sign-in off; not publishing one leaves it", () => {
  // `[]` has to be distinguishable from "not set", which is why the field is
  // nullable rather than defaulting to an empty array.
  const off = resolveOpConfig(BOOTSTRAP, publish({ auth: { socialProviders: [] } }));
  assert.deepEqual(off.auth.socialProviders, []);
  const untouched = resolveOpConfig(BOOTSTRAP, publish({ auth: { sessionTtlSeconds: 60 } }));
  assert.deepEqual(untouched.auth.socialProviders, ["google"]);
  assert.equal(untouched.auth.sessionTtlSeconds, 60);
});

await test("an empty string means unset, never set-to-empty", () => {
  // A cleared text box in the console must not point the deployment at a
  // provider named "" — it must hand the field back to the deployment.
  const r = resolveOpConfig(BOOTSTRAP, publish({ llm: { provider: "", model: "" }, mail: { fromAddress: "" } }));
  assert.equal(r.llm.provider, "anthropic");
  assert.equal(r.llm.model, "claude-x");
  assert.equal(r.mail.fromAddress, "no-reply@example.com");
});

await test("clearing the sign-in domain cannot open the deployment", () => {
  // The dangerous direction is deliberately not reachable by emptying a field:
  // publishing "" falls back to the configured domain rather than admitting
  // every address on the internet.
  const r = resolveOpConfig(BOOTSTRAP, publish({ org: { allowedEmailDomain: "" } }));
  assert.equal(r.org.allowedEmailDomain, "example.com");
  const widened = resolveOpConfig(BOOTSTRAP, publish({ org: { allowedEmailDomain: "other.com" } }));
  assert.equal(widened.org.allowedEmailDomain, "other.com");
});

await test("per-provider STT settings merge rather than replace", () => {
  // Publishing a block for one engine must not silently drop the settings of
  // another the deployment still dispatches to.
  const r = resolveOpConfig(BOOTSTRAP, publish({ stt: { settings: { soniox: { model: "stt-rt-preview" } } } }));
  assert.deepEqual(r.stt.settings.soniox, { model: "stt-rt-preview" });
  assert.deepEqual(r.stt.settings.deepgram, { model: "nova" });
});

await test("the gateway's nested agent knobs and a flat one both fall back", () => {
  // The gateway holds these at `gateway.agent`, everything else at `agent`.
  // Both are accepted so neither service has to rename its config to adopt this.
  const flat = resolveOpConfig({ agent: { cooldownSeconds: 5 } }, DEFAULT_OPCONFIG);
  assert.equal(flat.agent.cooldownSeconds, 5);
  const nested = resolveOpConfig({ gateway: { agent: { cooldownSeconds: 7 } } }, DEFAULT_OPCONFIG);
  assert.equal(nested.agent.cooldownSeconds, 7);
});

await test("an empty deployment config still resolves to working defaults", () => {
  // A local run with nothing configured must not produce undefined knobs.
  const r = resolveOpConfig({}, DEFAULT_OPCONFIG);
  assert.equal(r.mail.provider, "ses");
  assert.equal(r.stt.language, "en");
  assert.equal(r.agent.sensitivity, "medium");
  assert.equal(r.retentionDays, 30);
  assert.equal(r.rtc.defaultMode, "sfu");
  assert.deepEqual(r.auth.socialProviders, []);
});

await test("resolving with no published version at all is the same as the default", () => {
  assert.deepEqual(resolveOpConfig(BOOTSTRAP, null), resolveOpConfig(BOOTSTRAP, DEFAULT_OPCONFIG));
});

// --- versions in effect -----------------------------------------------------

await test("the newest version whose effectiveFrom has passed is the one in effect", () => {
  const versions = [
    opConfigSchema.parse({ version: 1, effectiveFrom: 0 }),
    opConfigSchema.parse({ version: 2, effectiveFrom: 1000 }),
    opConfigSchema.parse({ version: 3, effectiveFrom: 5000 }),
  ];
  assert.equal(pickOpConfig(versions, 999).version, 1);
  assert.equal(pickOpConfig(versions, 1000).version, 2);
  assert.equal(pickOpConfig(versions, 99999).version, 3);
});

// --- the cache --------------------------------------------------------------

await test("an unreadable table keeps serving the last published version", () => {
  // Never the seeded defaults. A deployment that silently reverted to bootstrap
  // values mid-day is far harder to diagnose than one running stale settings —
  // and the operator's console would be showing something else entirely.
  let now = 0;
  let fail = false;
  const rows = [{ PK: OPCONFIG_PK, SK: "V#000002", version: 2, effectiveFrom: 0, llm: { provider: "deepseek" } }];
  const cache = createOpConfigCache({
    fetchItems: async () => {
      if (fail) throw new Error("dynamo is down");
      return rows;
    },
    now: () => now,
    onError: () => {},
  });

  return (async () => {
    assert.equal((await cache.current()).llm.provider, "deepseek");
    assert.equal(cache.status().source, "table");
    fail = true;
    now += 120_000;
    assert.equal((await cache.current()).llm.provider, "deepseek");
    assert.equal(cache.status().source, "stale");
  })();
});

await test("publishing invalidates, so the operator sees their own change at once", () => {
  let now = 0;
  let provider = "anthropic";
  const cache = createOpConfigCache({
    fetchItems: async () => [{ PK: OPCONFIG_PK, SK: "V#000002", version: 2, effectiveFrom: 0, llm: { provider } }],
    now: () => now,
  });
  return (async () => {
    assert.equal((await cache.current()).llm.provider, "anthropic");
    provider = "deepseek";
    // Without invalidate the operator would stare at the old value for a
    // minute after saving and reasonably conclude the save failed.
    assert.equal((await cache.current()).llm.provider, "anthropic");
    cache.invalidate();
    assert.equal((await cache.current()).llm.provider, "deepseek");
  })();
});

await test("an empty partition is a fresh deployment, not a failure", () => {
  const cache = createOpConfigCache({
    fetchItems: async () => [],
    onError: () => assert.fail("an unpublished deployment must not log an error"),
  });
  return (async () => {
    assert.equal((await cache.current()).version, DEFAULT_OPCONFIG.version);
    assert.equal(cache.status().source, "default");
  })();
});

console.log(`contracts/opconfig: ${passed} passed`);
