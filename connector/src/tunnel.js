// The bridge half of the Kelabo Agent Protocol (docs 16 §2.A).
//
// Knows nothing about coding agents: it moves frames, reconnects, and replays
// the current attachment after a reconnect. What to do with a transcript frame
// is the binding's problem, and how to inject it is the adapter's.
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import { parseDownFrame } from "@kelabo/contracts";
import { BRIDGE_VERSION as VERSION } from "./version.js";

export function createTunnel({
  gatewayUrl,
  getToken,
  agent,
  heartbeatMs = 30000,
  reconnectMaxMs = 60000,
  log = () => {},
  WebSocketImpl = WebSocket,
}) {
  const bus = new EventEmitter();
  let ws = null;
  let attempts = 0;
  let stopped = false;
  let heartbeat = null;
  // What we are attached to, so a reconnect restores it without the developer
  // re-running /kstart. The Gateway's state is in-process and does not survive a
  // restart either, so re-announcing is the only thing that makes a dropped
  // socket a non-event.
  let attachment = null;
  // Journeys this session attached to directly (docs 20 §12.3),
  // journeyId -> title. Replayed after a reconnect for the same reason as
  // `attachment`; independent of it — either, both or neither may be set.
  const journeyAttachments = new Map();
  // requestId -> resolve, for board reads.
  const pending = new Map();

  function send(frame) {
    if (!ws || ws.readyState !== 1) return false;
    try {
      ws.send(JSON.stringify(frame));
      return true;
    } catch (err) {
      log("send_failed", { error: err.message });
      return false;
    }
  }

  async function connect() {
    if (stopped) return;
    let token;
    try {
      token = await getToken();
    } catch (err) {
      bus.emit("error", err);
      return scheduleReconnect();
    }
    if (!token) {
      bus.emit("error", new Error("not_paired"));
      return scheduleReconnect();
    }
    ws = new WebSocketImpl(`${gatewayUrl}/rig`);

    ws.on("open", () => {
      send({ type: "register", token, agent: { ...agent, version: VERSION } });
    });

    ws.on("message", (raw) => {
      const parsed = parseDownFrame(raw);
      if (!parsed.ok) {
        log("bad_frame", { error: parsed.error });
        return;
      }
      onFrame(parsed.frame);
    });

    ws.on("close", () => {
      clearInterval(heartbeat);
      heartbeat = null;
      bus.emit("disconnected");
      if (!stopped) scheduleReconnect();
    });

    ws.on("error", (err) => log("socket_error", { error: err.message }));
  }

  function onFrame(frame) {
    switch (frame.type) {
      case "registered":
        attempts = 0;
        clearInterval(heartbeat);
        heartbeat = setInterval(() => send({ type: "heartbeat" }), heartbeatMs);
        heartbeat.unref?.();
        bus.emit("registered", frame);
        if (attachment) send({ type: "attach", ...attachment });
        // Replayed fire-and-forget: the re-attach either lands (the Gateway
        // re-authorizes it) or the next journey tool call surfaces the loss.
        // The briefing each replay produces resolves no waiter and is dropped.
        for (const journeyId of journeyAttachments.keys()) {
          send({ type: "journey_attach", requestId: randomUUID(), journeyId });
        }
        return;
      case "rejected":
        // A rejected registration is terminal — a revoked or malformed token
        // will not become valid by trying again in a minute.
        bus.emit("rejected", frame);
        if (frame.reason === "invalid_token" || frame.reason === "agent_token_revoked") stop();
        return;
      case "board": {
        const resolve = pending.get(frame.requestId);
        if (resolve) {
          pending.delete(frame.requestId);
          resolve(frame.contributions);
        }
        return;
      }
      case "history":
      case "journey_info":
      case "journey_briefing":
      case "journey_context":
      case "journey_kelabos":
      case "journey_documents":
      case "journey_reports":
      case "journey_timeline":
      case "journey_board":
      case "journey_report_submitted":
      case "journey_posted": {
        // Resolved with the whole frame in every one of these, not a
        // sub-field: `enabled` on `history` and `resolved` on the journey
        // frames matter as much as the payload (opted-out vs. empty; no
        // journey vs. ambiguous vs. the answer itself).
        const resolve = pending.get(frame.requestId);
        if (resolve) {
          pending.delete(frame.requestId);
          resolve(frame);
        }
        return;
      }
      default:
        bus.emit(frame.type, frame);
    }
  }

  function scheduleReconnect() {
    if (stopped) return;
    const delay = Math.min(1000 * 2 ** attempts, reconnectMaxMs);
    attempts += 1;
    const t = setTimeout(connect, delay);
    t.unref?.();
  }

  function attach(info) {
    attachment = info;
    return send({ type: "attach", ...info });
  }

  function detach() {
    const kelaboId = attachment?.kelaboId;
    attachment = null;
    if (kelaboId) send({ type: "detach", kelaboId });
    return kelaboId;
  }

  function requestBoard(kelaboId, timeoutMs = 10000) {
    const requestId = randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(requestId);
        resolve([]);
      }, timeoutMs);
      timer.unref?.();
      pending.set(requestId, (v) => {
        clearTimeout(timer);
        resolve(v);
      });
      if (!send({ type: "board_request", requestId, kelaboId })) {
        pending.delete(requestId);
        clearTimeout(timer);
        resolve([]);
      }
    });
  }

  // Null on timeout or a dead socket — unlike the board's [], because "no
  // answer" and "the host shares nothing" must read differently to the agent.
  function requestHistory(kelaboId, timeoutMs = 10000) {
    const requestId = randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(requestId);
        resolve(null);
      }, timeoutMs);
      timer.unref?.();
      pending.set(requestId, (v) => {
        clearTimeout(timer);
        resolve(v);
      });
      if (!send({ type: "history_request", requestId, kelaboId })) {
        pending.delete(requestId);
        clearTimeout(timer);
        resolve(null);
      }
    });
  }

  /** Shared request/response shape for every `journey_*` tool (docs 20
   *  §12.2) — mint a requestId, track it in `pending` exactly like
   *  `requestBoard`/`requestHistory` above, resolve with the whole frame
   *  (never a sub-field) on arrival, `null` on timeout or a dead socket.
   *  A falsy `kelaboId` is omitted from the wire (docs 20 §12.3): the
   *  Gateway then resolves against this connection's direct journey
   *  attachments instead of a kelabo's links. */
  function requestJourney(upType, kelaboId, extra = {}, timeoutMs = 10000) {
    const requestId = randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(requestId);
        resolve(null);
      }, timeoutMs);
      timer.unref?.();
      pending.set(requestId, (v) => {
        clearTimeout(timer);
        resolve(v);
      });
      if (!send({ type: upType, requestId, ...(kelaboId ? { kelaboId } : {}), ...extra })) {
        pending.delete(requestId);
        clearTimeout(timer);
        resolve(null);
      }
    });
  }

  /** Attach to a journey directly (docs 20 §12.3). Resolves with the
   *  `journey_briefing` frame, `null` on timeout — the attachment is only
   *  remembered for reconnect replay when the Gateway said "ok". */
  async function attachJourney(journeyId, timeoutMs = 10000) {
    const frame = await requestJourney("journey_attach", "", { journeyId }, timeoutMs);
    if (frame?.resolved === "ok") journeyAttachments.set(journeyId, frame.title || "");
    return frame;
  }

  /** Detach from one journey, or every journey when none is named. Returns
   *  the journeyIds detached from. */
  function detachJourney(journeyId) {
    const ids = journeyId ? (journeyAttachments.has(journeyId) ? [journeyId] : []) : [...journeyAttachments.keys()];
    for (const id of ids) journeyAttachments.delete(id);
    if (ids.length) send({ type: "journey_detach", ...(journeyId ? { journeyId } : {}) });
    return ids;
  }

  const requestJourneyInfo = (kelaboId, journeyId) =>
    requestJourney("journey_info_request", kelaboId, journeyId ? { journeyId } : {});

  const requestJourneyTimeline = (kelaboId, { journeyId, entryType, before, limit } = {}) =>
    requestJourney("journey_timeline_request", kelaboId, {
      ...(journeyId ? { journeyId } : {}),
      ...(entryType ? { entryType } : {}),
      ...(typeof before === "number" ? { before } : {}),
      ...(typeof limit === "number" ? { limit } : {}),
    });

  const requestJourneyBoard = (kelaboId, journeyId) =>
    requestJourney("journey_board_request", kelaboId, journeyId ? { journeyId } : {});

  const requestJourneyContext = (kelaboId, journeyId) =>
    requestJourney("journey_context_request", kelaboId, journeyId ? { journeyId } : {});

  const requestJourneyKelabos = (kelaboId, journeyId) =>
    requestJourney("journey_kelabos_request", kelaboId, journeyId ? { journeyId } : {});

  const requestJourneyDocuments = (kelaboId, { journeyId, docId } = {}) =>
    requestJourney("journey_documents_request", kelaboId, {
      ...(journeyId ? { journeyId } : {}),
      ...(docId ? { docId } : {}),
    });

  const requestJourneyReports = (kelaboId, { journeyId, reportId } = {}) =>
    requestJourney("journey_reports_request", kelaboId, {
      ...(journeyId ? { journeyId } : {}),
      ...(reportId ? { reportId } : {}),
    });

  const submitJourneyReport = (kelaboId, { journeyId, question, answer } = {}) =>
    requestJourney("journey_report_submit", kelaboId, { ...(journeyId ? { journeyId } : {}), question, answer });

  const postJourneyMessage = (kelaboId, { journeyId, content, msgId } = {}) =>
    requestJourney("journey_post", kelaboId, { ...(journeyId ? { journeyId } : {}), content, ...(msgId ? { msgId } : {}) });

  function stop() {
    stopped = true;
    clearInterval(heartbeat);
    try {
      ws?.close();
    } catch {}
  }

  return Object.assign(bus, {
    connect,
    send,
    attach,
    detach,
    attachJourney,
    detachJourney,
    requestBoard,
    requestHistory,
    requestJourneyInfo,
    requestJourneyTimeline,
    requestJourneyBoard,
    requestJourneyContext,
    requestJourneyKelabos,
    requestJourneyDocuments,
    requestJourneyReports,
    submitJourneyReport,
    postJourneyMessage,
    stop,
    attachedKelabo: () => attachment?.kelaboId || "",
    attachedJourneys: () => [...journeyAttachments].map(([journeyId, title]) => ({ journeyId, title })),
    isConnected: () => ws?.readyState === 1,
  });
}
