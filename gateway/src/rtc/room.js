import { RTC_MODES } from "@kelabo/contracts";
import { getMeta, updateMeta } from "../db.js";
import { meshHasRoom, meshUnits } from "./capacity.js";

// Per-kelabo conference presence. Deliberately in-process and unpersisted, for
// the same reason as sseSubscribers: it is a view of who currently holds a live
// connection, and a task restart rebuilds it as clients reconnect. The durable
// half — which transport the kelabo uses — lives on the kelabo META as
// `rtcMode`, written once at creation by the REST API.

/**
 * @typedef {object} Peer
 * @property {string} participantId
 * @property {string} displayName
 * @property {boolean} isGuest
 * @property {string} [sfuSessionId]  Cloudflare session, sfu mode only
 * @property {Record<string,string>} tracks  media kind -> published track name
 * @property {number} joinedAt
 */

export function createRtcRoom(c) {
  const meshMax = c.config.rtc.meshMaxParticipants;
  const disconnectGraceMs = Math.max(0, (c.config.rtc.disconnectGraceSeconds ?? 0) * 1000);
  // `${kelaboId}\n${participantId}` -> pending eviction timer. A participant
  // whose last SSE stream closed keeps their seat for the grace window, so an
  // EventSource blip or a reload is invisible to the room instead of a full
  // peer_left / peer_joined churn.
  const disconnectTimers = new Map();
  const timerKey = (kelaboId, participantId) => `${kelaboId}\n${participantId}`;

  function room(kelaboId) {
    return c.state.rtcRooms.get(kelaboId) ?? null;
  }

  /**
   * Resolve (and cache) the kelabo's transport from its META.
   *
   * Fails CLOSED: if the META cannot be read and the room is not in memory,
   * this throws rather than falling back to the default mode. The default is
   * `sfu`, so guessing here would silently move a mesh kelabo — whose whole
   * point is that no server can decrypt the media — onto Cloudflare's SFU on
   * nothing more than a DynamoDB blip during a rejoin into an empty room.
   * A missing `rtcMode` on a META that *was* read is different: that is a
   * kelabo predating the field, and the default is correct for it.
   */
  async function modeFor(kelaboId) {
    const existing = room(kelaboId);
    if (existing) return existing.mode;
    let meta;
    try {
      meta = await getMeta(c, kelaboId);
    } catch (err) {
      c.logError("rtc_mode_unresolved", err, { kelaboId });
      const e = new Error("rtc mode unresolved");
      e.code = "rtc_mode_unavailable";
      throw e;
    }
    return RTC_MODES.includes(meta?.rtcMode) ? meta.rtcMode : c.config.rtc.defaultMode;
  }

  function ensureRoom(kelaboId, mode) {
    let r = room(kelaboId);
    if (!r) {
      r = { mode, peers: new Map() };
      c.state.rtcRooms.set(kelaboId, r);
    }
    return r;
  }

  function roster(kelaboId) {
    const r = room(kelaboId);
    if (!r) return [];
    return [...r.peers.values()].map(toWire);
  }

  function toWire(p) {
    return {
      participantId: p.participantId,
      displayName: p.displayName,
      avatarVariant: p.avatarVariant || 0,
      isGuest: p.isGuest,
      sfuSessionId: p.sfuSessionId,
      tracks: { ...p.tracks },
      media: { ...p.media },
      joinedAt: p.joinedAt,
    };
  }

  function peer(kelaboId, participantId) {
    return room(kelaboId)?.peers.get(participantId) ?? null;
  }

  /**
   * Register a participant on the call.
   * @returns {{ ok:true, mode:string, self:Peer, peers:object[] }
   *          | { ok:false, code:string, status:number, detail?:object }}
   */
  async function join({ kelaboId, participantId, displayName, avatarVariant, isGuest }) {
    let mode;
    try {
      mode = await modeFor(kelaboId);
    } catch {
      // Retryable by design (5xx): the client's join retry gets another chance
      // once the META is readable again, instead of a silent mode downgrade.
      return { ok: false, code: "rtc_mode_unavailable", status: 503 };
    }
    const r = ensureRoom(kelaboId, mode);

    const rejoining = r.peers.has(participantId);
    // Mesh is a hard cap, not a soft one: silently spilling over to the SFU
    // would revoke the peer-to-peer guarantee the host chose, so the join is
    // refused instead. Counted in units — participants plus active screen
    // shares (see capacity.js). Rejoining an existing seat never counts
    // against it.
    if (!rejoining && !meshHasRoom({ mode: r.mode, meshMax, units: meshUnits(r.peers.values()) })) {
      return { ok: false, code: "mesh_room_full", status: 409, detail: { meshMax } };
    }

    const self = r.peers.get(participantId) ?? {
      participantId,
      displayName: displayName || participantId,
      avatarVariant: Number(avatarVariant) || 0,
      isGuest: !!isGuest,
      sfuSessionId: undefined,
      tracks: {},
      // Mic and camera switched on until told otherwise, for both: "on" is the
      // value that makes the tiles behave exactly as they did before this field
      // existed, reading the track and nothing else. Defaulting to "off" would
      // put a mic badge on everyone for the moment between joining and their
      // first report, and — worse during a rollout — would hide the camera of
      // any peer still on a bundle that does not know to report at all.
      //
      // `screen` starts OFF, unlike the other two: nobody shares by default,
      // and in mesh mode a share occupies a capacity unit, which must never be
      // taken by a peer who merely joined.
      media: { audio: true, video: true, screen: false },
      joinedAt: Date.now(),
    };
    self.displayName = displayName || self.displayName;
    r.peers.set(participantId, self);
    // A rejoin lands here while an eviction may still be pending from the old
    // page's SSE close (reload, or a rejoin during the grace window). The seat
    // was just retaken; evicting it on the old stream's schedule would delete
    // the peer record out from under the new page.
    clearDisconnectTimer(kelaboId, participantId);

    // The joiner gets the roster in its /rtc/join response; everyone already in
    // the room learns about them here. Peers decide who dials whom (mesh) or
    // which tracks to pull (sfu) from this event.
    c.sseHub.rtc(kelaboId, { kind: "peer_joined", peer: toWire(self) });
    c.log("rtc_join", { kelaboId, participantId, mode: r.mode, peers: r.peers.size });

    return {
      ok: true,
      mode: r.mode,
      self: toWire(self),
      peers: [...r.peers.values()].filter((p) => p.participantId !== participantId).map(toWire),
    };
  }

  /**
   * Bind the Cloudflare session created for this participant (sfu mode).
   *
   * A *new* session id means the old one is gone, and with it every track that
   * was published on it. The roster has to forget them in the same breath:
   * `tracks` only ever accumulated before, so a participant who rebuilt their
   * session — after a reload, or after Cloudflare declared the old one
   * disconnected — kept advertising tracks that no longer existed anywhere.
   * Every other participant went on pulling them for the rest of the kelabo,
   * once per reconcile tick, and got `not_found_track_error` every time.
   */
  function bindSfuSession(kelaboId, participantId, sfuSessionId) {
    const p = peer(kelaboId, participantId);
    if (!p) return null;
    const replaced = p.sfuSessionId && p.sfuSessionId !== sfuSessionId;
    p.sfuSessionId = sfuSessionId;
    if (replaced && Object.keys(p.tracks).length) {
      p.tracks = {};
      c.sseHub.rtc(kelaboId, { kind: "tracks", peer: toWire(p) });
      c.log("rtc_tracks_retracted", { kelaboId, participantId });
    }
    return p;
  }

  /**
   * Record tracks this participant now publishes and tell the room, so peers
   * know what to pull. Keyed by media kind, so a video track lands beside
   * the audio one without touching the wire format.
   */
  function announceTracks(kelaboId, participantId, tracks) {
    const p = peer(kelaboId, participantId);
    if (!p) return null;
    let changed = false;
    for (const t of tracks) {
      if (t.location !== "local") continue;
      if (p.tracks[t.kind] === t.trackName) continue;
      p.tracks[t.kind] = t.trackName;
      changed = true;
    }
    if (changed) c.sseHub.rtc(kelaboId, { kind: "tracks", peer: toWire(p) });
    return p;
  }

  /**
   * Record whether this participant's microphone, camera and screen share are
   * switched on, and tell the room if it changed.
   *
   * Deliberately separate from `announceTracks`. A published track and a
   * switched-on device are different facts with different lifetimes: the track
   * stays negotiated for the whole kelabo precisely so that toggling a camera
   * costs nothing, so "is there a track" cannot answer "is it on".
   *
   * `screen: true` is an *admission request* in a mesh room, not just a report:
   * the Gateway never sees mesh media or SDP, so this is the only gate at which
   * the participants-plus-shares cap can hold. A full room refuses the share
   * and the client must not publish it.
   *
   * @returns {{ ok:true, peer:Peer } | { ok:false, code:string, status:number,
   *            detail?:object } | null}  null when the caller has no seat.
   */
  function setMedia(kelaboId, participantId, media) {
    const r = room(kelaboId);
    const p = r?.peers.get(participantId) ?? null;
    if (!p) return null;
    if (
      media.screen === true &&
      !p.media.screen &&
      !meshHasRoom({ mode: r.mode, meshMax, units: meshUnits(r.peers.values()) })
    ) {
      c.log("rtc_screen_refused", { kelaboId, participantId, meshMax });
      return { ok: false, code: "mesh_room_full", status: 409, detail: { meshMax } };
    }
    let changed = false;
    for (const kind of ["audio", "video", "screen"]) {
      const next = media[kind];
      if (typeof next !== "boolean" || p.media[kind] === next) continue;
      p.media[kind] = next;
      changed = true;
    }
    if (changed) c.sseHub.rtc(kelaboId, { kind: "media", peer: toWire(p) });
    return { ok: true, peer: p };
  }

  /**
   * Is `sfuSessionId` owned by a peer of this kelabo? This is the check that
   * stops a client pulling from, or interfering with, a session belonging to
   * another kelabo — the Cloudflare docs call out unauthenticated session ids
   * as the main abuse vector for the SFU API.
   */
  function ownsSession(kelaboId, sfuSessionId) {
    const r = room(kelaboId);
    if (!r || !sfuSessionId) return false;
    for (const p of r.peers.values()) if (p.sfuSessionId === sfuSessionId) return true;
    return false;
  }

  /** Remove a participant and tell the room. Idempotent. */
  async function leave(kelaboId, participantId, reason = "left") {
    clearDisconnectTimer(kelaboId, participantId);
    const r = room(kelaboId);
    const p = r?.peers.get(participantId);
    if (!p) return false;
    r.peers.delete(participantId);
    if (!r.peers.size) c.state.rtcRooms.delete(kelaboId);

    // The room hears about the departure FIRST. The Cloudflare cleanup below
    // carries two 10s timeouts; awaiting it before the broadcast held
    // everyone's roster hostage to a slow third-party API for a fact — the
    // peer is gone — that was already true.
    c.sseHub.rtc(kelaboId, { kind: "peer_left", participantId, reason });
    c.log("rtc_leave", { kelaboId, participantId, reason, peers: r.peers.size });

    // Best-effort: the SFU also expires idle sessions on its own, so a failure
    // here costs nothing but a little lingering state on Cloudflare's side.
    if (r.mode === "sfu" && p.sfuSessionId && Object.keys(p.tracks).length) {
      try {
        const session = await c.rtc.getSession(p.sfuSessionId);
        const mids = (session.tracks ?? []).filter((t) => t.mid).map((t) => ({ mid: t.mid }));
        if (mids.length) await c.rtc.closeTracks(p.sfuSessionId, { tracks: mids, force: true });
      } catch (err) {
        c.logError("rtc_session_close_failed", err, { kelaboId, participantId });
      }
    }
    return true;
  }

  function clearDisconnectTimer(kelaboId, participantId) {
    const key = timerKey(kelaboId, participantId);
    const t = disconnectTimers.get(key);
    if (!t) return false;
    clearTimeout(t);
    disconnectTimers.delete(key);
    return true;
  }

  // Called by sseHub when a participant's LAST event stream closes. Losing the
  // SSE stream is the only liveness signal we get — /rtc/leave fires on a clean
  // exit, but a closed laptop or a killed tab never sends it.
  //
  // Eviction is deferred by the grace window rather than immediate: an
  // EventSource drop of a second or two is routine (mobile, proxies, reloads),
  // and evicting on it cost the whole room a peer_left/peer_joined cycle and a
  // full renegotiation for a participant who never left. During the window the
  // room sees `peer_away`; a resubscribe cancels the timer (see `subscribe` in
  // sseHub.js) and fans `peer_back`.
  function handleDisconnect(kelaboId, participantId) {
    if (!peer(kelaboId, participantId)) return;
    const evict = () =>
      leave(kelaboId, participantId, "disconnected").catch((err) =>
        c.logError("rtc_disconnect_cleanup_failed", err, { kelaboId, participantId }),
      );
    if (disconnectGraceMs <= 0) {
      evict();
      return;
    }
    const key = timerKey(kelaboId, participantId);
    if (disconnectTimers.has(key)) return;
    const timer = setTimeout(() => {
      disconnectTimers.delete(key);
      evict();
    }, disconnectGraceMs);
    timer.unref?.();
    disconnectTimers.set(key, timer);
    c.sseHub.rtc(kelaboId, { kind: "peer_away", participantId });
    c.log("rtc_peer_away", { kelaboId, participantId, graceMs: disconnectGraceMs });
  }

  /** The participant's stream came back inside the grace window. */
  function cancelDisconnect(kelaboId, participantId) {
    if (!clearDisconnectTimer(kelaboId, participantId)) return;
    c.sseHub.rtc(kelaboId, { kind: "peer_back", participantId });
    c.log("rtc_peer_back", { kelaboId, participantId });
  }

  /**
   * Move a live call off the SFU and onto mesh, mid-call.
   *
   * The one sanctioned exception to "a kelabo's `rtcMode` never changes after
   * creation". That rule exists so a *joiner* is never silently moved onto a
   * transport the host did not choose — it is about drift, not about the
   * operator. This is the opposite: a deliberate, announced, whole-room move,
   * made when the alternative is not "keep the SFU" but "no call at all"
   * (Cloudflare unreachable, or an operator policy that has stopped paying for
   * routing). Downgrading is the generous half of that; it is never an upgrade,
   * because mesh is the mode with the stronger promise and taking it away is
   * what the invariant guards.
   *
   * **Refused when the room is too big for mesh**, and this is the whole
   * reason the caller gets an answer rather than a promise. Mesh is not a
   * cheaper SFU: every participant sends their uplink to every other one, so a
   * nine-seat call demoted to mesh is nine times the uplink and, at
   * `meshMaxParticipants`, explicitly more than the cap admits. A call that
   * cannot be carried is left alone for the caller to deal with — ending it
   * cleanly beats delivering a room nobody can hear.
   *
   * Cloudflare teardown is deliberately **not** awaited. The room has already
   * been told, the peers have already stopped advertising sessions, and the
   * SFU expires an idle session on its own; holding the caller — which on a
   * metered deployment is a timer with a whole room's worth of work to do —
   * behind two 10s third-party timeouts per peer buys nothing.
   *
   * @returns {Promise<{ok:true, peers:number, already?:boolean}
   *                  | {ok:false, code:string, detail?:object}>}
   */
  async function demote(kelaboId, { reason = "demoted" } = {}) {
    const r = room(kelaboId);
    if (!r) return { ok: false, code: "rtc_no_room" };
    if (r.mode === "mesh") return { ok: true, peers: r.peers.size, already: true };

    const units = meshUnits(r.peers.values());
    // `adding: 0` — nobody is joining. This asks whether the room as it stands
    // fits, which is a different question from the one `join` asks.
    if (!meshHasRoom({ mode: "mesh", meshMax, units, adding: 0 })) {
      c.log("rtc_demote_refused", { kelaboId, units, meshMax, reason });
      return { ok: false, code: "mesh_too_small", detail: { meshMax, units } };
    }

    r.mode = "mesh";
    // Durable, and before anything else observable: a task that restarts after
    // the announcement but before the write would read `sfu` back off the META
    // and put the room straight onto the transport the caller just ruled out.
    try {
      await updateMeta(c, kelaboId, { rtcMode: "mesh" });
    } catch (err) {
      // The in-process room is already mesh and the announcement still goes
      // out: a call that keeps working until the next restart is a better
      // outcome than one that stays on a transport nobody wants because a
      // single write failed.
      c.logError("rtc_demote_meta_failed", err, { kelaboId });
    }

    // Every SFU session is abandoned by this, so the roster must stop naming
    // them in the same breath. Peers pulling tracks off a session that is on
    // its way out get `not_found_track_error` for the rest of the kelabo
    // otherwise — the same failure `bindSfuSession` retracts tracks for. It is
    // also what stops a metered deployment counting seat-seconds for a call
    // that is no longer being routed.
    const abandoned = [];
    for (const p of r.peers.values()) {
      if (p.sfuSessionId) abandoned.push({ participantId: p.participantId, sfuSessionId: p.sfuSessionId });
      p.sfuSessionId = undefined;
      p.tracks = {};
    }

    c.sseHub.rtc(kelaboId, { kind: "mode", mode: "mesh", reason });
    c.log("rtc_demoted", { kelaboId, peers: r.peers.size, units, sessions: abandoned.length, reason });

    for (const { participantId, sfuSessionId } of abandoned) {
      closeSessionTracks(kelaboId, participantId, sfuSessionId).catch(() => {});
    }
    return { ok: true, peers: r.peers.size };
  }

  /** Best-effort: retract everything a session publishes. Never throws. */
  async function closeSessionTracks(kelaboId, participantId, sfuSessionId) {
    try {
      const session = await c.rtc.getSession(sfuSessionId);
      const mids = (session.tracks ?? []).filter((t) => t.mid).map((t) => ({ mid: t.mid }));
      if (mids.length) await c.rtc.closeTracks(sfuSessionId, { tracks: mids, force: true });
    } catch (err) {
      c.logError("rtc_session_close_failed", err, { kelaboId, participantId });
    }
  }

  /** Kelabo ended: drop the whole room. The `ended` SSE event is sent separately. */
  function closeKelabo(kelaboId) {
    for (const key of [...disconnectTimers.keys()]) {
      if (key.startsWith(`${kelaboId}\n`)) {
        clearTimeout(disconnectTimers.get(key));
        disconnectTimers.delete(key);
      }
    }
    const r = room(kelaboId);
    if (!r) return;
    c.state.rtcRooms.delete(kelaboId);
    c.log("rtc_room_closed", { kelaboId, peers: r.peers.size });
  }

  return {
    join,
    leave,
    handleDisconnect,
    cancelDisconnect,
    demote,
    closeKelabo,
    roster,
    peer,
    bindSfuSession,
    announceTracks,
    setMedia,
    ownsSession,
    modeFor,
  };
}
