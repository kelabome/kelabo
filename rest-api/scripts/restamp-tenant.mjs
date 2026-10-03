#!/usr/bin/env node
// Move one alias domain's existing rows into the organisation's primary tenant
// (issue #14). Dry-run by default; nothing is written without --apply.
//
//   KELABO_ENV=prod AWS_PROFILE=... node scripts/restamp-tenant.mjs acme.io
//   KELABO_ENV=prod AWS_PROFILE=... node scripts/restamp-tenant.mjs acme.io --apply
//
// Only needed when people at a domain that has just become an alias already
// had accounts under their own tenant — they signed in while the allow-list
// was open, or under an earlier domain. Sign-in and refresh already put them
// in the primary from now on (tenancy.js), and refresh moves their user row;
// what neither can move is what they *created* before: kelabos and journeys
// stamped `tenantId = acme.io`, which the primary's lists never read, so their
// own journeys would vanish from "mine" until this runs.
//
// Re-stamps, for every row whose `tenantId` is the alias:
//   - users     USER#<email>   tenantId
//   - kelabos   META           tenantId, tenantStatus  (<tenant>#<status>)
//   - journeys  META           tenantId, tenantStatus
// and reports (does not move) an organisation directory imported under the
// alias: re-import it against the primary from /admin, which now maps an alias
// to the primary on its own.
//
// Idempotent: a re-run finds nothing left under the alias.
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { orgDomains, normaliseDomain } from "@kelabo/contracts/org-domains";
import { ensureConfig } from "../src/config.js";
import { createDb } from "../src/db.js";
import { createOpConfig } from "../src/opconfig.js";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const alias = normaliseDomain(args.find((a) => !a.startsWith("--")) || "");
if (!alias) {
  console.error("usage: node scripts/restamp-tenant.mjs <alias-domain> [--apply]");
  process.exit(2);
}

const config = await ensureConfig();
const opConfig = createOpConfig({ config, db: createDb({ config }) });
const org = orgDomains(await opConfig.effective());
if (!org.primary) {
  console.error("This deployment has no allowedEmailDomain (open registration): there is no primary to move into.");
  process.exit(2);
}
if (!org.aliases.includes(alias)) {
  console.error(
    `${alias} is not one of this organisation's alias domains (${org.aliases.join(", ") || "none"}). ` +
      "Publish it as org.emailDomainAliases first — re-stamping a domain that is not an alias would " +
      "move people into a tenant that sign-in then moves them straight back out of."
  );
  process.exit(2);
}
const primary = org.primary;

const doc = DynamoDBDocumentClient.from(new DynamoDBClient({ region: config.region }));
const T = config.tableNames;

async function scanAll(TableName, filter, values) {
  const out = [];
  let ExclusiveStartKey;
  do {
    const res = await doc.send(
      new ScanCommand({ TableName, FilterExpression: filter, ExpressionAttributeValues: values, ExclusiveStartKey })
    );
    out.push(...(res.Items || []));
    ExclusiveStartKey = res.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return out;
}

const report = { alias, primary, apply, users: 0, kelabos: 0, journeys: 0, directory: 0 };

// users: USER# rows only (TERMS#/USAGE# rows are informational stamps).
const users = await scanAll(T.users, "tenantId = :a AND begins_with(PK, :p)", { ":a": alias, ":p": "USER#" });
report.users = users.length;
for (const u of users) {
  if (!apply) continue;
  await doc.send(
    new UpdateCommand({
      TableName: T.users,
      Key: { PK: u.PK },
      UpdateExpression: "SET tenantId = :t",
      ConditionExpression: "tenantId = :a",
      ExpressionAttributeValues: { ":t": primary, ":a": alias },
    })
  );
}

// kelabos and journeys: the META row carries both the tenant and the GSI key.
for (const [name, table] of [
  ["kelabos", T.kelabos],
  ["journeys", T.journeys],
]) {
  if (!table) continue;
  const metas = await scanAll(table, "tenantId = :a AND SK = :m", { ":a": alias, ":m": "META" });
  report[name] = metas.length;
  for (const m of metas) {
    if (!apply) continue;
    const status = String(m.tenantStatus || "").slice(alias.length + 1);
    await doc.send(
      new UpdateCommand({
        TableName: table,
        Key: { PK: m.PK, SK: m.SK },
        UpdateExpression: status ? "SET tenantId = :t, tenantStatus = :ts" : "SET tenantId = :t",
        ConditionExpression: "tenantId = :a",
        ExpressionAttributeValues: { ":t": primary, ":a": alias, ...(status ? { ":ts": `${primary}#${status}` } : {}) },
      })
    );
  }
}

// An organisation directory imported under the alias: reported, not moved.
if (T.contacts) {
  const dir = await scanAll(T.contacts, "PK = :pk", { ":pk": `DIR#${alias}` });
  report.directory = dir.length;
}

console.log(JSON.stringify(report, null, 2));
if (report.directory) {
  console.log(`\n${report.directory} directory entries are filed under ${alias}: re-import that file from /admin (it now lands under ${primary}), then remove the ${alias} directory.`);
}
if (!apply) console.log("\nDry run. Re-run with --apply to write.");
