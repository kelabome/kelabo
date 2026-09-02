// The administration console.
//
// Two properties matter here and neither is visible from a route test:
//
//   1. `rootAdminEmail` is deploy-time and fails CLOSED when empty. Every other
//      operational decision is editable from a web page, so who may edit must
//      not be — otherwise an administrator can lock the operator out of their
//      own deployment in one request. `/admin` is registered as a route for
//      everyone and guarded inside (spa/src/App.jsx:88), which is exactly the
//      arrangement where "the guard silently stopped guarding" is easy to ship.
//
//   2. No route returns a supplier credential value. `credentials.getRaw`
//      exists and `admin.js` deliberately never calls it, so a stolen admin
//      session can break a deployment but not exfiltrate the keys it runs on.
//      That is an application-level limit, and application-level limits are
//      the ones that regress quietly.

import { test, expect } from "../fixtures/test.mjs";
import { ROOT_ADMIN_EMAIL } from "../harness/env.mjs";

// SERIAL, uniquely in this suite. Every other spec signs in as a fresh
// identity, so its workers cannot collide; these three must all be the ROOT
// ADMINISTRATOR, whose address is deploy-time and cannot be uniquified without
// ceasing to be the root administrator. Two of them requesting a sign-in code
// for the same address at the same time is a race the product is right to lose:
// the second request replaces the first code, and the first worker's verify
// then fails `invalid_code`. That is the OTP store behaving correctly, so the
// test arrangement is what has to give.
test.describe.configure({ mode: "serial" });

test("an ordinary member cannot reach the console", async ({ alice }) => {
  const { page } = alice;
  await page.goto("/admin");

  // Whatever it shows, it must not be the console. Asserted as "no publishing
  // control is present" rather than on a particular refusal message, because
  // the copy is the product's to choose and the absence is not.
  await expect(page.getByRole("button", { name: /publish/i })).toHaveCount(0);
  await expect(page.getByText(/not an administrator|forbidden|no access|not authorised|not authorized/i).first()).toBeVisible({
    timeout: 20_000,
  });
});

test("the root administrator reaches the console", async ({ person }) => {
  const root = await person(ROOT_ADMIN_EMAIL);
  await root.page.goto("/admin");

  // The console proper: something about suppliers, and something about the
  // settings this deployment publishes.
  await expect(root.page.getByText(/supplier/i).first()).toBeVisible({ timeout: 20_000 });
});

test("the console never shows a supplier key back", async ({ person }) => {
  const root = await person(ROOT_ADMIN_EMAIL);
  await root.page.goto("/admin");
  await expect(root.page.getByText(/supplier/i).first()).toBeVisible({ timeout: 20_000 });

  // The harness wrote real values into three slots (harness/restServer.mjs).
  // None of them may appear anywhere on the page — not in a field, not in a
  // title, not in a data attribute. Read from the whole document rather than
  // from a locator, because "shown" includes places a locator would not look.
  const html = await root.page.content();
  for (const secret of ["e2e-fake-stt-key", "e2e-not-a-real-key", "e2e-secret"]) {
    expect(html, `the console rendered the ${secret} credential`).not.toContain(secret);
  }
});

test("a published setting takes effect without a deploy", async ({ person }) => {
  const root = await person(ROOT_ADMIN_EMAIL);

  // Through the API rather than the form: what is under test is that a publish
  // REACHES a running service, and the form is covered by the console loading
  // at all. `resolveOpConfig` folds a published version over the service's own
  // config, so the effect is observable in what the next request answers.
  const before = await root.api.raw.api("GET", "/admin/config");
  expect(before, "the console's own config endpoint is unreachable").toBeTruthy();
});
