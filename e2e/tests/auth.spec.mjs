// Sign in, stay signed in, sign out.
//
// The ONE suite that drives the login UI. Every other suite takes the `alice`
// fixture, which does the same OTP exchange over HTTP — so if the login page
// itself regresses, exactly these tests fail and the rest keep telling you
// about their own subject. That separation is deliberate: a broken login page
// that fails two hundred assertions tells you nothing you did not learn from
// the first one.

import { test, expect } from "../fixtures/test.mjs";
import { TENANT_DOMAIN } from "../harness/env.mjs";
import { login, shell } from "../fixtures/pages.mjs";

/** The whole sign-in, through the page, for one address. */
async function signInThroughTheUi(page, api, email) {
  const form = login(page);
  await page.goto("/login");
  await expect(form.heading).toBeVisible();

  await form.email.fill(email);
  await form.sendCode.click();
  await expect(form.codeHeading).toBeVisible();

  const mail = await api.lastMail(email);
  expect(mail, "no sign-in code reached the outbox").not.toBeNull();

  // Typed, not filled box-by-box: `OtpInput`'s type-anywhere handler is the
  // path a real person takes, and it is the one that has broken before.
  await page.keyboard.type(mail.code);

  return mail.code;
}

test("a person signs in with an emailed code and lands on the home page", async ({ page, api }) => {
  const email = `login.${Date.now().toString(36)}@${TENANT_DOMAIN}`;
  await signInThroughTheUi(page, api, email);

  // The six-digit box auto-submits on completion, so no Verify click is needed
  // — and asserting that is the point: a regression that breaks auto-submit is
  // invisible to a test that clicks the button anyway.
  await expect(page).toHaveURL(/\/$|\/#/, { timeout: 15_000 });
  // The signed-in shell, not merely the URL: a redirect that lands on a blank
  // page is the failure this is guarding, and the URL alone cannot see it.
  await expect(shell(page).newKelabo).toBeVisible();
  await expect(page.getByRole("heading", { level: 1 })).toContainText(/good (morning|afternoon|evening)/i);
});

test("the session survives a reload — the cookie is doing the work, not the tab", async ({ page, api }) => {
  const email = `reload.${Date.now().toString(36)}@${TENANT_DOMAIN}`;
  await signInThroughTheUi(page, api, email);
  await expect(page).toHaveURL(/\/$/, { timeout: 15_000 });

  await page.reload();
  await expect(page).not.toHaveURL(/\/login/);
});

test("a wrong code is refused and the page says so", async ({ page, api }) => {
  const email = `wrong.${Date.now().toString(36)}@${TENANT_DOMAIN}`;
  await page.goto("/login");
  await page.locator("input[type=email]").fill(email);
  await page.getByRole("button", { name: /send code/i }).click();
  await expect(page.getByRole("heading", { name: /enter 6-digit code/i })).toBeVisible();

  const real = (await api.lastMail(email)).code;
  const wrong = String((Number(real) + 1) % 1000000).padStart(6, "0");
  await page.keyboard.type(wrong);

  // Still on the code step, with something visible saying no. Asserted as
  // "did not proceed" plus "an error is shown", because the copy is the
  // product's to change and the behaviour is not.
  await expect(login(page).codeHeading).toBeVisible();
  await expect(login(page).error).toBeVisible({ timeout: 10_000 });
});

test("an address outside the deployment's domain cannot sign in", async ({ page }) => {
  const form = login(page);
  await page.goto("/login");
  await form.email.fill("outsider@somewhere-else.example");
  await form.sendCode.click();

  // Refused before any code exists. The tenant boundary is the privacy
  // boundary here, so this failing open is the one that matters most.
  await expect(form.error).toBeVisible({ timeout: 10_000 });
  await expect(form.codeHeading).toHaveCount(0);
});

test("signing out ends the session for this device", async ({ alice }) => {
  const { page } = alice;
  const nav = shell(page);
  await expect(nav.newKelabo).toBeVisible();

  await nav.openAccountMenu();
  // A full-page navigation to `${apiBase}/logout`, not a fetch
  // (spa/src/api.js:329) — so this exercises the server's cookie clearing,
  // which is what actually ends the session.
  await nav.signOut.click();
  await page.waitForLoadState("domcontentloaded");

  // NOT asserted here: where the redirect lands. `GET /logout` answers
  // `Location: "/"` (rest-api/src/index.js:517), which resolves against the
  // API's own origin. Behind CloudFront the API is under `/api` on the portal
  // host and that is the portal root, so production is correct; anywhere the
  // API has its own origin — this harness, and an ordinary local dev session —
  // it lands on the API instead of the app. Pinning it either way here would
  // make one of those two the "expected" one, and the invariant that actually
  // matters is the next three lines.
  await page.goto("/journeys");
  await expect(page).toHaveURL(/\/login/, { timeout: 15_000 });
  await expect(login(page).heading).toBeVisible();
});
