// Thin client over the two Cloudflare Realtime APIs we use:
//
//   SFU  https://rtc.live.cloudflare.com/v1/apps/<appId>/...   (Bearer appSecret)
//   TURN https://rtc.live.cloudflare.com/v1/turn/keys/<id>/... (Bearer turnKeyApiToken)
//
// Credentials live in the `rtc` slot of the credentials table and never leave
// the Gateway — the browser only ever sees short-lived ICE credentials and
// SDP. `fetchImpl` is injected so tests run offline, the same seam
// rest-api/src/stt/index.js uses.

const REQUEST_TIMEOUT_MS = 10_000;

/** @typedef {{ sfuAppId:string, sfuAppSecret:string, turnKeyId?:string, turnKeyApiToken?:string }} CloudflareRtcCreds */

export class RtcError extends Error {
  constructor(code, status, detail) {
    super(detail ? `${code}: ${detail}` : code);
    this.code = code;
    this.status = status;
    this.detail = detail;
  }
}

/**
 * @param {{ apiBase:string, getCreds:() => Promise<CloudflareRtcCreds|null>, fetchImpl?:typeof fetch }} opts
 */
/**
 * What a room gets when no TURN credentials can be minted: STUN alone. Direct
 * connectivity still works on most networks; only relay-requiring peers fail.
 * Exported so the routes can answer without touching Cloudflare.
 */
export const STUN_ONLY = Object.freeze({
  iceServers: Object.freeze([Object.freeze({ urls: ["stun:stun.cloudflare.com:3478"] })]),
  relay: false,
});

export function createCloudflareRtc({ apiBase, getCreds, fetchImpl = fetch }) {
  async function creds() {
    const c = await getCreds();
    if (!c || !c.sfuAppId || !c.sfuAppSecret) {
      throw new RtcError("rtc_unavailable", 503, "cloudflare realtime credentials missing");
    }
    return c;
  }

  async function call(url, { method = "POST", token, body }) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), REQUEST_TIMEOUT_MS);
    let res;
    try {
      res = await fetchImpl(url, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          // Only when there is one: Cloudflare validates the body whenever it is
          // present, so an empty-but-present body is worse than none.
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ac.signal,
      });
    } catch (e) {
      throw new RtcError("rtc_unavailable", 502, String(e));
    } finally {
      clearTimeout(timer);
    }
    const text = await res.text().catch(() => "");
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    if (!res.ok) {
      // Cloudflare's own status and errorCode are carried alongside the text.
      // Not every failure means the same thing to a caller: `session_error` is
      // terminal for that session and the only cure is a new one, while most
      // others are worth another go. Leaving that distinction buried in a
      // string meant the SPA could only retry everything forever.
      const err = new RtcError("rtc_unavailable", 502, `cloudflare ${res.status} ${text.slice(0, 300)}`);
      err.cfStatus = res.status;
      err.cfCode = typeof data?.errorCode === "string" ? data.errorCode : undefined;
      throw err;
    }
    return data ?? {};
  }

  const appUrl = (c, path) => `${apiBase}/apps/${encodeURIComponent(c.sfuAppId)}${path}`;

  /**
   * Create a session, optionally answering a client offer in the same round trip.
   *
   * With no offer the request must carry **no body at all**. Cloudflare validates
   * the body whenever one is present, so `{}` is rejected with
   * `decoding_error: sessionDescription` — verified against the live API.
   */
  async function newSession(sessionDescription) {
    const c = await creds();
    return call(appUrl(c, "/sessions/new"), {
      token: c.sfuAppSecret,
      body: sessionDescription ? { sessionDescription } : undefined,
    });
  }

  /**
   * Publish (`location:"local"`) or pull (`location:"remote"`) tracks. Callers
   * must have already validated that every remote `sessionId` belongs to a peer
   * of the same kelabo — this client does no authorization of its own.
   */
  async function newTracks(sessionId, { sessionDescription, tracks }) {
    const c = await creds();
    return call(appUrl(c, `/sessions/${encodeURIComponent(sessionId)}/tracks/new`), {
      token: c.sfuAppSecret,
      body: { ...(sessionDescription ? { sessionDescription } : {}), tracks },
    });
  }

  async function renegotiate(sessionId, sessionDescription) {
    const c = await creds();
    return call(appUrl(c, `/sessions/${encodeURIComponent(sessionId)}/renegotiate`), {
      method: "PUT",
      token: c.sfuAppSecret,
      body: { sessionDescription },
    });
  }

  async function closeTracks(sessionId, { tracks, sessionDescription, force }) {
    const c = await creds();
    return call(appUrl(c, `/sessions/${encodeURIComponent(sessionId)}/tracks/close`), {
      method: "PUT",
      token: c.sfuAppSecret,
      body: {
        tracks,
        ...(sessionDescription ? { sessionDescription } : {}),
        force: force ?? true,
      },
    });
  }

  async function getSession(sessionId) {
    const c = await creds();
    return call(appUrl(c, `/sessions/${encodeURIComponent(sessionId)}`), {
      method: "GET",
      token: c.sfuAppSecret,
    });
  }

  /**
   * Short-lived STUN/TURN credentials for the browser. Used by both transports:
   * the SFU falls back to TURN on restrictive networks, and mesh needs it to
   * traverse symmetric NATs. TURN only relays DTLS-SRTP packets it cannot
   * decrypt, so a relayed mesh call keeps its peer-to-peer confidentiality.
   */
  async function iceServers(ttlSeconds) {
    const c = await creds();
    if (!c.turnKeyId || !c.turnKeyApiToken) {
      return STUN_ONLY;
    }
    const data = await call(
      `${apiBase}/turn/keys/${encodeURIComponent(c.turnKeyId)}/credentials/generate-ice-servers`,
      { token: c.turnKeyApiToken, body: { ttl: ttlSeconds } },
    );
    // Port 53 is documented to hang in browsers unless trickle ICE is used; drop
    // it so a candidate gathering pass never stalls on it.
    const servers = (data.iceServers ?? []).map((s) => ({
      ...s,
      urls: (Array.isArray(s.urls) ? s.urls : [s.urls]).filter((u) => !String(u).includes(":53")),
    }));
    return { iceServers: servers.filter((s) => s.urls.length > 0), relay: true };
  }

  return { newSession, newTracks, renegotiate, closeTracks, getSession, iceServers };
}
