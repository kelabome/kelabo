// DynamoDB reserved words in hand-written expressions (notes #11).
//
// `cancelScheduledKelabo` wrote `SET ... ttl = :ttl`. TTL is a reserved word,
// so DynamoDB rejected the whole update with a ValidationException and every
// cancel came back 500. Nothing caught it: the stub db in these tests is a Map,
// so it happily "cancelled" the kelabo, and the only place the truth lived was
// a real table nobody hits in a test run.
//
// So this test does not exercise the code — it reads it. Every expression
// literal in db.js is scanned for a bare attribute name that DynamoDB will
// refuse, which is the one property the stub structurally cannot check. Aliasing
// (`#ttl` + ExpressionAttributeNames) is always legal, so "alias it" is the only
// fix and there are no false positives to argue with.
//
// WORDS below is not the full reserved list (it runs to ~570 entries). It is the
// subset that could plausibly appear as an attribute name in this schema, plus
// every word this codebase has actually been bitten by. Adding an attribute
// whose name is reserved but unlisted still passes — add the word when you add
// the attribute.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const WORDS = new Set(
  `absolute action add all alter and any append as asc at attribute authorization
   between block by bytes cache call cancel cascade case cast column comment commit
   condition connection copy count counter create current cursor data database date
   day default define delete desc describe descriptor detail disable distinct do
   domain double drop duration each element else enable end error escape eval
   exclusive exists exit explain expression false family field file filter first
   float for force format free from full function get global grant group handler
   hash hour identified identity if ignore immediate import in index indexed
   initial inner input insert instead int integer intersect interval into is
   isolation item items iterator join key keys language last leading left less
   level like limit list load local location lock log login long loop map match
   max member merge method metrics min minute missing mode modify module month
   name names natural new next no none not null number of off offset on online
   only open operator option or order other others out outer output over owner
   parameter partial partition password path percent period permission position
   precision prepare primary priority private privileges procedure public put
   query quit quorum raise range raw read reads real record redo reference
   references regexp region reindex relative remove rename repeatable replace
   request reset resource response result return returning returns reverse revoke
   right role rollback rollup row rows rule sample scan schema scope search second
   section select self semi sensitive separate sequence serializable session set
   sets shard share show signal similar size skewed smallint snapshot some source
   sql stable start state static status storage store stored stream string struct
   style sub submultiset subpartition substring subtype sum super synonym system
   table tablesample temp temporary terminated text than then throughput time
   timestamp timezone tinyint to token total touch trailing transaction transform
   translate translation trigger trim true truncate ttl tuple type under undo
   union unique unit unknown unlogged unnest unprocessed unsigned until update
   use user using uuid vacuum value values varchar variable variance varint
   varying view views virtual void wait when where while window with within
   without work wrapped write year zone`
    .split(/\s+/)
    .filter(Boolean)
);

// Functions DynamoDB defines; they are not attribute names.
const FUNCTIONS = new Set([
  "attribute_exists",
  "attribute_not_exists",
  "attribute_type",
  "begins_with",
  "contains",
  "if_not_exists",
  "list_append",
  "size",
]);

const src = readFileSync(fileURLToPath(new URL("../src/db.js", import.meta.url)), "utf8");

// Every string or template literal that reads like an expression. Template
// literals matter: `SET ${sets.join(", ")}` interpolates names that were built
// with `#`-aliases, and the surrounding literal is still worth scanning for the
// static half.
const EXPRESSION = /(?:Update|Condition|KeyCondition|Filter|Projection)Expression:\s*((?:"[^"]*"|`[^`]*`|'[^']*')(?:\s*\+\s*(?:"[^"]*"|`[^`]*`|'[^']*'|\([^)]*\)))*)/g;

// A bare identifier: not preceded by `#` (aliased), `:` (a value), `.` (a nested
// path we do not resolve) or `$` (inside an interpolation).
const IDENT = /(^|[^#:.\w$])([A-Za-z_][A-Za-z0-9_]*)/g;

const offences = [];
for (const m of src.matchAll(EXPRESSION)) {
  const literal = m[1];
  // Drop `${...}` interpolations — what they expand to is built from aliases.
  const scanned = literal.replace(/\$\{[^}]*\}/g, " ");
  for (const t of scanned.matchAll(IDENT)) {
    const word = t[2];
    const lower = word.toLowerCase();
    if (FUNCTIONS.has(word)) continue;
    // Expression keywords themselves.
    if (["SET", "REMOVE", "ADD", "DELETE", "AND", "OR", "NOT", "BETWEEN", "IN"].includes(word)) continue;
    if (!WORDS.has(lower)) continue;
    offences.push({ word, at: src.slice(0, m.index).split("\n").length, literal: literal.trim() });
  }
}

assert.deepEqual(
  offences,
  [],
  offences
    .map((o) => `db.js:${o.at} uses reserved word "${o.word}" un-aliased — write #${o.word} and add it to ExpressionAttributeNames\n    ${o.literal}`)
    .join("\n")
);

// A FilterExpression may not name the table's own key attributes. `deleteJourney`
// filtered `SK <> :meta`, DynamoDB answered "Filter Expression can only contain
// non-primary key attributes", and every journey delete came back 500 — while
// the Map-backed stub deleted it happily. Same blind spot, same remedy: read the
// source. Applies to both services' db.js; every table here keys on PK/SK.
const FILTER = /FilterExpression:\s*("[^"]*"|`[^`]*`|'[^']*')/g;
const KEY_IN_FILTER = /(^|[^#:.\w$])(PK|SK)\b/;
const keyOffences = [];
for (const rel of ["../src/db.js", "../../gateway/src/db.js"]) {
  let text;
  try {
    text = readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
  } catch {
    continue;
  }
  for (const m of text.matchAll(FILTER)) {
    const scanned = m[1].replace(/\$\{[^}]*\}/g, " ");
    if (KEY_IN_FILTER.test(scanned)) {
      keyOffences.push(`${rel.replace(/^(\.\.\/)+/, "")}:${text.slice(0, m.index).split("\n").length} filters on a key attribute — use the KeyConditionExpression or filter the items in code\n    ${m[1]}`);
    }
  }
}
assert.deepEqual(keyOffences, [], keyOffences.join("\n"));

console.log(`rest-api/reserved: ${[...src.matchAll(EXPRESSION)].length} expressions scanned, 0 reserved words un-aliased, 0 key attributes filtered`);
