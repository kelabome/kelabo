import { defineConfig, devices } from "@playwright/test";
import { PORTAL_URL, PORTS } from "./harness/env.mjs";

export default defineConfig({
  testDir: "./tests",
  testMatch: "**/*.spec.mjs",
  // The harness is ONE process holding ONE in-memory store, so workers share a
  // backend. That is deliberate — it is what a deployment is — and it is safe
  // because every test creates its own kelabo, journey and identity. What it
  // does mean is that a test must never assert on a global list ("there are two
  // kelabos"), only on the ones it made.
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : [["list"]],

  timeout: 30_000,
  expect: { timeout: 10_000 },

  use: {
    baseURL: PORTAL_URL,
    trace: "retain-on-failure",
    video: "retain-on-failure",
    screenshot: "only-on-failure",
    // localhost is a secure context, so `getUserMedia`, `RTCPeerConnection` and
    // the SPA's own `isSecureContext` banner all behave as they do in
    // production (spa/src/App.jsx:61).
    permissions: ["microphone"],
  },

  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        launchOptions: {
          args: [
            // A synthesised microphone, and no permission prompt. Enough for
            // the capture pipeline because nothing in `useMicStream.js` asks
            // for an `exact` device (spa/src/rtc/useMicStream.js:60).
            "--use-fake-device-for-media-stream",
            "--use-fake-ui-for-media-stream",
            // Two contexts on one machine still negotiate over host candidates;
            // this keeps a mesh test off the network entirely.
            "--allow-loopback-in-peer-connection",
          ],
        },
      },
    },
  ],

  webServer: [
    {
      command: "node harness/start.mjs",
      // The REST API is last to listen, so it is the readiness signal for all
      // three services (see harness/start.mjs for why the order is fixed).
      url: `http://localhost:${PORTS.rest}/health`,
      reuseExistingServer: !process.env.CI,
      stdout: "pipe",
      stderr: "pipe",
      timeout: 60_000,
    },
    {
      // BUILT, then previewed — not `vite dev`.
      //
      // Two reasons, one of them forced. The forced one: the dev server's
      // dependency optimizer cannot pre-bundle `onnxruntime-web` (the Silero
      // VAD's runtime), because `vite.config.js` aliases `@kelabo/ort-wasm-mjs`
      // to a file INSIDE node_modules and the scanner then tries to optimize a
      // module containing top-level await. The page loads and then never
      // renders. The good reason: this is the artifact CloudFront actually
      // serves, and `npm run build` is already the repo's only syntax gate for
      // JSX — so the suite runs against the same bytes a deployment does. It
      // costs about two seconds.
      command: `npm run build && npx vite preview --port ${PORTS.spa} --strictPort`,
      cwd: "../spa",
      url: PORTAL_URL,
      reuseExistingServer: !process.env.CI,
      timeout: 180_000,
    },
  ],
});
