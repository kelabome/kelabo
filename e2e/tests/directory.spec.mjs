// The organisation directory (docs 18 §4.7) and name search over it (§4.8).
//
// What a route test cannot show: that an administrator can get a file from
// their disk into the directory through the console, and that a member typing
// part of a NAME — into the invite field, or when adding a journey accessor —
// is offered that person's address.

import { test, expect } from "../fixtures/test.mjs";
import { ROOT_ADMIN_EMAIL, TENANT_DOMAIN } from "../harness/env.mjs";

// Root is one fixed identity (see admin.spec.mjs for why that forces serial).
test.describe.configure({ mode: "serial" });

// Excel's shape: a byte-order mark, CRLF, a case-variant duplicate and a
// contractor at another domain. Names are unusual enough not to collide with
// anybody another spec signs in.
const FILE =
  "\uFEFFName,Email\r\n" +
  `Quentin Farrowby,qfarrowby@${TENANT_DOMAIN}\r\n` +
  `Ysolde Marchetti,ymarchetti@${TENANT_DOMAIN}\r\n` +
  `QUENTIN FARROWBY,QFarrowby@${TENANT_DOMAIN}\r\n` +
  "Pat Contractor,pat.contractor@partner.example\r\n";

test("an administrator previews and imports a directory from a file", async ({ person }) => {
  const root = await person(ROOT_ADMIN_EMAIL);
  const { page } = root;
  await page.goto("/admin?tab=directory");
  await expect(page.getByText("Import or refresh")).toBeVisible({ timeout: 20_000 });

  await page.getByPlaceholder("example.com").fill(TENANT_DOMAIN);
  await page.locator('input[type="file"]').setInputFiles({ name: "users.csv", mimeType: "text/csv", buffer: Buffer.from(FILE) });
  await page.getByRole("button", { name: "Preview" }).click();

  // The preview: three people after merging the duplicate, and the contractor's
  // domain called out as not the tenant.
  await expect(page.getByText("3 people in the file")).toBeVisible();
  await expect(page.getByText(/1 duplicate merged/)).toBeVisible();
  await expect(page.getByText(`not ${TENANT_DOMAIN}`)).toBeVisible();

  await page.getByRole("button", { name: `Import 3 people into ${TENANT_DOMAIN}` }).click();
  await expect(page.getByText(`${TENANT_DOMAIN} — 3 people`)).toBeVisible();
});

test("a member finds a directory person by name in the invite field", async ({ alice }) => {
  const { page } = alice;
  await page.goto("/schedule");
  const input = page.locator('input[name="invitee-search"]');
  await input.fill("farowby"); // misspelt, and never signed in

  const option = page.locator(".epick-option").filter({ hasText: "Quentin Farrowby" });
  await expect(option).toBeVisible();
  await expect(option).toContainText(`qfarrowby@${TENANT_DOMAIN}`);
  await expect(option).toContainText("directory");
  await option.click();
  await expect(page.locator(".epick-chip").filter({ hasText: `qfarrowby@${TENANT_DOMAIN}` })).toBeVisible();

  // The contractor at another domain is findable too.
  await input.fill("pat contr");
  await expect(page.locator(".epick-option").filter({ hasText: "Pat Contractor" })).toBeVisible();
});

test("a journey lead adds an accessor found by name", async ({ person }) => {
  const lead = await person("lead");
  const journey = await lead.api.createJourney({ title: "Private roadmap", visibility: "private" });
  const { page } = lead;
  await page.goto(`/journeys/${journey.journeyId}`);
  await page.getByRole("tab", { name: "Helm" }).click();
  await page.getByRole("button", { name: "Add accessor" }).click();

  const dialog = page.getByRole("dialog", { name: "Add accessors" });
  await dialog.locator('input[name="invitee-search"]').fill("ysolde marc");
  const option = dialog.locator(".epick-option").filter({ hasText: "Ysolde Marchetti" });
  await expect(option).toBeVisible();
  await option.click();
  await dialog.getByRole("button", { name: "Add", exact: true }).click();

  await expect(page.getByText(`ymarchetti@${TENANT_DOMAIN}`)).toBeVisible();
  const { accessors } = await lead.api.raw.api("GET", `/journeys/${journey.journeyId}/accessors`);
  expect(accessors.map((a) => a.identity)).toContain(`ymarchetti@${TENANT_DOMAIN}`);
});

test("removing the directory stops the suggestions", async ({ person }) => {
  const root = await person(ROOT_ADMIN_EMAIL);
  const { page } = root;
  await page.goto("/admin?tab=directory");
  const row = page.locator(".settings-row").filter({ hasText: `${TENANT_DOMAIN} — 3 people` });
  await row.getByRole("button", { name: /Remove/ }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Remove" }).click();
  await expect(page.getByText(/None yet/)).toBeVisible();

  const res = await root.api.raw.api("GET", "/people/search?q=quentin");
  expect(res.suggestions).toEqual([]);
});
