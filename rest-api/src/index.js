import {
  COOKIE_SESSION,
  COOKIE_REFRESH,
  COOKIE_PARTICIPANT,
  otpRequestBodySchema,
  otpVerifyBodySchema,
  createKelaboBodySchema,
  scheduleKelaboBodySchema,
  cancelKelaboBodySchema,
  rescheduleKelaboBodySchema,
  updateInviteesBodySchema,
  huddleBodySchema,
  ringBodySchema,
  ringAnswerBodySchema,
  rsvpBodySchema,
  rsvpCookieSchema,
  COOKIE_RSVP,
  joinBodySchema,
  settingsPutBodySchema,
  mcpServerPutBodySchema,
  mcpProbeBodySchema,
  purgeRecordsBodySchema,
  agentDeviceCodeBodySchema,
  agentDeviceTokenBodySchema,
  agentApproveBodySchema,
  joinCodeRedeemBodySchema,
  createJourneyBodySchema,
  patchJourneyBodySchema,
  journeyDescriptionBodySchema,
  journeyAccessorBodySchema,
  journeyLinkKelaboBodySchema,
  journeyStatusBodySchema,
  journeyBoardMessageBodySchema,
  journeyDocumentBodySchema,
  journeyReportBodySchema,
} from "@kelabo/contracts";
import { timingSafeEqual } from "node:crypto";
import { ZodError } from "zod";
import { ensureConfig } from "./config.js";
import { createDb } from "./db.js";
import { createSecrets } from "./secrets.js";
import { createOtp } from "./otp.js";
import { createMailer, mailSettingsFromConfig } from "./mail/index.js";
import { createSessions } from "./sessions.js";
import { createOidc } from "./oidc.js";
import { createMcpOauth } from "./mcpOauth.js";
import { createAuthProvider } from "./authProvider.js";
import { createKelabos } from "./kelabos.js";
import { createScheduling } from "./scheduling.js";
import { createContacts } from "./contacts.js";
import { createHuddle } from "./huddle.js";
import { createJoin } from "./join.js";
import { createJoinCodes } from "./joinCode.js";
import { createRecords } from "./records.js";
import { createJourneys } from "./journeys.js";
import { createSttToken } from "./stt/index.js";
import { createInternal } from "./internal.js";
import { createAgent } from "./agent.js";
import { parseCookies, readCookie, mintCookie, serializeCookie } from "./cookies.js";
import { ApiError, err } from "./errors.js";

const VERSION = process.env.KELABO_VERSION || "0.1.0";

/** The header CloudFront injects, and the only thing separating a request that
 *  came through the distribution from one that went around it. */
export const ORIGIN_SECRET_HEADER = "x-kelabo-origin";

/**
 * Constant-time comparison of the presented origin secret against the expected
 * one. `timingSafeEqual` throws when the buffers differ in length, so length is
 * checked first — it is not itself secret, since the value is generated at a
 * fixed width.
 */
export function originSecretMatches(presented, expected) {
  if (!expected || typeof presented !== "string" || !presented) return false;
  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

function log(level, msg, extra = {}) {
  const fn = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
  fn(JSON.stringify({ level, msg, ts: new Date().toISOString(), ...extra }));
}

function compile(pattern) {
  const names = [];
  const regex = new RegExp(
    "^" +
      pattern
        .split("/")
        .map((seg) => {
          if (seg.startsWith(":")) {
            names.push(seg.slice(1));
            return "([^/]+)";
          }
          return seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        })
        .join("/") +
      "$"
  );
  return { regex, names };
}

function htmlErrorPage(status, code) {
  const body = `<!doctype html><html><head><title>Kelabo sign-in</title></head><body style="font-family:sans-serif;max-width:32rem;margin:4rem auto"><h1>Sign-in failed</h1><p><code>${code}</code></p><p><a href="/">Back to Kelabo</a></p></body></html>`;
  return { status, headers: { "Content-Type": "text/html; charset=utf-8" }, body };
}

export function createApp(deps) {
  const { config, sessions, auth, kelabos, join, joinCodes, records, sttToken, db, secrets, mcpOauth, scheduling, contacts, huddle, agent, journeys } = deps;

  /**
   * Best-effort link into the journeys named at kelabo creation/schedule time
   * (docs 20 §11). One bad id must not lose the kelabo, same reasoning as an
   * invite email that fails to send: the caller is told which links failed
   * rather than the create silently doing less than it said.
   */
  async function linkNewKelaboToJourneys({ identity, kelaboId, journeyIds }) {
    if (!journeyIds?.length) return undefined;
    const results = [];
    for (const journeyId of journeyIds) {
      try {
        await journeys.linkKelabo({ journeyId, identity, kelaboId });
        results.push({ journeyId, linked: true });
      } catch (e) {
        results.push({ journeyId, linked: false, reason: e.code || e.name || "link_failed" });
      }
    }
    return results;
  }

  /** `Authorization: Bearer <token>` — the agent bridge's only credential. */
  function bearerToken(req) {
    const m = /^Bearer\s+(.+)$/i.exec(req.headers?.authorization || "");
    return m ? m[1].trim() : "";
  }

  async function requireSession(req) {
    const session = await sessions.readSession(req.cookies[COOKIE_SESSION]);
    if (!session) throw err(401, "unauthenticated");
    return session;
  }

  /**
   * The signed cookie that tells a returning guest apart from a new one. Only
   * ever consulted when there is no session — a signed-in invitee is already
   * identified by their address, which is a far better key than a cookie.
   */
  async function readRsvpKey(req, kelaboId) {
    const raw = req.cookies[COOKIE_RSVP];
    if (!raw) return null;
    const key = await secrets.getCookieKey(config);
    const c = readCookie(raw, key, rsvpCookieSchema);
    if (!c || c.kelaboId !== kelaboId) return null;
    return c.inviteKey;
  }

  async function rsvpCookie(kelaboId, inviteKey) {
    const key = await secrets.getCookieKey(config);
    const maxAgeSeconds = 90 * 24 * 3600;
    return serializeCookie(
      COOKIE_RSVP,
      mintCookie({ kind: "rsvp", kelaboId, inviteKey, exp: Math.floor(Date.now() / 1000) + maxAgeSeconds }, key),
      { maxAgeSeconds, domain: config.cookieDomain }
    );
  }

  async function requireParticipant(req, kelaboId) {
    const p = await join.readParticipant(req.cookies[COOKIE_PARTICIPANT], kelaboId);
    if (!p) throw err(401, "unauthenticated");
    return p;
  }

  const routes = [
    {
      method: "GET",
      pattern: "/health",
      handle: async () => ({ status: 200, body: { ok: true, version: deps.version || VERSION } }),
    },
    {
      method: "POST",
      pattern: "/auth/otp/request",
      handle: async (req) => {
        const { email } = otpRequestBodySchema.parse(req.body);
        const result = await auth.otp.request({ email: email.toLowerCase(), ip: req.ip });
        return { status: 200, body: result };
      },
    },
    {
      method: "POST",
      pattern: "/auth/otp/verify",
      handle: async (req) => {
        const { email, code } = otpVerifyBodySchema.parse(req.body);
        const result = await auth.otp.verify({ email: email.toLowerCase(), code });
        return { status: 200, body: { identity: result.identity, tenantId: result.tenantId }, cookies: result.cookies };
      },
    },
    {
      method: "GET",
      pattern: "/auth/oidc/:provider/start",
      handle: async (req) => auth.oidcSocial.start(req.params.provider),
    },
    {
      method: "GET",
      pattern: "/auth/oidc/:provider/callback",
      handle: (req) => oidcCallback(req, req.query),
    },
    {
      method: "POST",
      pattern: "/auth/oidc/:provider/callback",
      handle: (req) => oidcCallback(req, { ...req.query, ...(req.body || {}) }),
    },
    {
      method: "POST",
      pattern: "/auth/refresh",
      handle: async (req) => {
        const result = await sessions.refresh(req.cookies[COOKIE_REFRESH]);
        return { status: 200, body: { identity: result.identity, tenantId: result.tenantId }, cookies: result.cookies };
      },
    },
    {
      method: "GET",
      pattern: "/me",
      handle: async (req) => {
        const session = await requireSession(req);
        const user = await db.getUser(session.identity);
        // The Settings display name is the user's own choice and wins.
        // `users.displayName` is only ever stamped once, at first login, with the
        // email local-part (otp.js, if_not_exists) — reporting that as the
        // identity made every surface show the raw local-part no matter what the
        // user had set.
        const chosen = typeof user?.settings?.name === "string" ? user.settings.name.trim() : "";
        return {
          status: 200,
          body: {
            identity: {
              email: session.identity,
              displayName: chosen || user?.displayName || session.identity.split("@")[0],
              // The identicon re-roll (Settings → Avatar). 0 = default.
              avatarVariant: Number(user?.settings?.avatar) || 0,
            },
            tenantId: session.tenantId,
          },
        };
      },
    },
    {
      method: "GET",
      pattern: "/me/settings",
      handle: async (req) => {
        const session = await requireSession(req);
        const data = await db.getUserSettings(session.identity);
        return { status: 200, body: { settings: data?.settings ?? null, updatedAt: data?.updatedAt ?? 0 } };
      },
    },
    {
      method: "PUT",
      pattern: "/me/settings",
      handle: async (req) => {
        const session = await requireSession(req);
        const parsed = settingsPutBodySchema.safeParse(req.body);
        if (!parsed.success) throw err(400, "bad_request", JSON.stringify(parsed.error.issues));
        const data = await db.putUserSettings(session.identity, parsed.data.settings, parsed.data.updatedAt ?? Date.now());
        return { status: 200, body: data ?? { settings: null, updatedAt: 0 } };
      },
    },
    {
      method: "GET",
      pattern: "/me/mcp",
      handle: async (req) => {
        const session = await requireSession(req);
        const scope = `host#${session.identity}`;
        const [items, tokens] = await Promise.all([db.getMcpServers(scope), db.getMcpTokens(scope)]);
        const byName = new Map(tokens.map((t) => [t.name, t]));
        const servers = items.map(({ PK, SK, secretRef, ...s }) => {
          const token = byName.get(s.name);
          return {
            ...s,
            authType: s.authType ?? (secretRef ? "bearer" : "none"),
            // secretRef is an internal Secrets Manager path — the browser only
            // needs to know whether a credential exists, never where it lives.
            hasSecret: !!secretRef,
            oauth: s.oauth ? { issuer: s.oauth.issuer, scope: s.oauth.scope ?? null } : undefined,
            connected: !!token,
            expiresAt: token?.expiresAt ?? null,
          };
        });
        return { status: 200, body: { servers } };
      },
    },
    {
      // Unauthenticated look at a candidate URL so the UI can offer "Connect"
      // (OAuth) vs an auth-token field before the server is saved.
      method: "POST",
      pattern: "/me/mcp/probe",
      handle: async (req) => {
        await requireSession(req);
        const parsed = mcpProbeBodySchema.safeParse(req.body);
        if (!parsed.success) throw err(400, "bad_request", JSON.stringify(parsed.error.issues));
        return { status: 200, body: await mcpOauth.probe(parsed.data.url) };
      },
    },
    {
      // Top-level navigation target: 302s the browser to the MCP server's own
      // authorization server. SameSite=Lax lets the session cookie ride along.
      method: "GET",
      pattern: "/me/mcp/:name/oauth/start",
      handle: async (req) => {
        const session = await requireSession(req);
        return mcpOauth.start(session.identity, req.params.name);
      },
    },
    {
      // Fixed callback for every server and every user — the name and identity
      // come from the signed state cookie, because the redirect URI is what gets
      // registered with the authorization server and must match exactly.
      method: "GET",
      pattern: "/me/mcp/oauth/callback",
      handle: async (req) => {
        let session;
        try {
          session = await requireSession(req);
        } catch {
          // Session lapsed during consent: send them back to the UI rather than
          // dead-ending a browser navigation on a JSON 401.
          return {
            status: 302,
            headers: { Location: `${config.portalUrl}/settings?mcp_error=unauthenticated` },
          };
        }
        return mcpOauth.callback(session.identity, { query: req.query, cookies: req.cookies });
      },
    },
    {
      method: "DELETE",
      pattern: "/me/mcp/:name/oauth",
      handle: async (req) => {
        const session = await requireSession(req);
        return { status: 200, body: await mcpOauth.disconnect(session.identity, req.params.name) };
      },
    },
    {
      method: "PUT",
      pattern: "/me/mcp",
      handle: async (req) => {
        const session = await requireSession(req);
        const parsed = mcpServerPutBodySchema.safeParse(req.body);
        if (!parsed.success) throw err(400, "bad_request", JSON.stringify(parsed.error.issues));
        const { name, url, headers, enabled, secret, authType } = parsed.data;
        const scope = `host#${session.identity}`;
        const secretRef = `${session.identity}/${name}`;
        if (secret) await secrets.putMcpSecret(config, session.identity, name, secret);
        const existing = (await db.getMcpServers(scope)).find((s) => s.name === name);
        const keepsSecret = !!(secret || existing?.secretRef);
        // An explicit authType wins; otherwise infer from what we hold, and
        // never silently downgrade an already-connected OAuth server.
        const effectiveAuthType =
          authType ?? existing?.authType ?? (keepsSecret ? "bearer" : "none");
        const server = {
          name,
          transport: "http",
          url,
          ...(headers ? { headers } : {}),
          // Keep a previously stored secret unless the request replaces it; a
          // new server with no token gets no secretRef.
          ...(keepsSecret ? { secretRef } : {}),
          authType: effectiveAuthType,
          // Discovery metadata only survives while the server stays on OAuth.
          ...(effectiveAuthType === "oauth" && existing?.oauth ? { oauth: existing.oauth } : {}),
          enabled: enabled ?? existing?.enabled ?? true,
        };
        await db.putMcpServer(scope, server);
        return { status: 200, body: { server: { ...server, secretRef: undefined, hasSecret: keepsSecret } } };
      },
    },
    {
      method: "DELETE",
      pattern: "/me/mcp/:name",
      handle: async (req) => {
        const session = await requireSession(req);
        const scope = `host#${session.identity}`;
        const existing = (await db.getMcpServers(scope)).find((s) => s.name === req.params.name);
        if (!existing) throw err(404, "not_found");
        await db.deleteMcpServer(scope, req.params.name);
        // Tokens live in a sibling item and would otherwise be orphaned.
        await db.deleteMcpToken(scope, req.params.name);
        if (existing.secretRef) await secrets.deleteMcpSecret(config, session.identity, req.params.name);
        return { status: 200, body: { ok: true } };
      },
    },
    {
      method: "GET",
      pattern: "/logout",
      handle: async (req) => {
        await sessions.logout(req.cookies[COOKIE_REFRESH]);
        return {
          status: 302,
          headers: { Location: "/" },
          cookies: sessions.clearAuthCookies(),
        };
      },
    },
    {
      method: "POST",
      pattern: "/logout-all",
      handle: async (req) => {
        const session = await requireSession(req);
        await sessions.logoutAll(session.identity);
        return { status: 200, body: { ok: true } };
      },
    },
    // --- agent bridge pairing (docs 16 §6) ---------------------------------
    // /agent/device/code and /agent/device/token are unauthenticated by design:
    // the bridge has no credential yet, which is the entire point of the flow.
    // Authority enters at /agent/device/approve, which requires a session.
    {
      method: "POST",
      pattern: "/agent/device/code",
      handle: async (req) => {
        const body = agentDeviceCodeBodySchema.parse(req.body || {});
        return { status: 200, body: await agent.requestDeviceCode(body) };
      },
    },
    {
      method: "POST",
      pattern: "/agent/device/token",
      handle: async (req) => {
        const { deviceCode } = agentDeviceTokenBodySchema.parse(req.body || {});
        return { status: 200, body: await agent.redeem({ deviceCode }) };
      },
    },
    {
      method: "GET",
      pattern: "/agent/device/pending",
      handle: async (req) => {
        await requireSession(req);
        return { status: 200, body: await agent.describeUserCode(req.query.code) };
      },
    },
    {
      method: "POST",
      pattern: "/agent/device/approve",
      handle: async (req) => {
        const session = await requireSession(req);
        const { userCode } = agentApproveBodySchema.parse(req.body || {});
        const result = await agent.approve({
          userCode,
          identity: session.identity,
          tenantId: session.tenantId,
        });
        return { status: 200, body: result };
      },
    },
    {
      method: "GET",
      pattern: "/agent/tokens",
      handle: async (req) => {
        const session = await requireSession(req);
        return { status: 200, body: await agent.listTokens({ identity: session.identity }) };
      },
    },
    {
      method: "DELETE",
      pattern: "/agent/tokens/:jti",
      handle: async (req) => {
        const session = await requireSession(req);
        return {
          status: 200,
          body: await agent.revokeToken({ identity: session.identity, jti: req.params.jti }),
        };
      },
    },
    {
      method: "GET",
      pattern: "/agent/kelabos",
      handle: async (req) => {
        // Bearer, not a cookie: the caller is a process on a laptop, not a
        // browser, and it holds an agent token rather than a session.
        const payload = await agent.verifyAgentToken(bearerToken(req));
        if (!payload) throw err(401, "unauthenticated");
        return {
          status: 200,
          body: await agent.joinableKelabos({ identity: payload.sub }),
        };
      },
    },
    {
      method: "POST",
      pattern: "/kelabos",
      handle: async (req) => {
        const session = await requireSession(req);
        const body = createKelaboBodySchema.parse(req.body || {});
        const result = await kelabos.createKelabo({ identity: session.identity, body });
        const journeyLinks = await linkNewKelaboToJourneys({
          identity: session.identity,
          kelaboId: result.body.kelaboId,
          journeyIds: body.journeyIds,
        });
        return journeyLinks ? { ...result, body: { ...result.body, journeyLinks } } : result;
      },
    },
    {
      // Huddle (docs 18 §6): start an instant kelabo and ring contacts into it.
      method: "POST",
      pattern: "/huddles",
      handle: async (req) => {
        const session = await requireSession(req);
        const body = huddleBodySchema.parse(req.body || {});
        return huddle.create({ identity: session.identity, displayName: session.displayName, body });
      },
    },
    {
      method: "GET",
      pattern: "/kelabos",
      handle: async (req) => {
        const session = await requireSession(req);
        return { status: 200, body: await kelabos.listKelabos({ identity: session.identity }) };
      },
    },
    {
      method: "POST",
      pattern: "/kelabos/schedule",
      handle: async (req) => {
        // Scheduling is the one kelabo action a guest can never take: it sends
        // mail in the tenant's name and puts an entry in other people's lists.
        const session = await requireSession(req);
        const body = scheduleKelaboBodySchema.parse(req.body || {});
        const res = await scheduling.schedule({
          identity: session.identity,
          displayName: session.displayName,
          body,
        });
        // Whether the invitations actually left the building. Without this line
        // the only record of a failed send was a boolean in the response body,
        // gone the moment the host closed the tab.
        const invited = res.body?.invited ?? [];
        if (invited.length) {
          const failures = invited.filter((i) => !i.sent);
          log(failures.length ? "warn" : "info", "invites_sent", {
            kelaboId: res.body.kelaboId,
            host: session.identity,
            invited: invited.length,
            sent: invited.length - failures.length,
            failed: failures.map((f) => `${f.email}:${f.reason || "unknown"}`),
          });
        }
        const journeyLinks = await linkNewKelaboToJourneys({
          identity: session.identity,
          kelaboId: res.body?.kelaboId,
          journeyIds: body.journeyIds,
        });
        return journeyLinks ? { ...res, body: { ...res.body, journeyLinks } } : res;
      },
    },
    {
      method: "GET",
      pattern: "/kelabos/scheduled",
      handle: async (req) => {
        const session = await requireSession(req);
        return { status: 200, body: await scheduling.listScheduled({ identity: session.identity }) };
      },
    },
    {
      method: "GET",
      pattern: "/kelabos/:id/scheduled",
      handle: async (req) => {
        const session = await requireSession(req);
        return {
          status: 200,
          body: await scheduling.getScheduled({ kelaboId: req.params.id, identity: session.identity }),
        };
      },
    },
    {
      method: "POST",
      pattern: "/kelabos/:id/start-scheduled",
      handle: async (req) => {
        const session = await requireSession(req);
        return scheduling.start({ kelaboId: req.params.id, identity: session.identity });
      },
    },
    {
      method: "POST",
      pattern: "/kelabos/:id/cancel",
      handle: async (req) => {
        const session = await requireSession(req);
        const body = cancelKelaboBodySchema.parse(req.body || {});
        return scheduling.cancel({ kelaboId: req.params.id, identity: session.identity, reason: body.reason });
      },
    },
    {
      // Ring more people into a kelabo that is already live (docs 18 §6).
      method: "POST",
      pattern: "/kelabos/:id/ring",
      handle: async (req) => {
        const session = await requireSession(req);
        const body = ringBodySchema.parse(req.body || {});
        return huddle.ringInto({ kelaboId: req.params.id, identity: session.identity, displayName: session.displayName, body });
      },
    },
    {
      method: "POST",
      pattern: "/kelabos/:id/ring/answer",
      handle: async (req) => {
        const session = await requireSession(req);
        const body = ringAnswerBodySchema.parse(req.body || {});
        return huddle.answer({ kelaboId: req.params.id, identity: session.identity, body });
      },
    },
    {
      method: "POST",
      pattern: "/kelabos/:id/ring/cancel",
      handle: async (req) => {
        const session = await requireSession(req);
        return huddle.cancel({ kelaboId: req.params.id, identity: session.identity });
      },
    },
    {
      method: "POST",
      pattern: "/kelabos/:id/reschedule",
      handle: async (req) => {
        const session = await requireSession(req);
        const body = rescheduleKelaboBodySchema.parse(req.body || {});
        return scheduling.reschedule({ kelaboId: req.params.id, identity: session.identity, body });
      },
    },
    {
      // Add or remove invitees on a kelabo that has not started yet (docs 18
      // §3.5) — host-only, scheduled-only, the same guard reschedule uses.
      method: "POST",
      pattern: "/kelabos/:id/invitees",
      handle: async (req) => {
        const session = await requireSession(req);
        const body = updateInviteesBodySchema.parse(req.body || {});
        return scheduling.updateInvitees({
          kelaboId: req.params.id,
          identity: session.identity,
          displayName: session.displayName,
          body,
        });
      },
    },
    {
      // Readable without a session on purpose: the entire point of an invitation
      // link is that it reaches people who have no account.
      method: "GET",
      pattern: "/kelabos/:id/invitation",
      handle: async (req) => {
        const session = await sessions.readSession(req.cookies[COOKIE_SESSION]);
        return {
          status: 200,
          body: await scheduling.getInvitation({
            kelaboId: req.params.id,
            identity: session?.identity || null,
            rsvpKey: await readRsvpKey(req, req.params.id),
          }),
        };
      },
    },
    {
      method: "POST",
      pattern: "/kelabos/:id/rsvp",
      handle: async (req) => {
        const session = await sessions.readSession(req.cookies[COOKIE_SESSION]);
        const body = rsvpBodySchema.parse(req.body || {});
        const result = await scheduling.rsvp({
          kelaboId: req.params.id,
          body,
          identity: session?.identity || null,
          displayName: session?.displayName,
          rsvpKey: await readRsvpKey(req, req.params.id),
        });
        // A guest gets a cookie holding their invite key so a second visit can
        // change the answer instead of creating a second person.
        const cookies = result.isGuest ? [await rsvpCookie(req.params.id, result.inviteKey)] : [];
        return { status: 200, body: result, cookies };
      },
    },
    {
      method: "GET",
      pattern: "/people/search",
      handle: async (req) => {
        const session = await requireSession(req);
        return {
          status: 200,
          body: await scheduling.suggestPeople({ identity: session.identity, prefix: req.query?.q || "" }),
        };
      },
    },
    // Contacts (docs 18 §4). Favourites are same-org, private and always
    // available. The `/contacts/favourites*` routes are registered before any
    // future `/contacts/:email/*` external route so the literal `favourites`
    // segment is never read as a peer email.
    {
      method: "GET",
      pattern: "/contacts",
      handle: async (req) => {
        const session = await requireSession(req);
        return { status: 200, body: await contacts.listContacts({ identity: session.identity }) };
      },
    },
    {
      method: "POST",
      pattern: "/contacts/favourites",
      handle: async (req) => {
        const session = await requireSession(req);
        const email = String(req.body?.email || "");
        return { status: 200, body: await contacts.favourite({ identity: session.identity, email }) };
      },
    },
    {
      method: "DELETE",
      pattern: "/contacts/favourites/:email",
      handle: async (req) => {
        const session = await requireSession(req);
        await contacts.unfavourite({ identity: session.identity, email: req.params.email });
        return { status: 204 };
      },
    },
    {
      method: "GET",
      pattern: "/kelabos/:id",
      handle: async (req) => {
        const participant = await join.readParticipant(req.cookies[COOKIE_PARTICIPANT], req.params.id);
        return { status: 200, body: await kelabos.getKelabo({ kelaboId: req.params.id, participant }) };
      },
    },
    {
      method: "POST",
      pattern: "/kelabos/:id/start",
      handle: async (req) => {
        const session = await requireSession(req);
        return { status: 200, body: await kelabos.startKelabo({ kelaboId: req.params.id, identity: session.identity }) };
      },
    },
    {
      method: "POST",
      pattern: "/kelabos/:id/end",
      handle: async (req) => {
        const session = await requireSession(req);
        return { status: 200, body: await kelabos.endKelabo({ kelaboId: req.params.id, identity: session.identity }) };
      },
    },
    {
      method: "POST",
      pattern: "/kelabos/:id/minutes",
      handle: async (req) => {
        const session = await requireSession(req);
        return { status: 200, body: await kelabos.requestMinutes({ kelaboId: req.params.id, identity: session.identity }) };
      },
    },
    {
      method: "GET",
      pattern: "/kelabos/:id/board",
      handle: async (req) => {
        const participant = await requireParticipant(req, req.params.id);
        const since = req.query.since ? Number(req.query.since) : undefined;
        const limit = req.query.limit ? Math.min(Number(req.query.limit), 200) : 50;
        return {
          status: 200,
          body: await kelabos.board({ kelaboId: req.params.id, participant, since, limit }),
        };
      },
    },
    {
      method: "POST",
      pattern: "/kelabos/:id/join",
      handle: async (req) => {
        const body = joinBodySchema.safeParse(req.body || {});
        if (!body.success) {
          const missingName = body.error.issues.some((i) => i.path[0] === "displayName");
          throw err(400, missingName ? "name_required" : "bad_request");
        }
        const session = await sessions.readSession(req.cookies[COOKIE_SESSION]);
        const result = await join.join({ kelaboId: req.params.id, body: body.data, session });
        return { status: 200, body: result.body, cookies: result.cookies };
      },
    },
    // --- join codes (rest-api/src/joinCode.js) -----------------------------
    // Minting takes the participant cookie, not a session: the authority is
    // "you are in this kelabo", which is the right one and the only one a guest
    // with no account can hold. Redeeming is unauthenticated by design — the
    // person holding a code is precisely someone who has no link and may have
    // no account.
    {
      method: "POST",
      pattern: "/kelabos/:id/join-code",
      handle: async (req) => {
        await requireParticipant(req, req.params.id);
        return { status: 200, body: await joinCodes.mint({ kelaboId: req.params.id }) };
      },
    },
    {
      method: "POST",
      pattern: "/join-code/redeem",
      handle: async (req) => {
        const { code } = joinCodeRedeemBodySchema.parse(req.body || {});
        return { status: 200, body: await joinCodes.redeem({ code, ip: req.ip }) };
      },
    },
    {
      method: "GET",
      pattern: "/records",
      handle: async (req) => {
        const session = await requireSession(req);
        return { status: 200, body: await records.listRecords({ identity: session.identity }) };
      },
    },
    {
      // Bulk retention purge of the CALLER'S OWN records. Irreversible when
      // dryRun is false, so the SPA always previews first.
      method: "POST",
      pattern: "/records/purge",
      handle: async (req) => {
        const session = await requireSession(req);
        const parsed = purgeRecordsBodySchema.safeParse(req.body);
        if (!parsed.success) throw err(400, "bad_request", JSON.stringify(parsed.error.issues));
        const { value, unit, dryRun } = parsed.data;
        const result = await records.purgeRecords({ identity: session.identity, value, unit, dryRun });
        log(result.dryRun ? "info" : "warn", "records_purge", {
          identity: session.identity,
          value,
          unit,
          dryRun: !!result.dryRun,
          matched: result.matched,
          purged: result.purged.length,
          removedFromList: result.removedFromList.length,
          failed: result.failed.length,
        });
        return { status: 200, body: result };
      },
    },
    {
      // Before /records/:archiveId, or "search" would be read as an archive id.
      method: "GET",
      pattern: "/records/search",
      handle: async (req) => {
        const session = await requireSession(req);
        return { status: 200, body: await records.searchRecords({ identity: session.identity, q: req.query?.q || "" }) };
      },
    },
    {
      method: "GET",
      pattern: "/records/:archiveId",
      handle: async (req) => {
        const session = await requireSession(req);
        return { status: 200, body: await records.getRecord({ identity: session.identity, archiveId: req.params.archiveId }) };
      },
    },
    {
      // Delete ONE record. Irreversible for a host (same blast radius as a
      // purge of that record); a participant only loses it from their list.
      method: "DELETE",
      pattern: "/records/:archiveId",
      handle: async (req) => {
        const session = await requireSession(req);
        const result = await records.deleteRecord({
          identity: session.identity,
          archiveId: req.params.archiveId,
        });
        log("warn", "record_delete", {
          identity: session.identity,
          archiveId: req.params.archiveId,
          outcome: result.outcome,
        });
        return { status: 200, body: result };
      },
    },
    // --- journeys (docs 20) -------------------------------------------------
    // A persistent container linking related kelabos so description,
    // decisions and Q&A history carry from one meeting to the next. Every
    // route requires a session; per-journey access (owner / public-tenant-
    // member / private-accessor) is resolved fresh inside journeys.js, never
    // cached on a cookie.
    {
      method: "POST",
      pattern: "/journeys",
      handle: async (req) => {
        const session = await requireSession(req);
        const body = createJourneyBodySchema.parse(req.body || {});
        return { status: 200, body: await journeys.createJourney({ identity: session.identity, body }) };
      },
    },
    {
      method: "GET",
      pattern: "/journeys",
      handle: async (req) => {
        const session = await requireSession(req);
        return { status: 200, body: await journeys.listJourneys({ identity: session.identity }) };
      },
    },
    {
      method: "GET",
      pattern: "/journeys/:id",
      handle: async (req) => {
        const session = await requireSession(req);
        return {
          status: 200,
          body: await journeys.getJourney({ journeyId: req.params.id, identity: session.identity }),
        };
      },
    },
    {
      method: "PATCH",
      pattern: "/journeys/:id",
      handle: async (req) => {
        const session = await requireSession(req);
        const body = patchJourneyBodySchema.parse(req.body || {});
        return {
          status: 200,
          body: await journeys.patchJourney({ journeyId: req.params.id, identity: session.identity, body }),
        };
      },
    },
    {
      method: "POST",
      pattern: "/journeys/:id/complete",
      handle: async (req) => {
        const session = await requireSession(req);
        return {
          status: 200,
          body: await journeys.completeJourney({ journeyId: req.params.id, identity: session.identity }),
        };
      },
    },
    {
      method: "POST",
      pattern: "/journeys/:id/reopen",
      handle: async (req) => {
        const session = await requireSession(req);
        return {
          status: 200,
          body: await journeys.reopenJourney({ journeyId: req.params.id, identity: session.identity }),
        };
      },
    },
    {
      method: "DELETE",
      pattern: "/journeys/:id",
      handle: async (req) => {
        const session = await requireSession(req);
        return {
          status: 200,
          body: await journeys.deleteJourney({ journeyId: req.params.id, identity: session.identity }),
        };
      },
    },
    {
      method: "GET",
      pattern: "/journeys/:id/accessors",
      handle: async (req) => {
        const session = await requireSession(req);
        return {
          status: 200,
          body: await journeys.listAccessors({ journeyId: req.params.id, identity: session.identity }),
        };
      },
    },
    {
      method: "POST",
      pattern: "/journeys/:id/accessors",
      handle: async (req) => {
        const session = await requireSession(req);
        const body = journeyAccessorBodySchema.parse(req.body || {});
        return {
          status: 200,
          body: await journeys.addAccessor({ journeyId: req.params.id, identity: session.identity, body }),
        };
      },
    },
    {
      method: "DELETE",
      pattern: "/journeys/:id/accessors/:identity",
      handle: async (req) => {
        const session = await requireSession(req);
        return {
          status: 200,
          body: await journeys.removeAccessor({
            journeyId: req.params.id,
            identity: session.identity,
            target: req.params.identity,
          }),
        };
      },
    },
    {
      method: "POST",
      pattern: "/journeys/:id/kelabos",
      handle: async (req) => {
        const session = await requireSession(req);
        const body = journeyLinkKelaboBodySchema.parse(req.body || {});
        return {
          status: 200,
          body: await journeys.linkKelabo({
            journeyId: req.params.id,
            identity: session.identity,
            kelaboId: body.kelaboId,
          }),
        };
      },
    },
    {
      method: "GET",
      pattern: "/journeys/:id/kelabos",
      handle: async (req) => {
        const session = await requireSession(req);
        return {
          status: 200,
          body: await journeys.listLinkedKelabos({ journeyId: req.params.id, identity: session.identity }),
        };
      },
    },
    {
      method: "DELETE",
      pattern: "/journeys/:id/kelabos/:kelaboId",
      handle: async (req) => {
        const session = await requireSession(req);
        return {
          status: 200,
          body: await journeys.unlinkKelabo({
            journeyId: req.params.id,
            identity: session.identity,
            kelaboId: req.params.kelaboId,
          }),
        };
      },
    },
    {
      method: "POST",
      pattern: "/journeys/:id/description",
      handle: async (req) => {
        const session = await requireSession(req);
        const body = journeyDescriptionBodySchema.parse(req.body || {});
        return {
          status: 200,
          body: await journeys.updateDescription({ journeyId: req.params.id, identity: session.identity, body }),
        };
      },
    },
    {
      method: "GET",
      pattern: "/journeys/:id/description/history",
      handle: async (req) => {
        const session = await requireSession(req);
        return {
          status: 200,
          body: await journeys.getDescriptionHistory({ journeyId: req.params.id, identity: session.identity }),
        };
      },
    },
    {
      // Health/progress (docs 20 §5) — optional, member-writable, frozen once
      // the journey is completed.
      method: "POST",
      pattern: "/journeys/:id/status",
      handle: async (req) => {
        const session = await requireSession(req);
        const body = journeyStatusBodySchema.parse(req.body || {});
        return {
          status: 200,
          body: await journeys.updateStatus({ journeyId: req.params.id, identity: session.identity, body }),
        };
      },
    },
    {
      method: "GET",
      pattern: "/journeys/:id/status/history",
      handle: async (req) => {
        const session = await requireSession(req);
        return {
          status: 200,
          body: await journeys.getStatusHistory({ journeyId: req.params.id, identity: session.identity }),
        };
      },
    },
    {
      // Backward cursor (docs 20 §9.2), same shape as /caption/history's
      // `before`, not the board's forward `since` — a journey's timeline is
      // unbounded and read newest-first.
      method: "GET",
      pattern: "/journeys/:id/timeline",
      handle: async (req) => {
        const session = await requireSession(req);
        const before = req.query.before ? Number(req.query.before) : undefined;
        const limit = req.query.limit ? Math.min(Number(req.query.limit), 200) : 50;
        const type = typeof req.query.type === "string" && req.query.type ? req.query.type : undefined;
        return {
          status: 200,
          body: await journeys.getTimeline({ journeyId: req.params.id, identity: session.identity, type, before, limit }),
        };
      },
    },
    // Message board (docs 20 §7) — distinct from a kelabo's own board;
    // mutable in place, every edit kept, member-writable, frozen once
    // completed.
    {
      method: "POST",
      pattern: "/journeys/:id/board",
      handle: async (req) => {
        const session = await requireSession(req);
        const body = journeyBoardMessageBodySchema.parse(req.body || {});
        return {
          status: 200,
          body: await journeys.addBoardMessage({ journeyId: req.params.id, identity: session.identity, body }),
        };
      },
    },
    {
      method: "GET",
      pattern: "/journeys/:id/board",
      handle: async (req) => {
        const session = await requireSession(req);
        return {
          status: 200,
          body: await journeys.listBoardMessages({ journeyId: req.params.id, identity: session.identity }),
        };
      },
    },
    {
      method: "PATCH",
      pattern: "/journeys/:id/board/:msgId",
      handle: async (req) => {
        const session = await requireSession(req);
        const body = journeyBoardMessageBodySchema.parse(req.body || {});
        return {
          status: 200,
          body: await journeys.editBoardMessage({
            journeyId: req.params.id,
            identity: session.identity,
            msgId: req.params.msgId,
            body,
          }),
        };
      },
    },
    // Archive/unarchive (docs 20 §7) — a state change, not a deletion, so
    // these are POST sub-resources rather than DELETE, the same shape
    // /journeys/:id/complete and /journeys/:id/reopen already use for a
    // reversible status transition.
    {
      method: "POST",
      pattern: "/journeys/:id/board/:msgId/archive",
      handle: async (req) => {
        const session = await requireSession(req);
        return {
          status: 200,
          body: await journeys.archiveBoardMessage({
            journeyId: req.params.id,
            identity: session.identity,
            msgId: req.params.msgId,
          }),
        };
      },
    },
    {
      method: "POST",
      pattern: "/journeys/:id/board/:msgId/unarchive",
      handle: async (req) => {
        const session = await requireSession(req);
        return {
          status: 200,
          body: await journeys.unarchiveBoardMessage({
            journeyId: req.params.id,
            identity: session.identity,
            msgId: req.params.msgId,
          }),
        };
      },
    },
    {
      method: "GET",
      pattern: "/journeys/:id/board/:msgId/history",
      handle: async (req) => {
        const session = await requireSession(req);
        return {
          status: 200,
          body: await journeys.getBoardMessageHistory({
            journeyId: req.params.id,
            identity: session.identity,
            msgId: req.params.msgId,
          }),
        };
      },
    },
    // Documents (docs 20 §8) — pasted/typed text, member-writable, added
    // once, only ever soft-removed (no edit).
    {
      method: "POST",
      pattern: "/journeys/:id/documents",
      handle: async (req) => {
        const session = await requireSession(req);
        const body = journeyDocumentBodySchema.parse(req.body || {});
        return {
          status: 200,
          body: await journeys.addDocument({ journeyId: req.params.id, identity: session.identity, body }),
        };
      },
    },
    {
      method: "GET",
      pattern: "/journeys/:id/documents",
      handle: async (req) => {
        const session = await requireSession(req);
        return {
          status: 200,
          body: await journeys.listDocuments({ journeyId: req.params.id, identity: session.identity }),
        };
      },
    },
    {
      method: "GET",
      pattern: "/journeys/:id/documents/:docId",
      handle: async (req) => {
        const session = await requireSession(req);
        return {
          status: 200,
          body: await journeys.getDocument({
            journeyId: req.params.id,
            identity: session.identity,
            docId: req.params.docId,
          }),
        };
      },
    },
    {
      method: "DELETE",
      pattern: "/journeys/:id/documents/:docId",
      handle: async (req) => {
        const session = await requireSession(req);
        return {
          status: 200,
          body: await journeys.removeDocument({
            journeyId: req.params.id,
            identity: session.identity,
            docId: req.params.docId,
          }),
        };
      },
    },
    // Reports (docs 20 §6) — generation happens in the Gateway, which holds
    // the LLM credential; POST awaits that call the same way requestMinutes
    // does, but returns only `{reportId, status}` — the client re-fetches
    // the finished row via GET, the same "mutating call returns a summary"
    // convention every other create endpoint here already follows.
    {
      method: "POST",
      pattern: "/journeys/:id/reports",
      handle: async (req) => {
        const session = await requireSession(req);
        const body = journeyReportBodySchema.parse(req.body || {});
        return {
          status: 200,
          body: await journeys.requestReport({ journeyId: req.params.id, identity: session.identity, body }),
        };
      },
    },
    {
      method: "GET",
      pattern: "/journeys/:id/reports",
      handle: async (req) => {
        const session = await requireSession(req);
        return {
          status: 200,
          body: await journeys.listReports({ journeyId: req.params.id, identity: session.identity }),
        };
      },
    },
    {
      method: "GET",
      pattern: "/journeys/:id/reports/:reportId",
      handle: async (req) => {
        const session = await requireSession(req);
        return {
          status: 200,
          body: await journeys.getReport({
            journeyId: req.params.id,
            identity: session.identity,
            reportId: req.params.reportId,
          }),
        };
      },
    },
    // Contributors (docs 20 §10) — a rollup, not a live query; recoverable
    // from the source rows (kelabo links + report requests) if it ever
    // needed rebuilding, never itself authoritative.
    {
      method: "GET",
      pattern: "/journeys/:id/contributors",
      handle: async (req) => {
        const session = await requireSession(req);
        return {
          status: 200,
          body: await journeys.listContributors({ journeyId: req.params.id, identity: session.identity }),
        };
      },
    },
    {
      method: "POST",
      pattern: "/kelabos/:id/stt-token",
      handle: async (req) => {
        const participant = await requireParticipant(req, req.params.id);
        const opts = {
          language: typeof req.body?.language === "string" ? req.body.language : undefined,
          diarize: req.body?.diarize === true,
        };
        return { status: 200, body: await sttToken.mint({ kelaboId: req.params.id, participant, opts }) };
      },
    },
  ].map((r) => ({ ...r, ...compile(r.pattern) }));

  async function oidcCallback(req, query) {
    try {
      const result = await auth.oidcSocial.callback(req.params.provider, { query, cookies: req.cookies });
      return {
        status: 302,
        headers: { Location: "/" },
        cookies: result.cookies,
      };
    } catch (e) {
      if (e instanceof ApiError && (e.code === "domain_not_allowed" || e.code === "oidc_failed")) {
        return htmlErrorPage(e.status, e.code);
      }
      throw e;
    }
  }

  async function route(req) {
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = r.regex.exec(req.path);
      if (!m) continue;
      req.params = Object.fromEntries(r.names.map((n, i) => [n, decodeURIComponent(m[i + 1])]));
      return r.handle(req);
    }
    throw err(404, "not_found", `${req.method} ${req.path}`);
  }

  return async function handle(event) {
    const started = Date.now();
    const method = event.requestContext?.http?.method || event.httpMethod || "GET";
    const path = event.rawPath || event.path || "/";
    const query = Object.fromEntries(new URLSearchParams(event.rawQueryString || "").entries());
    const headers = Object.fromEntries(Object.entries(event.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));

    // The API answers on its own execute-api URL as well as through
    // CloudFront, and that URL passes neither the distribution nor the WAF —
    // so without this, `allowIps` closes the portal and the Gateway while the
    // whole control plane stays open to the internet (docs 07). CloudFront
    // injects a secret header; a request without it arrived by the back door.
    //
    // Checked before the body is parsed, so nothing is done on an
    // unauthorised caller's behalf, and answered with a bare 403 that names
    // neither the header nor the reason.
    if (config.api?.requireOriginSecret) {
      let expected = null;
      try {
        expected = await secrets.getApiOriginSecret(config);
      } catch (e) {
        // Fail closed: a gate that opens when it cannot read its own secret is
        // not a gate. Logged at error because it takes the API down with it,
        // and the cause must not have to be inferred from a wall of 403s.
        log("error", "origin_secret_unreadable", { secret: config.secrets?.apiOrigin, error: String(e) });
      }
      if (!originSecretMatches(headers[ORIGIN_SECRET_HEADER], expected)) {
        log("warn", "origin_rejected", { method, path, ip: event.requestContext?.http?.sourceIp });
        return {
          statusCode: 403,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ error: "forbidden" }),
        };
      }
    }

    let body = null;
    if (event.body) {
      const raw = event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : event.body;
      const ct = headers["content-type"] || "";
      if (ct.includes("application/x-www-form-urlencoded")) {
        body = Object.fromEntries(new URLSearchParams(raw).entries());
      } else {
        try {
          body = JSON.parse(raw);
        } catch {
          throw err(400, "bad_request", "invalid JSON body");
        }
      }
    }
    const req = {
      method,
      path: path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path,
      query,
      headers,
      body,
      cookies: parseCookies(event),
      ip: event.requestContext?.http?.sourceIp,
      params: {},
    };
    try {
      const res = await route(req);
      const status = res.status || 200;
      const isHtml = res.headers?.["Content-Type"]?.startsWith("text/html");
      log("info", "request", { method, path: req.path, status, ms: Date.now() - started });
      return {
        statusCode: status,
        headers: { "Content-Type": "application/json", ...(res.headers || {}) },
        ...(res.cookies?.length ? { cookies: res.cookies } : {}),
        body: isHtml ? res.body : res.body !== undefined ? JSON.stringify(res.body) : "",
      };
    } catch (e) {
      let status = 500;
      let code = "internal_error";
      let message;
      if (e instanceof ApiError) {
        status = e.status;
        code = e.code;
        message = e.message !== e.code ? e.message : undefined;
      } else if (e instanceof ZodError) {
        status = 400;
        code = "bad_request";
        message = e.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
      } else {
        log("error", "unhandled", { method, path: req.path, error: String(e), stack: e.stack });
      }
      log("info", "request", { method, path: req.path, status, code, ms: Date.now() - started });
      return {
        statusCode: status,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(message ? { error: code, message } : { error: code }),
      };
    }
  };
}

let defaultApp;

export async function handler(event, context) {
  if (!defaultApp) {
    const config = await ensureConfig();
    const db = createDb({ config });
    const secrets = createSecrets({ region: config.region });
    // Resolved per send rather than captured here, which costs nothing on a
    // self-hosted deployment (the same object every time) and is what lets a
    // deployment holding its mail settings elsewhere change provider or
    // rotate a key without a restart. The key is read only when a provider
    // needs one: SES authenticates with this Lambda's own IAM role, so an SES
    // deployment never touches the mail secret and does not have to have one.
    const mailer = createMailer({
      resolve: async () =>
        mailSettingsFromConfig(config, config.mail.provider === "ses" ? "" : await secrets.getMailApiKey(config)),
    });
    const otp = createOtp({ config, db, mailer });
    const sessions = createSessions({ config, db, secrets });
    const oidc = createOidc({ config, secrets });
    const auth = createAuthProvider({ otp, oidc, sessions });
    const mcpOauth = createMcpOauth({ config, db, secrets });
    const internal = createInternal({ config, secrets });
    const kelabos = createKelabos({ config, db, internal, secrets });
    const scheduling = createScheduling({ config, db, mailer, internal });
    const contacts = createContacts({ config, db });
    const huddle = createHuddle({ config, db, internal, kelabos });
    const join = createJoin({ config, db, secrets });
    const joinCodes = createJoinCodes({ config, db });
    const records = createRecords({ config, db });
    const journeys = createJourneys({ config, db, internal });
    const sttToken = createSttToken({ config, db, secrets });
    const agent = createAgent({ config, db, secrets });
    defaultApp = createApp({ config, db, secrets, mailer, sessions, auth, kelabos, join, joinCodes, records, sttToken, internal, mcpOauth, scheduling, contacts, huddle, agent, journeys });
  }
  return defaultApp(event, context);
}
