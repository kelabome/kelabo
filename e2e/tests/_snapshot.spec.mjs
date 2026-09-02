// A scaffolding aid, not a test: dumps the accessibility tree of each page so
// selectors in the real specs are written from what the app actually renders
// rather than guessed. Skipped by default; run it with
// `npx playwright test _snapshot --grep-invert nothing` when a page changes.
import { test } from "../fixtures/test.mjs";

test.skip(!process.env.E2E_SNAPSHOT, "set E2E_SNAPSHOT=1 to dump page trees");

test("dump", async ({ alice }) => {
  const { page, api } = alice;
  const kelabo = await api.createKelabo({ title: "Snapshot kelabo" });
  await api.joinKelabo(kelabo.kelaboId, { displayName: "Alice" });
  const journey = await api.createJourney({ title: "Snapshot journey" });

  const pages = [
    ["/new", "New kelabo"],
    ["/schedule", "Schedule"],
    ["/enter", "Enter code"],
    ["/journeys", "Journeys list"],
    [`/journeys/${journey.journeyId}`, "Journey detail"],
    ["/kelabos", "Records"],
    ["/contacts", "Contacts"],
    ["/settings", "Settings"],
    ["/admin", "Admin"],
    [`/m/${kelabo.kelaboId}/lobby`, "Lobby"],
    [`/m/${kelabo.kelaboId}`, "Room"],
  ];

  for (const [path, label] of pages) {
    await page.goto(path);
    await page.waitForTimeout(1500);
    console.log(`\n\n########## ${label}  (${path})\n`);
    console.log(await page.locator("body").ariaSnapshot());
  }
});
