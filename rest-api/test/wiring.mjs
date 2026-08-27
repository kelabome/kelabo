// The composition root, actually executed once.
//
// `smoke.mjs` builds the app through `createApp(deps)` with its own stubs. That
// is the right seam for route behaviour and, it turns out, a blind spot the
// size of the whole deployment: the real wiring in `composeApp` was reached by
// nothing — not a test, not `make check`, not the build.
//
// What can go through it: a factory called without being imported. A
// `ReferenceError` at the composition root, thrown before the app's own
// try/catch exists, so **every** request on **every** cold container answers
// 500 with no `unhandled` log line to say why — sign-in included. `node --check`
// sees only syntax; esbuild bundles an unresolved identifier without complaint;
// 160 green tests never loaded the line.
//
// So this file does the two cheapest things that would have caught it:
//
//   1. runs `composeApp` against an env-derived config, which is enough to
//      resolve every identifier the wiring names. The AWS clients it builds open
//      no socket until a command is sent, so this stays offline.
//   2. checks statically that every dependency `createApp` destructures is
//      actually passed at the composition root — a name forgotten there is a
//      second `ReferenceError` the first run cannot see.
//
// Neither asserts anything about behaviour. Wiring is all they are for.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Before importing config.js: `fromEnv()` is chosen by the presence of these,
// and it caches on first call. The values are shaped like the ones CDK writes
// into the task definition; none of them is contacted.
Object.assign(process.env, {
  AWS_REGION: process.env.AWS_REGION || "us-east-1",
  KELABO_ENV: "wiring-test",
  KELABO_TABLE_KELABOS: "wiring-kelabos",
  KELABO_TABLE_USERS: "wiring-users",
  KELABO_TABLE_OTP: "wiring-otp",
  KELABO_TABLE_REFRESH: "wiring-refresh",
  KELABO_TABLE_HISTORY: "wiring-history",
  KELABO_TABLE_MCP: "wiring-mcp",
  KELABO_TABLE_CONTACTS: "wiring-contacts",
  KELABO_TABLE_CREDENTIALS: "wiring-credentials",
  KELABO_ALLOWED_EMAIL_DOMAIN: "example.com",
  KELABO_PORTAL_URL: "https://example.com",
  KELABO_GATEWAY_BASE_URL: "https://gw.example.com",
  KELABO_SES_FROM_ADDRESS: "no-reply@example.com",
  KELABO_SECRET_COOKIE_KEY: "kelabo/wiring/cookie",
  KELABO_SECRET_API_ORIGIN: "kelabo/wiring/api-origin",
  KELABO_ARCHIVE_BUCKET: "wiring-archive",
});

const { ensureConfig } = await import("../src/config.js");
const { composeApp } = await import("../src/index.js");

const config = await ensureConfig();
assert.equal(config.tableNames.kelabos, "wiring-kelabos", "the env config path was not taken");

// The assertion this file exists for. Any factory named but not imported, any
// module whose top level throws, fails here.
const app = composeApp(config);
assert.equal(typeof app, "function", "composeApp did not return a handler");

// A second container's worth, because a composition root that only works once
// is a warm-Lambda bug rather than a cold-start one.
assert.equal(typeof composeApp(config), "function", "composeApp is not repeatable");

// --- what createApp asks for, against what the wiring hands it ---------------
//
// Read as text on purpose. The destructure and the call are both object
// literals one regex away, and the alternative — importing and introspecting —
// cannot see a name that was never passed, which is exactly the defect.
const src = readFileSync(new URL("../src/index.js", import.meta.url), "utf8");

const wanted = /export function createApp\(deps\)\s*\{\s*const \{([^}]*)\}/.exec(src);
assert.ok(wanted, "could not find createApp's destructure — this checker has gone blind");
const needs = wanted[1]
  .split(",")
  .map((s) => s.split(":")[0].trim())
  .filter(Boolean);
assert.ok(needs.length > 15, `only ${needs.length} deps parsed out of createApp — the regex stopped matching`);

const passed = /return createApp\(\{([^}]*)\}\)/.exec(src);
assert.ok(passed, "could not find the createApp call in composeApp");
const given = new Set(
  passed[1]
    .split(",")
    .map((s) => s.split(":").pop().trim())
    .filter(Boolean)
);

const missing = needs.filter((name) => !given.has(name));
assert.equal(
  missing.length,
  0,
  `createApp destructures these, and composeApp never passes them: ${missing.join(", ")}`
);

console.log(`rest-api/wiring: composition root runs, ${needs.length} deps all supplied`);
