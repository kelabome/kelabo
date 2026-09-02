// Conference audio: the transport that works offline, and the one that fails.
//
// The harness fills the `rtc` credential slot but points the Cloudflare API at
// a port nothing listens on (see harness/env.mjs for why the slot must be
// filled at all). That splits the two transports cleanly and offline:
//
//   mesh  signalling is pure Gateway relay and ICE is best-effort, so it falls
//         back to STUN-only and two contexts on one machine connect over host
//         candidates. Nothing leaves the machine.
//   sfu   cannot reach its API, so it reports `rtc_unavailable` — the real
//         degradation path, refused instantly rather than by a timeout.
//
// What both tests are really for is the promise in docs 19: three capabilities,
// three independent fates. A call that fails must not take the board or the
// transcript with it.

import { test, expect } from "../fixtures/test.mjs";
import { room } from "../fixtures/pages.mjs";

test("an SFU kelabo whose provider is unreachable says so, and keeps working", async ({ alice }) => {
  const { page, api } = alice;
  const kelabo = await api.createKelabo({ title: "SFU kelabo" });
  await alice.enterKelabo(kelabo.kelaboId, { displayName: "Alice" });

  // The connection light is the room's own account of the call. Whatever the
  // copy says, it must not claim to be connected.
  await expect(room(page).connectionStatus).not.toContainText(/on the call/i, { timeout: 25_000 });

  // The claim that captions and the board are unaffected, tested rather than
  // trusted — this is the whole point of degrading instead of failing.
  const composer = await room(page).openPanel("Messages");
  await composer.fill("The call is down but this still goes through.");
  await composer.press("Enter");
  await expect(room(page).line("The call is down but this still goes through.")).toBeVisible({ timeout: 20_000 });
});

test("a mesh kelabo connects two participants with no reachable Cloudflare", async ({ person }) => {
  const alice = await person("alice");
  const bob = await person("bob");
  const kelabo = await alice.api.createKelabo({ title: "Mesh kelabo", rtcMode: "mesh" });
  await alice.enterKelabo(kelabo.kelaboId, { displayName: "Alice" });
  await bob.enterKelabo(kelabo.kelaboId, { displayName: "Bob" });

  await expect(room(alice.page).participantCount(2)).toBeVisible({ timeout: 20_000 });
  // The badge only renders when the room resolved its transport as mesh from
  // the Gateway's own join answer (spa/src/room/RoomShell.jsx:451) — so this is
  // an assertion about the server's decision, not about a checkbox.
  await expect(alice.page.getByText("P2P secure").first()).toBeVisible({ timeout: 25_000 });

  // And a peer connection actually reached a connected state. Asked of the
  // browser, because a room can look joined while no media flows — which in a
  // live kelabo is indistinguishable from a bad network, and is exactly the
  // failure `spa/src/rtc/reconcile.js` exists to reason about.
  await expect
    .poll(async () => (await room(alice.page).connectionStatus.textContent()) ?? "", {
      timeout: 40_000,
      message: "the mesh call never reported a connection",
    })
    .toMatch(/mesh|peer-to-peer|on the call|connected/i);
});

test("a call that cannot connect does not silence the assistant", async ({ alice, voice }) => {
  // The independence claim, at its most fragile point: an `rtc_unavailable`
  // that takes the room's error handling with it and stops the board too.
  //
  // ONE browser, not two. The second participant is here to say something, and
  // nothing is ever asserted about their screen — so they are an API client
  // (the `voice` fixture) rather than a Chromium context. This test was the
  // heaviest in the suite while they had one: two rooms, two failing SFU
  // negotiations with their retry backoff, and an agent turn, all in series.
  // It passed on an idle machine and timed out on a loaded one, which is the
  // worst kind of test to own.
  const { page, api } = alice;
  const kelabo = await api.createKelabo({ title: "Degraded kelabo" });
  await alice.enterKelabo(kelabo.kelaboId, { displayName: "Alice" });
  const bob = await voice(kelabo.kelaboId, "bob");

  // Alice's own stream, not the roster count: Bob has no browser, so he never
  // subscribes and never appears in the roster (see the `voice` fixture). What
  // has to be true before he speaks is that ALICE is listening.
  await expect(room(page).connectionStatus).toContainText(/Connected/i, { timeout: 25_000 });

  for (const n of [1, 2]) {
    await bob.caption(kelabo.kelaboId, {
      messageId: `deg${n}-${Date.now()}`,
      text: "What is the current LTS version?",
      source: "speech",
    });
  }
  await room(page).openPanel("Board");
  await expect(page.locator(".side").getByText(/scripted offline result/i).first()).toBeVisible({ timeout: 30_000 });
});
