// The harness environment, applied before either service loads its config.
//
// Both services already have an env-driven config path — `fromEnv()` in
// gateway/src/config.js:12 and rest-api/src/config.js:76 — and it is the one
// production uses, because CDK writes exactly these variables into the task
// definition and the Lambda. So the harness sets them rather than inventing a
// third loader: the e2e run then exercises the same config path the deployment
// does, and a setting that is missing from `fromEnv` fails here too.
//
// It must be imported (or `applyHarnessEnv()` called) BEFORE `src/config.js` on
// either side, because both cache on first read.

export const PORTS = { rest: 3000, gateway: 3001, spa: 5173 };

export const PORTAL_URL = `http://localhost:${PORTS.spa}`;
export const API_BASE = `http://localhost:${PORTS.rest}`;
export const GATEWAY_BASE = `http://localhost:${PORTS.gateway}`;

/**
 * The one signing key behind all three token families (docs: "Three token
 * families share one signing key"). Fixed rather than random so a test process
 * separate from the server process can mint a session cookie — which is the
 * fast path every suite but auth.spec uses.
 */
export const COOKIE_KEY = "e2e-harness-signing-key-not-a-secret";

export const TENANT_DOMAIN = "example.test";
export const ROOT_ADMIN_EMAIL = `admin@${TENANT_DOMAIN}`;

const TABLES = {
  KELABO_TABLE_KELABOS: "e2e-kelabos",
  KELABO_TABLE_USERS: "e2e-users",
  KELABO_TABLE_OTP: "e2e-otp",
  KELABO_TABLE_REFRESH: "e2e-refresh",
  KELABO_TABLE_HISTORY: "e2e-history",
  KELABO_TABLE_MCP: "e2e-mcp",
  KELABO_TABLE_CONTACTS: "e2e-contacts",
  KELABO_TABLE_CREDENTIALS: "e2e-credentials",
  KELABO_TABLE_JOURNEYS: "e2e-journeys",
  KELABO_TABLE_CONFIG: "e2e-config",
};

export function applyHarnessEnv() {
  Object.assign(process.env, {
    AWS_REGION: "us-east-1",
    KELABO_ENV: "e2e",
    ...TABLES,

    KELABO_ALLOWED_EMAIL_DOMAIN: TENANT_DOMAIN,
    KELABO_TENANT_ID: TENANT_DOMAIN,
    KELABO_PORTAL_URL: PORTAL_URL,
    KELABO_GATEWAY_BASE_URL: GATEWAY_BASE,
    KELABO_ROOT_ADMIN_EMAIL: ROOT_ADMIN_EMAIL,

    // No Domain attribute on localhost: a cookie scoped to `Domain=localhost`
    // is rejected outright by Chrome, and the failure looks like a broken
    // sign-in rather than a bad cookie. Unset means host-only, which is what
    // `serializeCookie` emits when `domain` is falsy (rest-api/src/cookies.js:19).
    KELABO_COOKIE_DOMAIN: "",

    KELABO_ARCHIVE_BUCKET: "e2e-archive",
    KELABO_SECRET_COOKIE_KEY: "e2e/cookie",
    KELABO_SECRET_API_ORIGIN: "e2e/api-origin",
    // The CloudFront back-door gate. Off here because there is no CloudFront:
    // with it on, every request from the Vite dev server is a bare 403 that
    // names neither the header nor the reason (rest-api/src/index.js:1487).
    KELABO_REQUIRE_ORIGIN_SECRET: "false",

    KELABO_MAIL_FROM_ADDRESS: `no-reply@${TENANT_DOMAIN}`,

    // Speech-to-text: the deterministic in-repo provider, so the browser's
    // capture pipeline can be driven end to end with a fake audio device and
    // no supplier account. See spa/src/stt/fake.js.
    KELABO_STT_PROVIDER: "fake",
    KELABO_STT_LANGUAGE: "en",

    // Zero, so a test may request a second code immediately. This is the one
    // rate limit a suite genuinely has to defeat; the rest are left at their
    // defaults precisely so the tests run against the real ones.
    KELABO_OTP_RESEND_SECONDS: "0",
    KELABO_OTP_PER_EMAIL_MAX_REQUESTS: "1000",
    KELABO_OTP_PER_IP_MAX_REQUESTS: "1000",

    // Conference audio. The `rtc` credential slot IS filled (see
    // restServer.mjs), because the capability is computed from the slot alone
    // — `call: cap(hasRtc, …)` in contracts/src/entitlement.js:109 — so an
    // empty slot turns the call off before the browser asks for anything, and
    // neither transport can then be exercised at all.
    //
    // The Cloudflare API base is pointed at a port nothing listens on. A mesh
    // kelabo is unaffected: its signalling is pure Gateway relay and ICE is
    // best-effort, so it falls back to STUN-only and connects over host
    // candidates. An SFU kelabo cannot reach its API and reports
    // `rtc_unavailable` — the real degradation path, refused locally and
    // instantly rather than by a timeout against a real host.
    KELABO_RTC_API_BASE: "http://127.0.0.1:3999/v1",
    KELABO_RTC_DEFAULT_MODE: "sfu",
    KELABO_RTC_MESH_MAX: "4",

    // The agent. A model name must be present or the worker refuses to start;
    // the harness replaces the provider itself (see llm.mjs), so the name is
    // only ever echoed.
    KELABO_LLM_PROVIDER: "openai",
    KELABO_LLM_MODEL: "e2e-scripted",
    KELABO_LLM_SMALL_MODEL: "e2e-scripted",
    KELABO_LLM_API_KEY: "e2e-not-a-real-key",
  });
}

export { TABLES };
