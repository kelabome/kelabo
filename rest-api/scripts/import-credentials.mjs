#!/usr/bin/env node
// Import (or refresh) every supplier credential slot for one environment from
// a local JSON file — `config/credentials.json` by default, gitignored, shaped
// like `config/credentials.template.json`.
//
//   make credentials-import env=dev              # dry run: what each slot would get
//   make credentials-import env=dev write=1      # apply
//   make credentials-import env=dev file=/path/other.json write=1
//
// Deliberately NOT a second write path. Each slot is handed to
// `put-credential.mjs`, so validation, the merge rule, the version counter and
// the rotatedAt/rotatedBy trail are exactly those of `make credential-set`.
// Values travel to it as `KELABO_CRED_<SLOT>_<FIELD>` environment variables,
// never as arguments, so no key appears in `ps` or in shell history.
//
// Empty strings are skipped rather than written: a blank in the file means
// "not filled in yet", and put-credential merges, so a skipped field keeps
// whatever the slot already holds. Removing a field is still
// `make credential-set … replace=1 force=1`, on purpose.
//
// Never prints a value. Field NAMES only.
import { readFileSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CREDENTIAL_SLOTS, credentialFieldKeys, isCredentialSlot } from "@kelabo/contracts/credentials";

const here = dirname(fileURLToPath(import.meta.url));
const USAGE = "usage: node scripts/import-credentials.mjs <env> [--file=path] [--write] [by=you@example.com]";

const [env, ...rest] = process.argv.slice(2);
if (!env) {
  console.error(USAGE);
  process.exit(1);
}
const args = Object.fromEntries(
  rest.map((a) => {
    const i = a.indexOf("=");
    return i === -1 ? [a.replace(/^--/, ""), "true"] : [a.slice(0, i).replace(/^--/, ""), a.slice(i + 1)];
  }),
);
const write = args.write === "true";
const by = args.by || "credentials-import";
const file = resolve(args.file && args.file !== "true" ? args.file : join(here, "../../config/credentials.json"));

let raw;
try {
  raw = JSON.parse(readFileSync(file, "utf8"));
} catch (e) {
  console.error(`cannot read ${file}: ${e.code === "ENOENT" ? "not found — copy config/credentials.template.json" : e.message}`);
  process.exit(1);
}

// A key file anyone on the machine can read is worth a warning, not a refusal.
try {
  const mode = statSync(file).mode & 0o777;
  if (mode & 0o077) console.warn(`WARNING: ${file} is mode ${mode.toString(8)}; run \`chmod 600\` on it.\n`);
} catch {}

const block = raw.environments?.[env];
if (!block || typeof block !== "object") {
  console.error(`${file} has no environments.${env} block (have: ${Object.keys(raw.environments || {}).join(", ") || "none"})`);
  process.exit(1);
}

// Validate the whole file before touching anything, so a typo in the last slot
// does not leave the first three written and the fourth not.
const plan = [];
for (const [slot, fields] of Object.entries(block)) {
  if (slot.startsWith("_")) continue;
  if (!isCredentialSlot(slot)) {
    console.error(`unknown slot "${slot}" — known slots are ${CREDENTIAL_SLOTS.join(", ")}`);
    process.exit(1);
  }
  if (!fields || typeof fields !== "object") {
    console.error(`slot ${slot}: expected an object of field → value`);
    process.exit(1);
  }
  const allowed = credentialFieldKeys(slot);
  const filled = {};
  for (const [key, value] of Object.entries(fields)) {
    if (key.startsWith("_")) continue;
    if (!allowed.includes(key)) {
      console.error(`slot ${slot} has no field "${key}" (fields: ${allowed.join(", ")})`);
      process.exit(1);
    }
    if (typeof value !== "string") {
      console.error(`slot ${slot} field ${key}: expected a string`);
      process.exit(1);
    }
    if (value.trim()) filled[key] = value.trim();
  }
  plan.push({ slot, filled });
}

/** Same derivation as put-credential.mjs: `apiKey` -> `KELABO_CRED_LLM_API_KEY`. */
const envName = (slot, key) => `KELABO_CRED_${slot}_${key.replace(/([a-z0-9])([A-Z])/g, "$1_$2")}`.toUpperCase();

// Strip any KELABO_CRED_* already in the caller's environment, so a stale
// export in the shell cannot sneak a value in that the file does not hold.
const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("KELABO_CRED_")));

console.log(`env=${env}  file=${file}  ${write ? "MODE: writing" : "MODE: dry run — pass write=1 to apply"}\n`);

let failed = 0;
let skipped = 0;
for (const { slot, filled } of plan) {
  const keys = Object.keys(filled);
  if (!keys.length) {
    console.log(`── ${slot}: nothing filled in, skipped\n`);
    skipped++;
    continue;
  }
  console.log(`── ${slot}: ${keys.join(", ")}`);
  const childEnv = { ...baseEnv };
  for (const [k, v] of Object.entries(filled)) childEnv[envName(slot, k)] = v;
  const r = spawnSync(
    process.execPath,
    [join(here, "put-credential.mjs"), env, `--slot=${slot}`, ...(write ? ["--write"] : []), `by=${by}`],
    { env: childEnv, stdio: "inherit", cwd: join(here, "..") },
  );
  if (r.status !== 0) failed++;
  console.log();
}

const done = plan.length - skipped - failed;
console.log(`${write ? "wrote" : "would write"} ${done} slot(s), skipped ${skipped} empty, ${failed} failed.`);
if (write && done) console.log("Keys are picked up within ~5 minutes (the credential cache); no redeploy needed.");
process.exit(failed ? 1 : 0);
