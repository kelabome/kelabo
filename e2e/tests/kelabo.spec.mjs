// Creating a kelabo, getting into it, and ending it.
//
// The create page is driven through the UI because its checkboxes are decisions
// with consequences elsewhere — "Secure kelabo" is what makes `rtcMode` mesh,
// and a kelabo's `rtcMode` never changes after creation, so getting it wrong
// here cannot be corrected later by anything.

import { test, expect } from "../fixtures/test.mjs";
import { room, shell, toggle } from "../fixtures/pages.mjs";

test("a host creates a kelabo, waits in the lobby, and starts it", async ({ alice }) => {
  const { page } = alice;

  await shell(page).newKelabo.click();
  await expect(page.getByRole("heading", { name: "Create a kelabo" })).toBeVisible();

  await page.getByRole("textbox", { name: "Kelabo title" }).fill("Quarterly planning");
  await page.getByRole("button", { name: "Create kelabo" }).click();

  // The lobby, not the room: creating puts the host in front of the invite
  // link first, which is the whole reason the lobby exists.
  await expect(page).toHaveURL(/\/m\/[0-9a-f-]+\/lobby/, { timeout: 15_000 });
  await expect(page.getByRole("heading", { name: "Quarterly planning" })).toBeVisible();
  await expect(page.getByText(/^http:\/\/localhost:5173\/join\//)).toBeVisible();

  await page.getByRole("link", { name: "Start" }).click();
  await expect(page).toHaveURL(/\/m\/[0-9a-f-]+$/);
  await expect(room(page).endKelabo).toBeVisible();
});

test("the secure toggle makes it a mesh kelabo, and that is durable", async ({ alice }) => {
  const { page, api } = alice;

  await page.goto("/new");
  await page.getByRole("textbox", { name: "Kelabo title" }).fill("Secure sync");
  await toggle(page, "Secure peer-to-peer kelabo").set(true);
  await page.getByRole("button", { name: "Create kelabo" }).click();
  await expect(page).toHaveURL(/\/m\/([0-9a-f-]+)\/lobby/, { timeout: 15_000 });

  const kelaboId = page.url().match(/\/m\/([0-9a-f-]+)\/lobby/)[1];
  // Read back from the server, not from the page: the claim is that the
  // transport was PERSISTED, and a checkbox that only styled itself would
  // satisfy any assertion made against the DOM.
  const joined = await api.joinKelabo(kelaboId, { displayName: "Alice" });
  expect(joined.rtcMode).toBe("mesh");
});

test("a second person joins by the invite link and both appear in the room", async ({ person }) => {
  const alice = await person("alice");
  const bob = await person("bob");

  const kelabo = await alice.api.createKelabo({ title: "Two-person kelabo" });
  await alice.enterKelabo(kelabo.kelaboId, { displayName: "Alice" });
  await expect(room(alice.page).endKelabo).toBeVisible();

  // Bob takes the link a host would have sent him, rather than the room URL —
  // the join page is where a name is chosen and the participant cookie is
  // minted, and skipping it is skipping the thing under test.
  await bob.page.goto(`/join/${kelabo.kelaboId}`);
  const nameField = bob.page.getByRole("textbox").first();
  await nameField.fill("Bob");
  await bob.page.getByRole("button", { name: /join|enter/i }).first().click();

  await expect(bob.page).toHaveURL(new RegExp(`/m/${kelabo.kelaboId}`), { timeout: 20_000 });
  await expect(bob.page.getByRole("button", { name: /leave/i }).first()).toBeVisible({ timeout: 20_000 });

  // Two in the room, seen from the host's side. Asserted on the ROSTER count
  // rather than on a tile bearing Bob's name: whether a participant gets a
  // stage tile depends on the join mode and the layout, and neither is what
  // this test is about. That chip is fed by the `roster` SSE event
  // (spa/src/room/RoomShell.jsx:437) and is null until the stream delivers one
  // — so this is also the proof that Alice's stream saw Bob arrive.
  await expect(alice.page.getByTitle("2 in the kelabo now")).toBeVisible({ timeout: 20_000 });
});

test("ending a kelabo closes it for everyone and files it under Kelabos", async ({ alice }) => {
  const { page, api } = alice;
  const kelabo = await api.createKelabo({ title: "Ends here" });
  await alice.enterKelabo(kelabo.kelaboId, { displayName: "Alice" });

  // Through `room().click`, which re-wakes the control bar before every
  // attempt — a faded bar is covered by the stage rather than hidden, so a
  // plain click is intercepted rather than refused (see fixtures/pages.mjs).
  await room(page).click(room(page).endKelabo);
  // The confirm step, if the product has one. Tolerated rather than required:
  // whether ending asks twice is a product decision, and pinning it here would
  // fail the day it changes without anything actually being broken.
  const confirm = page.getByRole("button", { name: /^(end|end kelabo|confirm|yes)/i }).last();
  if (await confirm.isVisible().catch(() => false)) await confirm.click();

  // The room does NOT navigate away — it raises a dialog and closes the
  // stream. That is deliberate: a host who ends a kelabo by accident would
  // otherwise lose the page before reading anything.
  const ended = room(page).endedDialog;
  await expect(ended).toBeVisible({ timeout: 20_000 });
  await expect(room(page).connectionStatus).toContainText(/ended/i);

  await ended.getByRole("link", { name: "Open kelabo" }).click();
  await expect(page).toHaveURL(new RegExp(`/kelabos/${kelabo.kelaboId}`), { timeout: 20_000 });

  await page.goto("/kelabos");
  await expect(page.getByText("Ends here").first()).toBeVisible({ timeout: 20_000 });
});
