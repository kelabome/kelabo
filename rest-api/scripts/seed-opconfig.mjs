#!/usr/bin/env node
// Publish this deployment's CURRENT configuration as an op-config version
// (contracts/src/opconfig.js), so the console owns those values from then on.
//
//   make opconfig-seed env=dev              # dry run: prints exactly what it would publish
//   make opconfig-seed env=dev write=1 by=you@example.com
//   make opconfig-seed env=dev groups="llm,agent" write=1   # only some of it
//
// ## Read this before running it with write=1
//
// **You probably do not need this.** The fold in `resolveOpConfig` already
// means an unpublished field falls back to `config/kelabo.json`, so a
// deployment that has published nothing behaves exactly as it always did, and
// `/admin` already shows every one of those values as "Deployment default".
// Nothing is missing; nothing is broken; there is no state to repair.
//
// What this changes is *ownership*. After a field is published, the published
// value wins, and editing `config/kelabo.json` for that field has **no effect
// at all** — no error, no warning, just a redeploy that appears to do nothing.
// That is the trap this script creates, and it is worth being deliberate about:
// bulk-seeding forty fields makes forty entries in `kelabo.json` misleading in
// exchange for making a console that already displayed them display them
// slightly differently.
//
// It is genuinely useful in one case: a deployment that wants the console to be
// the single source of truth going forward — typically because the people who
// will operate it do not have the repo, and `kelabo.json` is about to stop
// being maintained. That is a real situation, and this is how you get there
// in one deliberate act with an author and a note against it.
//
// The alternative, and the one the design intends, is to publish a field when
// you first change it. The console does that already.
//
// ## Why it runs here and not in the Lambda
//
// Same reason as `put-credential.mjs`: this is a first-run/operator act, run
// under a human's own AWS credentials against a named environment. Making it a
// route would mean a "reset my deployment to its config file" endpoint, which
// is a much larger thing to hold than the problem justifies.
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { OPCONFIG_PK, opConfigItem, opConfigSchema, parseOpConfig } from "@kelabo/contracts/opconfig";

const args = process.argv.slice(2);
const env = args.find((a) => !a.startsWith("--")) || "dev";
const write = args.includes("--write");
const flag = (name) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : "";
};
const by = flag("by") || process.env.USER || "seed-opconfig";
const only = flag("groups")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const { loadConfig } = await import("../../config/loadConfig.mjs");
const cfg = loadConfig(env);
const table = cfg.tableNames.config;
const doc = DynamoDBDocumentClient.from(new DynamoDBClient({ region: cfg.region }));

/**
 * The deployment's own values, in the published document's shape.
 *
 * Only what `config/kelabo.json` (and `loadConfig`'s derivations) actually
 * state. A field the deployment never set is left unpublished rather than
 * seeded with a code default — publishing a default freezes a value nobody
 * chose, which is the same trap as bulk-seeding, in miniature.
 */
const groups = {
  llm: {
    provider: cfg.llm?.provider ?? "",
    model: cfg.llm?.model ?? "",
    smallModel: cfg.llm?.smallModel ?? "",
    baseUrl: cfg.llm?.baseUrl ?? "",
  },
  stt: {
    provider: cfg.stt?.provider ?? "",
    language: cfg.stt?.language ?? "",
    settings: cfg.stt?.providers ?? {},
  },
  mail: { provider: cfg.mail?.provider ?? "", fromAddress: cfg.mail?.fromAddress ?? "" },
  agent: cfg.gateway?.agent ?? {},
  rtc: {
    defaultMode: cfg.rtc?.defaultMode ?? "",
    meshMaxParticipants: cfg.rtc?.meshMaxParticipants ?? null,
    iceTtlSeconds: cfg.rtc?.iceTtlSeconds ?? null,
    disconnectGraceSeconds: cfg.rtc?.disconnectGraceSeconds ?? null,
    video: typeof cfg.rtc?.video === "boolean" ? cfg.rtc.video : null,
  },
  otp: cfg.otp ?? {},
  joinCode: cfg.joinCode ?? {},
  auth: {
    sessionTtlSeconds: cfg.auth?.sessionTtlSeconds ?? null,
    refreshTtlDays: cfg.auth?.refreshTtlDays ?? null,
    participantTtlSeconds: cfg.auth?.participantTtlSeconds ?? null,
    agentTokenTtlDays: cfg.auth?.agentTokenTtlDays ?? null,
    socialProviders: cfg.auth?.socialProviders ?? null,
  },
  org: { allowedEmailDomain: cfg.allowedEmailDomain ?? "" },
  contacts: { external: typeof cfg.contacts?.external === "boolean" ? cfg.contacts.external : null },
  retentionDays: cfg.retentionDays ?? null,
};

const chosen = only.length ? only : Object.keys(groups);
const unknown = chosen.filter((g) => !(g in groups));
if (unknown.length) {
  console.error(`unknown group(s): ${unknown.join(", ")}\nknown: ${Object.keys(groups).join(", ")}`);
  process.exit(1);
}

const body = {};
for (const g of chosen) body[g] = groups[g];

// Validated before anything is read or written, so a bad shape fails here
// rather than half way through.
let candidate;
try {
  candidate = opConfigSchema.parse({ ...body, version: 1, effectiveFrom: 0, publishedBy: by, note: "seed" });
} catch (e) {
  console.error(`the derived document does not validate: ${e.message}`);
  process.exit(1);
}

const res = await doc.send(
  new QueryCommand({
    TableName: table,
    KeyConditionExpression: "PK = :pk",
    ExpressionAttributeValues: { ":pk": OPCONFIG_PK },
  }),
);
const existing = (res.Items || []).map((i) => {
  try {
    return parseOpConfig(i);
  } catch {
    return null;
  }
}).filter(Boolean);
const head = existing.reduce((m, v) => Math.max(m, v.version || 0), 0);
const version = head + 1;

console.log(`env        : ${env}`);
console.log(`table      : ${table}`);
console.log(`published  : ${head ? `v${head} is the current head` : "nothing published yet"}`);
console.log(`would write: v${version} by ${by}`);
console.log(`groups     : ${chosen.join(", ")}`);
console.log("");
console.log(JSON.stringify(body, null, 2));

if (!write) {
  console.log("");
  console.log("dry run — nothing written. Re-run with write=1 to publish.");
  console.log("Note: a published field stops tracking config/kelabo.json. Edits there will have no effect on it.");
  process.exit(0);
}

const item = opConfigItem({
  ...candidate,
  version,
  effectiveFrom: Date.now(),
  note: `seeded from config/kelabo.json (${chosen.join(", ")})`,
});
try {
  await doc.send(
    new PutCommand({
      TableName: table,
      Item: item,
      // The same condition the API's publish uses: the chain is append-only, so
      // losing a race means retrying against the new head, never overwriting.
      ConditionExpression: "attribute_not_exists(PK) AND attribute_not_exists(SK)",
    }),
  );
} catch (e) {
  if (e?.name === "ConditionalCheckFailedException") {
    console.error(`v${version} already exists — someone published while this ran. Re-run to retry against the new head.`);
    process.exit(1);
  }
  throw e;
}
console.log("");
console.log(`published v${version}.`);
console.log("The gateway picks this up within 60s; publishing anything from /admin reloads it immediately.");
