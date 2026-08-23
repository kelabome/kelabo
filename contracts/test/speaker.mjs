// How a spoken line is attributed, and the one thing that must never come out
// of it.
//
// This label is written into the record and into the prompt the language model
// receives, and — when a participant attaches their own coding agent — onto that
// participant's machine. So the interesting assertion is not that a name comes
// back, it is that an *address* never does, whichever input carried it. A
// regression here is invisible in a live kelabo: the room renders a plausible
// label either way, and the only observer who would notice is the supplier.
import assert from "node:assert/strict";
import { speakerLabel } from "../src/speaker.js";

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

// --- a name wins ------------------------------------------------------------

test("a display name is used as given", () => {
  assert.equal(speakerLabel("Alex", "alex@acme.example"), "Alex");
  assert.equal(speakerLabel("Alex Tran", "alex@acme.example"), "Alex Tran");
});

test("a diarization label passes through", () => {
  // The diarized branch hands us "A"/"B", or the host's rename of it.
  assert.equal(speakerLabel("A", null), "A");
  assert.equal(speakerLabel("Alex", null), "Alex");
});

test("surrounding whitespace is not part of a name", () => {
  assert.equal(speakerLabel("  Alex  ", null), "Alex");
  assert.equal(speakerLabel("   ", "alex@acme.example"), "alex");
});

// --- no address ever comes back ---------------------------------------------

test("the identity fallback is the local part, never the address", () => {
  // The path that mattered: a client that sends no displayName at all.
  assert.equal(speakerLabel(undefined, "alex@acme.example"), "alex");
  assert.equal(speakerLabel(null, "alex@acme.example"), "alex");
  assert.equal(speakerLabel("", "alex@acme.example"), "alex");
});

test("a display name that IS an address is reduced too", () => {
  // The server does not get to assume the client was careful.
  assert.equal(speakerLabel("alex@acme.example", null), "alex");
  assert.equal(speakerLabel("alex@acme.example", "alex@acme.example"), "alex");
});

test("a name that merely contains an address is left alone", () => {
  // Someone who types this as their public label has chosen it, and mangling it
  // to "Alex (alex" would be worse than carrying it.
  assert.equal(speakerLabel("Alex (alex@acme.example)", null), "Alex (alex@acme.example)");
});

test("a malformed address still loses its domain", () => {
  assert.equal(speakerLabel(null, "alex@acme@example"), "alex");
  assert.equal(speakerLabel("alex@@acme", null), "alex");
});

test("an address with no local part does not become an empty label", () => {
  assert.equal(speakerLabel(null, "@acme.example"), "Speaker");
  assert.equal(speakerLabel("@acme.example", "alex@acme.example"), "alex");
});

// --- guests and gaps --------------------------------------------------------

test("a guest identity is a guest, not a uuid", () => {
  assert.equal(speakerLabel(null, "guest:2f1c8a4e-0000-4000-8000-000000000000"), "Guest");
  assert.equal(speakerLabel("", "GUEST:abc"), "Guest");
  // A guest who gave a name is called by it.
  assert.equal(speakerLabel("Sam", "guest:2f1c8a4e"), "Sam");
});

test("nothing to attribute to still yields a label", () => {
  // Downstream requires a non-empty speaker; a blank renders as an
  // unattributed bubble and reads as a bug.
  assert.equal(speakerLabel(null, null), "Speaker");
  assert.equal(speakerLabel("", ""), "Speaker");
  assert.equal(speakerLabel(undefined, undefined), "Speaker");
});

test("an identity that is neither guest nor address is used as-is", () => {
  assert.equal(speakerLabel(null, "service-account"), "service-account");
});

// --- bounds -----------------------------------------------------------------

test("a label is capped, whichever input produced it", () => {
  // `displayName` is capped at 64 by captionPostSchema; without the same cap
  // here, omitting it and letting a long identity through would be a way to
  // exceed that.
  const long = "n".repeat(200);
  assert.equal(speakerLabel(long, null).length, 64);
  assert.equal(speakerLabel(null, `${long}@acme.example`).length, 64);
  assert.equal(speakerLabel(null, long).length, 64);
});

// --- the invariant, swept ---------------------------------------------------

test("no input produces a bare email address", () => {
  const inputs = [
    "alex@acme.example",
    "  alex@acme.example  ",
    "a@b",
    "alex@acme@example",
    "@acme.example",
    "guest:abc",
    "Alex",
    "",
    null,
    undefined,
  ];
  const isBareAddress = (s) => !/\s/.test(s) && s.includes("@");
  for (const name of inputs) {
    for (const identity of inputs) {
      const label = speakerLabel(name, identity);
      assert.equal(typeof label, "string");
      assert.ok(label.length > 0, `empty label for (${name}, ${identity})`);
      assert.ok(
        !isBareAddress(label),
        `label "${label}" is an address, from (${name}, ${identity})`
      );
    }
  }
});

console.log(`contracts/speaker: ${passed} passed`);
