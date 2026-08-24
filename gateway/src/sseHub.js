import { SSE_EVENT_AGENT, SSE_EVENT_CONTRIBUTION, SSE_EVENT_DEBUG, SSE_EVENT_ENDED, SSE_EVENT_PING, SSE_EVENT_RENAME, SSE_EVENT_ROSTER, SSE_EVENT_RTC, SSE_EVENT_UTTERANCE } from "@kelabo/contracts";
import { putContrib } from "./db.js";

const PING_INTERVAL_MS = 25_000;

/**
 * Which browser origins may talk to the Gateway with credentials.
 *
 * More than one, because the portal can answer on more than one hostname (an
 * apex beside a `www`), and the browser sends whichever the user typed.
 * `Access-Control-Allow-Origin` cannot be a list and cannot be `*` on a
 * credentialed request, so the request's own origin is echoed back when it is
 * one we serve, and the portal is the answer otherwise (which fails the
 * browser's check, exactly as an unknown origin should).
 */
export function corsOrigin(c, origin) {
  const allowed = c.config.allowedOrigins?.length ? c.config.allowedOrigins : [c.config.portalUrl];
  return allowed.includes(origin) ? origin : c.config.portalUrl;
}

export function setCorsHeaders(c, res, req) {
  res.setHeader("Access-Control-Allow-Origin", corsOrigin(c, req?.headers?.origin));
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Headers", "content-type, authorization");
  // PUT is needed by /rtc/sfu/renegotiate and /rtc/sfu/tracks/close.
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS");
  res.setHeader("Vary", "Origin");
}

export function createSseHub(c) {
  const pingTimer = setInterval(() => {
    for (const [kelaboId, subs] of c.state.sseSubscribers) {
      // A named event, not an SSE comment: comments keep proxies from idling
      // the TCP connection but are invisible to the EventSource API, so the
      // client could never tell a quiet room from a half-open socket. The
      // client's staleness watchdog (useBoard.js) counts on seeing this.
      for (const sub of subs) writeEvent(sub.res, SSE_EVENT_PING, { at: Date.now() });
      if (!subs.size) c.state.sseSubscribers.delete(kelaboId);
    }
  }, PING_INTERVAL_MS);
  pingTimer.unref?.();
  c.shutdownHooks.push(async () => clearInterval(pingTimer));

  // --- Live roster -------------------------------------------------------
  //
  // Who is in the kelabo *now*. `sseSubscribers` is the only signal that knows
  // it: the kelabo META's `participants` list is append-only (a join ledger, so
  // it never goes down), and the call roster misses board-only participants,
  // who hold a stream but never POST /rtc/join.
  //
  // How long an identity keeps its place after its last stream closes. The same
  // window the call uses before `peer_away` (rtc/room.js), for the same reason:
  // an EventSource blip or a reload would otherwise make the headcount visibly
  // dip and recover on every refresh.
  const departureGraceMs = Math.max(0, (c.config.rtc?.disconnectGraceSeconds ?? 20) * 1000);
  /** kelaboId -> Map<participantId, timer>: no stream, still counted. */
  const leaving = new Map();
  /** kelaboId -> last roster fanned out, so a reconnect does not emit no-ops. */
  const lastRoster = new Map();

  /** Distinct identities holding a live stream, plus those inside the grace window. */
  function liveParticipants(kelaboId) {
    const ids = new Set();
    for (const sub of c.state.sseSubscribers.get(kelaboId) ?? []) {
      if (sub.participantId) ids.add(sub.participantId);
    }
    for (const id of leaving.get(kelaboId)?.keys() ?? []) ids.add(id);
    return [...ids].sort();
  }

  function rosterPayload(kelaboId) {
    const participants = liveParticipants(kelaboId);
    return { count: participants.length, participants };
  }

  /** @returns {boolean} whether anything was written. */
  function fanRoster(kelaboId) {
    const subs = c.state.sseSubscribers.get(kelaboId);
    if (!subs?.size) {
      lastRoster.delete(kelaboId);
      return false;
    }
    const payload = rosterPayload(kelaboId);
    const signature = payload.participants.join("\n");
    if (lastRoster.get(kelaboId) === signature) return false;
    lastRoster.set(kelaboId, signature);
    for (const sub of subs) writeEvent(sub.res, SSE_EVENT_ROSTER, payload);
    c.log("roster_fanned", { kelaboId, count: payload.count, subscribers: subs.size });
    return true;
  }

  function forgetDeparture(kelaboId, participantId) {
    const pending = leaving.get(kelaboId);
    pending?.delete(participantId);
    if (pending && !pending.size) leaving.delete(kelaboId);
  }

  function scheduleDeparture(kelaboId, participantId) {
    let pending = leaving.get(kelaboId);
    if (!pending) {
      pending = new Map();
      leaving.set(kelaboId, pending);
    }
    if (pending.has(participantId)) return;
    const drop = () => {
      forgetDeparture(kelaboId, participantId);
      fanRoster(kelaboId);
    };
    if (departureGraceMs <= 0) {
      drop();
      return;
    }
    const timer = setTimeout(drop, departureGraceMs);
    timer.unref?.();
    pending.set(participantId, timer);
  }

  function cancelDeparture(kelaboId, participantId) {
    const timer = leaving.get(kelaboId)?.get(participantId);
    if (!timer) return;
    clearTimeout(timer);
    forgetDeparture(kelaboId, participantId);
  }

  function clearDepartures(kelaboId) {
    for (const timer of leaving.get(kelaboId)?.values() ?? []) clearTimeout(timer);
    leaving.delete(kelaboId);
    lastRoster.delete(kelaboId);
  }

  c.shutdownHooks.push(async () => {
    for (const kelaboId of [...leaving.keys()]) clearDepartures(kelaboId);
  });

  // A subscriber is { res, participantId } rather than a bare response: mesh
  // signalling has to reach exactly one participant, and a peer that drops its
  // stream must be removed from the call roster.
  //
  // `transcriptEntitled: false` marks a subscriber who may not receive spoken
  // words (a guest on a deployment that withholds the transcript from guests).
  // The filter lives HERE, at the fan-out, because this is the one place every
  // utterance passes through — a client-side filter would still deliver the
  // speech to the guest's browser, which is not isolation at all.
  function subscribe(kelaboId, res, participantId = "", { transcriptEntitled = true } = {}) {
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
    let set = c.state.sseSubscribers.get(kelaboId);
    if (!set) {
      set = new Set();
      c.state.sseSubscribers.set(kelaboId, set);
    }
    const sub = { res, participantId, transcriptEntitled };
    set.add(sub);
    res.on("close", () => {
      // Re-read the set rather than closing over the one that was current at
      // subscribe time. When the last subscriber leaves, the kelabo's set is
      // deleted from the map (below) and the next subscriber builds a fresh
      // one — so a connection that outlived that gap held a reference to an
      // orphaned Set, and the "is this participant still here?" scan below ran
      // against a collection nobody else could see. It answered "no" every
      // time, and evicted a participant who had already reconnected.
      const current = c.state.sseSubscribers.get(kelaboId);
      current?.delete(sub);
      if (current && !current.size) c.state.sseSubscribers.delete(kelaboId);
      // Losing the stream is how we learn a participant left the call: there is
      // no other liveness signal, and /rtc/leave only fires on a clean exit.
      //
      // But only when it was their LAST stream. EventSource reconnects on its
      // own, and the old connection's close routinely lands after the
      // replacement has already subscribed — evicting a participant who is
      // sitting right there. That is what left one participant missing from
      // everyone else's call roster.
      if (!participantId) {
        fanRoster(kelaboId);
        return;
      }
      let remaining = 0;
      for (const other of current ?? []) if (other.participantId === participantId) remaining += 1;
      if (remaining > 0) {
        c.log("sse_resubscribed", { kelaboId, participantId, streams: remaining });
        return;
      }
      // Still counted for the grace window; `scheduleDeparture` fans the drop
      // when it expires, and `subscribe` cancels it if they come back.
      scheduleDeparture(kelaboId, participantId);
      c.rtcRoom?.handleDisconnect(kelaboId, participantId);
      // Their last caption stream in any kelabo closed → tell contact-presence
      // watchers they are no longer in a kelabo (docs 18 §5). Deferred a tick so
      // the scan below sees the fully-updated sseSubscribers map.
      if (c.presence) setImmediate(() => c.presence.refreshKelaboState(participantId));
    });
    c.log("sse_subscribed", { kelaboId, participantId, subscribers: set.size });
    // Back inside the disconnect grace window: the pending eviction is
    // cancelled and the room is told the peer never really left.
    if (participantId) {
      cancelDeparture(kelaboId, participantId);
      c.rtcRoom?.cancelDisconnect?.(kelaboId, participantId);
    }
    // The headcount changed for everyone, or — on a reconnect that changed
    // nothing — only this stream still needs its opening value.
    if (!fanRoster(kelaboId)) writeEvent(res, SSE_EVENT_ROSTER, rosterPayload(kelaboId));
    // Entering a kelabo flips `inKelabo` for contact-presence watchers.
    if (participantId && c.presence) c.presence.refreshKelaboState(participantId);
  }

  function writeEvent(res, event, data) {
    writeRaw(res, `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  async function publish(kelaboId, contribution) {
    // Ephemeral cards are streamed but never persisted: in-progress placeholders
    // ("working"), "skipped" cards (the agent explaining why nothing is coming —
    // useful live, noise in an archive) and empty "clear" markers (a done card
    // with no title/markdown, used to remove an in-progress card). Only real
    // final contributions are stored.
    const isClearMarker = contribution.status === "done" && !contribution.title && !contribution.markdown;
    const isEphemeral = contribution.status === "working" || contribution.status === "skipped";
    if (!isEphemeral && !isClearMarker) {
      try {
        await putContrib(c, contribution);
      } catch (err) {
        c.logError("contrib_persist_failed", err, { kelaboId });
      }
    }
    const subs = c.state.sseSubscribers.get(kelaboId);
    if (!subs) return;
    for (const sub of subs) writeEvent(sub.res, SSE_EVENT_CONTRIBUTION, contribution);
    c.log("contribution_fanned", {
      kelaboId,
      tag: contribution.tag,
      kind: contribution.kind,
      origin: contribution.origin,
      status: contribution.status,
      subscribers: subs.size,
    });
  }

  function rename(kelaboId, payload) {
    const subs = c.state.sseSubscribers.get(kelaboId);
    if (!subs) return;
    for (const sub of subs) writeEvent(sub.res, SSE_EVENT_RENAME, payload);
    c.log("rename_fanned", { kelaboId, ...payload, subscribers: subs.size });
  }

  // Fan out an LLM debug entry (request messages / raw response) for the
  // in-app debug panel. Ephemeral — never persisted.
  function debug(kelaboId, payload) {
    const subs = c.state.sseSubscribers.get(kelaboId);
    if (!subs) return;
    for (const sub of subs) writeEvent(sub.res, SSE_EVENT_DEBUG, payload);
  }

  // Fan out an utterance (not persisted here; persistence happens via putUtt in
  // the caption handler). Typed messages reach everyone; speech — live
  // fragments and sealed messages alike — only reaches transcript-entitled
  // subscribers. Fragments never carry `source`, so they are speech by
  // construction and cannot leak past the entitlement check.
  function utterance(kelaboId, payload) {
    const subs = c.state.sseSubscribers.get(kelaboId);
    if (!subs) return;
    const typedMessage = payload.source === "typed";
    for (const sub of subs) {
      if (!typedMessage && sub.transcriptEntitled === false) continue;
      writeEvent(sub.res, SSE_EVENT_UTTERANCE, payload);
    }
  }

  // Conference-audio signalling (docs 15). Roster changes go to the whole room;
  // mesh offer/answer/ICE go to one peer only, so a participant never sees
  // another pair's negotiation.
  function rtc(kelaboId, payload) {
    const subs = c.state.sseSubscribers.get(kelaboId);
    if (!subs) return 0;
    for (const sub of subs) writeEvent(sub.res, SSE_EVENT_RTC, payload);
    return subs.size;
  }

  function rtcTo(kelaboId, participantId, payload) {
    const subs = c.state.sseSubscribers.get(kelaboId);
    if (!subs) return 0;
    let sent = 0;
    for (const sub of subs) {
      if (sub.participantId !== participantId) continue;
      writeEvent(sub.res, SSE_EVENT_RTC, payload);
      sent += 1;
    }
    return sent;
  }

  // A developer's local agent attached or detached (docs 16). Ephemeral, like
  // `rename`: the durable half is `isDeveloperPresent` on the META. Worth
  // fanning out because a dropped bridge used to hand the kelabo back to the
  // server agent with nothing on screen to say so.
  function agent(kelaboId, payload) {
    const subs = c.state.sseSubscribers.get(kelaboId);
    if (!subs) return;
    for (const sub of subs) writeEvent(sub.res, SSE_EVENT_AGENT, payload);
    c.log("agent_presence_fanned", { kelaboId, ...payload, subscribers: subs.size });
  }

  function ended(kelaboId, payload = { reason: "ended" }) {
    const subs = c.state.sseSubscribers.get(kelaboId);
    if (subs) {
      for (const sub of subs) {
        writeEvent(sub.res, SSE_EVENT_ENDED, payload);
        sub.res.end();
      }
      c.state.sseSubscribers.delete(kelaboId);
    }
    clearDepartures(kelaboId);
    c.log("sse_ended", { kelaboId, subscribers: subs?.size ?? 0 });
  }

  return { subscribe, publish, rename, debug, utterance, rtc, rtcTo, agent, ended, roster: rosterPayload, writeEvent };
}

function writeRaw(res, chunk) {
  try {
    res.write(chunk);
  } catch {}
}
