// Fuzzy people search (docs 18 §4.8): what someone types, against who they mean.
import assert from "node:assert/strict";
import { editDistance, fold, indexPerson, rankPeople, scorePerson, scoreWord, wordsOf } from "../src/peopleSearch.js";

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

const PEOPLE = [
  { email: "dokafor@example.com", displayName: "Daniel Okafor" },
  { email: "jdanvers@example.com", displayName: "Jordan Danvers" },
  { email: "mdevries@example.com", displayName: "Marianne De Vries" },
  { email: "michael.oconnor@example.com", displayName: "Michael O'Connor" },
  { email: "zoe.nguyen@example.com", displayName: "Zoë Nguyễn" },
  { email: "dispatch@example.com", displayName: "" },
  { email: "ann@partner.example.net", displayName: "Ann Lee" },
];
const top = (q, opts) => rankPeople(q, PEOPLE, opts).map((p) => p.email);
const score = (q, p) => scorePerson(q, indexPerson(p));

await test("folding removes case and accents", () => {
  assert.equal(fold("Zoë NGUYỄN"), "zoe nguyen");
  assert.deepEqual(wordsOf("Michael O'Connor-Smith 2"), ["michael", "o", "connor", "smith", "2"]);
});

await test("edit distance counts a transposition as one slip", () => {
  assert.equal(editDistance("micheal", "michael"), 1);
  assert.equal(editDistance("okafr", "okafor"), 1);
  assert.equal(editDistance("abc", "xyz"), 2);
});

await test("word scores are ordered exact > prefix > typo > inside > in-order", () => {
  const s = (q, w) => scoreWord(q, w);
  assert.ok(s("daniel", "daniel") > s("dan", "daniel"));
  assert.ok(s("dan", "daniel") > s("danile", "daniel"));
  assert.ok(s("danile", "daniel") > s("vries", "mdevries"));
  assert.ok(s("vries", "mdevries") > s("dnl", "daniel"));
  assert.ok(s("dnl", "daniel") > 0);
  assert.equal(s("xq", "daniel"), 0);
  // Short fragments do not fuzzy-match: two letters inside a word is noise.
  assert.equal(s("an", "daniel"), 0);
});

await test("a first name, a surname, or both", () => {
  assert.equal(top("dan")[0], "dokafor@example.com", "first-name prefix beats a surname prefix");
  assert.deepEqual(top("dan").slice(0, 2), ["dokafor@example.com", "jdanvers@example.com"]);
  assert.deepEqual(top("okafor"), ["dokafor@example.com"]);
  assert.deepEqual(top("dan ok"), ["dokafor@example.com"]);
  assert.deepEqual(top("ok dan"), ["dokafor@example.com"], "word order does not matter");
});

await test("every typed word must match", () => {
  assert.deepEqual(top("dan smith"), []);
});

await test("the address, typed as an address, wins outright", () => {
  assert.equal(top("doka")[0], "dokafor@example.com");
  assert.ok(score("dokafor@ex", PEOPLE[0]) >= 1000);
  assert.deepEqual(top("@partner"), ["ann@partner.example.net"]);
});

await test("misspellings and half-remembered names", () => {
  assert.equal(top("micheal")[0], "michael.oconnor@example.com");
  assert.equal(top("okafr")[0], "dokafor@example.com");
  assert.equal(top("devries")[0], "mdevries@example.com", "inside the local part");
  assert.equal(top("de vries")[0], "mdevries@example.com");
  assert.equal(top("oconnor")[0], "michael.oconnor@example.com");
});

await test("accents in the directory do not have to be typed", () => {
  assert.deepEqual(top("zoe nguyen"), ["zoe.nguyen@example.com"]);
});

await test("initials", () => {
  assert.equal(top("do")[0], "dokafor@example.com");
  assert.equal(top("mdv")[0], "mdevries@example.com");
  // Nothing but the initials can match here: no word starts with "mo".
  assert.deepEqual(top("mo"), ["michael.oconnor@example.com"]);
});

await test("somebody with no display name is found by their address", () => {
  assert.deepEqual(top("dispatch"), ["dispatch@example.com"]);
});

await test("a boost reorders matches and never adds a non-match", () => {
  const fav = new Set(["jdanvers@example.com"]);
  const boost = (p) => (fav.has(p.email) ? 15 : 0);
  assert.equal(top("dan", { boost })[0], "jdanvers@example.com");
  assert.deepEqual(top("zzz", { boost: () => 1000 }), []);
});

await test("limit, and a stable order for equal scores", () => {
  const many = Array.from({ length: 20 }, (_, i) => ({ email: `sam${String(i).padStart(2, "0")}@example.com`, displayName: "Sam" }));
  const r = rankPeople("sam", many, { limit: 5 });
  assert.equal(r.length, 5);
  assert.deepEqual(r.map((p) => p.email), many.slice(0, 5).map((p) => p.email));
});

await test("an empty or punctuation-only query matches nobody", () => {
  assert.deepEqual(top(""), []);
  assert.deepEqual(top("  ,. "), []);
});

console.log(`peopleSearch: ${passed} passed`);
