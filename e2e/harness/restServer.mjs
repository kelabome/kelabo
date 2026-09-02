// The control plane, as an HTTP server.
//
// `rest-api` is a Lambda: its only entrypoint takes an API-Gateway v2 event
// (rest-api/src/index.js:1461) and there is no `listen` anywhere in it. A
// browser cannot drive that, so this adapts one to the other — request in,
// event out, event result back to a response. It adds exactly two things the
// deployment does not need and an e2e run cannot do without:
//
//   - **CORS.** In production the API is same-origin under `/api`, with
//     CloudFront stripping the prefix, so the service sets no CORS headers at
//     all. Here the SPA is on :5173 and the API on :3000 — cross-origin, though
//     same-SITE, which is why the `SameSite=Lax` session cookie still travels.
//   - **`/__test/*`.** The mail outbox, so a test can read the sign-in code
//     that would have been emailed, and a store reset between suites.
//
// Everything else is `composeApp`, the real composition root, with only the AWS
// boundary replaced.

import http from "node:http";
import { createMailer } from "../../rest-api/src/mail/index.js";
import { createCredentials } from "../../rest-api/src/credentials.js";
import { createDb } from "../../rest-api/src/db.js";

const TEST_PREFIX = "/__test/";

/** Set-Cookie values arrive as a `cookies` array on the Lambda result. */
function writeResult(res, result, corsHeaders) {
  const headers = { ...(result.headers || {}), ...corsHeaders };
  // As an ARRAY, so several Set-Cookie headers survive. A sign-in sets three
  // (session, refresh, and often rsvp); collapsed into one header value the
  // browser keeps none of them and the whole suite fails as "not signed in".
  if (result.cookies?.length) headers["Set-Cookie"] = result.cookies;
  res.writeHead(result.statusCode || 200, headers);
  res.end(result.body ?? "");
}

function corsFor(req, portalUrl) {
  const origin = req.headers.origin;
  if (!origin) return {};
  // Echoed, not `*`: the SPA sends `credentials: 'include'` (spa/src/api.js:11)
  // and a wildcard origin is rejected outright for credentialed requests.
  const allowed = origin === portalUrl ? origin : portalUrl;
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Credentials": "true",
    Vary: "Origin",
  };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/**
 * The outbox. `factories`, not `sendEmail`, deliberately: overriding the
 * TRANSPORT keeps `messages.js` in the path, so the sign-in code this returns
 * is the one that was actually composed into the mail rather than the argument
 * that went in. A test that reads it has proven the code reaches the message.
 */
function createOutbox(fromAddress) {
  const sent = [];
  const mailer = createMailer({
    resolve: async () => ({ provider: "e2e", fromAddress, apiKey: "" }),
    factories: {
      e2e: () => ({
        id: "e2e",
        async send(message) {
          const code = /\b(\d{6})\b/.exec(message.text || "")?.[1] ?? null;
          sent.push({ ...message, code, at: Date.now() });
          return { ok: true, messageId: `e2e-${sent.length}` };
        },
      }),
    },
  });
  return { mailer, sent };
}

/**
 * @param {object} opts
 * @param {object} opts.config        the resolved rest-api config
 * @param {object} opts.dynamoClient  the shared in-memory document client
 * @param {object} opts.s3            the shared in-memory S3 client
 * @param {string} opts.cookieKey     the one signing key
 * @param {() => void} opts.reset     clears every store
 */
export async function createRestServer({ config, dynamoClient, s3, cookieKey, reset }) {
  const { composeApp } = await import("../../rest-api/src/index.js");
  const { mailer, sent } = createOutbox(config.mail.fromAddress);

  // Supplier slots, filled the way `/admin` fills them — rows in the
  // credentials table, through the real credentials module.
  //
  //  - `stt`, because the mint core reads a key BEFORE dispatching to a
  //    provider (rest-api/src/stt/index.js:55). The fake provider goes through
  //    that same path deliberately: one exempt from the credential check would
  //    be exercising a shorter route than the real ones.
  //
  //  - `llm`, because the CAPABILITY MAP is computed from
  //    `credentials.exists("llm")`, and an assistant reported as off removes
  //    the Board tab from the room entirely (spa/src/room/SidePanel.jsx). The
  //    Gateway's `KELABO_LLM_API_KEY` bootstrap is not enough on its own: the
  //    agent then runs and posts while the room has nowhere to show it, which
  //    is a genuinely confusing state and one this suite should be able to tell
  //    apart from a silent assistant.
  //
  //  - `rtc`, for a reason worth stating because it is not obvious and it is
  //    arguably a product question: the CALL capability is `cap(hasRtc, …)`
  //    (contracts/src/entitlement.js:109), and `hasRtc` is only "is the slot
  //    filled". So an empty slot turns conference audio off entirely —
  //    including MESH, which needs no Cloudflare account and which the Gateway
  //    is written to serve STUN-only when the credential is absent
  //    (gateway/src/rtc/routes.js:172). With the slot empty the browser never
  //    asks, so that fallback is unreachable and neither transport can be
  //    exercised. The values here are not real; `KELABO_RTC_API_BASE` points at
  //    a dead local port, so the SFU path fails instantly and offline — which
  //    is the degradation `rtc.spec` asserts — while mesh connects over host
  //    candidates.
  const credentials = createCredentials({ db: createDb({ config, client: dynamoClient }) });
  await credentials.put("stt", { fake: "e2e-fake-stt-key" }, { by: "e2e-harness" });
  await credentials.put("llm", { apiKey: "e2e-not-a-real-key" }, { by: "e2e-harness" });
  await credentials.put("rtc", { sfuAppId: "e2e-app", sfuAppSecret: "e2e-secret" }, { by: "e2e-harness" });

  const app = composeApp(config, {
    dynamoClient,
    s3,
    mailer,
    // Secrets Manager holds only identity and perimeter here. Both are fixed
    // strings in the harness; the cookie key has to match the Gateway's or the
    // three token families stop verifying across the two services.
    secrets: {
      getCookieKey: async () => cookieKey,
      getApiOriginSecret: async () => "e2e-origin-secret",
      getSecretRaw: async () => "",
      getSecretJson: async () => ({}),
      // Social sign-in is off in the harness (`socialProviders` is empty), so
      // nothing reaches this. Present rather than absent so a test that turns
      // it on gets a refusal from the OIDC code rather than a TypeError here.
      getOidcSecret: async () => ({}),
    },
  });

  const server = http.createServer(async (req, res) => {
    const cors = corsFor(req, config.portalUrl);

    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        ...cors,
        "Access-Control-Allow-Methods": "GET, POST, PATCH, PUT, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": req.headers["access-control-request-headers"] || "content-type, authorization",
        "Access-Control-Max-Age": "600",
      });
      return res.end();
    }

    const url = new URL(req.url, config.portalUrl);

    if (url.pathname.startsWith(TEST_PREFIX)) {
      return handleTestRoute(url, req, res, cors, { sent, reset });
    }

    const raw = await readBody(req);
    const result = await app({
      version: "2.0",
      rawPath: url.pathname,
      rawQueryString: url.searchParams.toString(),
      headers: Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(", ") : v])),
      requestContext: { http: { method: req.method, sourceIp: req.socket.remoteAddress || "127.0.0.1" } },
      body: raw.length ? raw.toString("utf8") : undefined,
      isBase64Encoded: false,
    });
    writeResult(res, result, cors);
  });

  return { server, sent };
}

function handleTestRoute(url, req, res, cors, { sent, reset }) {
  const json = (status, body) => {
    res.writeHead(status, { "content-type": "application/json", ...cors });
    res.end(JSON.stringify(body));
  };

  // The sign-in code that would have been emailed. `?to=` filters; the newest
  // is first, because a resend must not be answered with the stale code.
  if (url.pathname === "/__test/mail") {
    const to = url.searchParams.get("to");
    const matches = sent.filter((m) => !to || m.to === to).slice().reverse();
    return json(200, { messages: matches.map(({ inline, html, ...rest }) => rest) });
  }
  if (url.pathname === "/__test/reset" && req.method === "POST") {
    sent.length = 0;
    reset?.();
    return json(200, { ok: true });
  }
  return json(404, { error: "not_found" });
}
