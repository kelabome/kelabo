import { randomUUID } from "node:crypto";
import { COOKIE_SESSION, COOKIE_REFRESH, COOKIE_PARTICIPANT, sessionCookieSchema } from "@kelabo/contracts";
import { randomToken, sha256 } from "./jwt.js";
import { mintCookie, readCookie, serializeCookie, clearCookie } from "./cookies.js";
import { err } from "./errors.js";

/**
 * The display name for a user row, from the one place that decides it.
 *
 * Two rules, and they are easy to get backwards:
 *
 *  - The Settings name wins when the user has chosen one, including when the
 *    choice is **no name at all**. `null` means never chosen; `""` means
 *    deliberately cleared, and those are different answers. Collapsing them
 *    with `||` is what made a cleared name come back on the next request.
 *  - Only when nothing has been chosen do we fall back to `users.displayName`
 *    (stamped once at first login) and then to the email local-part.
 *
 * `/me` and the refresh path both call this. They used to answer separately —
 * refresh never consulted `settings.name` at all — so the name you saw depended
 * on which request had most recently refreshed your session.
 */
export function resolveDisplayName(user, identity) {
  const chosen = typeof user?.settings?.name === "string" ? user.settings.name.trim() : null;
  return chosen ?? (user?.displayName || identity.split("@")[0]);
}

export function createSessions({ config, db, secrets, opConfig }) {
  /**
   * Token lifetimes, published (contracts/src/opconfig.js) and read at the
   * moment a token is minted.
   *
   * That timing is the whole of what this can and cannot do, and it is worth
   * being plain about: shortening a lifetime here affects tokens minted from
   * now on and **does not touch a session already issued**. Nothing in this
   * mechanism revokes; an operator tightening a TTL after an incident still
   * needs `/logout-all`.
   */
  const authNow = async () => (opConfig ? (await opConfig.effective()).auth : config.auth);

  async function sessionPayload(identity, tenantId) {
    return {
      kind: "identity",
      identity,
      tenantId,
      exp: Math.floor(Date.now() / 1000) + (await authNow()).sessionTtlSeconds,
    };
  }

  async function mintSessionCookie(identity, tenantId) {
    const key = await secrets.getCookieKey(config);
    const sessionTtlSeconds = (await authNow()).sessionTtlSeconds;
    return serializeCookie(COOKIE_SESSION, mintCookie(await sessionPayload(identity, tenantId), key), {
      maxAgeSeconds: sessionTtlSeconds,
      // Domain-scoped like the refresh and participant cookies, so it reaches the
      // gateway subdomain (`gw.<portal>`). Presence (docs 18 §5) is the first
      // gateway route to authenticate with the SESSION cookie; without a Domain
      // it is host-only to the portal and the browser never sends it to the
      // gateway, so `/presence/stream` (and any future session-authed gateway
      // route) 401s and every contact shows offline.
      domain: config.cookieDomain,
    });
  }

  async function mintRefreshCookie(identity, tenantId, { chainId, rotatedFrom } = {}) {
    const tokenId = randomUUID();
    const raw = randomToken(32);
    const now = Date.now();
    const refreshTtlDays = (await authNow()).refreshTtlDays;
    const expiresAt = now + refreshTtlDays * 86400 * 1000;
    await db.putRefreshToken({
      tokenId,
      identityHash: sha256(identity),
      identity,
      hash: sha256(raw),
      chainId: chainId || randomUUID(),
      ...(rotatedFrom ? { rotatedFrom } : {}),
      revoked: false,
      expiresAt,
      ttl: Math.floor(expiresAt / 1000),
      createdAt: now,
      tenantId,
    });
    return serializeCookie(COOKIE_REFRESH, `${tokenId}.${raw}`, {
      maxAgeSeconds: refreshTtlDays * 86400,
      domain: config.cookieDomain,
    });
  }

  async function establishSession(email, displayName) {
    const tenantId = email.split("@")[1].toLowerCase();
    const name = displayName || email.split("@")[0];
    await db.upsertUser({ email, displayName: name, tenantId });
    // The user row this just wrote IS the record the invitee autocomplete
    // reads, via the users table's `tenant-index`. There is no second list to
    // keep in step.
    const session = await mintSessionCookie(email, tenantId);
    const refresh = await mintRefreshCookie(email, tenantId);
    return {
      cookies: [session, refresh],
      identity: { email, displayName: displayName || email.split("@")[0] },
      tenantId,
    };
  }

  async function readSession(cookieValue) {
    if (!cookieValue) return null;
    const key = await secrets.getCookieKey(config);
    return readCookie(cookieValue, key, sessionCookieSchema);
  }

  async function refresh(refreshCookie) {
    if (!refreshCookie) throw err(401, "refresh_invalid");
    const dot = refreshCookie.indexOf(".");
    if (dot < 0) throw err(401, "refresh_invalid");
    const tokenId = refreshCookie.slice(0, dot);
    const raw = refreshCookie.slice(dot + 1);
    const item = await db.getRefreshToken(tokenId);
    if (!item || item.hash !== sha256(raw)) throw err(401, "refresh_invalid");
    if (item.expiresAt <= Date.now()) throw err(401, "refresh_invalid");
    if (item.revoked) {
      await revokeChain(item);
      throw err(401, "refresh_invalid");
    }
    await db.setRefreshRevoked(tokenId, true);
    const user = await db.getUser(item.identity);
    const displayName = resolveDisplayName(user, item.identity);
    const session = await mintSessionCookie(item.identity, item.tenantId);
    const rotated = await mintRefreshCookie(item.identity, item.tenantId, {
      chainId: item.chainId,
      rotatedFrom: tokenId,
    });
    return {
      cookies: [session, rotated],
      identity: { email: item.identity, displayName },
      tenantId: item.tenantId,
    };
  }

  async function revokeChain(item) {
    if (!item?.chainId) return;
    const tokens = await db.listRefreshTokensByIdentity(item.identityHash);
    for (const t of tokens) {
      if (t.chainId === item.chainId && !t.revoked) await db.setRefreshRevoked(t.tokenId, true);
    }
  }

  async function logout(refreshCookie) {
    if (!refreshCookie) return;
    const dot = refreshCookie.indexOf(".");
    if (dot < 0) return;
    const item = await db.getRefreshToken(refreshCookie.slice(0, dot));
    if (item && !item.revoked) await db.setRefreshRevoked(item.tokenId, true);
  }

  async function logoutAll(identity) {
    const tokens = await db.listRefreshTokensByIdentity(sha256(identity));
    for (const t of tokens) {
      if (!t.revoked) await db.setRefreshRevoked(t.tokenId, true);
    }
  }

  function clearAuthCookies() {
    // A Set-Cookie deletion only removes a cookie whose Domain matches exactly.
    // The session cookie used to be minted host-only (no Domain) and is now
    // minted with the shared Domain, so BOTH variants may exist in a browser
    // mid-migration — a stale host-only one that logout could not clear was why
    // "log out" bounced straight back in. Clear both shapes of each cookie so a
    // legacy cookie is removed regardless of how it was set.
    return [
      clearCookie(COOKIE_SESSION, { domain: config.cookieDomain }),
      clearCookie(COOKIE_SESSION), // host-only legacy variant
      clearCookie(COOKIE_REFRESH, { domain: config.cookieDomain }),
      clearCookie(COOKIE_REFRESH),
      clearCookie(COOKIE_PARTICIPANT, { domain: config.cookieDomain }),
      clearCookie(COOKIE_PARTICIPANT),
    ];
  }

  return {
    establishSession,
    readSession,
    refresh,
    logout,
    logoutAll,
    clearAuthCookies,
    mintSessionCookie,
  };
}
