// Records: what is left after the kelabo.
//
// The chain under test crosses both services and both stores, which is why it
// is worth a browser test at all: the Gateway writes the archive object to S3
// at end, stamps a row per participant in the history table, and the control
// plane serves both back to the record page. A test that stubbed either half
// would prove nothing about the join between them.

import { test, expect } from "../fixtures/test.mjs";
import { room } from "../fixtures/pages.mjs";

/** Run a short kelabo with something said in it, and end it. */
async function aFinishedKelabo(person, title) {
  const alice = await person("alice");
  const bob = await person("bob");
  const kelabo = await alice.api.createKelabo({ title });
  await alice.enterKelabo(kelabo.kelaboId, { displayName: "Alice" });
  await bob.enterKelabo(kelabo.kelaboId, { displayName: "Bob" });
  await expect(room(alice.page).participantCount(2)).toBeVisible({ timeout: 20_000 });

  await bob.api.caption(kelabo.kelaboId, {
    messageId: `rec-${Date.now()}`,
    text: "We agreed to ship on Tuesday.",
    source: "speech",
  });
  await expect(room(alice.page).connectionStatus).toBeVisible();

  await alice.api.endKelabo(kelabo.kelaboId);
  return { alice, bob, kelaboId: kelabo.kelaboId };
}

test("an ended kelabo becomes a record both participants can open", async ({ person }) => {
  const title = `Shipped ${Date.now().toString(36)}`;
  const { alice, bob, kelaboId } = await aFinishedKelabo(person, title);

  // The host.
  await alice.page.goto("/kelabos");
  await expect(alice.page.getByText(title).first()).toBeVisible({ timeout: 20_000 });

  // And the other participant — the history table is indexed by participant,
  // not by host, and "only the host can find it afterwards" is the bug that
  // index exists to prevent.
  await bob.page.goto("/kelabos");
  await expect(bob.page.getByText(title).first()).toBeVisible({ timeout: 20_000 });

  await bob.page.getByText(title).first().click();
  await expect(bob.page).toHaveURL(new RegExp(`/kelabos/${kelaboId}`), { timeout: 20_000 });
});

test("the record carries the transcript that was spoken in the kelabo", async ({ person }) => {
  const title = `Transcribed ${Date.now().toString(36)}`;
  const { alice, kelaboId } = await aFinishedKelabo(person, title);

  await alice.page.goto(`/kelabos/${kelaboId}`);
  // The words came from the Gateway's archive object in S3, fetched by the
  // control plane — the only place in the suite where that crossing is
  // observable from a browser.
  await expect(alice.page.getByText("We agreed to ship on Tuesday.").first()).toBeVisible({ timeout: 25_000 });
});

test("search finds a record by its title", async ({ person }) => {
  const title = `Findable ${Date.now().toString(36)}`;
  const { alice } = await aFinishedKelabo(person, title);

  await alice.page.goto("/kelabos");
  await alice.page.getByRole("textbox", { name: /title, or anything from the minutes/i }).fill(title);
  await expect(alice.page.getByText(title).first()).toBeVisible({ timeout: 20_000 });
});
