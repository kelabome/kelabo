// The board: the assistant's only way into the room.
//
// The agent here is real — the real TriggerGate, MainAgent and SubAgent, in the
// real worker thread, talking to a real OpenAI-compatible client. What is
// scripted is the model at the other end of that client
// (`e2e/harness/llmServer.mjs`), so a turn is deterministic without being
// short-circuited. That distinction is the point: an injected provider object
// would skip the request shaping, the tool-call parsing and the streaming
// reassembly, which is where provider bugs actually live.

import { test, expect } from "../fixtures/test.mjs";
import { room } from "../fixtures/pages.mjs";

test("a question in the room becomes a board contribution", async ({ person }) => {
  const alice = await person("alice");
  const bob = await person("bob");
  const kelabo = await alice.api.createKelabo({ title: "Board kelabo" });
  await alice.enterKelabo(kelabo.kelaboId, { displayName: "Alice" });
  await bob.enterKelabo(kelabo.kelaboId, { displayName: "Bob" });
  await expect(room(alice.page).participantCount(2)).toBeVisible({ timeout: 20_000 });

  const board = await room(alice.page).openPanel("Board");
  expect(board).toBeTruthy();

  // Two lines, because the gate reads the last line of a window and one caption
  // is not yet a conversation.
  for (const n of [1, 2]) {
    await bob.api.caption(kelabo.kelaboId, {
      messageId: `q${n}-${Date.now()}`,
      text: "What is the latest version of Node.js?",
      source: "speech",
    });
  }

  // The card arrives over the same SSE stream as everything else. Asserted in
  // the BROWSER rather than through `GET /kelabos/:id/board`, because the
  // harness selftest already proves the server side — what is unproven until
  // here is that a contribution reaches a rendered card.
  await expect(alice.page.locator(".side").getByText(/scripted offline result/i).first()).toBeVisible({ timeout: 30_000 });
});

test("the board is shared: both participants see the same card", async ({ person }) => {
  const alice = await person("alice");
  const bob = await person("bob");
  const kelabo = await alice.api.createKelabo({ title: "Shared board" });
  await alice.enterKelabo(kelabo.kelaboId, { displayName: "Alice" });
  await bob.enterKelabo(kelabo.kelaboId, { displayName: "Bob" });
  await expect(room(alice.page).participantCount(2)).toBeVisible({ timeout: 20_000 });

  await room(alice.page).openPanel("Board");
  await room(bob.page).openPanel("Board");

  for (const n of [1, 2]) {
    await bob.api.caption(kelabo.kelaboId, {
      messageId: `shared${n}-${Date.now()}`,
      text: "Does anyone know what the current release is?",
      source: "speech",
    });
  }

  const card = /scripted offline result/i;
  await expect(alice.page.locator(".side").getByText(card).first()).toBeVisible({ timeout: 30_000 });
  await expect(bob.page.locator(".side").getByText(card).first()).toBeVisible({ timeout: 30_000 });
});

test("an ordinary remark produces no board card", async ({ person }) => {
  // The other half of the gate, and the more important one: an assistant that
  // answers everything is worse than one that answers nothing. Silence is the
  // default, and nothing but a test can hold it to that.
  const alice = await person("alice");
  const bob = await person("bob");
  const kelabo = await alice.api.createKelabo({ title: "Quiet kelabo" });
  await alice.enterKelabo(kelabo.kelaboId, { displayName: "Alice" });
  await bob.enterKelabo(kelabo.kelaboId, { displayName: "Bob" });
  await expect(room(alice.page).participantCount(2)).toBeVisible({ timeout: 20_000 });

  for (const n of [1, 2, 3]) {
    await bob.api.caption(kelabo.kelaboId, {
      messageId: `chat${n}-${Date.now()}`,
      text: "Right, let us move the chairs and get started.",
      source: "speech",
    });
  }

  // Asserted against the server rather than the DOM: "no card appeared" needs
  // to be true of the board itself, not merely of a panel that might not have
  // been open. A generous wait, because a false negative here is a test that
  // passes while the assistant is in fact interrupting the room.
  await alice.page.waitForTimeout(8_000);
  const { contributions } = await alice.api.board(kelabo.kelaboId);
  expect(contributions, `the assistant posted when it should have stayed silent: ${JSON.stringify(contributions)}`).toHaveLength(0);
});
