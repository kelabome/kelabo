// The expression evaluator, on its own.
//
// It is pure, so it gets a plain node test — and it needs one, because the two
// defects it has already had were both silent in the wrong direction. A
// condition that evaluates to the wrong boolean does not throw; it returns the
// wrong rows, and the suite then fails somewhere else entirely with a message
// about a missing message bubble. Both cases below are regressions, not
// hypotheticals.

import assert from "node:assert/strict";
import { evaluateCondition, applyUpdate, project } from "./expr.mjs";

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test("BETWEEN's AND is part of the comparison, not a conjunction", () => {
  // `queryJourneyMessages` (gateway/src/journeys.js:1199) issues exactly this.
  // Splitting on the inner AND left `SK BETWEEN :lo` as a whole expression,
  // which threw — loudly, which is the only reason it was cheap to find.
  const expr = "PK = :pk AND SK BETWEEN :lo AND :hi";
  const values = { ":pk": "JOURNEY#1", ":lo": "MSG#0001", ":hi": "MSG#0009" };
  assert.equal(evaluateCondition(expr, { PK: "JOURNEY#1", SK: "MSG#0005" }, {}, values), true);
  assert.equal(evaluateCondition(expr, { PK: "JOURNEY#1", SK: "MSG#0099" }, {}, values), false);
  assert.equal(evaluateCondition(expr, { PK: "OTHER", SK: "MSG#0005" }, {}, values), false);
});

test("a counter increments through if_not_exists", () => {
  // `SET n = if_not_exists(n, :zero) + :one` — the idiom every rollup counter
  // in the repository uses. A first attempt refused any left operand
  // containing a bracket, so this silently evaluated to `undefined` and every
  // counter stayed unset.
  const values = { ":zero": 0, ":one": 1 };
  const fresh = {};
  applyUpdate("SET n = if_not_exists(n, :zero) + :one", fresh, {}, values);
  assert.equal(fresh.n, 1);
  applyUpdate("SET n = if_not_exists(n, :zero) + :one", fresh, {}, values);
  assert.equal(fresh.n, 2);
});

test("SET and REMOVE in one expression, with aliased names", () => {
  const item = { text: "hello", deletedAt: undefined };
  applyUpdate("SET deletedAt = :at, deletedBy = :by REMOVE #text", item, { "#text": "text" }, { ":at": 7, ":by": "me" });
  assert.equal(item.deletedAt, 7);
  assert.equal(item.deletedBy, "me");
  assert.equal("text" in item, false);
});

test("attribute_exists / attribute_not_exists against an absent item", () => {
  assert.equal(evaluateCondition("attribute_not_exists(PK)", null, {}, {}), true);
  assert.equal(evaluateCondition("attribute_exists(PK)", null, {}, {}), false);
  assert.equal(evaluateCondition("attribute_not_exists(PK) AND attribute_not_exists(SK)", null, {}, {}), true);
  assert.equal(evaluateCondition("attribute_not_exists(PK)", { PK: "x" }, {}, {}), false);
});

test("OR binds looser than AND", () => {
  const item = { a: 1, b: 2 };
  assert.equal(evaluateCondition("attribute_not_exists(z) OR a = :two", item, {}, { ":two": 2 }), true);
  assert.equal(evaluateCondition("a = :two OR b = :two", item, {}, { ":two": 2 }), true);
  assert.equal(evaluateCondition("a = :two AND b = :two", item, {}, { ":two": 2 }), false);
});

test("an absent attribute compares false on every ordering operator", () => {
  // DynamoDB's rule, and not JavaScript's: `undefined < 5` is false already,
  // but `undefined >= 0` would be false too and `null < 5` would be TRUE.
  assert.equal(evaluateCondition("missing < :n", { a: 1 }, {}, { ":n": 5 }), false);
  assert.equal(evaluateCondition("missing > :n", { a: 1 }, {}, { ":n": 5 }), false);
  assert.equal(evaluateCondition("missing <> :n", { a: 1 }, {}, { ":n": 5 }), true);
});

test("begins_with, and a value placeholder that carries an AND", () => {
  const item = { SK: "CONTRIB#0001 AND MORE" };
  assert.equal(evaluateCondition("begins_with(SK, :p)", item, {}, { ":p": "CONTRIB#" }), true);
  assert.equal(evaluateCondition("begins_with(SK, :p)", item, {}, { ":p": "UTT#" }), false);
});

test("list_append grows a list and tolerates an absent one", () => {
  const item = {};
  applyUpdate("SET participants = list_append(if_not_exists(participants, :empty), :p)", item, {}, { ":empty": [], ":p": ["a"] });
  assert.deepEqual(item.participants, ["a"]);
  applyUpdate("SET participants = list_append(if_not_exists(participants, :empty), :p)", item, {}, { ":empty": [], ":p": ["b"] });
  assert.deepEqual(item.participants, ["a", "b"]);
});

test("a projection keeps only what it names, aliases included", () => {
  const item = { PK: "a", SK: "b", secret: "no", version: 3 };
  assert.deepEqual(project(item, "PK, SK, #v", { "#v": "version" }), { PK: "a", SK: "b", version: 3 });
});

test("an unsupported construct throws rather than evaluating to true", () => {
  // The property this file exists to protect. A permissive evaluator turns
  // every `attribute_not_exists(PK)` guard into a no-op and the suite then
  // passes against a store with none of the concurrency behaviour the product
  // is written against.
  assert.throws(() => evaluateCondition("contains(tags, :t)", { tags: [] }, {}, { ":t": "x" }), /unsupported condition/);
  assert.throws(() => applyUpdate("ADD n :one", {}, {}, { ":one": 1 }), /unsupported update action/);
  assert.throws(() => evaluateCondition("a = :missing", { a: 1 }, {}, {}), /unknown ExpressionAttributeValue/);
  assert.throws(() => evaluateCondition("#x = :v", { a: 1 }, {}, { ":v": 1 }), /unknown ExpressionAttributeName/);
});

let failed = 0;
for (const t of tests) {
  try {
    t.fn();
    console.log(`ok   ${t.name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${t.name}`);
    console.error(e);
  }
}
console.log(`\ne2e/expr: ${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
