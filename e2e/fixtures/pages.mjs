// Where the app's controls are, named once.
//
// Locators live here rather than inline in the specs for the ordinary reason —
// a renamed button is one edit instead of thirty — and for a sharper one: the
// repository has no `data-testid` anywhere, and adding them would mean editing
// product markup to suit a test. Accessible names are what is already there, so
// the suite reads the app the way a screen reader does. When one of these
// breaks, an accessible name changed, and that is worth knowing.

import { expect } from "@playwright/test";

/** The signed-in shell: sidebar, nav, account menu. */
export function shell(page) {
  return {
    newKelabo: page.getByRole("link", { name: "New kelabo" }).first(),
    schedule: page.getByRole("link", { name: "Schedule" }).first(),
    join: page.getByRole("link", { name: "Join" }).first(),
    newJourney: page.getByRole("button", { name: "New journey" }),
    nav: {
      home: page.getByRole("link", { name: "Home", exact: true }),
      kelabos: page.getByRole("link", { name: "Kelabos", exact: true }),
      journeys: page.getByRole("link", { name: "Journeys", exact: true }),
      contacts: page.getByRole("link", { name: "Contacts", exact: true }),
    },
    /** The avatar button, whose accessible name carries the display name. */
    accountMenu: page.getByRole("button", { name: /'s avatar/ }),
    settings: page.getByRole("menuitem", { name: "Settings" }),
    signOut: page.getByRole("menuitem", { name: "Sign out" }),

    async openAccountMenu() {
      await this.accountMenu.click();
      await this.signOut.waitFor();
    },
  };
}

/** The sign-in page. */
export function login(page) {
  return {
    heading: page.getByRole("heading", { name: "Sign in" }),
    email: page.locator("input[type=email]"),
    sendCode: page.getByRole("button", { name: /send code/i }),
    codeHeading: page.getByRole("heading", { name: /enter 6-digit code/i }),
    verify: page.getByRole("button", { name: /^verify/i }),
    /** Any of the several danger banners the page can raise. */
    error: page.locator("[class*=danger]").first(),
  };
}

/**
 * A `<Switch>` toggle (spa/src/components/ui/Switch.jsx).
 *
 * The real `<input type=checkbox>` is inside the label and drawn by a sibling
 * `.track` span, so the input itself is not visible and `check()` waits for it
 * forever. A person clicks the label; so does this. Returned with the input as
 * well, because "is it on?" must be read from the checkbox and not from a class
 * name on the decoration.
 */
export function toggle(page, ariaLabel) {
  const input = page.getByRole("checkbox", { name: ariaLabel });
  return {
    input,
    label: page.locator(`label.switch:has(input[aria-label="${ariaLabel}"])`),
    async set(on) {
      if ((await input.isChecked()) !== on) await this.label.click();
      await expect(input).toBeChecked({ checked: on });
    },
  };
}

/** The live room. */
export function room(page) {
  const panelButton = page.getByRole("button", { name: /^Conversation/ });

  return {
    endKelabo: page.getByRole("button", { name: "End kelabo" }),
    leave: page.getByRole("button", { name: "Leave", exact: true }),
    participantCount: (n) => page.getByTitle(`${n} in the kelabo now`),
    connectionStatus: page.getByRole("status", { name: "Connection status" }),
    endedDialog: page.getByRole("dialog", { name: "Kelabo ended" }),

    /**
     * Wake the control bar.
     *
     * It fades out when the pointer is idle, and a faded bar is COVERED by the
     * stage rather than hidden — so Playwright sees a visible, enabled, stable
     * button and the click is intercepted by `<div class="stage">`. A page
     * nobody has touched (the second participant's, always) is in that state
     * from the moment it loads.
     *
     * The move is a small jiggle rather than a single position, because the
     * fade is driven by time since the last `mousemove` and Playwright's
     * pointer does not move on its own: setting it once and then waiting is
     * indistinguishable, to the page, from an idle user.
     */
    async wake() {
      const box = page.viewportSize() ?? { width: 1280, height: 720 };
      await page.mouse.move(box.width / 2, box.height - 60);
      await page.mouse.move(box.width / 2, box.height - 40);
    },

    /**
     * Click something in the room's chrome, waking the bar before EVERY
     * attempt.
     *
     * Playwright already retries an intercepted click, but re-trying without
     * re-waking cannot succeed: each attempt finds the bar a little more faded
     * than the last. On an unloaded machine the first attempt wins and this
     * looks unnecessary; under load it is the difference between a suite that
     * is trustworthy and one that is not.
     */
    async click(locator, { timeout = 20_000 } = {}) {
      const deadline = Date.now() + timeout;
      for (;;) {
        await this.wake();
        try {
          await locator.click({ timeout: 2_000 });
          return;
        } catch (err) {
          if (Date.now() > deadline) throw err;
        }
      }
    },

    /**
     * Open the side panel on one of its tabs.
     *
     * Two tabs over one stream (spa/src/room/SidePanel.jsx:19): **Messages** is
     * what people typed and everyone has it; **Transcript** is what was spoken,
     * and it exists only where the deployment has transcription. Looking for a
     * spoken line under Messages finds nothing and looks exactly like a broken
     * fan-out.
     */
    async openPanel(tab = "Messages") {
      // Waited for, not assumed: the room mounts its controls asynchronously,
      // so reading `aria-pressed` too early answers `null` and the click that
      // follows lands on nothing. Opening is then verified before the tab is
      // touched — a `getByRole("tab")` against a closed panel simply waits out
      // the whole timeout and reports the tab as missing, which points at the
      // wrong thing entirely.
      await panelButton.waitFor({ state: "visible" });

      // Converge on the STATE, never blind-retry the click. The panel control
      // is a TOGGLE, so a retrying click is not idempotent: when an attempt
      // actually lands but is reported as failed — which happens whenever the
      // fading control bar makes the stability check time out — the retry
      // closes the panel again. The symptom is this method waiting out its
      // whole timeout on a tab that was briefly visible, which reads as a
      // missing tab and sends you looking at capabilities.
      await expect
        .poll(
          async () => {
            if ((await panelButton.getAttribute("aria-pressed")) === "true") return true;
            await this.wake();
            await panelButton.click({ timeout: 2_000 }).catch(() => {});
            return (await panelButton.getAttribute("aria-pressed")) === "true";
          },
          { timeout: 20_000, message: "the conversation panel never opened" }
        )
        .toBe(true);

      // Matched by PREFIX, not exactly. A tab carrying unread items renames
      // itself — "Board" becomes "Board 1" the moment a contribution arrives —
      // so an exact match finds the tab only while there is nothing on it.
      // Every test that opened the panel before anything happened passed; the
      // one that let a card land first waited out its timeout on a tab that was
      // plainly visible in the snapshot.
      const tabControl = page.getByRole("tab", { name: new RegExp(`^${tab}\\b`) });
      await tabControl.waitFor({ state: "visible" });
      await tabControl.click();
      return page.getByRole("textbox", { name: /type a message/i });
    },

    /**
     * A line of text inside the side panel.
     *
     * Scoped to the panel because the room may legitimately render the same
     * words twice — the panel and the live-caption overlay — and which surfaces
     * show a line is not what a transcript test is about.
     */
    line: (text) => page.locator(".side").getByText(text).first(),
  };
}
