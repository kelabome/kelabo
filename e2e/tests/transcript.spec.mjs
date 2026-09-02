// The transcript: one reducer, two directions, and a reload.
//
// The invariant under test is the one docs 13 states and the codebase enforces
// in `spa/src/transcript/`: a speaker's own events and everyone else's SSE
// events go through the SAME `apply()`. A test that only ever looked at the
// sender's screen cannot see that break — the bug it produced was a speaker and
// a listener rendering different bubbles — so every assertion here is made on
// BOTH pages.
//
// No microphone and no STT provider. Typed messages exercise the composer and
// the publisher from inside the browser; injected sealed captions exercise the
// fan-out. Between them they cover the pipeline the room depends on without a
// supplier account.

import { test, expect } from "../fixtures/test.mjs";
import { room } from "../fixtures/pages.mjs";

/** Both participants, in one live kelabo, ready to talk. */
async function twoInARoom(person) {
  const alice = await person("alice");
  const bob = await person("bob");
  const kelabo = await alice.api.createKelabo({ title: "Transcript kelabo" });
  await alice.enterKelabo(kelabo.kelaboId, { displayName: "Alice" });
  await bob.enterKelabo(kelabo.kelaboId, { displayName: "Bob" });
  // Both streams live before anything is said: a message published before the
  // listener's EventSource is open is not lost by the product (history backfills
  // it) but it would make this test pass for the wrong reason.
  await expect(room(alice.page).participantCount(2)).toBeVisible({ timeout: 20_000 });
  await expect(room(bob.page).participantCount(2)).toBeVisible({ timeout: 20_000 });
  return { alice, bob, kelaboId: kelabo.kelaboId };
}

/** Open the side panel on `page`, on the tab that carries what we assert next. */
const openConversation = (page, tab = "Messages") => room(page).openPanel(tab);

/** A line of text inside the side panel of `page`. */
const line = (page, text) => room(page).line(text);

test("a typed message is rendered the same for the sender and the listener", async ({ person }) => {
  const { alice, bob } = await twoInARoom(person);

  const composer = await openConversation(alice.page);
  await composer.fill("Shall we start with the migration?");
  await composer.press("Enter");

  // The sender sees it from their OWN event, the listener from the SSE fan-out
  // — two paths that must produce the same bubble.
  await expect(line(alice.page, "Shall we start with the migration?")).toBeVisible({ timeout: 20_000 });
  await openConversation(bob.page);
  await expect(line(bob.page, "Shall we start with the migration?")).toBeVisible({ timeout: 20_000 });
});

test("spoken transcript reaches the other participant", async ({ person }) => {
  const { alice, bob, kelaboId } = await twoInARoom(person);
  await openConversation(alice.page, "Transcript");

  // Injected as a sealed caption — the exact request `transcript/publisher.js`
  // makes. This is what stands in for speech in a suite with no STT provider.
  //
  // Published as BOB and asserted on ALICE. A speaker drops the echo of their
  // own utterance (spa/src/capture/useCapture.js:688) because it is already in
  // their transcript from the local composer, so injecting as Alice and looking
  // at Alice's screen asserts the opposite of the truth — and passes only if
  // that filter is broken.
  await bob.api.caption(kelaboId, {
    messageId: `spoken-${Date.now()}`,
    text: "The migration lands on Tuesday.",
    source: "speech",
  });

  await expect(line(alice.page, "The migration lands on Tuesday.")).toBeVisible({ timeout: 20_000 });
});

test("a speaker does not see their own utterance twice", async ({ person }) => {
  // The other half of the rule above, asserted directly rather than left as a
  // comment. Alice publishes; Alice's own page must not grow a bubble from the
  // echo, because she has not spoken through her own composer.
  const { alice, kelaboId } = await twoInARoom(person);
  await openConversation(alice.page, "Transcript");

  await alice.api.caption(kelaboId, {
    messageId: `echo-${Date.now()}`,
    text: "This is my own voice coming back.",
    source: "speech",
  });

  await expect(line(alice.page, "This is my own voice coming back.")).toHaveCount(0);
});

test("transcript survives a reload — history backfills what the stream already delivered", async ({ person }) => {
  const { alice, bob, kelaboId } = await twoInARoom(person);
  await openConversation(alice.page, "Transcript");

  await bob.api.caption(kelaboId, { messageId: `before-${Date.now()}`, text: "Said before the reload.", source: "speech" });
  await expect(line(alice.page, "Said before the reload.")).toBeVisible({ timeout: 20_000 });

  await alice.page.reload();
  await openConversation(alice.page, "Transcript");
  // From `GET /caption/history` this time, not from the stream — a different
  // code path producing the same rendered line.
  await expect(line(alice.page, "Said before the reload.")).toBeVisible({ timeout: 20_000 });
});

test("message boundaries belong to the speaker: one messageId is one bubble", async ({ person }) => {
  const { alice, bob, kelaboId } = await twoInARoom(person);
  await openConversation(alice.page, "Transcript");

  // Two sentences under ONE messageId. Nothing downstream may re-derive a
  // boundary from adjacency or timing and split them — that rule is why
  // `messageId` is the only grouping key.
  const messageId = `grouped-${Date.now()}`;
  await bob.api.caption(kelaboId, { messageId, text: "First half. Second half.", source: "speech" });

  const bubble = line(alice.page, "First half. Second half.");
  await expect(bubble).toBeVisible({ timeout: 20_000 });
  await expect(bubble).toHaveCount(1);
});
