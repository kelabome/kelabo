// Which browser origins the Gateway actually answers — on the *response the
// browser reads*, not on the preflight.
//
// This exists because of a bug that verified as fixed and was not. The app is
// served from more than one hostname — the portal and any alias it also answers
// on — so some requests are cross-origin; the allowed origin was made
// configurable and `OPTIONS` was checked by hand and answered correctly. But an EventSource does not send a preflight, and both SSE
// handlers re-stated the CORS headers in their own `writeHead` — where a named
// header WINS over one already set with `setHeader`. So the preflight kept
// saying yes while every actual stream said the old, hard-coded origin, and the
// only symptom was a browser refusing a response the server had returned 200 for.
//
// The lesson is in what is asserted: the header on the streaming response.
import assert from "node:assert/strict";
import { createSseHub, setCorsHeaders, corsOrigin } from "../src/sseHub.js";
import { createPresence } from "../src/presence.js";
import { createState } from "../src/state.js";

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
  } catch (err) {
    console.error(`FAIL ${name}`);
    throw err;
  }
}

const PORTAL = "https://saas.kelabo.dev";
// A second hostname the same app is served from — an apex beside a `www`, or
// any other portal alias. The browser sends whichever the user typed.
const ALIAS = "https://kelabo.dev";

function container() {
  return {
    config: { portalUrl: PORTAL, allowedOrigins: [PORTAL, ALIAS], guestTranscriptAccess: false },
    state: createState(),
    log: () => {},
    logError: () => {},
    // Both hubs register a timer teardown on the container.
    shutdownHooks: [],
  };
}

/** A response that records headers the way node does: writeHead wins. */
function fakeRes() {
  const headers = {};
  return {
    headers,
    setHeader: (k, v) => {
      headers[k.toLowerCase()] = v;
    },
    writeHead(status, extra = {}) {
      this.status = status;
      for (const [k, v] of Object.entries(extra)) headers[k.toLowerCase()] = v;
      return this;
    },
    write: () => true,
    end: () => {},
    on: () => {},
    once: () => {},
    setTimeout: () => {},
    writableEnded: false,
  };
}

const allowed = (res) => res.headers["access-control-allow-origin"];

test("the choice of origin is made in one place", () => {
  const c = container();
  assert.equal(corsOrigin(c, ALIAS), ALIAS);
  assert.equal(corsOrigin(c, PORTAL), PORTAL);
  assert.equal(corsOrigin(c, "https://evil.example.com"), PORTAL);
});

test("the presence STREAM answers an alias origin, not just its preflight", () => {
  const c = container();
  c.presence = createPresence(c);
  const res = fakeRes();
  // The route sets CORS, then the handler writes the stream head.
  setCorsHeaders(c, res, { headers: { origin: ALIAS } });
  c.presence.subscribe(res, { identity: "rico@example.com", tenantId: "example.com" });
  assert.equal(res.status, 200);
  // Was: the portal, hard-coded in writeHead, overriding the line above.
  assert.equal(allowed(res), ALIAS);
});

test("the board STREAM answers an alias origin too", () => {
  const c = container();
  c.sseHub = createSseHub(c);
  const res = fakeRes();
  setCorsHeaders(c, res, { headers: { origin: ALIAS } });
  c.sseHub.subscribe("kelabo-1", res, "rico@example.com", { transcriptEntitled: true });
  assert.equal(allowed(res), ALIAS);
});

test("an origin we do not serve gets the portal back, which the browser refuses", () => {
  const c = container();
  c.presence = createPresence(c);
  const res = fakeRes();
  setCorsHeaders(c, res, { headers: { origin: "https://evil.example.com" } });
  c.presence.subscribe(res, { identity: "rico@example.com", tenantId: "example.com" });
  assert.equal(allowed(res), PORTAL);
});

console.log(`gateway/cors: ${passed} passed`);
