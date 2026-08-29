import {
  COOKIE_PARTICIPANT,
  rtcJoinBodySchema,
  rtcLeaveBodySchema,
  rtcIceBodySchema,
  rtcMediaBodySchema,
  rtcRosterBodySchema,
  rtcSignalBodySchema,
  rtcSfuSessionBodySchema,
  rtcSfuTracksBodySchema,
  rtcRenegotiateBodySchema,
  rtcCloseTracksBodySchema,
} from "@kelabo/contracts";
import { parseCookies, verifyParticipantCookie } from "../cookies.js";
import { readJson, send } from "../caption.js";
import { getMeta } from "../db.js";
import { effectiveConfig } from "../opconfig.js";
import { RtcError, STUN_ONLY } from "./cloudflare.js";

// SDP payloads are much larger than a caption; 512 KiB comfortably fits a
// multi-track offer with inline candidates while staying bounded.
const BODY_LIMIT = 512 * 1024;

export const RTC_PATHS = new Set([
  "/rtc/join",
  "/rtc/leave",
  "/rtc/ice",
  "/rtc/media",
  "/rtc/roster",
  "/rtc/signal",
  "/rtc/sfu/session",
  "/rtc/sfu/tracks",
  "/rtc/sfu/renegotiate",
  "/rtc/sfu/tracks/close",
]);

/**
 * Authenticate the caller and parse their body in one step. Every /rtc route is
 * kelabo-scoped, and the kelabo always comes from the *cookie*, never from
 * the body — the body's kelaboId is only ever checked against it.
 */
async function context(c, req, res, schema) {
  const cookies = parseCookies(req);
  const key = await c.getCookieKey();
  const participant = verifyParticipantCookie(cookies[COOKIE_PARTICIPANT], key);
  if (!participant) {
    send(res, 401, { error: "unauthenticated" });
    return null;
  }
  let body;
  try {
    body = await readJson(req, BODY_LIMIT);
  } catch {
    send(res, 400, { error: "bad_request" });
    return null;
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    send(res, 400, { error: "bad_request", detail: parsed.error.issues });
    return null;
  }
  if (parsed.data.kelaboId !== participant.kelaboId) {
    send(res, 403, { error: "forbidden" });
    return null;
  }
  return { participant, kelaboId: participant.kelaboId, body: parsed.data };
}

/**
 * The caller's own Cloudflare session id, taken from their peer record. Never
 * read from the request body: that is what stops a client driving a session it
 * does not own.
 */
function ownSession(c, kelaboId, participantId, res) {
  const peer = c.rtcRoom.peer(kelaboId, participantId);
  if (!peer) {
    send(res, 409, { error: "peer_not_found" });
    return null;
  }
  if (!peer.sfuSessionId) {
    send(res, 409, { error: "peer_not_found", detail: "no sfu session — call /rtc/sfu/session first" });
    return null;
  }
  return peer.sfuSessionId;
}

/**
 * One line per SFU round trip, describing the *signalling* rather than the
 * media: who called, what they asked for, and — the part that matters — whether
 * Cloudflare answered or offered back.
 *
 * Every failure in this subsystem so far has been an offer nobody answered, and
 * it is invisible from either end alone: the browser knows what it sent and the
 * logs knew only that something later returned a 406. The Gateway proxies every
 * one of these calls, so the whole exchange is reconstructable from here.
 */
function logSignal(c, where, ctx, body, out) {
  c.log(`rtc_sfu_${where}`, {
    kelaboId: ctx.kelaboId,
    participantId: ctx.participant.identity,
    sent: body?.sessionDescription?.type ?? null,
    got: out?.sessionDescription?.type ?? null,
    reneg: out?.requiresImmediateRenegotiation === true,
    tracks: (body?.tracks ?? []).map((t) => `${t.location ?? "?"}:${t.trackName ?? t.mid ?? "?"}`),
    mids: Array.isArray(out?.tracks) ? out.tracks.map((t) => t?.mid ?? "") : undefined,
  });
}

function fail(c, res, err, where, fields) {
  if (err instanceof RtcError) {
    // `cfCode` travels to the client because some Cloudflare failures are
    // terminal for the session and the SPA has to tell those apart to rebuild
    // it. It is logged for the plainer reason that reading these events without
    // knowing whose session failed made a two-person outage take an hour to
    // attribute — every one of these lines used to name only the kelabo.
    c.logError(`rtc_${where}_failed`, err, { ...fields, cfStatus: err.cfStatus, cfCode: err.cfCode });
    return send(res, err.status, {
      error: err.code,
      detail: err.detail,
      cfStatus: err.cfStatus,
      cfCode: err.cfCode,
    });
  }
  throw err;
}

export async function handleRtc(c, req, res, path, method) {
  if (method === "POST" && path === "/rtc/join") return join(c, req, res);
  if (method === "POST" && path === "/rtc/leave") return leave(c, req, res);
  if (method === "POST" && path === "/rtc/ice") return ice(c, req, res);
  if (method === "POST" && path === "/rtc/media") return media(c, req, res);
  if (method === "POST" && path === "/rtc/roster") return roster(c, req, res);
  if (method === "POST" && path === "/rtc/signal") return signal(c, req, res);
  if (method === "POST" && path === "/rtc/sfu/session") return sfuSession(c, req, res);
  if (method === "POST" && path === "/rtc/sfu/tracks") return sfuTracks(c, req, res);
  if (method === "PUT" && path === "/rtc/sfu/renegotiate") return sfuRenegotiate(c, req, res);
  if (method === "PUT" && path === "/rtc/sfu/tracks/close") return sfuCloseTracks(c, req, res);
  return send(res, 404, { error: "not_found" });
}

async function join(c, req, res) {
  const ctx = await context(c, req, res, rtcJoinBodySchema);
  if (!ctx) return undefined;
  const { participant, kelaboId } = ctx;

  const meta = await getMeta(c, kelaboId).catch(() => null);
  if (!meta) return send(res, 404, { error: "kelabo_not_found" });
  if (meta.status !== "active") return send(res, 410, { error: "kelabo_ended" });

  const roster = (meta.participants ?? []).find((p) => p.identity === participant.identity);
  const displayName = roster?.displayName ?? participant.identity;

  const result = await c.rtcRoom.join({
    kelaboId,
    participantId: participant.identity,
    displayName,
    // Stamped onto the participant record at REST join (join.js) — the Gateway
    // cannot read the users table, so this is a relay, not a lookup.
    avatarVariant: Number(roster?.avatarVariant) || 0,
    isGuest: participant.isGuest,
  });
  if (!result.ok) {
    return send(res, result.status, { error: result.code, ...(result.detail ?? {}) });
  }

  // Published operational config folded over this task's own (docs 23) —
  // never `c.config.rtc` directly, or the published values would reach the
  // REST-side entitlement while this task kept answering with the bootstrap,
  // and the two would disagree about the same room.
  const { rtc } = await effectiveConfig(c);

  // ICE is best-effort: without it the SFU still works on most networks over
  // STUN, and a mesh call on a permissive network still connects directly.
  let ice = STUN_ONLY;
  try {
    ice = await c.rtc.iceServers(rtc.iceTtlSeconds);
  } catch (err) {
    c.logError("rtc_ice_failed", err, { kelaboId });
  }

  return send(res, 200, {
    mode: result.mode,
    self: result.self,
    peers: result.peers,
    iceServers: ice.iceServers,
    // The client schedules its own re-mint (POST /rtc/ice) from this. Without
    // it the credentials minted here silently expire mid-call, and the first
    // ICE restart past the hour gathers with dead TURN and fails on exactly
    // the networks that needed the relay.
    ttlSeconds: rtc.iceTtlSeconds,
    meshMax: rtc.meshMaxParticipants,
    video: rtc.video,
  });
}

async function leave(c, req, res) {
  const ctx = await context(c, req, res, rtcLeaveBodySchema);
  if (!ctx) return undefined;
  await c.rtcRoom.leave(ctx.kelaboId, ctx.participant.identity, "left");
  return send(res, 200, { ok: true });
}

async function ice(c, req, res) {
  const ctx = await context(c, req, res, rtcIceBodySchema);
  if (!ctx) return undefined;
  try {
    const { rtc } = await effectiveConfig(c);
    const out = await c.rtc.iceServers(rtc.iceTtlSeconds);
    return send(res, 200, { iceServers: out.iceServers, ttlSeconds: rtc.iceTtlSeconds });
  } catch (err) {
    return fail(c, res, err, "ice", { kelaboId: ctx.kelaboId });
  }
}

/**
 * Report whether this participant's microphone and camera are switched on.
 *
 * Fanned to the room like any other roster change. A participant who has not
 * joined the call has nothing to report, so this is a `409` rather than a
 * silent success — a tile showing stale mute state is worse than none.
 */
async function media(c, req, res) {
  const ctx = await context(c, req, res, rtcMediaBodySchema);
  if (!ctx) return undefined;
  const { kelaboId, participant, body } = ctx;
  const result = c.rtcRoom.setMedia(kelaboId, participant.identity, body);
  if (!result) return send(res, 409, { error: "peer_not_found" });
  // A refused screen share in a full mesh room — same code as a refused join,
  // and the client tells them apart by which request it made.
  if (!result.ok) return send(res, result.status, { error: result.code, ...(result.detail ?? {}) });
  return send(res, 200, { ok: true, media: result.peer.media });
}

/**
 * Authoritative membership snapshot for the reconcile loop. The SSE events are
 * single-delivery; a `peer_joined` that landed while a tab was throttled used
 * to skew that client's roster for the rest of the kelabo — this is how it
 * converges again. POST like every other /rtc route so the kelabo scope rides
 * the same cookie-checked body.
 */
async function roster(c, req, res) {
  const ctx = await context(c, req, res, rtcRosterBodySchema);
  if (!ctx) return undefined;
  return send(res, 200, { peers: c.rtcRoom.roster(ctx.kelaboId) });
}

async function signal(c, req, res) {
  const ctx = await context(c, req, res, rtcSignalBodySchema);
  if (!ctx) return undefined;
  const { kelaboId, participant, body } = ctx;

  const self = c.rtcRoom.peer(kelaboId, participant.identity);
  if (!self) return send(res, 409, { error: "peer_not_found" });
  if (!c.rtcRoom.peer(kelaboId, body.to)) return send(res, 404, { error: "peer_not_found" });

  // Relayed verbatim to exactly one participant's stream. The Gateway does not
  // inspect or store the SDP — in mesh mode it is a signalling relay and nothing
  // more, and it never sees a media packet.
  const sent = c.sseHub.rtcTo(kelaboId, body.to, {
    kind: "signal",
    from: participant.identity,
    to: body.to,
    signal: body.signal,
  });
  c.log("rtc_signal", { kelaboId, from: participant.identity, to: body.to, type: body.signal.type, sent });
  return send(res, 200, { ok: true, delivered: sent > 0 });
}

async function sfuSession(c, req, res) {
  const ctx = await context(c, req, res, rtcSfuSessionBodySchema);
  if (!ctx) return undefined;
  const { kelaboId, participant, body } = ctx;
  if (!c.rtcRoom.peer(kelaboId, participant.identity)) {
    return send(res, 409, { error: "peer_not_found" });
  }
  try {
    const out = await c.rtc.newSession(body.sessionDescription);
    if (!out.sessionId) throw new RtcError("rtc_unavailable", 502, "no sessionId in response");
    c.rtcRoom.bindSfuSession(kelaboId, participant.identity, out.sessionId);
    logSignal(c, "session", ctx, body, out);
    // The session id is echoed back because the client needs it to name itself
    // in its own logs; every subsequent call still resolves it server-side.
    return send(res, 200, { sessionId: out.sessionId, sessionDescription: out.sessionDescription });
  } catch (err) {
    return fail(c, res, err, "sfu_session", { kelaboId, participantId: participant.identity });
  }
}

async function sfuTracks(c, req, res) {
  const ctx = await context(c, req, res, rtcSfuTracksBodySchema);
  if (!ctx) return undefined;
  const { kelaboId, participant, body } = ctx;

  const sessionId = ownSession(c, kelaboId, participant.identity, res);
  if (!sessionId) return undefined;

  // Every remote pull must resolve to a session belonging to a peer of this
  // kelabo. Without that check a leaked session id from any other kelabo
  // could be subscribed to — the abuse the Cloudflare SFU docs warn about.
  //
  // A pull that names a `participantId` is resolved from the roster here, which
  // is the authoritative copy. The client's own view of who holds which session
  // is a snapshot, and a publisher who rebuilt their session between that
  // snapshot and this request would otherwise be refused for being stale rather
  // than for being wrong.
  for (const t of body.tracks) {
    if (t.location !== "remote") continue;
    if (t.participantId) {
      const target = c.rtcRoom.peer(kelaboId, t.participantId);
      if (!target?.sfuSessionId) {
        c.log("rtc_pull_rejected", {
          kelaboId,
          participantId: participant.identity,
          target: t.participantId,
          reason: target ? "no_session" : "not_a_peer",
        });
        return send(res, 403, { error: "forbidden", detail: "track is not published in this kelabo" });
      }
      t.sessionId = target.sfuSessionId;
      continue;
    }
    if (!t.sessionId || !c.rtcRoom.ownsSession(kelaboId, t.sessionId)) {
      c.log("rtc_pull_rejected", { kelaboId, participantId: participant.identity, sessionId: t.sessionId });
      return send(res, 403, { error: "forbidden", detail: "track is not published in this kelabo" });
    }
  }

  try {
    const out = await c.rtc.newTracks(sessionId, {
      sessionDescription: body.sessionDescription,
      // `kind` and `participantId` are ours, not Cloudflare's — the latter has
      // already done its job above, resolving to the `sessionId` sent here.
      tracks: body.tracks.map(({ kind, participantId, ...t }) => t),
    });

    // Cloudflare reports a rejected track *inside* a 200, one entry at a time.
    // Announcing regardless put tracks on the roster the SFU had refused, so
    // every other participant spent the kelabo pulling something that was
    // never there — and the only trace of the real reason lived in a response
    // body nobody read.
    const results = Array.isArray(out?.tracks) ? out.tracks : null;
    const rejected = results?.filter((t) => t?.errorCode) ?? [];
    if (rejected.length) {
      c.log("rtc_sfu_track_rejected", {
        kelaboId,
        participantId: participant.identity,
        tracks: rejected.map((t) => ({
          trackName: t.trackName,
          code: t.errorCode,
          detail: t.errorDescription,
        })),
      });
    }
    const accepted = results
      ? new Set(results.filter((t) => !t?.errorCode).map((t) => t.trackName))
      : null;
    c.rtcRoom.announceTracks(
      kelaboId,
      participant.identity,
      accepted ? body.tracks.filter((t) => accepted.has(t.trackName)) : body.tracks,
    );
    logSignal(c, "tracks", ctx, body, out);
    return send(res, 200, out);
  } catch (err) {
    return fail(c, res, err, "sfu_tracks", { kelaboId, participantId: participant.identity });
  }
}

async function sfuRenegotiate(c, req, res) {
  const ctx = await context(c, req, res, rtcRenegotiateBodySchema);
  if (!ctx) return undefined;
  const sessionId = ownSession(c, ctx.kelaboId, ctx.participant.identity, res);
  if (!sessionId) return undefined;
  try {
    const out = await c.rtc.renegotiate(sessionId, ctx.body.sessionDescription);
    logSignal(c, "renegotiate", ctx, ctx.body, out);
    return send(res, 200, out);
  } catch (err) {
    return fail(c, res, err, "sfu_renegotiate", {
      kelaboId: ctx.kelaboId,
      participantId: ctx.participant.identity,
    });
  }
}

async function sfuCloseTracks(c, req, res) {
  const ctx = await context(c, req, res, rtcCloseTracksBodySchema);
  if (!ctx) return undefined;
  const sessionId = ownSession(c, ctx.kelaboId, ctx.participant.identity, res);
  if (!sessionId) return undefined;
  try {
    const out = await c.rtc.closeTracks(sessionId, {
      tracks: ctx.body.tracks,
      sessionDescription: ctx.body.sessionDescription,
      force: ctx.body.force,
    });
    logSignal(c, "close_tracks", ctx, ctx.body, out);
    return send(res, 200, out);
  } catch (err) {
    return fail(c, res, err, "sfu_close_tracks", {
      kelaboId: ctx.kelaboId,
      participantId: ctx.participant.identity,
    });
  }
}
