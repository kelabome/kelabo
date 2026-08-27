#!/usr/bin/env node
// Set one supplier credential slot in the credentials table
// (contracts/src/credentials.js). The first-run counterpart to
// `migrate-credentials.mjs`: that one copies keys a deployment already has in
// Secrets Manager, this one is how a deployment that never had any gets its
// first.
//
//   make credential-set env=dev slot=rtc                      # print the slot's fields and exit
//   make credential-set env=dev slot=llm fields="apiKey=sk-…"  # dry run: says what it would do
//   make credential-set env=dev slot=llm fields="apiKey=sk-…" write=1
//   KELABO_CRED_LLM_API_KEY=sk-… make credential-set env=dev slot=llm write=1
//
// ## Where the value comes from
//
// Named fields only — `apiKey=…`, `soniox=…`, `sfuAppId=…` — never positional
// soup, because three of the four slots hold more than one field and two of
// them hold two interchangeable ones (`stt` holds a key per engine, `rtc` holds
// an SFU pair and an optional TURN pair). A positional value would have to
// guess which, and guessing wrong writes a working key under a name nothing
// reads.
//
// Each field may equally come from the environment, as
// `KELABO_CRED_<SLOT>_<FIELD>` (`apiKey` -> `API_KEY`, `sfuAppId` ->
// `SFU_APP_ID`). That is the better path for a real key: an argument is in the
// shell's history, in `ps`, and in whatever CI log ran the command. A CLI
// argument wins over the environment when both are given, and the output names
// which source each field came from — never the value.
//
// ## Merge, not replace
//
// The default is to merge the fields given over whatever the slot already
// holds. `stt` is why: a deployment holding both engines' keys that ran this
// with `soniox=…` alone would, on a replace, silently lose `deepgram` — and
// which one is live is the rate card's decision, not this script's, so the loss
// would surface as transcription failing at some later publish. `--replace`
// writes only what was given, and refuses to drop a field that is currently set
// unless `--force` says so.
//
// Merging also cleans up: the existing value is re-validated against the slot's
// field list before the new fields go over it, so the `oniox`/`onionx` typos
// that the old free-form blob accepted are dropped here the same way
// `migrate-credentials.mjs` drops them.
//
// ## The rotation trail
//
// Written through `rest-api/src/credentials.js` `put()` rather than as a raw
// PutItem, so the version counter, `rotatedAt`/`rotatedBy` and the preserved
// `createdAt` are produced by the same code the control plane uses. There is
// one write shape for this row and this script is not a second one.
//
// Never prints a credential, or a prefix of one. Field NAMES only.
import {
  CREDENTIAL_FIELDS,
  CREDENTIAL_SLOTS,
  credentialFieldKeys,
  credentialStatus,
  isCredentialSlot,
  parseCredential,
  validateCredentialFields,
} from "@kelabo/contracts/credentials";
import { createDb } from "../src/db.js";
import { createCredentials } from "../src/credentials.js";
import { loadConfig } from "../../config/loadConfig.mjs";

const USAGE =
  "usage: node scripts/put-credential.mjs <env> --slot=<slot> [<field>=<value> …] [--write] [--replace] [--force] [by=you@example.com]";

// Argument names this script owns. No slot defines a field with any of these
// names, so anything else in `key=value` form is a credential field — and an
// unrecognised one is refused rather than dropped, which is the whole reason
// the field list is closed.
const RESERVED = new Set(["slot", "write", "replace", "force", "by"]);

const [env, ...rest] = process.argv.slice(2);
if (!env) {
  console.error(USAGE);
  console.error(`slots: ${CREDENTIAL_SLOTS.join(", ")}`);
  process.exit(1);
}
const args = Object.fromEntries(
  rest.map((a) => {
    const i = a.indexOf("=");
    return i === -1 ? [a.replace(/^--/, ""), "true"] : [a.slice(0, i).replace(/^--/, ""), a.slice(i + 1)];
  })
);
const write = args.write === "true";
const replace = args.replace === "true";
const force = args.force === "true";
const by = args.by || "put-credential";

const slot = args.slot;
if (!slot || slot === "true") {
  console.error(USAGE);
  console.error(`slots: ${CREDENTIAL_SLOTS.join(", ")}`);
  process.exit(1);
}
if (!isCredentialSlot(slot)) {
  console.error(`unknown slot "${slot}" — known slots are ${CREDENTIAL_SLOTS.join(", ")}`);
  process.exit(1);
}

/** `apiKey` -> `API_KEY`, so the env names read like env names. */
const envName = (key) => `KELABO_CRED_${slot}_${key.replace(/([a-z0-9])([A-Z])/g, "$1_$2")}`.toUpperCase();

function describeSlot() {
  console.log(`slot ${slot} takes:`);
  for (const f of CREDENTIAL_FIELDS[slot] ?? []) {
    console.log(`  ${f.key.padEnd(16)} ${f.required ? "required" : "optional"}  ${f.label}`);
    if (f.hint) console.log(`  ${" ".repeat(16)}           ${f.hint}`);
    console.log(`  ${" ".repeat(16)}           env: ${envName(f.key)}`);
  }
}

// Refuse an unrecognised field name loudly. Dropping it would write a
// credential that looks set and is missing the key that matters — which is the
// exact failure the closed field list exists to prevent, so it must not be
// reintroduced by the tool that fills the slot.
const supplied = {};
const sources = {};
const allowed = credentialFieldKeys(slot);
for (const [key, value] of Object.entries(args)) {
  if (RESERVED.has(key)) continue;
  if (!allowed.includes(key)) {
    console.error(`slot ${slot} has no field "${key}".`);
    describeSlot();
    process.exit(1);
  }
  supplied[key] = value;
  sources[key] = "argument";
}
for (const key of allowed) {
  if (key in supplied) continue;
  const fromEnv = process.env[envName(key)];
  if (fromEnv && fromEnv.trim()) {
    supplied[key] = fromEnv;
    sources[key] = `env ${envName(key)}`;
  }
}

if (!Object.keys(supplied).length) {
  console.error(`no fields given for slot ${slot} — nothing to write.\n`);
  describeSlot();
  process.exit(1);
}

const { fields: incoming, unknown, missing: incomingMissing } = validateCredentialFields(slot, supplied);
if (unknown.length) {
  // Unreachable via the check above; kept because the contract, not this file,
  // is the authority on what a slot accepts.
  console.error(`slot ${slot} has no field(s): ${unknown.join(", ")}`);
  process.exit(1);
}
if (!Object.keys(incoming).length) {
  console.error(`every field given for slot ${slot} was empty — an empty string is "not set", not "set to empty".`);
  process.exit(1);
}

const cfg = loadConfig(env);
const table = cfg.tableNames.credentials;
if (!table) {
  console.error(`no credentials table derived for env ${env}`);
  process.exit(1);
}

const db = createDb({ config: cfg });
const credentials = createCredentials({ db });

console.log(`env=${env}  region=${cfg.region}  table=${table}  slot=${slot}`);
console.log(write ? "MODE: writing\n" : "MODE: dry run — pass write=1 to apply\n");

// Read before deciding, and say plainly when the table is not there yet. Same
// ordering trap `migrate-credentials.mjs` calls out: deploying code before the
// table gives it an env var pointing at nothing, and the failure is a runtime
// ResourceNotFoundException on the first request rather than a deploy error.
let existingItem = null;
try {
  existingItem = await db.getCredential(slot);
} catch (e) {
  if (e?.name !== "ResourceNotFoundException") throw e;
  console.error(`${table} does not exist yet — run \`make infra env=${env}\` first.`);
  process.exit(1);
}

const before = credentialStatus(slot, existingItem);
const existingFields = validateCredentialFields(slot, parseCredential(existingItem?.value) ?? {}).fields;
if (before.unknown.length) {
  console.log(`  dropping unrecognised field(s) already stored: ${before.unknown.join(", ")}`);
}

// `--replace` is the destructive one, so it is the one that has to be asked for
// twice when it would actually destroy something.
const dropped = replace ? Object.keys(existingFields).filter((k) => !(k in incoming)) : [];
if (dropped.length && !force) {
  console.error(`--replace would drop field(s) still set on ${slot}: ${dropped.join(", ")}`);
  console.error("Pass --force if that is what you mean, or drop --replace to merge instead.");
  process.exit(1);
}

const merged = replace ? { ...incoming } : { ...existingFields, ...incoming };
const { fields, missing } = validateCredentialFields(slot, merged);

// Field NAMES and their provenance, never a value or a prefix of one.
for (const key of allowed) {
  const had = key in existingFields;
  const gets = key in incoming;
  const kept = key in fields;
  const verb = gets ? (had ? "replaces" : "sets") : kept ? "keeps" : had ? "drops" : "";
  if (!verb) continue;
  console.log(`  ${key.padEnd(16)} ${verb.padEnd(8)} ${gets ? `<- ${sources[key]}` : ""}`.trimEnd());
}
if (missing.length) {
  console.log(`\n  WARNING: slot ${slot} is still missing required field(s): ${missing.join(", ")}`);
  console.log("  The capability stays unconfigured until they are set (docs 19).");
} else if (incomingMissing.length && !replace) {
  // Required fields the arguments alone did not carry, satisfied by what was
  // already stored. Worth saying, so a partial write does not read as a full one.
  console.log(`\n  (required field(s) ${incomingMissing.join(", ")} came from the stored credential)`);
}

if (!write) {
  console.log(`\nwould write ${slot} v${(Number(before.version) || 0) + 1}. Re-run with write=1.`);
  process.exit(0);
}

const after = await credentials.put(slot, JSON.stringify(fields), { by });
console.log(
  `\nwrote ${slot} v${after.version} (was v${before.version || 0}), by ${by}. ` +
    `Set: ${Object.entries(after.fields)
      .filter(([, v]) => v)
      .map(([k]) => k)
      .join(", ") || "none"}.`
);
console.log("`make credentials-show env=" + env + "` lists every slot; it never prints a value.");
