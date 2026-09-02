// The setup client: everything a test needs to ARRANGE, done over HTTP.
//
// Not a second implementation of the product — every call here is a route the
// SPA itself calls. It exists so a test that is about the journeys page does
// not spend forty seconds signing in and creating a kelabo through the UI. What
// a test ASSERTS should still go through the browser; what it merely needs to
// exist can come from here.
//
// Signing in is deliberately the real OTP exchange rather than a minted cookie.
// It costs two requests, and it leaves the same USER row behind that a real
// sign-in does — a minted cookie names an identity that was never registered,
// and everything downstream that reads a display name or a tenant then behaves
// subtly differently from production for no reason a test could see.

import { API_BASE, GATEWAY_BASE, TENANT_DOMAIN } from "../harness/env.mjs";

/** Parse `Set-Cookie` response headers into Playwright's cookie shape. */
function cookiesFrom(response, url = new URL(API_BASE)) {
  const raw = response.headers.getSetCookie?.() ?? [];
  return raw
    .map((line) => {
      const [pair, ...attrs] = line.split(";");
      const idx = pair.indexOf("=");
      if (idx < 0) return null;
      const name = pair.slice(0, idx).trim();
      const value = decodeURIComponent(pair.slice(idx + 1).trim());
      if (!value) return null; // a cleared cookie
      const attributes = Object.fromEntries(
        attrs.map((a) => {
          const [k, v = ""] = a.split("=");
          return [k.trim().toLowerCase(), v.trim()];
        })
      );
      return {
        name,
        value,
        domain: url.hostname,
        path: attributes.path || "/",
        httpOnly: "httponly" in attributes,
        // Chromium accepts `Secure` on http://localhost, which is a trustworthy
        // origin — this is why the harness does not have to strip the flag and
        // therefore does not diverge from the deployment's cookie attributes.
        secure: "secure" in attributes,
        sameSite: "Lax",
      };
    })
    .filter(Boolean);
}

const cookieHeader = (cookies) => cookies.map((c) => `${c.name}=${encodeURIComponent(c.value)}`).join("; ");

export function createApiClient() {
  /** name -> cookie, so a later response's cookie replaces an earlier one. */
  const jar = new Map();

  function absorb(response) {
    for (const c of cookiesFrom(response)) jar.set(c.name, c);
  }

  async function call(base, method, path, body) {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        ...(jar.size ? { cookie: cookieHeader([...jar.values()]) } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "manual",
    });
    absorb(res);
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {}
    // Thrown, not returned: a setup step that quietly failed produces an
    // assertion failure three screens later about something unrelated.
    if (res.status >= 400) {
      throw new Error(`${method} ${path} -> ${res.status} ${text.slice(0, 300)}`);
    }
    return json;
  }

  const api = (method, path, body) => call(API_BASE, method, path, body);
  const gw = (method, path, body) => call(GATEWAY_BASE, method, path, body);

  return {
    /** Every cookie collected so far, ready for `context.addCookies`. */
    cookies: () => [...jar.values()],

    /** The real OTP exchange: request a code, read it from the outbox, verify. */
    async signIn(localPart = "alice") {
      const email = localPart.includes("@") ? localPart : `${localPart}@${TENANT_DOMAIN}`;
      await api("POST", "/auth/otp/request", { email });
      const { messages } = await api("GET", `/__test/mail?to=${encodeURIComponent(email)}`);
      const code = messages[0]?.code;
      if (!code) throw new Error(`no sign-in code was sent to ${email}`);
      const result = await api("POST", "/auth/otp/verify", { email, code });
      return { email, ...result };
    },

    /** The most recent mail sent to an address — what auth.spec reads its code from. */
    async lastMail(email) {
      const { messages } = await api("GET", `/__test/mail?to=${encodeURIComponent(email)}`);
      return messages[0] ?? null;
    },

    me: () => api("GET", "/me"),

    createKelabo: (body = {}) => api("POST", "/kelabos", { title: "E2E kelabo", ...body }),
    joinKelabo: (kelaboId, body = {}) =>
      api("POST", `/kelabos/${kelaboId}/join`, { displayName: "Tester", mode: "audio-board", ...body }),
    board: (kelaboId) => api("GET", `/kelabos/${kelaboId}/board`),
    endKelabo: (kelaboId) => api("POST", `/kelabos/${kelaboId}/end`),

    createJourney: (body = {}) => api("POST", "/journeys", { title: "E2E journey", ...body }),
    linkKelabo: (journeyId, kelaboId) => api("POST", `/journeys/${journeyId}/kelabos`, { kelaboId }),
    journeyBoardPost: (journeyId, content) => api("POST", `/journeys/${journeyId}/board`, { content }),
    journeyDocument: (journeyId, title, content) => api("POST", `/journeys/${journeyId}/documents`, { title, content }),
    journeyTimeline: (journeyId) => api("GET", `/journeys/${journeyId}/timeline`),

    /**
     * A sealed caption, straight at the Gateway — the same request
     * `spa/src/transcript/publisher.js` makes. This is how a test injects
     * transcript without an STT provider or a microphone.
     */
    caption: (kelaboId, { messageId, text, speaker, source = "speech" }) =>
      gw("POST", "/caption", { kelaboId, messageId, kind: "sealed", isFinal: true, text, speaker, source }),

    captionHistory: (kelaboId) => gw("GET", `/caption/history?kelaboId=${kelaboId}`),

    raw: { api, gw },
  };
}
