// Addressing the assistant in typed text (notes #4).
//
// This matcher is a gate bypass: a match means the caption skips the trigger
// gate, the cooldown and the rate cap, and the agent runs a turn no matter what
// the kelabo is doing. So both directions are worth asserting — a miss loses a
// question a participant asked in so many words, and a false positive is an
// unstoppable lookup nobody wanted.
import assert from "node:assert/strict";
import { addressesAssistant, stripAddress, parseMentionHandles, resolveMentions } from "../src/mention.js";

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
  } catch (err) {
    console.error(`FAIL ${name}`);
    throw err;
  }
}

// --- addressed --------------------------------------------------------------

test("@mention anywhere in the line is an address", () => {
  assert.equal(addressesAssistant("@kelabo what is the retry policy?"), true);
  assert.equal(addressesAssistant("could someone ask @kelabo about this"), true);
  assert.equal(addressesAssistant("@Kelabo WHAT"), true);
});

test("the bare name in vocative position is an address", () => {
  assert.equal(addressesAssistant("kelabo, what is the retry policy?"), true);
  assert.equal(addressesAssistant("Kelabo: check the changelog"), true);
  assert.equal(addressesAssistant("  kelabo - look this up"), true);
});

// --- not addressed ----------------------------------------------------------

test("the bare name mid-sentence is a remark, not an address", () => {
  // Nobody is being asked anything here, and firing a lookup on it would make
  // the assistant impossible to talk *about*.
  assert.equal(addressesAssistant("I asked kelabo yesterday and it was wrong"), false);
  assert.equal(addressesAssistant("kelabo is the name of the product"), false);
});

test("a vocative with nothing after it is not a question", () => {
  assert.equal(addressesAssistant("kelabo,"), false);
  assert.equal(addressesAssistant("kelabo, "), false);
});

test("the name inside a longer word is not a mention", () => {
  assert.equal(addressesAssistant("@kelaboard is a different thing"), false);
  assert.equal(addressesAssistant("email me at alex@kelabo.example"), false);
});

test("empty and junk input never address anyone", () => {
  assert.equal(addressesAssistant(""), false);
  assert.equal(addressesAssistant(null), false);
  assert.equal(addressesAssistant(undefined), false);
});

// --- the query the agent actually receives ----------------------------------

test("stripping removes the address and keeps the question", () => {
  assert.equal(stripAddress("@kelabo what is the retry policy?"), "what is the retry policy?");
  assert.equal(stripAddress("kelabo, what is the retry policy?"), "what is the retry policy?");
  assert.equal(stripAddress("Kelabo: check the changelog"), "check the changelog");
});

test("a mid-sentence mention keeps its surrounding words", () => {
  assert.equal(stripAddress("could someone ask @kelabo about this"), "could someone ask about this");
});

test("stripping never yields an empty query", () => {
  // An empty query downstream titles a board card with nothing at all, which is
  // worse than echoing back what little was typed.
  assert.equal(stripAddress("@kelabo"), "@kelabo");
  assert.equal(stripAddress("  @kelabo  "), "@kelabo");
});

// --- mentioning a person (docs 20 §19.8) ------------------------------------
//
// A weaker consequence than addressing the assistant — a badge, not an LLM
// call — but the false positives are the interesting half: an email address
// written out in prose is the single most likely thing to be mistaken for a
// mention, and it appears in exactly the kind of message people write here.

test("handles are found, lowercased and de-duplicated in order", () => {
  assert.deepEqual(parseMentionHandles("@bob can you look? cc @Carol and @bob"), ["bob", "carol"]);
  assert.deepEqual(parseMentionHandles("@bob@example.com please"), ["bob@example.com"]);
  assert.deepEqual(parseMentionHandles("nothing here"), []);
  assert.deepEqual(parseMentionHandles(""), []);
  assert.deepEqual(parseMentionHandles(null), []);
});

test("an email address written out in prose is not a mention", () => {
  // The whole reason for the lookbehind. Without it this reads as a mention of
  // "@example.com", and everyone whose local part is "example" gets a badge.
  assert.deepEqual(parseMentionHandles("write to bob@example.com about it"), []);
  assert.deepEqual(parseMentionHandles("see foo.bar@example.com"), []);
  // …but the same address deliberately addressed still is one.
  assert.deepEqual(parseMentionHandles("@bob@example.com"), ["bob@example.com"]);
});

test("resolution accepts a local part or a whole address", () => {
  const people = ["bob@example.com", "carol@example.com"];
  assert.deepEqual(resolveMentions("@bob take a look", people), ["bob@example.com"]);
  assert.deepEqual(resolveMentions("@bob@example.com take a look", people), ["bob@example.com"]);
  assert.deepEqual(resolveMentions("@Bob take a look", people), ["bob@example.com"], "case-insensitive");
  assert.deepEqual(resolveMentions("@dave take a look", people), [], "not a member of anything");
  assert.deepEqual(resolveMentions("@bob and @carol", people), ["bob@example.com", "carol@example.com"]);
});

test("an ambiguous local part resolves to nobody rather than to a guess", () => {
  // Notifying both tells the wrong person they were named; picking one does it
  // silently. Neither is better than asking the sender to be specific.
  const people = ["bob@example.com", "bob@other.com"];
  assert.deepEqual(resolveMentions("@bob look", people), []);
  // The unambiguous form still works.
  assert.deepEqual(resolveMentions("@bob@other.com look", people), ["bob@other.com"]);
});

test("the assistant never appears on a human mention list", () => {
  // It is addressed through addressesAssistant, which is a different decision
  // with a different consequence. On this list it would be a person.
  assert.deepEqual(resolveMentions("@kelabo and @bob", ["bob@example.com", "kelabo"]), ["bob@example.com"]);
});

test("the handle matcher is stateless across calls", () => {
  // It is a /g/ regex, so a shared lastIndex between calls would make every
  // other message silently lose its first mention.
  const people = ["bob@example.com"];
  for (let i = 0; i < 3; i++) assert.deepEqual(resolveMentions("@bob hi", people), ["bob@example.com"]);
});

console.log(`contracts/mention: ${passed} passed`);
