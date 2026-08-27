import { COOKIE_PARTICIPANT, participantCookieSchema } from "@kelabo/contracts";
import { mintCookie, readCookie, serializeCookie } from "./cookies.js";
import { generateGuestIdentity } from "./otp.js";
import { err } from "./errors.js";

export function createJoin({ config, db, secrets }) {
  async function mintParticipantCookie({ kelaboId, identity, tenantId, isGuest }) {
    const key = await secrets.getCookieKey(config);
    const payload = {
      kind: "participant",
      kelaboId,
      identity,
      tenantId,
      isGuest,
      exp: Math.floor(Date.now() / 1000) + config.auth.participantTtlSeconds,
    };
    return serializeCookie(COOKIE_PARTICIPANT, mintCookie(payload, key), {
      maxAgeSeconds: config.auth.participantTtlSeconds,
      domain: config.cookieDomain,
    });
  }

  async function readParticipant(cookieValue, kelaboId) {
    if (!cookieValue) return null;
    const key = await secrets.getCookieKey(config);
    const p = readCookie(cookieValue, key, participantCookieSchema);
    if (!p) return null;
    if (kelaboId && p.kelaboId !== kelaboId) return null;
    return p;
  }

  async function join({ kelaboId, body, session }) {
    const meta = await db.getKelaboMeta(kelaboId);
    if (!meta) throw err(404, "kelabo_not_found");
    if (meta.status === "scheduled") throw err(409, "kelabo_not_started");
    if (meta.status === "cancelled") throw err(409, "kelabo_cancelled");
    if (meta.status !== "active") throw err(410, "kelabo_ended");
    const displayName = body.displayName?.trim();
    if (!displayName) throw err(400, "name_required");

    let identity;
    let isGuest;
    let tenantId;
    if (session) {
      identity = session.identity;
      tenantId = session.tenantId;
      isGuest = false;
    } else {
      identity = generateGuestIdentity();
      tenantId = meta.tenantId;
      isGuest = true;
    }

    // Bound the participants list — each new browser is a new guest
    // identity, and an unbounded list_append is how an item hits the 400 KB
    // ceiling and bricks the room. Old entries only mattered to participant
    // cookies that expired long before the list wrapped.
    const ps = meta.participants || [];
    if (ps.length >= 200) {
      await db.updateKelaboMeta(kelaboId, { participants: ps.slice(-100) }).catch(() => {});
      meta.participants = ps.slice(-100);
    }

    const existing = (meta.participants || []).find((p) => p.identity === identity);
    if (!existing) {
      // The joiner's identicon re-roll rides on the participant record: this is
      // the one moment this service (which can read the users table) crosses
      // paths with the roster the Gateway will later fan out, so the room's
      // tiles can draw the avatar the person actually chose.
      let avatarVariant = 0;
      if (!isGuest) {
        avatarVariant = Number((await db.getUserSettings(identity).catch(() => null))?.settings?.avatar) || 0;
      }
      await db.appendParticipant(kelaboId, { identity, displayName, isGuest, avatarVariant, joinedAt: Date.now() });
    }

    // Stamp the host's language onto the kelabo the first time the host joins.
    // The minutes are written in it (the record belongs to the host, whatever
    // language the room happened to speak), and only this service can read it —
    // user settings live in the users table, which the Gateway cannot see. Join
    // is the one path every kelabo takes, scheduled or created, so it is the
    // one place this has to be done.
    if (!isGuest && identity === meta.hostIdentity && !meta.hostLang) {
      try {
        const stt = (await db.getUserSettings(identity))?.settings?.sttLang;
        if (stt) await db.updateKelaboMeta(kelaboId, { hostLang: stt });
      } catch {
        // Never block a join on this: no hostLang just means the minutes fall
        // back to the language the kelabo was held in.
      }
    }

    const cookie = await mintParticipantCookie({ kelaboId, identity, tenantId, isGuest });
    return {
      body: {
        kelaboId,
        gatewayBaseUrl: config.gatewayBaseUrl,
        rtcMode: meta.rtcMode || config.rtc.defaultMode,
        participant: { identity, displayName, isGuest },
      },
      cookies: [cookie],
    };
  }

  return { join, readParticipant, mintParticipantCookie };
}
