// `config/template.json` is a deploy-time file, and this test is what keeps it one.
//
// Operational configuration moved into `kelabo-<env>-config` and is published
// from `/admin` (docs 23). `config/loadConfig.mjs` therefore defaults every
// publishable block field-by-field to exactly the values `resolveOpConfig`
// falls back to, so a config file that omits them behaves identically to one
// that spells them out — which is what let the template drop them.
//
// Two things can go wrong afterwards, and neither one fails anywhere else:
//
//   1. A key CDK reads goes missing and the deployment ships the *string*
//      "undefined" as an environment variable. `loadConfig.mjs` warns about
//      exactly this in two places (the `gateway.agent` and `secrets.stt`
//      comments) because it has happened; nothing checked it.
//
//   2. A publishable block creeps back into the template. That is not an
//      error — it still loads, it still deploys — it is worse: once the field
//      is published, the file entry does nothing at all, and the operator
//      editing it gets no error, no warning, and a redeploy that appears to do
//      nothing (docs 23 §9). A value that looks like it works and does not is
//      the failure this whole mechanism exists to remove.
//
// Run for all three template environments, because the three deliberately
// differ (see the mail note below) and a default that only holds for one of
// them is not a default.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { opConfigSchema } from "@kelabo/contracts/opconfig";
import { loadConfig } from "../../config/loadConfig.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../..");
const TEMPLATE = join(root, "config/template.json");
const ENVS = ["dev", "staging", "prod"];

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

const raw = JSON.parse(readFileSync(TEMPLATE, "utf8"));
const blocks = Object.fromEntries(ENVS.map((e) => [e, raw.environments[e]]));

// --- 1. Nothing CDK writes resolves to "undefined" ---------------------------

// The stack sources are read rather than restated, so a new `String(cfg.…)`
// site is covered the day it is written. That is the whole point: the last
// time this broke, the value was added to one stack and not to the config
// loader, and the list in a test would have been updated to match the bug.
const STACKS = ["gateway-ecs-stack.js", "lambda-stack.js"];

function stringifiedPaths() {
  const paths = new Set();
  for (const file of STACKS) {
    const src = readFileSync(join(root, "infra/lib", file), "utf8");
    // Stops at the first character that cannot be part of a dotted path, so
    // `String(cfg.gateway.agent.maxDispatchPerTurn ?? 3)` yields the path and
    // not the `??` guard. Testing the left-hand side alone is deliberate: the
    // guard is belt and braces, and the property under test is that
    // `loadConfig` supplies the value without it.
    for (const m of src.matchAll(/String\(cfg\.([A-Za-z0-9_.]+)/g)) paths.add(m[1]);
  }
  return [...paths].sort();
}

const dig = (obj, path) => path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);

await test("every value CDK writes into a task definition resolves", async () => {
  const paths = stringifiedPaths();
  // A regex that matched nothing would make this test pass by doing nothing —
  // the failure mode of every source-reading assertion.
  assert.ok(paths.length >= 20, `expected to find the String(cfg.…) sites, found ${paths.length}`);

  for (const env of ENVS) {
    const cfg = loadConfig(env, TEMPLATE);
    for (const path of paths) {
      const value = dig(cfg, path);
      assert.notEqual(value, undefined, `${env}: cfg.${path} is undefined — CDK would write the string "undefined"`);
      assert.notEqual(String(value), "undefined", `${env}: cfg.${path} stringifies to "undefined"`);
    }
  }
});

// --- 2. Publishable groups stay out of the template ---------------------------

// Keyed by `opConfigSchema` group, so adding a publishable field to the schema
// without deciding what the template does about it fails here rather than
// being noticed by nobody. `null` = the group must be absent from every
// environment block; a string = the template key that is allowed to carry it.
//
// The four exceptions are not arbitrary. `llm`, `stt.providers` and
// `mail.fromAddress` have no working fallback — `resolveOpConfig` resolves
// them to "" — so a deployment that omitted them would come up with no model
// and unable to send a sign-in code, with no published version to fix it from
// and no console to publish one (root must be an address at
// `allowedEmailDomain`, which is the fourth). `auth.socialProviders` and
// `stt.settings` are the two schema fields docs 23 §1.2 records as having no
// console control at all, so the file is the only place they can be set.
// `retentionDays` is kept as a statement about people's data rather than a
// knob: a self-hoster should say it, not inherit it.
const TEMPLATE_KEY = {
  llm: "llm",
  stt: "stt",
  mail: "mail",
  org: "allowedEmailDomain",
  retentionDays: "retentionDays",
  auth: "auth", // socialProviders only — the four TTLs are checked below
  agent: null, // gateway.agent
  rtc: null,
  otp: null,
  joinCode: null,
  contacts: null,
};

// Not configuration: the version envelope every published item carries.
const ENVELOPE = new Set(["version", "effectiveFrom", "publishedBy", "note"]);

await test("every publishable group has a stated position in the template", async () => {
  for (const group of Object.keys(opConfigSchema.shape)) {
    if (ENVELOPE.has(group)) continue;
    assert.ok(
      group in TEMPLATE_KEY,
      `opConfigSchema gained "${group}" — decide whether config/template.json carries it and say so here`,
    );
  }
});

await test("a published block is not also a template block", async () => {
  for (const [group, key] of Object.entries(TEMPLATE_KEY)) {
    if (key !== null) continue;
    for (const env of ENVS) {
      assert.equal(blocks[env][group], undefined, `${env}: "${group}" is published from /admin and must not be in the template`);
    }
  }
  // The agent knobs sit under `gateway`, not at the top level, so the loop
  // above cannot see them.
  for (const env of ENVS) {
    assert.equal(blocks[env].gateway?.agent, undefined, `${env}: gateway.agent is published from /admin`);
  }
});

await test("auth carries socialProviders and nothing else", async () => {
  // The one group that is half in and half out. Its four TTLs are ordinary
  // published settings; `socialProviders` has no console control, and its
  // meaningful empty (`[]` = social sign-in off) is why.
  for (const env of ENVS) {
    assert.deepEqual(Object.keys(blocks[env].auth ?? {}), ["socialProviders"], env);
  }
});

// --- 3. Secret names: the four that are real, and the ones that are not -------

await test("the template names the secrets that have no default, and only those", async () => {
  // These four are read straight off the block — `loadConfig` supplies no
  // fallback, so an absent one reaches CDK as `undefined`.
  const REQUIRED = ["cookieSigningKey", "oidcGoogle", "oidcApple", "mcpPrefix"];
  // These are derived (`loadConfig.mjs`), and three of them are no longer
  // where a supplier key lives at all — `llm`, `stt` and `cloudflareRealtime`
  // are `CRED#` rows now, and the names survive only so
  // `migrate-credentials.mjs` knows where they used to be. Naming one in the
  // template invites somebody to paste a key into Secrets Manager and wait for
  // a deployment that will never read it.
  const DERIVED = ["stt", "llm", "mail", "cloudflareRealtime", "apiOrigin"];
  for (const env of ENVS) {
    const secrets = blocks[env].secrets ?? {};
    for (const k of REQUIRED) assert.ok(secrets[k], `${env}: secrets.${k} has no default and must be named`);
    for (const k of DERIVED) assert.equal(secrets[k], undefined, `${env}: secrets.${k} is derived, not configured`);
  }
});

// --- 4. The mail asymmetry is load-bearing -----------------------------------

await test("the three environments still demonstrate three mail configurations", async () => {
  // dev names SES explicitly, staging names no provider at all (the shape
  // every config written before mail became a choice has), and prod names
  // another provider — which is what turns the SES identity stack off.
  // `rest-api/test/mail.mjs` asserts the resolved behaviour; this asserts the
  // fixture that produces it, so a tidy-up that makes the three blocks look
  // alike fails here, next to the reason, rather than there.
  assert.equal(blocks.dev.mail?.provider, "ses");
  assert.equal(blocks.staging.mail, undefined, "staging must name no mail block");
  assert.ok(blocks.staging.ses?.fromAddress, "staging's from-address comes from ses.fromAddress");
  assert.equal(blocks.prod.mail?.provider, "mailersend");
});

console.log(`config template: ${passed} tests passed`);
