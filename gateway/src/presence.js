import { queryAcceptedContacts } from "./db.js";

/**
 * Contact presence (docs 18 §5) — the first non-kelabo-scoped browser stream on
 * the Gateway.
 *
 * Every open tab that is signed in holds one `GET /presence/stream`. A person is
 * "online" while they hold at least one such stream. When their first stream
 * opens, everyone who should see them gets an `online` event; when their last
 * closes, an `offline`. Each stream, on connect, is sent a `snapshot` of exactly
 * the people it may see who are online right now — and that snapshot is the
 * recovery mechanism, so an EventSource reconnect re-syncs with no server replay.
 *
 * Who may see whom: everyone in the same tenant (presence inside a domain is
 * already public there), plus a subscriber's accepted external contacts when the
 * deployment enables them. Names never travel here — the SPA has them from
 * `GET /contacts`; presence carries identities only.
 *
 * State lives on the container:
 *   c.state.presence         : identity -> { tenantId, streams:Set<res> }
 *   c.state.presenceByTenant  : tenantId -> Set<identity>
 *
 * Liveness copies the SSE hub's reference-counting exactly: `offline` fires only
 * when an identity's LAST stream closes, counted by re-reading the current set
 * rather than the one captured at subscribe time — otherwise an EventSource
 * reconnect (old close lands after the new subscribe) marks a present colleague
 * offline.
 */

const PING_INTERVAL_MS = 25_000;
// How long a ring rings before it gives up on unanswered targets (docs 18 §6).
const RING_TTL_MS = 45_000;

function writeRaw(res, chunk) {
  try {
    res.write(chunk);
  } catch {}
}

function writeEvent(res, data) {
  writeRaw(res, `event: presence\ndata: ${JSON.stringify(data)}\n\n`);
}

export function createPresence(c) {
  // Overridable only through the container, the same seam `llm` and
  // `skipRebuild` use — a test cannot wait 25 seconds to assert the keepalive
  // is the visible kind, and the alternative is not asserting it at all.
  // Never a config value: no deployment has a reason to change this.
  const pingMs = c.presencePingMs ?? PING_INTERVAL_MS;
  const pingTimer = setInterval(() => {
    for (const [, entry] of c.state.presence) {
      // A named event, not the SSE comment this used to be. A comment keeps
      // proxies from idling the TCP connection but is invisible to the
      // EventSource API, so a client could never tell a quiet stream from a
      // half-open socket — exactly the lesson `sseHub` records for the caption
      // stream. It did not matter while this carried only presence and rings,
      // both of which self-correct; it matters now that thread messages ride
      // it (docs 20 §19.9) and a silently dead stream means a person simply
      // stops being told anything.
      for (const res of entry.streams) writeRaw(res, `event: ping\ndata: {}\n\n`);
    }
  }, pingMs);
  pingTimer.unref?.();
  c.shutdownHooks.push(async () => clearInterval(pingTimer));

  /** Is this identity currently in a live kelabo? Derived from whether they
   *  hold any /caption/replies subscription — no separate bookkeeping. */
  function isInKelabo(identity) {
    for (const [, subs] of c.state.sseSubscribers) {
      for (const sub of subs) if (sub.participantId === identity) return true;
    }
    return false;
  }

  function onlineIdentities() {
    return c.state.presence;
  }

  /** Everyone `viewer` (identity in `tenantId`) is allowed to see the presence
   *  of: same-tenant colleagues plus accepted external contacts. */
  async function audienceFor(identity, tenantId) {
    const set = new Set(c.state.presenceByTenant.get(tenantId) || []);
    if (c.config.contacts?.external) {
      // The people `identity` has accepted see them, and they see those people.
      // Presence is symmetric for an accepted pair, so the same peer list serves
      // both "whom I notify" and "whose snapshot includes me".
      const peers = await queryAcceptedContacts(c, identity).catch(() => []);
      for (const p of peers) set.add(p);
    }
    set.delete(identity);
    return set;
  }

  /** Deliver one presence event to every stream a target identity holds.
   *  Answers whether anyone was reachable, which the journey fan-out logs. */
  function sendTo(identity, data) {
    const entry = c.state.presence.get(identity);
    if (!entry) return false;
    for (const res of entry.streams) writeEvent(res, data);
    return entry.streams.size > 0;
  }

  /** Everyone from this tenant holding a stream right now. The audience for a
   *  public journey, whose membership is a tenant match computed at read time
   *  (docs 20 §3.2) and which the Gateway therefore cannot enumerate — but it
   *  does not have to: an offline person cannot be pushed to anyway, and their
   *  badge is correct the moment they load a page. */
  function tenantOnline(tenantId) {
    return new Set(c.state.presenceByTenant.get(tenantId) || []);
  }

  /**
   * Fan one thread message out to a journey's members (docs 20 §19.9).
   *
   * This stream rather than one of its own: it is already open on every page
   * of a signed-in tab, it is authenticated by the session cookie — exactly
   * the credential a journey uses — and it already carries a non-presence
   * payload in the ring. A dedicated journey stream would be a third
   * EventSource against the browser's six-per-origin budget, and would still
   * not solve the cross-journey badge, because you are by definition not
   * subscribed to the journey you are not looking at.
   *
   * There is no replay here, deliberately (docs 18 §5.4). A missed event costs
   * one late badge and nothing else: every surface still polls as a backstop,
   * and the counts themselves are always recomputed server-side.
   */
  function notifyJourney(identities, payload) {
    let reached = 0;
    for (const identity of identities) {
      if (sendTo(identity, { kind: "journey_message", ...payload })) reached++;
    }
    return reached;
  }

  /**
   * Register a new presence stream for `identity`. Sends the connecting stream
   * its snapshot, and — if this is the identity's first stream — announces them
   * online to everyone who should see them.
   */
  async function subscribe(res, { identity, tenantId }) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
      // No CORS headers here on purpose. `setCorsHeaders` has already put them
      // on this response with `setHeader`, and anything named again in
      // `writeHead` WINS — so re-stating them here silently overrode the
      // allowed-origin decision with a hard-coded one. The preflight (which
      // never reaches this code) kept answering correctly while the stream
      // itself was refused, which is a very quiet way to be broken.
    });
    res.write(`: connected\n\n`);

    let entry = c.state.presence.get(identity);
    const firstStream = !entry;
    if (!entry) {
      entry = { tenantId, streams: new Set() };
      c.state.presence.set(identity, entry);
      let tset = c.state.presenceByTenant.get(tenantId);
      if (!tset) {
        tset = new Set();
        c.state.presenceByTenant.set(tenantId, tset);
      }
      tset.add(identity);
    }
    entry.streams.add(res);

    // The audience this viewer may see, and — for the announce below — the
    // audience that may see this viewer. They are the same set (symmetric).
    const audience = await audienceFor(identity, tenantId);

    // Snapshot: who among the people I may see is online right now.
    const online = [];
    for (const other of audience) {
      if (c.state.presence.has(other)) online.push({ identity: other, inKelabo: isInKelabo(other) });
    }
    writeEvent(res, { kind: "snapshot", online });

    // Announce myself online to my audience, but only when I just came online
    // (first stream) — a second tab must not re-announce.
    if (firstStream) {
      const me = { kind: "online", identity, inKelabo: isInKelabo(identity) };
      for (const other of audience) sendTo(other, me);
    }

    res.on("close", () => {
      // Re-read the current entry rather than closing over `entry`: the map may
      // have been rebuilt between subscribe and close.
      const current = c.state.presence.get(identity);
      if (!current) return;
      current.streams.delete(res);
      if (current.streams.size > 0) return; // other tabs still hold them online
      c.state.presence.delete(identity);
      const tset = c.state.presenceByTenant.get(tenantId);
      if (tset) {
        tset.delete(identity);
        if (!tset.size) c.state.presenceByTenant.delete(tenantId);
      }
      // Announce offline to the audience. Recompute it — external contacts may
      // have changed — but the same symmetric-set reasoning holds.
      audienceFor(identity, tenantId)
        .then((aud) => {
          for (const other of aud) sendTo(other, { kind: "offline", identity });
        })
        .catch(() => {});
      c.log("presence_offline", { identity });
    });

    c.log("presence_online", { identity, streams: entry.streams.size, firstStream });
  }

  /**
   * Tell a person's watchers their kelabo state changed (online but now busy,
   * or free again). Called when a caption subscription opens/closes. Best-effort
   * and only meaningful while they are online.
   */
  async function refreshKelaboState(identity) {
    const entry = c.state.presence.get(identity);
    if (!entry) return;
    const audience = await audienceFor(identity, entry.tenantId).catch(() => new Set());
    const data = { kind: "busy", identity, inKelabo: isInKelabo(identity) };
    for (const other of audience) sendTo(other, data);
    // Also update the person's own tabs so their self-view is consistent.
    for (const res of entry.streams) writeEvent(res, data);
  }

  // Is this identity online right now (holds any presence stream)?
  function isOnline(identity) {
    return c.state.presence.has(identity);
  }

  /**
   * Ring a set of targets into a kelabo (docs 18 §6). Targets are already
   * authorized by REST. Delivers `ring_incoming` to each ONLINE target over
   * their presence streams; offline targets are reported back so the caller can
   * tell the ringer who could not be reached. Sets a timeout after which
   * unanswered targets get `ring_cancelled{reason:"timeout"}` and the ringer a
   * `ring_answer{response:"timeout"}` per target.
   *
   * @returns {{rung:string[], offline:string[]}}
   */
  function ring(kelaboId, { from, fromName, fromAvatar, title, targets }) {
    // Supersede any prior ring for this kelabo (a re-dial).
    const prior = c.state.rings.get(kelaboId);
    if (prior?.timer) clearTimeout(prior.timer);

    const rung = [];
    const offline = [];
    const live = new Set();
    for (const t of targets) {
      if (t === from) continue;
      if (isOnline(t)) {
        sendTo(t, { kind: "ring_incoming", kelaboId, from, fromName: fromName || from, fromAvatar: fromAvatar || 0, title: title || "" });
        rung.push(t);
        live.add(t);
      } else {
        offline.push(t);
      }
    }

    if (live.size === 0) {
      c.state.rings.delete(kelaboId);
      c.log("ring_none_online", { kelaboId, from, offline: offline.length });
      return { rung, offline };
    }

    const expiresAt = Date.now() + RING_TTL_MS;
    const timer = setTimeout(() => expireRing(kelaboId), RING_TTL_MS);
    timer.unref?.();
    c.state.rings.set(kelaboId, { from, fromName: fromName || from, title: title || "", targets: live, answered: new Set(), expiresAt, timer });
    c.log("ring_started", { kelaboId, from, rung: rung.length, offline: offline.length });
    return { rung, offline };
  }

  function expireRing(kelaboId) {
    const r = c.state.rings.get(kelaboId);
    if (!r) return;
    c.state.rings.delete(kelaboId);
    for (const t of r.targets) {
      if (r.answered.has(t)) continue;
      sendTo(t, { kind: "ring_cancelled", kelaboId, reason: "timeout" });
      sendTo(r.from, { kind: "ring_answer", kelaboId, from: t, response: "timeout" });
    }
    c.log("ring_expired", { kelaboId });
  }

  /** A target answered (accepted/declined). Relayed to the ringer; the target's
   *  own devices are told to stop ringing. */
  function ringAnswer(kelaboId, { from: target, response }) {
    const r = c.state.rings.get(kelaboId);
    // Tell the ringer regardless — even a late answer is worth surfacing.
    const ringer = r?.from;
    if (ringer) sendTo(ringer, { kind: "ring_answer", kelaboId, from: target, response });
    // Stop the ring on all of the answerer's devices.
    sendTo(target, { kind: "ring_cancelled", kelaboId, reason: "answered" });
    if (r) {
      r.answered.add(target);
      // Everyone answered → nothing left to ring.
      let outstanding = false;
      for (const t of r.targets) if (!r.answered.has(t)) outstanding = true;
      if (!outstanding) {
        if (r.timer) clearTimeout(r.timer);
        c.state.rings.delete(kelaboId);
      }
    }
    c.log("ring_answered", { kelaboId, target, response });
  }

  /** The ringer cancelled (hung up). Every outstanding target stops ringing. */
  function ringCancel(kelaboId, reason = "cancelled") {
    const r = c.state.rings.get(kelaboId);
    if (!r) return;
    if (r.timer) clearTimeout(r.timer);
    c.state.rings.delete(kelaboId);
    for (const t of r.targets) {
      if (r.answered.has(t)) continue;
      sendTo(t, { kind: "ring_cancelled", kelaboId, reason });
    }
    c.log("ring_cancelled", { kelaboId, reason });
  }

  return { subscribe, refreshKelaboState, isInKelabo, isOnline, onlineIdentities, tenantOnline, notifyJourney, ring, ringAnswer, ringCancel };
}
