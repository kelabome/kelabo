// Agent bridge pairing and discovery (docs 16 §6).
//
// A developer's local coding agent needs exactly two things from Kelabo: a
// token, and a list of kelabos it may attach to. Both live here. Everything
// else the agent does goes over the Gateway's WSS tunnel.
//
// Pairing is a device-code flow rather than a copy-pasted secret: `kelabo login`
// prints a short user code, the developer approves it in the portal while
// already signed in, and the bridge polls for the token. The secret is never
// displayed, never in shell history, and the approval is an authenticated
// action by the person who owns the identity being delegated.
import { randomBytes, randomUUID } from "node:crypto";
import {
  AGENT_DEVICE_CODE_TTL_SECONDS,
  AGENT_DEVICE_POLL_SECONDS,
  AGENT_JWT_AUD,
  AGENT_JWT_ROLE,
  AGENT_USER_CODE_ALPHABET,
  AGENT_USER_CODE_LENGTH,
} from "@kelabo/contracts";
import { signJwt, verifyJwt, sha256, randomToken } from "./jwt.js";
import { err } from "./errors.js";

/** Uniform over the alphabet: `% alphabet.length` on a raw byte is not, and a
 *  code a human reads aloud is short enough for the bias to matter. */
function userCode() {
  const n = AGENT_USER_CODE_ALPHABET.length;
  const limit = Math.floor(256 / n) * n;
  let out = "";
  while (out.length < AGENT_USER_CODE_LENGTH) {
    for (const b of randomBytes(AGENT_USER_CODE_LENGTH)) {
      if (b >= limit) continue;
      out += AGENT_USER_CODE_ALPHABET[b % n];
      if (out.length === AGENT_USER_CODE_LENGTH) break;
    }
  }
  return `${out.slice(0, 4)}-${out.slice(4)}`;
}

/** Accept what a human typed: case, spaces and a missing dash are all theirs. */
export function normalizeUserCode(raw) {
  const clean = String(raw || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (clean.length !== AGENT_USER_CODE_LENGTH) return "";
  return `${clean.slice(0, 4)}-${clean.slice(4)}`;
}

export function createAgent({ config, db, secrets }) {
  const ttlDays = config.auth.agentTokenTtlDays;

  async function requestDeviceCode({ runtime, label }) {
    const now = Date.now();
    const expiresAt = now + AGENT_DEVICE_CODE_TTL_SECONDS * 1000;
    const item = {
      deviceCode: randomToken(32),
      userCode: userCode(),
      runtime: String(runtime || "unknown").slice(0, 64),
      label: String(label || "").slice(0, 80),
      createdAt: now,
      expiresAt,
      ttl: Math.floor(expiresAt / 1000),
    };
    await db.putDeviceCode(item);
    return {
      deviceCode: item.deviceCode,
      userCode: item.userCode,
      verificationUri: `${config.portalUrl}/pair`,
      expiresInSeconds: AGENT_DEVICE_CODE_TTL_SECONDS,
      intervalSeconds: AGENT_DEVICE_POLL_SECONDS,
    };
  }

  /** What the portal shows before the developer confirms, so they can see what
   *  they are about to authorize rather than approving an opaque code. */
  async function describeUserCode(raw) {
    const code = normalizeUserCode(raw);
    if (!code) throw err(400, "device_code_invalid");
    const item = await db.getDeviceCodeByUserCode(code);
    if (!item) throw err(404, "device_code_invalid");
    if (item.expiresAt <= Date.now()) throw err(410, "device_code_expired");
    return {
      userCode: item.userCode,
      runtime: item.runtime,
      label: item.label,
      requestedAt: item.createdAt,
      approved: !!item.approvedAt,
    };
  }

  async function approve({ userCode: raw, identity, tenantId }) {
    const code = normalizeUserCode(raw);
    if (!code) throw err(400, "device_code_invalid");
    const item = await db.getDeviceCodeByUserCode(code);
    if (!item) throw err(404, "device_code_invalid");
    if (item.expiresAt <= Date.now()) throw err(410, "device_code_expired");
    if (item.approvedAt) throw err(409, "device_code_invalid");
    try {
      await db.approveDeviceCode(item.deviceCode, { identity, tenantId, approvedAt: Date.now() });
    } catch (e) {
      if (e.name === "ConditionalCheckFailedException") throw err(409, "device_code_invalid");
      throw e;
    }
    return { ok: true, runtime: item.runtime, label: item.label };
  }

  /** Polled by the bridge. Deliberately 428 while pending: it is a real "not yet"
   *  rather than an error, and the bridge retries on it and gives up on anything
   *  else. */
  async function redeem({ deviceCode }) {
    if (!deviceCode) throw err(400, "device_code_invalid");
    const item = await db.getDeviceCode(deviceCode);
    if (!item) throw err(404, "device_code_invalid");
    if (item.expiresAt <= Date.now()) throw err(410, "device_code_expired");
    if (!item.approvedAt) throw err(428, "authorization_pending");

    const token = await mintAgentToken({
      identity: item.identity,
      tenantId: item.tenantId,
      runtime: item.runtime,
      label: item.label,
    });
    // One code, one token: burn it immediately so a leaked device code that was
    // already redeemed cannot mint a second.
    await db.deleteDeviceCode(item);
    return {
      agentToken: token.jwt,
      identity: item.identity,
      tenantId: item.tenantId,
      expiresAt: token.expiresAt,
      gatewayBaseUrl: config.gatewayBaseUrl,
    };
  }

  async function mintAgentToken({ identity, tenantId, runtime, label }) {
    const key = await secrets.getCookieKey(config);
    const now = Date.now();
    const expiresAt = now + ttlDays * 86400 * 1000;
    const jti = randomUUID();
    const jwt = signJwt(
      {
        sub: identity,
        tenant: tenantId,
        role: AGENT_JWT_ROLE,
        // Three token families share one signing key. `aud` is what stops a
        // session cookie being presented as an agent token, or the reverse.
        aud: AGENT_JWT_AUD,
        jti,
        label: label || runtime,
        iat: Math.floor(now / 1000),
        exp: Math.floor(expiresAt / 1000),
      },
      key
    );
    await db.putAgentToken({
      jti,
      identity,
      identityHash: sha256(identity),
      tenantId,
      runtime,
      label: label || runtime,
      revoked: false,
      createdAt: now,
      lastSeenAt: 0,
      expiresAt,
      ttl: Math.floor(expiresAt / 1000),
    });
    return { jwt, jti, expiresAt };
  }

  /** Verify a bearer token presented by a bridge. Signature and `aud` come from
   *  the JWT; revocation is a table read, which is affordable because it happens
   *  once per connection rather than once per frame. */
  async function verifyAgentToken(token) {
    const key = await secrets.getCookieKey(config);
    const payload = verifyJwt(token, key);
    if (!payload || payload.aud !== AGENT_JWT_AUD || payload.role !== AGENT_JWT_ROLE) return null;
    if (!payload.sub || !payload.jti) return null;
    const row = await db.getAgentToken(payload.jti);
    if (!row || row.revoked) return null;
    return payload;
  }

  async function listTokens({ identity }) {
    const rows = await db.listAgentTokensByIdentity(sha256(identity));
    return {
      agents: rows
        .filter((r) => !r.revoked && r.expiresAt > Date.now())
        .map((r) => ({
          jti: r.jti,
          runtime: r.runtime,
          label: r.label,
          createdAt: r.createdAt,
          lastSeenAt: r.lastSeenAt || 0,
          expiresAt: r.expiresAt,
        }))
        .sort((a, b) => b.createdAt - a.createdAt),
    };
  }

  async function revokeToken({ identity, jti }) {
    const row = await db.getAgentToken(jti);
    // 404 rather than 403 for someone else's token: whether a jti exists is not
    // this caller's business.
    if (!row || row.identity !== identity) throw err(404, "not_found");
    await db.setAgentTokenRevoked(jti, true);
    return { ok: true };
  }

  /**
   * Kelabos this identity may attach an agent to: active ones to attend, and
   * scheduled ones to prepare for. Host or invitee — preparing for a kelabo you
   * were invited to is the ordinary case, not a privileged one, including one
   * hosted at a tenant this identity does not belong to (docs 18 §2.8) — the
   * tenant this runs against is derived from `identity` itself for exactly
   * that reason, not taken from the caller.
   */
  async function joinableKelabos({ identity }) {
    const [{ sameTenant: activeSame, crossTenant: activeCross }, { sameTenant: schedSame, crossTenant: schedCross }] =
      await Promise.all([
        db.listKelabosByStatusForIdentity(identity, "active"),
        db.listKelabosByStatusForIdentity(identity, "scheduled"),
      ]);
    const active = [...activeSame, ...activeCross];
    const scheduled = [...schedSame, ...schedCross];
    const visible = await Promise.all(
      [...active, ...scheduled].map(async (meta) => {
        if (meta.hostIdentity === identity) return { meta, isHost: true };
        const invites = await db.listInvites(meta.kelaboId);
        return invites.some((i) => i.inviteKey === identity) ? { meta, isHost: false } : null;
      })
    );
    return {
      kelabos: visible
        .filter(Boolean)
        .map(({ meta, isHost }) => ({
          kelaboId: meta.kelaboId,
          title: meta.title || "",
          status: meta.status,
          isHost,
          scheduledAt: meta.scheduledAt ?? null,
          durationMinutes: meta.durationMinutes ?? null,
          startedAt: meta.startedAt || 0,
          host: meta.hostIdentity,
        }))
        // Live first, then soonest. The agent is choosing from this list, so the
        // order is the recommendation.
        .sort((a, b) => {
          if (a.status !== b.status) return a.status === "active" ? -1 : 1;
          return (a.scheduledAt || a.startedAt) - (b.scheduledAt || b.startedAt);
        }),
    };
  }

  return {
    requestDeviceCode,
    describeUserCode,
    approve,
    redeem,
    verifyAgentToken,
    listTokens,
    revokeToken,
    joinableKelabos,
  };
}
