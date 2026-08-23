// The Gateway half of the Kelabo Agent Protocol (docs 16 §2.A).
//
// One WSS connection per developer's local agent bridge. The protocol is
// runtime-agnostic — nothing here knows or cares whether the far end drives
// opencode, Claude Code or something else; `sessionRef` and `workspace` are
// opaque strings we store and display.
//
// The one structural rule worth stating up front: a binding to a *scheduled*
// kelabo goes in `prepByKelabo`, never `tunnelByKelabo`. `caption.js`
// consults only the latter, so a prep binding cannot receive transcript no
// matter what the client asks for. Attending a kelabo is a separate, deliberate
// attach made once it is live.
import { randomUUID } from "node:crypto";
import { WebSocketServer } from "ws";
import { parseUpFrame } from "@kelabo/contracts";
import { verifyAgentJwt } from "./cookies.js";
import { loadKelaboHistory } from "./agent/history.js";
import {
  putPromotion,
  updateMeta,
  getMeta,
  queryInvites,
  queryContrib,
  isAgentTokenRevoked,
} from "./db.js";
import {
  getJourneyMeta,
  latestDescription,
  activeBoardMessages,
  resolveJourneyForKelabo,
  queryJourneyTimeline,
  submitJourneyReport,
  postJourneyBoardMessage,
} from "./journeys.js";

const REGISTER_TIMEOUT_MS = 10_000;
const HEARTBEAT_EXPECT_MS = 30_000;
const STALE_AFTER_MS = 90_000;
const SUMMARY_WAIT_MS = 60_000;
const ARCHIVE_WAIT_MS = 30_000;
const BOARD_LIMIT = 50;
// A dev tool asking for a journey's board directly may reasonably want more
// than the terse digest agent/journeyContext.js pins into the system prompt
// per turn (5) — generous without being the unbounded whole collection.
const JOURNEY_BOARD_LIMIT = 20;
// Open card references remembered per connection. Generous: an agent running
// several background lookups at once holds several open at a time.
const MAX_CARDS_PER_CONN = 200;

export function createTunnel(c) {
  const wss = new WebSocketServer({ noServer: true });
  const conns = new Set();
  // requestId -> {resolve, timer}. Correlated rather than "whatever arrives
  // next": the previous protocol recovered a summary by intercepting the next
  // board post, which meant a contribution sent at the wrong moment silently
  // became the minutes.
  const pending = new Map();

  const staleTimer = setInterval(() => {
    const now = Date.now();
    for (const conn of conns) {
      if (now - conn.lastSeen > STALE_AFTER_MS) {
        c.log("tunnel_stale_close", { identity: conn.identity });
        try {
          conn.ws.close(4000, "stale");
        } catch {}
      }
    }
  }, HEARTBEAT_EXPECT_MS);
  staleTimer.unref?.();
  c.shutdownHooks.push(async () => {
    clearInterval(staleTimer);
    for (const conn of conns) {
      try {
        conn.ws.close(1001, "shutdown");
      } catch {}
    }
    wss.close();
  });

  function sendDown(ws, frame) {
    try {
      ws.send(JSON.stringify(frame));
    } catch (err) {
      c.logError("tunnel_send_failed", err);
    }
  }

  function handleUpgrade(req, socket, head) {
    wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws, req));
  }

  function onConnection(ws) {
    const conn = {
      ws,
      agentId: randomUUID(),
      identity: null,
      tenant: null,
      agent: { runtime: "", version: "", label: "" },
      // Kelabos this connection attends (transcript flows) and kelabos it is
      // only preparing for. Kept apart so a disconnect unwinds each correctly.
      kelabos: new Set(),
      prepKelabos: new Set(),
      // Contribution `ref`s already accepted, so a retry after a dropped socket
      // does not double-post.
      seenRefs: new Set(),
      // Card reference -> contribution id, for cards this connection opened.
      cards: new Map(),
      lastSeen: Date.now(),
      registered: false,
    };
    conns.add(conn);
    const registerTimer = setTimeout(() => {
      if (!conn.registered) {
        sendDown(ws, { type: "rejected", reason: "register_timeout" });
        ws.close(4001, "register_timeout");
      }
    }, REGISTER_TIMEOUT_MS);

    ws.on("message", async (raw) => {
      conn.lastSeen = Date.now();
      const parsed = parseUpFrame(raw);
      if (!parsed.ok) {
        c.log("tunnel_bad_frame", { error: parsed.error });
        return;
      }
      const frame = parsed.frame;
      if (!conn.registered) {
        clearTimeout(registerTimer);
        await handleRegister(conn, frame);
        return;
      }
      await handleFrame(conn, frame);
    });

    ws.on("close", () => {
      clearTimeout(registerTimer);
      conns.delete(conn);
      for (const kelaboId of [...conn.kelabos, ...conn.prepKelabos]) detach(kelaboId, conn);
      c.log("tunnel_closed", { identity: conn.identity, agentId: conn.agentId });
    });
    ws.on("error", () => {});
  }

  async function handleRegister(conn, frame) {
    if (frame.type !== "register") {
      sendDown(conn.ws, { type: "rejected", reason: "first_frame_must_be_register" });
      conn.ws.close(4001, "bad_first_frame");
      return;
    }
    let payload = null;
    try {
      const key = await c.getCookieKey();
      payload = verifyAgentJwt(frame.token, key);
      // Signature and audience come free with the JWT; revocation costs a table
      // read, which is affordable exactly once, here, rather than per frame.
      if (payload && (await isAgentTokenRevoked(c, payload.jti))) {
        sendDown(conn.ws, { type: "rejected", reason: "agent_token_revoked" });
        conn.ws.close(4003, "agent_token_revoked");
        c.log("tunnel_rejected", { reason: "agent_token_revoked", identity: payload.sub });
        return;
      }
    } catch (err) {
      c.logError("tunnel_register_error", err);
      payload = null;
    }
    if (!payload) {
      sendDown(conn.ws, { type: "rejected", reason: "invalid_token" });
      conn.ws.close(4003, "invalid_token");
      c.log("tunnel_rejected", { reason: "invalid_token" });
      return;
    }
    conn.registered = true;
    conn.identity = payload.sub;
    conn.tenant = payload.tenant;
    conn.agent = {
      runtime: frame.agent.runtime,
      version: frame.agent.version,
      label: frame.agent.label || payload.label || frame.agent.runtime,
    };
    // Deliberately no kelabo lookup here. Which kelabo to work on is the
    // developer's choice, made with `kelabo_join`, and the list they choose from
    // comes from the control plane (GET /agent/kelabos) which already knows
    // about invitations. Guessing "your active kelabo" cannot see a scheduled
    // one and cannot see one you were merely invited to.
    sendDown(conn.ws, { type: "registered", agentId: conn.agentId, kelaboId: "" });
    c.log("tunnel_registered", {
      identity: conn.identity,
      agentId: conn.agentId,
      runtime: conn.agent.runtime,
    });
  }

  async function handleFrame(conn, frame) {
    switch (frame.type) {
      case "heartbeat":
        return;
      case "attach":
        return onAttach(conn, frame);
      case "contribution":
        return onContribution(conn, frame);
      case "summary":
      case "archive":
        return onResponse(conn, frame);
      case "rename":
        return onRename(conn, frame);
      case "board_request":
        return onBoardRequest(conn, frame);
      case "history_request":
        return onHistoryRequest(conn, frame);
      case "journey_info_request":
        return onJourneyInfoRequest(conn, frame);
      case "journey_timeline_request":
        return onJourneyTimelineRequest(conn, frame);
      case "journey_board_request":
        return onJourneyBoardRequest(conn, frame);
      case "journey_report_submit":
        return onJourneyReportSubmit(conn, frame);
      case "journey_post":
        return onJourneyPost(conn, frame);
      case "detach": {
        const ids = frame.kelaboId ? [frame.kelaboId] : [...conn.kelabos, ...conn.prepKelabos];
        for (const kelaboId of ids) await detach(kelaboId, conn);
        if (!frame.kelaboId) conn.ws.close(1000, "detach");
        return;
      }
      case "register":
        return;
    }
  }

  /** Host or invitee. Being invited is enough: preparing for a kelabo someone
   *  invited you to is the ordinary case, not a privileged one. */
  async function mayAttach(conn, kelaboId, meta) {
    if (meta.tenantId && conn.tenant && meta.tenantId !== conn.tenant) return false;
    if (meta.hostIdentity === conn.identity) return true;
    if (Array.isArray(meta.participants) && meta.participants.some((p) => p.identity === conn.identity)) {
      return true;
    }
    try {
      const invites = await queryInvites(c, kelaboId);
      return invites.some((i) => i.inviteKey === conn.identity);
    } catch (err) {
      c.logError("attach_invite_lookup_failed", err, { kelaboId });
      return false;
    }
  }

  async function onAttach(conn, frame) {
    const { kelaboId } = frame;
    const meta = await getMeta(c, kelaboId).catch((err) => {
      c.logError("attach_meta_failed", err, { kelaboId });
      return null;
    });
    if (!meta) return reject(conn, "kelabo_not_found");
    if (meta.status === "ended") return reject(conn, "kelabo_ended");
    // A cancelled scheduled kelabo is gone: neither attend nor prep. Without
    // this the `scheduled` branch below is an else-catch-all that would prep it.
    if (meta.status === "cancelled") return reject(conn, "kelabo_cancelled");
    if (!(await mayAttach(conn, kelaboId, meta))) {
      c.log("attach_denied", { kelaboId, identity: conn.identity });
      return reject(conn, "not_invited");
    }

    const binding = {
      runtime: frame.runtime,
      sessionRef: frame.sessionRef,
      workspace: frame.workspace,
      label: conn.agent.label,
      boundBy: conn.identity,
      boundAt: Date.now(),
    };

    if (meta.status === "scheduled") {
      // Prep only. Never enters tunnelByKelabo, so `caption.js` cannot route
      // transcript here even after the kelabo goes live — attending is a second,
      // deliberate attach.
      c.state.prepByKelabo.set(kelaboId, conn);
      conn.prepKelabos.add(kelaboId);
      c.log("agent_prep_attached", { kelaboId, identity: conn.identity, runtime: frame.runtime });
    } else {
      c.state.promotedByKelabo.set(kelaboId, binding);
      c.state.tunnelByKelabo.set(kelaboId, conn);
      conn.kelabos.add(kelaboId);
      // A prep binding on the same connection is now redundant.
      conn.prepKelabos.delete(kelaboId);
      if (c.state.prepByKelabo.get(kelaboId) === conn) c.state.prepByKelabo.delete(kelaboId);
      try {
        await putPromotion(c, kelaboId, binding);
        await updateMeta(c, kelaboId, {
          mode: "dev",
          isDeveloperPresent: true,
          agentRuntime: frame.runtime,
          agentLabel: conn.agent.label,
        });
      } catch (err) {
        c.logError("attach_persist_failed", err, { kelaboId });
      }
      // Attaching used to be invisible, and so did dropping: a kelabo silently
      // handed itself back to the server agent on the next caption. Both are now
      // events the room can see.
      publishAgentPresence(kelaboId, {
        attached: true,
        runtime: frame.runtime,
        label: conn.agent.label,
        identity: conn.identity,
      });
      c.log("agent_attached", { kelaboId, identity: conn.identity, runtime: frame.runtime });
    }

    await sendBriefing(conn, kelaboId, meta);
  }

  async function sendBriefing(conn, kelaboId, meta) {
    let invitees = [];
    try {
      invitees = (await queryInvites(c, kelaboId)).map((i) => ({
        displayName: i.displayName || i.email || i.inviteKey || "",
        ...(i.email ? { email: i.email } : {}),
        response: i.response || "pending",
        isHost: !!i.isHost,
      }));
    } catch (err) {
      c.logError("briefing_invites_failed", err, { kelaboId });
    }
    sendDown(conn.ws, {
      type: "briefing",
      kelaboId,
      status: meta.status === "scheduled" ? "scheduled" : "active",
      title: meta.title || "",
      host: meta.hostIdentity || "",
      ...(meta.scheduledAt ? { scheduledAt: meta.scheduledAt } : {}),
      ...(meta.durationMinutes ? { durationMinutes: meta.durationMinutes } : {}),
      ...(meta.startedAt ? { startedAt: meta.startedAt } : {}),
      // Host-authored, unlike every other string here. The invitee display names
      // below are guest-controlled, which is why the bridge wraps the whole
      // briefing as untrusted before an agent sees it (docs 16 §6).
      note: meta.note || "",
      invitees,
      participants: (meta.participants || []).map((p) => ({
        identity: p.identity,
        displayName: p.displayName || p.identity,
        isGuest: !!p.isGuest,
      })),
    });
  }

  function reject(conn, reason) {
    sendDown(conn.ws, { type: "rejected", reason });
  }

  async function onContribution(conn, frame) {
    const { kelaboId } = frame;
    const attending = c.state.tunnelByKelabo.get(kelaboId) === conn;
    const preparing = c.state.prepByKelabo.get(kelaboId) === conn;
    if (!attending && !preparing) {
      c.log("contribution_from_unattached", { kelaboId, identity: conn.identity });
      return;
    }
    if (frame.ref) {
      const key = `${kelaboId}:${frame.ref}`;
      if (conn.seenRefs.has(key)) return;
      conn.seenRefs.add(key);
    }
    // A finished card must actually say something. The schema cannot express
    // this (a discriminated-union member is a plain object) and an empty `done`
    // card is the "clear this card" marker the SSE hub already understands, so
    // letting one through here would silently delete the card instead.
    if (frame.status === "done" && !frame.markdown.trim()) {
      c.log("contribution_empty_ignored", { kelaboId, identity: conn.identity });
      return;
    }
    const contribution = {
      id: cardId(conn, kelaboId, frame.card),
      kelaboId,
      tag: "LLM_CON",
      kind: frame.kind === "note" ? "note" : frame.kind,
      title: frame.title || frame.markdown.split("\n")[0].slice(0, 80),
      to: frame.to || "all",
      markdown: frame.markdown,
      ...(frame.sources?.length ? { sources: frame.sources } : {}),
      author: "assistant",
      origin: "local",
      runtime: conn.agent.runtime,
      agentLabel: conn.agent.label,
      status: frame.status,
      ...(frame.progress ? { progress: frame.progress } : {}),
      ...(frame.steps?.length ? { steps: frame.steps } : {}),
      ...(frame.reason ? { reason: frame.reason } : {}),
      at: Date.now(),
    };
    // Prep posts take the same path as live ones: they persist, and there are
    // simply no SSE subscribers yet. They are the same assistant's board post,
    // sitting at the top of the board when the first participant arrives.
    await c.sseHub.publish(kelaboId, contribution);
  }

  /**
   * Resolve the agent's card reference to a contribution id.
   *
   * Scoped to the connection, and never taken from the wire as-is. The id is
   * what the board updates in place, so an agent that could name one could
   * overwrite another agent's card — or one of the in-ECS agent's — on a board
   * it is legitimately attached to. A reference this connection has not used
   * before opens a new card; no reference at all behaves exactly as it did
   * before cards existed.
   */
  function cardId(conn, kelaboId, ref) {
    if (!ref) return randomUUID();
    const key = `${kelaboId}:${ref}`;
    const known = conn.cards.get(key);
    if (known) return known;
    // A long kelabo must not accumulate one entry per lookup forever. Map
    // iterates in insertion order, so the oldest reference is the first out.
    if (conn.cards.size >= MAX_CARDS_PER_CONN) {
      conn.cards.delete(conn.cards.keys().next().value);
    }
    const id = randomUUID();
    conn.cards.set(key, id);
    return id;
  }

  function onResponse(conn, frame) {
    const waiter = pending.get(frame.requestId);
    if (!waiter) {
      c.log("tunnel_response_unmatched", { requestId: frame.requestId, type: frame.type });
      return;
    }
    pending.delete(frame.requestId);
    clearTimeout(waiter.timer);
    waiter.resolve(frame.type === "summary" ? { text: frame.text } : frame.archive);
    c.log("tunnel_response", { requestId: frame.requestId, type: frame.type });
  }

  async function onRename(conn, frame) {
    if (c.state.tunnelByKelabo.get(frame.kelaboId) !== conn) return;
    try {
      await updateMeta(c, frame.kelaboId, { title: frame.title });
      c.log("kelabo_renamed", { kelaboId: frame.kelaboId, title: frame.title });
    } catch (err) {
      c.logError("kelabo_rename_failed", err, { kelaboId: frame.kelaboId });
    }
  }

  async function detach(kelaboId, conn) {
    const wasAttending = c.state.tunnelByKelabo.get(kelaboId) === conn;
    if (wasAttending) {
      c.state.tunnelByKelabo.delete(kelaboId);
      c.state.promotedByKelabo.delete(kelaboId);
    }
    if (c.state.prepByKelabo.get(kelaboId) === conn) c.state.prepByKelabo.delete(kelaboId);
    conn.kelabos.delete(kelaboId);
    conn.prepKelabos.delete(kelaboId);
    if (!wasAttending) return;
    try {
      await updateMeta(c, kelaboId, { isDeveloperPresent: false });
    } catch (err) {
      c.logError("agent_detach_persist_failed", err, { kelaboId });
    }
    publishAgentPresence(kelaboId, {
      attached: false,
      runtime: conn.agent.runtime,
      label: conn.agent.label,
      identity: conn.identity,
    });
    c.log("agent_detached", { kelaboId, identity: conn.identity });
  }

  function publishAgentPresence(kelaboId, payload) {
    try {
      c.sseHub.agent(kelaboId, payload);
    } catch (err) {
      c.logError("agent_presence_publish_failed", err, { kelaboId });
    }
  }

  /** The runtime of the agent currently attending this kelabo, or "" if none.
   *  The single question the rest of the Gateway asks about developer mode —
   *  truthy means "a local agent owns this kelabo", and the value names which
   *  one, which is what `generatedBy` on the minutes reports. */
  function attachedRuntime(kelaboId) {
    const conn = c.state.tunnelByKelabo.get(kelaboId);
    if (!conn || conn.ws.readyState !== 1) return "";
    return conn.agent.runtime || "local";
  }

  /** Send a request the bridge must answer, and wait for the answer bearing the
   *  same requestId. Resolves `null` on timeout or with no attached agent. */
  function ask(kelaboId, kind, timeoutMs) {
    const conn = c.state.tunnelByKelabo.get(kelaboId);
    if (!conn || conn.ws.readyState !== 1) return Promise.resolve(null);
    const requestId = randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(requestId);
        c.log("tunnel_request_timeout", { kelaboId, kind, requestId });
        resolve(null);
      }, timeoutMs);
      timer.unref?.();
      pending.set(requestId, { resolve, timer });
      sendDown(conn.ws, { type: "request", kind, requestId, kelaboId });
    });
  }

  const requestDevSummary = (kelaboId, timeoutMs = SUMMARY_WAIT_MS) =>
    ask(kelaboId, "summary", timeoutMs);

  const requestDevArchive = (kelaboId, timeoutMs = ARCHIVE_WAIT_MS) =>
    ask(kelaboId, "archive", timeoutMs);

  /** Push one sealed speaker message to the attached agent. Called from
   *  `caption.js`, which never looks at `prepByKelabo`. */
  function sendTranscript(kelaboId, utt) {
    const conn = c.state.tunnelByKelabo.get(kelaboId);
    if (!conn || conn.ws.readyState !== 1) return false;
    sendDown(conn.ws, {
      type: "transcript",
      kelaboId,
      messageId: utt.messageId || "",
      seq: utt.seq || 0,
      speaker: utt.speaker,
      text: utt.text,
      at: utt.at ?? Date.now(),
      final: true,
      human: !!utt.human,
    });
    return true;
  }

  /** Serve `kelabo_board`. Over the tunnel rather than the REST board route,
   *  which needs a participant cookie that cannot exist before a kelabo starts —
   *  and reading its own prior posts is exactly what a prep agent needs. */
  async function onBoardRequest(conn, frame) {
    const { kelaboId, requestId } = frame;
    if (c.state.tunnelByKelabo.get(kelaboId) !== conn && c.state.prepByKelabo.get(kelaboId) !== conn) {
      c.log("board_request_from_unattached", { kelaboId, identity: conn.identity });
      return;
    }
    let items = [];
    try {
      items = await queryContrib(c, kelaboId, { limit: BOARD_LIMIT, desc: true });
    } catch (err) {
      c.logError("board_request_failed", err, { kelaboId });
    }
    sendDown(conn.ws, {
      type: "board",
      requestId,
      kelaboId,
      contributions: items.reverse().map((i) => ({
        id: i.id,
        title: i.title || "",
        to: i.to || "all",
        markdown: i.markdown || "",
        author: i.author || "assistant",
        at: i.at || 0,
      })),
    });
  }

  /** Serve `kelabo_history`: the minutes of the host's past kelabos, behind
   *  the same host opt-in (`historyEnabled`) that feeds the in-ECS agent's
   *  memory — the tunnel hands out the record the host already granted, never
   *  more. `enabled:false` is a real answer, not an error: the agent should be
   *  able to tell the developer "the host has not shared history" rather than
   *  guessing between off and empty. */
  async function onHistoryRequest(conn, frame) {
    const { kelaboId, requestId } = frame;
    if (c.state.tunnelByKelabo.get(kelaboId) !== conn && c.state.prepByKelabo.get(kelaboId) !== conn) {
      c.log("history_request_from_unattached", { kelaboId, identity: conn.identity });
      return;
    }
    const meta = await getMeta(c, kelaboId).catch(() => null);
    if (!meta?.historyEnabled) {
      sendDown(conn.ws, { type: "history", requestId, kelaboId, enabled: false, entries: [] });
      return;
    }
    let entries = [];
    try {
      entries = await loadKelaboHistory(c, kelaboId, meta);
    } catch (err) {
      // Best-effort like the in-ECS path: a kelabo whose history lookup failed
      // is a normal kelabo, not a broken one.
      c.logError("history_request_failed", err, { kelaboId });
    }
    sendDown(conn.ws, { type: "history", requestId, kelaboId, enabled: true, entries });
  }

  /** Same attachment check `onBoardRequest`/`onHistoryRequest` already
   *  inline — factored out for the five journey handlers below, which all
   *  need it, without touching those two's already-tested bodies. */
  function attachedOrPreparing(conn, kelaboId) {
    return c.state.tunnelByKelabo.get(kelaboId) === conn || c.state.prepByKelabo.get(kelaboId) === conn;
  }

  /** Serve `kelabo_journey_info` (docs 20 §12.2). */
  async function onJourneyInfoRequest(conn, frame) {
    const { kelaboId, requestId, journeyId } = frame;
    if (!attachedOrPreparing(conn, kelaboId)) {
      c.log("journey_info_request_from_unattached", { kelaboId, identity: conn.identity });
      return;
    }
    const resolution = await resolveJourneyForKelabo(c, kelaboId, journeyId).catch((err) => {
      c.logError("journey_info_resolve_failed", err, { kelaboId });
      return { resolved: "no_journey", journeys: [] };
    });
    if (resolution.resolved !== "ok") {
      sendDown(conn.ws, { type: "journey_info", requestId, kelaboId, ...resolution });
      return;
    }
    const meta = await getJourneyMeta(c, resolution.journeyId).catch(() => null);
    if (!meta) {
      sendDown(conn.ws, { type: "journey_info", requestId, kelaboId, resolved: "journey_not_found", journeys: [] });
      return;
    }
    const description = await latestDescription(c, resolution.journeyId).catch(() => "");
    sendDown(conn.ws, {
      type: "journey_info",
      requestId,
      kelaboId,
      resolved: "ok",
      journeys: [],
      journeyId: meta.journeyId,
      title: meta.title || "",
      visibility: meta.visibility,
      status: meta.status,
      description,
      health: meta.health ?? null,
      progress: typeof meta.progress === "number" ? meta.progress : null,
      counts: {
        kelaboCount: meta.kelaboCount || 0,
        documentCount: meta.documentCount || 0,
        reportCount: meta.reportCount || 0,
        boardMessageCount: meta.boardMessageCount || 0,
        accessorCount: meta.accessorCount || 0,
      },
    });
  }

  /** Serve `kelabo_journey_timeline` (docs 20 §9.2, §12.2). */
  async function onJourneyTimelineRequest(conn, frame) {
    const { kelaboId, requestId, journeyId, entryType, before, limit } = frame;
    if (!attachedOrPreparing(conn, kelaboId)) {
      c.log("journey_timeline_request_from_unattached", { kelaboId, identity: conn.identity });
      return;
    }
    const resolution = await resolveJourneyForKelabo(c, kelaboId, journeyId).catch((err) => {
      c.logError("journey_timeline_resolve_failed", err, { kelaboId });
      return { resolved: "no_journey", journeys: [] };
    });
    if (resolution.resolved !== "ok") {
      sendDown(conn.ws, { type: "journey_timeline", requestId, kelaboId, ...resolution, entries: [] });
      return;
    }
    let entries = [];
    try {
      entries = await queryJourneyTimeline(c, resolution.journeyId, { type: entryType, before, limit: limit || 20 });
    } catch (err) {
      c.logError("journey_timeline_query_failed", err, { kelaboId, journeyId: resolution.journeyId });
    }
    const nextBefore = entries.length ? entries[entries.length - 1].at : undefined;
    sendDown(conn.ws, {
      type: "journey_timeline",
      requestId,
      kelaboId,
      resolved: "ok",
      journeys: [],
      entries: entries.map((e) => ({ type: e.type, summary: e.summary || "", ...(e.actor ? { actor: e.actor } : {}), at: e.at })),
      ...(nextBefore !== undefined ? { nextBefore } : {}),
    });
  }

  /** Serve `kelabo_journey_board` (docs 20 §12.2) — the journey's pinned
   *  board, distinct from this kelabo's own (`onBoardRequest`, above). */
  async function onJourneyBoardRequest(conn, frame) {
    const { kelaboId, requestId, journeyId } = frame;
    if (!attachedOrPreparing(conn, kelaboId)) {
      c.log("journey_board_request_from_unattached", { kelaboId, identity: conn.identity });
      return;
    }
    const resolution = await resolveJourneyForKelabo(c, kelaboId, journeyId).catch((err) => {
      c.logError("journey_board_resolve_failed", err, { kelaboId });
      return { resolved: "no_journey", journeys: [] };
    });
    if (resolution.resolved !== "ok") {
      sendDown(conn.ws, { type: "journey_board", requestId, kelaboId, ...resolution, messages: [] });
      return;
    }
    let heads = [];
    try {
      heads = await activeBoardMessages(c, resolution.journeyId, JOURNEY_BOARD_LIMIT);
    } catch (err) {
      c.logError("journey_board_query_failed", err, { kelaboId, journeyId: resolution.journeyId });
    }
    sendDown(conn.ws, {
      type: "journey_board",
      requestId,
      kelaboId,
      resolved: "ok",
      journeys: [],
      messages: heads.map((m) => ({
        msgId: m.msgId,
        content: m.content || "",
        ...(m.createdBy ? { createdBy: m.createdBy } : {}),
        ...(m.createdAt ? { createdAt: m.createdAt } : {}),
      })),
    });
  }

  /** Serve `kelabo_journey_report_submit` (docs 20 §12.2) — the agent's own
   *  synthesis, stored directly with no LLM round trip. */
  async function onJourneyReportSubmit(conn, frame) {
    const { kelaboId, requestId, journeyId, question, answer } = frame;
    if (!attachedOrPreparing(conn, kelaboId)) {
      c.log("journey_report_submit_from_unattached", { kelaboId, identity: conn.identity });
      return;
    }
    const resolution = await resolveJourneyForKelabo(c, kelaboId, journeyId).catch((err) => {
      c.logError("journey_report_resolve_failed", err, { kelaboId });
      return { resolved: "no_journey", journeys: [] };
    });
    if (resolution.resolved !== "ok") {
      sendDown(conn.ws, { type: "journey_report_submitted", requestId, kelaboId, ...resolution });
      return;
    }
    try {
      const { reportId } = await submitJourneyReport(c, resolution.journeyId, {
        reportId: randomUUID(),
        question,
        answer,
        identity: conn.identity,
      });
      sendDown(conn.ws, { type: "journey_report_submitted", requestId, kelaboId, resolved: "ok", journeys: [], reportId });
    } catch (err) {
      c.logError("journey_report_submit_failed", err, { kelaboId, journeyId: resolution.journeyId });
      sendDown(conn.ws, { type: "journey_report_submitted", requestId, kelaboId, resolved: "journey_not_found", journeys: [] });
    }
  }

  /** Serve `kelabo_journey_post` (docs 20 §7, §12.2) — write or edit a pinned
   *  journey board message, gated by the owner-controlled `aiCanPost`. */
  async function onJourneyPost(conn, frame) {
    const { kelaboId, requestId, journeyId, content, msgId } = frame;
    if (!attachedOrPreparing(conn, kelaboId)) {
      c.log("journey_post_from_unattached", { kelaboId, identity: conn.identity });
      return;
    }
    const resolution = await resolveJourneyForKelabo(c, kelaboId, journeyId).catch((err) => {
      c.logError("journey_post_resolve_failed", err, { kelaboId });
      return { resolved: "no_journey", journeys: [] };
    });
    if (resolution.resolved !== "ok") {
      sendDown(conn.ws, { type: "journey_posted", requestId, kelaboId, ...resolution });
      return;
    }
    const meta = await getJourneyMeta(c, resolution.journeyId).catch(() => null);
    if (!meta) {
      sendDown(conn.ws, { type: "journey_posted", requestId, kelaboId, resolved: "journey_not_found", journeys: [] });
      return;
    }
    // The one owner-controlled permission gate in this whole tool surface
    // (docs 20 §7/§12.2) — off by default, the same justification
    // `historyEnabled` already carries: a human-curated, always-visible
    // surface being edited unsupervised by an agent is a decision an owner
    // has to make, not a default. Refused explicitly — a real answer, the
    // same shape `history`'s `enabled:false` already uses — never a silently
    // dropped write.
    if (!meta.aiCanPost) {
      sendDown(conn.ws, { type: "journey_posted", requestId, kelaboId, resolved: "ai_posting_disabled", journeys: [] });
      return;
    }
    try {
      const result = await postJourneyBoardMessage(c, resolution.journeyId, { content, msgId, identity: conn.identity });
      if (!result.ok) {
        sendDown(conn.ws, {
          type: "journey_posted",
          requestId,
          kelaboId,
          resolved: result.reason === "already_archived" ? "already_archived" : "message_not_found",
          journeys: [],
        });
        return;
      }
      sendDown(conn.ws, {
        type: "journey_posted",
        requestId,
        kelaboId,
        resolved: "ok",
        journeys: [],
        msgId: result.msgId,
        version: result.version,
      });
    } catch (err) {
      c.logError("journey_post_failed", err, { kelaboId, journeyId: resolution.journeyId });
      sendDown(conn.ws, { type: "journey_posted", requestId, kelaboId, resolved: "journey_not_found", journeys: [] });
    }
  }

  function notifyKelabo(kelaboId, event, extra = {}) {
    for (const conn of [c.state.tunnelByKelabo.get(kelaboId), c.state.prepByKelabo.get(kelaboId)]) {
      if (conn && conn.ws.readyState === 1) {
        sendDown(conn.ws, { type: "kelabo", kelaboId, event, ...extra });
      }
    }
  }

  async function endTunnel(kelaboId) {
    notifyKelabo(kelaboId, "ended");
    const conn = c.state.tunnelByKelabo.get(kelaboId);
    // The socket deliberately stays open: the bridge may still be composing the
    // minutes, and closing it here is how the previous implementation lost them.
    if (conn) await detach(kelaboId, conn);
  }

  return {
    handleUpgrade,
    sendDown,
    sendTranscript,
    attachedRuntime,
    notifyKelabo,
    requestDevSummary,
    requestDevArchive,
    endTunnel,
    isRigPath: (url) => url === "/rig",
  };
}
