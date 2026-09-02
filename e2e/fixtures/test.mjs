// Playwright fixtures.
//
// `signedIn` is a browser context that already holds a real session, obtained
// through the real OTP exchange over HTTP (see fixtures/api.mjs). One test —
// auth.spec — signs in through the UI instead; everything else takes this, so
// the suite spends its time on what it is actually asserting.
//
// A fixture per SIGNED-IN PERSON rather than per page, because several suites
// need two participants in one kelabo and the room refuses two tabs of the same
// kelabo in one context (`spa/src/room/useSingleTab.js`). Separate contexts is
// not a workaround for that rule — it is what two people actually are.

import { test as base, expect } from "@playwright/test";
import { createApiClient } from "./api.mjs";
import { PORTAL_URL } from "../harness/env.mjs";

export const test = base.extend({
  /** An API client with no session — for the sign-in flows themselves. */
  api: async ({}, use) => {
    await use(createApiClient());
  },

  /**
   * `person('alice')` -> { api, context, page } for one signed-in participant.
   * Contexts are closed for you when the test ends.
   */
  person: async ({ browser }, use, testInfo) => {
    const open = [];
    async function person(localPart) {
      // Namespaced by test, so parallel workers do not share an identity and a
      // rate limit counter. `+tag` addressing keeps one tenant domain.
      //
      // A FULL address is taken as-is. That is how a suite signs in as somebody
      // specific — the root administrator, whose address is deploy-time and
      // cannot be uniquified without ceasing to be the root administrator.
      const unique = localPart.includes("@")
        ? localPart
        : `${localPart}+${testInfo.workerIndex}.${Date.now().toString(36)}`;
      const api = createApiClient();
      const session = await api.signIn(unique);
      const context = await browser.newContext();
      await context.addCookies(api.cookies());
      const page = await context.newPage();
      open.push(context);

      const self = {
        api,
        context,
        page,
        email: session.email,
        identity: session.identity,

        /**
         * Copy anything the API client has picked up since into the browser.
         *
         * Needed because a kelabo hands out a SECOND cookie: `kelabo_participant`,
         * minted by `POST /kelabos/:id/join` and required by every Gateway route
         * the room uses. Without this the page loads, the board stream 401s, and
         * the room shows "Lost the Kelabo server — reconnecting" — which reads
         * as a broken Gateway rather than a missing cookie.
         */
        async syncCookies() {
          await context.addCookies(api.cookies());
        },

        /** Join a kelabo and open its room, cookies and all. */
        async enterKelabo(kelaboId, { displayName } = {}) {
          await api.joinKelabo(kelaboId, { displayName: displayName ?? localPart });
          await self.syncCookies();
          await page.goto(`/m/${kelaboId}`);
          return self;
        },
      };
      return self;
    }
    await use(person);
    await Promise.all(open.map((c) => c.close().catch(() => {})));
  },

  /**
   * A signed-in participant with NO browser: an API client that has joined the
   * kelabo and can publish captions.
   *
   * Most tests that need a second person need them only to say something —
   * nothing is ever asserted about their screen. Giving them a Chromium context
   * anyway costs a browser, a room, an SSE stream and a WebRTC negotiation per
   * test, and on a loaded machine that is what turns a suite flaky. Use
   * `person` when a second SCREEN is the subject; use this when a second VOICE
   * is.
   *
   * NOT in the room's roster. The participant count comes from the `roster` SSE
   * event, and this participant never opens a stream — they have joined and can
   * publish, but nobody is watching on their behalf. A test that waits for
   * "2 in the kelabo now" after calling this waits forever, correctly.
   */
  voice: async ({}, use, testInfo) => {
    async function voice(kelaboId, localPart = "bob") {
      const api = createApiClient();
      await api.signIn(`${localPart}+v${testInfo.workerIndex}.${Date.now().toString(36)}`);
      await api.joinKelabo(kelaboId, { displayName: localPart });
      return api;
    }
    await use(voice);
  },

  /** The common case: one signed-in person, already on the home page. */
  alice: async ({ person }, use) => {
    const p = await person("alice");
    await p.page.goto(PORTAL_URL);
    await use(p);
  },
});

export { expect };
