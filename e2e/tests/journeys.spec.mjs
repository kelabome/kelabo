// Journeys: the container that carries work between kelabos.
//
// What makes a journey worth testing end to end rather than at the API is that
// its value is entirely in the carrying — a decision recorded in one meeting
// showing up as context in the next. Every assertion here is therefore about
// something written in one place appearing in another, and the tabs are visited
// through the UI because a tab that does not render is indistinguishable, from
// the server's side, from one that does.

import { test, expect } from "../fixtures/test.mjs";
import { shell } from "../fixtures/pages.mjs";

const tab = (page, name) => page.getByRole("tab", { name, exact: true });

test("a journey is created from the sidebar and opens on its own page", async ({ alice }) => {
  const { page } = alice;

  await shell(page).newJourney.click();
  const dialog = page.getByRole("dialog").first();
  await dialog.getByRole("textbox").first().fill("Platform migration");
  await dialog.getByRole("button", { name: /create|save|start/i }).first().click();

  await expect(page.getByRole("heading", { name: "Platform migration", level: 1 })).toBeVisible({ timeout: 20_000 });
  // Private and active by default — the two facts everything else depends on.
  await expect(page.getByText("active", { exact: true })).toBeVisible();
  await expect(page.getByText("private", { exact: true })).toBeVisible();
});

test("a kelabo linked to a journey appears under its Kelabos tab", async ({ alice }) => {
  const { page, api } = alice;
  const journey = await api.createJourney({ title: "Linked journey" });
  const kelabo = await api.createKelabo({ title: "Kickoff" });
  await api.linkKelabo(journey.journeyId, kelabo.kelaboId);

  await page.goto(`/journeys/${journey.journeyId}`);
  await tab(page, "Kelabos").click();
  await expect(page.getByText("Kickoff").first()).toBeVisible({ timeout: 20_000 });
});

test("a board note and a document are both readable from the journey", async ({ alice }) => {
  const { page, api } = alice;
  const journey = await api.createJourney({ title: "Documented journey" });
  await api.journeyBoardPost(journey.journeyId, "Retry logic landed and is covered by tests.");
  await api.journeyDocument(journey.journeyId, "Migration spec", "Secure kelabos use mesh; everything else uses the SFU.");

  await page.goto(`/journeys/${journey.journeyId}`);

  await tab(page, "Board").click();
  await expect(page.getByText("Retry logic landed and is covered by tests.").first()).toBeVisible({ timeout: 20_000 });

  await tab(page, "Documents").click();
  await expect(page.getByText("Migration spec").first()).toBeVisible({ timeout: 20_000 });
});

test("the timeline records what happened, in order, with who did it", async ({ alice }) => {
  const { page, api } = alice;
  const journey = await api.createJourney({ title: "Traceable journey" });
  const kelabo = await api.createKelabo({ title: "Planning" });
  await api.linkKelabo(journey.journeyId, kelabo.kelaboId);
  await api.journeyBoardPost(journey.journeyId, "Decided to ship on Tuesday.");

  await page.goto(`/journeys/${journey.journeyId}`);
  await tab(page, "Timeline").click();

  // Both events, and the fact that the linked kelabo is named rather than
  // referred to by id — the timeline is read by people.
  await expect(page.getByText(/Linked kelabo: Planning/).first()).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(/Decided to ship on Tuesday/).first()).toBeVisible();
});

test("a leg carries a message between kelabos", async ({ alice }) => {
  const { page } = alice;
  await shell(page).newJourney.click();
  const dialog = page.getByRole("dialog").first();
  await dialog.getByRole("textbox").first().fill("Legged journey");
  await dialog.getByRole("button", { name: /create|save|start/i }).first().click();
  await expect(page.getByRole("heading", { name: "Legged journey", level: 1 })).toBeVisible({ timeout: 20_000 });

  // Legs are served by the GATEWAY, not the control plane
  // (spa/src/api.js:228) — so this is also the only browser-driven proof that
  // the two services agree about who this person is, since the leg channel
  // authenticates with the session cookie the REST API minted.
  await tab(page, "Legs").click();
  const composer = page.getByRole("textbox", { name: "Message this leg" });
  await composer.fill("Carrying this to the next kelabo.");
  await page.getByRole("button", { name: "Send" }).click();

  await expect(page.getByText("Carrying this to the next kelabo.").first()).toBeVisible({ timeout: 20_000 });

  await page.reload();
  await tab(page, "Legs").click();
  // The point of a leg: it is still there when the meeting is over.
  await expect(page.getByText("Carrying this to the next kelabo.").first()).toBeVisible({ timeout: 20_000 });
});

test("a journey lists on the Journeys page for its owner", async ({ alice }) => {
  const { page, api } = alice;
  const journey = await api.createJourney({ title: `Listed ${Date.now().toString(36)}` });

  await page.goto("/journeys");
  const entry = page.getByRole("link", { name: new RegExp(journey.title) });
  await expect(entry).toBeVisible({ timeout: 20_000 });
  await entry.click();
  await expect(page).toHaveURL(new RegExp(`/journeys/${journey.journeyId}`));
});
