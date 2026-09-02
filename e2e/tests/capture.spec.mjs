// The capture pipeline, driven by a real microphone in a real browser.
//
// This is the suite the fake STT provider exists for. Everything between the
// device and a rendered bubble — `getUserMedia`, the AudioContext graph, the
// resampler, the VAD gate, the composer, the publisher, the SSE fan-out — is
// only reachable this way. The rest of the suite injects captions at the
// Gateway, which is the right shortcut for tests about the transcript but skips
// the whole front half.
//
// Chromium supplies the device (`--use-fake-device-for-media-stream`) and
// `spa/src/stt/fake.js` supplies the words. Nothing reaches a supplier.

import { test, expect } from "../fixtures/test.mjs";
import { room } from "../fixtures/pages.mjs";

/** Say something through the fake provider, from inside the page. */
async function say(page, text) {
  await page.evaluate((line) => {
    if (!window.__kelaboFakeStt) throw new Error("the fake stt provider never connected");
    window.__kelaboFakeStt.say(line);
  }, text);
}

test("the room acquires the microphone and reports transcription live", async ({ alice }) => {
  const { page, api } = alice;
  const kelabo = await api.createKelabo({ title: "Capture kelabo" });
  await alice.enterKelabo(kelabo.kelaboId, { displayName: "Alice" });

  // The connection light is the room's own account of the three capabilities.
  // Asserting on it rather than on an internal means a regression that leaves
  // capture working but never says so still fails — which matters, because the
  // light is the only thing a participant has.
  await expect(room(page).connectionStatus).toContainText(/Fake/i, { timeout: 30_000 });
  await expect(room(page).connectionStatus).toContainText(/Streaming to Fake from your device/i);

  // And the mic really was acquired — one `getUserMedia` for the kelabo
  // (spa/src/rtc/useMicStream.js), shared by capture and the call.
  const tracks = await page.evaluate(async () => {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter((d) => d.kind === "audioinput").length;
  });
  expect(tracks).toBeGreaterThan(0);
});

test("words from the provider become a transcript bubble", async ({ alice }) => {
  const { page, api } = alice;
  const kelabo = await api.createKelabo({ title: "Spoken kelabo" });
  await alice.enterKelabo(kelabo.kelaboId, { displayName: "Alice" });
  await expect(room(page).connectionStatus).toContainText(/Streaming to Fake/i, { timeout: 30_000 });

  await room(page).openPanel("Transcript");
  await say(page, "We should pin the Node version in CI.");

  // Through the composer and onto the speaker's own screen — the `mine: true`
  // half of the one reducer.
  await expect(room(page).line("We should pin the Node version in CI.")).toBeVisible({ timeout: 25_000 });
});

test("what one participant speaks reaches the other, and is persisted", async ({ person }) => {
  const alice = await person("alice");
  const bob = await person("bob");
  const kelabo = await alice.api.createKelabo({ title: "Two-way capture" });
  await alice.enterKelabo(kelabo.kelaboId, { displayName: "Alice" });
  await bob.enterKelabo(kelabo.kelaboId, { displayName: "Bob" });
  await expect(room(alice.page).participantCount(2)).toBeVisible({ timeout: 20_000 });
  await expect(room(alice.page).connectionStatus).toContainText(/Streaming to Fake/i, { timeout: 30_000 });

  await room(bob.page).openPanel("Transcript");
  await say(alice.page, "The migration is finished.");

  // The listener's screen: the `mine: false` half of the same reducer, and the
  // assertion that would have caught a speaker and a listener rendering
  // different bubbles.
  await expect(room(bob.page).line("The migration is finished.")).toBeVisible({ timeout: 25_000 });

  // And it was SEALED and stored, not merely relayed — the difference between
  // a caption the room saw and a transcript the record will have.
  await expect
    .poll(
      async () => (await alice.api.captionHistory(kelabo.kelaboId)).utterances.map((u) => u.text).join(" | "),
      { timeout: 25_000, message: "the spoken line never reached the transcript history" }
    )
    .toContain("The migration is finished.");
});
