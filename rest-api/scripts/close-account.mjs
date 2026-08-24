#!/usr/bin/env node
// Close an account: the operator-side runner for `src/closeAccount.js`, which
// documents exactly what is deleted, what is refused, and why the USER# row
// goes last. Dry-run by default; nothing is deleted without --apply.
//
//   KELABO_ENV=prod AWS_PROFILE=... node scripts/close-account.mjs someone@example.com
//   KELABO_ENV=prod AWS_PROFILE=... node scripts/close-account.mjs someone@example.com --apply
//
// Idempotent: a run that dies halfway leaves the USER# row in place, and
// running it again finishes the job.
import { ensureConfig } from "../src/config.js";
import { createDb } from "../src/db.js";
import { createRecords } from "../src/records.js";
import { createSecrets } from "../src/secrets.js";
import { createCloseAccount } from "../src/closeAccount.js";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const identity = args.find((a) => !a.startsWith("--"));

if (!identity) {
  console.error("usage: node scripts/close-account.mjs <email> [--apply]");
  process.exit(2);
}

const config = await ensureConfig();
const db = createDb({ config });
const records = createRecords({ config, db });
const secrets = createSecrets({ region: config.region });
const closeAccount = createCloseAccount({ config, db, records, secrets });

try {
  const report = await closeAccount.close({ identity, dryRun: !apply });
  console.log(JSON.stringify(report, null, 2));
  if (!apply) console.log("\nDry run. Re-run with --apply to delete.");
  if (report.warnings.length) {
    console.error(`\n${report.warnings.length} warning(s) — re-run to finish what failed.`);
    process.exit(1);
  }
} catch (e) {
  console.error(`refused: ${e?.code || e?.message || e}`);
  process.exit(1);
}
