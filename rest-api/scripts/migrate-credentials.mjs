#!/usr/bin/env node
// Copy supplier credentials out of Secrets Manager and into the credentials
// table (contracts/src/credentials.js).
//
//   make credentials-migrate env=dev              # dry run: says what it would do
//   make credentials-migrate env=dev write=1      # actually writes
//   make credentials-migrate env=dev write=1 force=1   # overwrite an existing slot
//
// ## What moves, and what does not
//
// Four slots move: `llm`, `stt`, `rtc`, `mail`. They are supplier keys —
// money, not identity. A leak costs money and is fixed by rotating at the
// supplier.
//
// Two do NOT move, and this script will refuse to touch them:
//
//   - `cookie-key`, which signs all three token families. Anyone holding it can
//     mint a session for any user in any tenant, and no rotation undoes the
//     sessions already minted with it.
//   - `api-origin`, the CloudFront perimeter check.
//
// Both are read once per cold start and never edited from a console, so moving
// them would widen the blast radius and buy nothing.
//
// ## Copy, never move
//
// The Secrets Manager entries are left exactly as they are. A migration that
// deletes its source turns a bug in the new path into a key re-issue at four
// suppliers; leaving them means a rollback is a code revert. Delete them by
// hand, later, once the new path has been proven.
//
// Idempotent: a slot that already holds a credential is skipped unless
// `force=1`, so re-running after a partial failure finishes the job rather than
// bumping every version.
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import {
  CREDENTIAL_SK,
  CREDENTIAL_SLOTS,
  credentialFieldKeys,
  credentialItem,
  credentialPk,
  validateCredentialFields,
} from "@kelabo/contracts/credentials";
import { loadConfig } from "../../config/loadConfig.mjs";

const [env, ...rest] = process.argv.slice(2);
if (!env) {
  console.error("usage: node scripts/migrate-credentials.mjs <env> [--write] [--force] [by=you@example.com]");
  process.exit(1);
}
const args = Object.fromEntries(
  rest.map((a) => {
    const i = a.indexOf("=");
    return i === -1 ? [a.replace(/^--/, ""), "true"] : [a.slice(0, i).replace(/^--/, ""), a.slice(i + 1)];
  })
);
const write = args.write === "true";
const force = args.force === "true";
const by = args.by || "migrate-credentials";

const cfg = loadConfig(env);
const table = cfg.tableNames.credentials;
if (!table) {
  console.error(`no credentials table derived for env ${env}`);
  process.exit(1);
}

const doc = DynamoDBDocumentClient.from(new DynamoDBClient({ region: cfg.region }), {
  marshallOptions: { removeUndefinedValues: true },
});
const sm = new SecretsManagerClient({ region: cfg.region });

// Slot -> the Secrets Manager name it used to live at. Derived from the same
// config the old code read, so this cannot drift from where the value actually
// is: `loadConfig` is the single source of truth for every secret name, and it
// still derives these — `stt` and `mail` because they remain the bootstrap
// fallback for a deployment that has not run this yet, `llm` and
// `cloudflareRealtime` because the gateway still reads them directly.
//
// Running this is what stops a deployment depending on that fallback. Once
// every slot is filled, nothing in the control plane reads Secrets Manager for
// a supplier key again.
const SOURCES = {
  llm: cfg.secrets.llm,
  stt: cfg.secrets.stt,
  rtc: cfg.secrets.cloudflareRealtime,
  mail: cfg.secrets.mail,
};

// Named so that a future reader does not "helpfully" add them.
const NEVER_MOVE = [`kelabo/${cfg.endpoint}/cookie-key`, `kelabo/${cfg.endpoint}/api-origin`];

async function readSecret(name) {
  try {
    const out = await sm.send(new GetSecretValueCommand({ SecretId: name }));
    return out.SecretString ?? Buffer.from(out.SecretBinary ?? []).toString("utf8");
  } catch (e) {
    if (e?.name === "ResourceNotFoundException") return null;
    throw e;
  }
}

console.log(`env=${env}  region=${cfg.region}  table=${table}`);
console.log(write ? "MODE: writing\n" : "MODE: dry run — pass write=1 to apply\n");

let warnedNoTable = false;
let moved = 0;
let skipped = 0;
let absent = 0;

for (const slot of CREDENTIAL_SLOTS) {
  const source = SOURCES[slot];
  const value = await readSecret(source);
  if (value === null) {
    console.log(`  ${slot.padEnd(9)} — no secret at ${source}; nothing to copy`);
    absent++;
    continue;
  }

  let existing;
  try {
    existing = await doc.send(
      new GetCommand({ TableName: table, Key: { PK: credentialPk(slot), SK: CREDENTIAL_SK } })
    );
  } catch (e) {
    // The table is created by `cdk deploy kelabo-<env>-ddb`, and the ordering
    // is the one AGENTS.md warns about: deploying the code before the table
    // gives it an env var pointing at nothing, and the failure is a runtime
    // ResourceNotFoundException on the first request rather than a deploy
    // error. Said plainly here so a dry run is a useful pre-flight rather than
    // a stack trace.
    if (e?.name !== "ResourceNotFoundException") throw e;
    if (!warnedNoTable) {
      warnedNoTable = true;
      console.error(`${table} does not exist yet — run \`make infra env=${env}\` first.`);
      console.error("Listing what would be copied; what is already set cannot be checked.\n");
    }
    existing = { Item: null };
    if (write) process.exit(1);
  }
  if (existing.Item && !force) {
    console.log(`  ${slot.padEnd(9)} — already set (v${existing.Item.version}); skipping. force=1 to overwrite`);
    skipped++;
    continue;
  }

  // Normalised against the slot's field list, not copied verbatim.
  //
  // This is the one place a migration should not be a byte-for-byte copy. A
  // real `stt` secret was found holding four keys — `soniox` beside the typos
  // `oniox` and `onionx` — because the old free-form blob accepted anything.
  // Carrying them across would move the problem rather than fix it, so unknown
  // fields are dropped here and named in the output.
  //
  // A value that is not JSON at all is treated as the single-field case, which
  // is what a slot with one field (`llm`) was most likely written as.
  let parsedInput;
  try {
    parsedInput = JSON.parse(value);
  } catch {
    parsedInput = null;
  }
  const keys = credentialFieldKeys(slot);
  const input =
    parsedInput && typeof parsedInput === "object"
      ? parsedInput
      : keys.length === 1
        ? { [keys[0]]: value }
        : {};

  const { fields, unknown, missing } = validateCredentialFields(slot, input);
  if (unknown.length) {
    console.log(`  ${" ".repeat(9)}   dropping unrecognised field(s): ${unknown.join(", ")}`);
  }
  if (missing.length) {
    console.log(`  ${" ".repeat(9)}   WARNING: still missing required field(s): ${missing.join(", ")}`);
  }
  if (!Object.keys(fields).length) {
    console.log(`  ${slot.padEnd(9)} — nothing recognisable in ${source}; skipping`);
    skipped++;
    continue;
  }

  const item = credentialItem({
    slot,
    value: JSON.stringify(fields),
    version: (Number(existing.Item?.version) || 0) + 1,
    rotatedBy: by,
  });
  if (existing.Item?.createdAt) item.createdAt = existing.Item.createdAt;

  // Field NAMES only, never a value or a prefix of one. Printing a prefix here
  // would put a credential in a terminal scrollback and, more likely, in
  // whatever CI log ran this.
  console.log(`  ${slot.padEnd(9)} <- ${source}  [${Object.keys(fields).join(", ")}]  v${item.version}`);
  if (write) {
    await doc.send(new PutCommand({ TableName: table, Item: item }));
    moved++;
  }
}

console.log(`\n${NEVER_MOVE.length} secrets deliberately left in Secrets Manager:`);
for (const n of NEVER_MOVE) console.log(`  ${n}`);

console.log(
  write
    ? `\nwrote ${moved}, skipped ${skipped}, absent ${absent}. The Secrets Manager entries are untouched — delete them by hand once the new path is proven.`
    : `\nwould write ${CREDENTIAL_SLOTS.length - skipped - absent}, skip ${skipped}, absent ${absent}. Re-run with write=1.`
);
