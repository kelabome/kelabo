// The board read, through the *real* `queryContributions` (src/db.js).
//
// smoke.mjs reaches the board route through `stubDb.js`, which re-implements
// the query in JS — so a key condition that is wrong in db.js and right in the
// stub passes every smoke test. That is exactly how issue #10 shipped: the
// stub filtered to `CONTRIB#` and stored bare `CONTRIB#<at>` keys, while the
// real query was `SK > :sk` with no upper bound against a partition whose
// other rows (META, INVITE#, JOURNEY#, MINUTES, PROMOTION, UTT#) all sort after
// `CONTRIB#`, and whose contribution keys carry a `#<rand>` suffix.
//
// Here the real function runs against a fake DynamoDB that evaluates the key
// condition it is actually sent, over a partition shaped like production.
import assert from "node:assert/strict";
import { createDb } from "../src/db.js";

const KID = "k-1";
const PK = `KELABO#${KID}`;
const pad = (n) => String(n).padStart(13, "0");
const sk = (at, rand) => `CONTRIB#${pad(at)}#${rand}`;

const base = 1_790_000_000_000;
const rows = [
  { PK, SK: "META", hostIdentity: "host@example.com", participants: [] },
  { PK, SK: "INVITE#invitee@example.com", email: "invitee@example.com", response: "pending" },
  { PK, SK: "JOURNEY#j-1", journeyId: "j-1" },
  { PK, SK: "MINUTES", markdown: "minutes" },
  { PK, SK: "PROMOTION", by: "host@example.com" },
  { PK, SK: "UTT#000000000001#abc123", text: "hello" },
  { PK, SK: sk(base + 1000, "aaaaaa"), id: "c1", at: base + 1000 },
  { PK, SK: sk(base + 2000, "bbbbbb"), id: "c2", at: base + 2000 },
  { PK, SK: sk(base + 3000, "cccccc"), id: "c3", at: base + 3000 },
  // A different kelabo's rows must never leak in either.
  { PK: "KELABO#other", SK: sk(base + 2500, "dddddd"), id: "x", at: base + 2500 },
];

// Evaluates exactly the two key-condition shapes queryContributions may send.
// Anything else fails loudly, so a future rewrite has to update this on purpose.
const sent = [];
const client = {
  async send(cmd) {
    const q = cmd.input;
    sent.push(q);
    const v = q.ExpressionAttributeValues;
    let match;
    if (q.KeyConditionExpression === "PK = :pk AND begins_with(SK, :sk)") {
      match = (r) => r.SK.startsWith(v[":sk"]);
    } else if (q.KeyConditionExpression === "PK = :pk AND SK BETWEEN :lo AND :hi") {
      match = (r) => r.SK >= v[":lo"] && r.SK <= v[":hi"];
    } else {
      throw new Error(`unexpected key condition: ${q.KeyConditionExpression}`);
    }
    let items = rows.filter((r) => r.PK === v[":pk"] && match(r)).sort((a, b) => (a.SK < b.SK ? -1 : 1));
    if (q.ScanIndexForward === false) items.reverse();
    if (q.Limit) items = items.slice(0, q.Limit);
    return { Items: items.map((r) => ({ ...r })) };
  },
};

const db = createDb({ config: { tableNames: { kelabos: "kelabos" } }, client });
const ids = (items) => items.map((i) => i.id);

let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (e) {
    failed++;
    console.error(`FAIL ${name}\n${e.stack}`);
  }
}

await test("caught up: since = newest returns nothing (no META, INVITE#, MINUTES…)", async () => {
  const items = await db.queryContributions(KID, { since: base + 3000, limit: 50 });
  assert.deepEqual(items, []);
});

await test("the cursor row itself is not returned again", async () => {
  const items = await db.queryContributions(KID, { since: base + 2000, limit: 50 });
  assert.deepEqual(ids(items), ["c3"]);
});

await test("since returns only contributions, oldest first, within limit", async () => {
  assert.deepEqual(ids(await db.queryContributions(KID, { since: base, limit: 50 })), ["c1", "c2", "c3"]);
  assert.deepEqual(ids(await db.queryContributions(KID, { since: base, limit: 2 })), ["c1", "c2"]);
});

await test("no cursor: the newest `limit` contributions, oldest first", async () => {
  assert.deepEqual(ids(await db.queryContributions(KID, { limit: 2 })), ["c2", "c3"]);
});

await test("a non-numeric or non-positive cursor is the tail read, not an open range", async () => {
  for (const since of [NaN, 0, -5, undefined, null]) {
    const items = await db.queryContributions(KID, { since, limit: 50 });
    assert.deepEqual(ids(items), ["c1", "c2", "c3"], `since=${since}`);
  }
});

await test("the range is bounded above to CONTRIB#", async () => {
  sent.length = 0;
  await db.queryContributions(KID, { since: base, limit: 50 });
  const v = sent[0].ExpressionAttributeValues;
  assert.ok(v[":hi"].startsWith("CONTRIB#"));
  for (const other of ["META", "INVITE#a", "JOURNEY#a", "MINUTES", "PROMOTION", "UTT#1"]) {
    assert.ok(other > v[":hi"] || other < v[":lo"], `${other} is outside the range`);
  }
});

if (failed) {
  console.error(`\n${failed} failed`);
  process.exit(1);
}
console.log("\nboard: all passed");
