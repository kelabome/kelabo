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
  queryKelaboItems,
  isAgentTokenRevoked,
} from "./db.js";
import {
  getJourneyMeta,
  latestDescription,
  activeBoardMessages,
  activeDocuments,
  linkedKelaboSummaries,
  listReadyReports,
  getJourneyDocument,
  getJourneyReport,
  resolveJourneyAccess,
  queryJourneyLinks,
  resolveJourneyForKelabo,
  queryJourneyTimeline,
  submitJourneyReport,
  postJourneyBoardMessage,
  clip,
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
// Per-message clip for that dedicated read. Roomier than the bundle's 500
// (a deliberate board read wants the note, not a teaser) but bounded: the
// write cap is 4,000 per message, and 20 × 4,000 unclipped was the one
// tool response that could dwarf every other budget on this surface.
const JOURNEY_BOARD_CLIP = 2000;
// kelabo_journey_info returns the description in full spirit but not in
// full 20,000-char write-cap glory — the same 4,000 the context bundle
// allows. The description is prose about the journey, not a document; the
// documents tool is the unbounded read, deliberately, one item at a time.
const JOURNEY_INFO_DESCRIPTION_CLIP = 4000;
// The pull-tool list budgets (docs 20 §12.3). Same posture as
// JOURNEY_BOARD_LIMIT: generous for a deliberate read, never unbounded.
const JOURNEY_KELABOS_LIMIT = 20;
const JOURNEY_DOCUMENTS_LIMIT = 50;
const JOURNEY_REPORTS_LIMIT = 20;
// `journey_context` is the one-call bundle — the same shape the in-ECS
// agent's per-turn push gets (agent/journeyContext.js), with the report
// pipeline's slightly roomier clips (journeys.js buildContext): a pull
// happens once, on demand, not on every turn.
const CONTEXT_DESCRIPTION_CLIP = 4000;
const CONTEXT_BOARD_LIMIT = 10;
const CONTEXT_BOARD_CLIP = 500;
const CONTEXT_DOCUMENTS_LIMIT = 5;
const CONTEXT_DOCUMENT_EXCERPT = 800;
const CONTEXT_REPORTS_LIMIT = 3;
const CONTEXT_REPORT_QUESTION_CLIP = 200;
const CONTEXT_REPORT_ANSWER_CLIP = 1000;
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
      // Journeys this connection is attached to directly (docs 20 §12.3),
      // journeyId -> title. Per-connection only — nothing routes *to* a
      // journey attachment the way transcript routes to `tunnelByKelabo`, so
      // no global map exists and a closed socket cleans itself up.
      journeys: new Map(),
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
      case "journey_attach":
        return onJourneyAttach(conn, frame);
      case "journey_detach":
        return onJourneyDetach(conn, frame);
      case "journey_info_request":
        return onJourneyInfoRequest(conn, frame);
      case "journey_context_request":
        return onJourneyContextRequest(conn, frame);
      case "journey_kelabos_request":
        return onJourneyKelabosRequest(conn, frame);
      case "journey_documents_request":
        return onJourneyDocumentsRequest(conn, frame);
      case "journey_reports_request":
        return onJourneyReportsRequest(conn, frame);
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
    // Journey membership (docs 20 §12.3) — the same `JOURNEY#` mirror rows
    // agent/journeyContext.js reads. Names only: the agent learns there is
    // journey context worth pulling, not the context itself.
    let journeys = [];
    try {
      journeys = (await queryKelaboItems(c, kelaboId, "JOURNEY#")).map((l) => ({
        journeyId: l.journeyId,
        title: l.journeyTitleSnapshot || "Untitled journey",
      }));
    } catch (err) {
      c.logError("briefing_journeys_failed", err, { kelaboId });
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
      journeys,
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
   *  same requestId. Resolves `null` on timeout or with no attached agent.
   *  `extra` carries optional request fields (frameRequestSchema). */
  function ask(kelaboId, kind, timeoutMs, extra = {}) {
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
      sendDown(conn.ws, { type: "request", kind, requestId, kelaboId, ...extra });
    });
  }

  // `language` (an English language name, from the host's settings) rides the
  // summary request so dev-mode minutes follow the same language rule as
  // server-mode ones — before this the frame carried no hint and the language
  // of a dev-mode record was whatever the developer's model picked.
  const requestDevSummary = (kelaboId, { language = "", timeoutMs = SUMMARY_WAIT_MS } = {}) =>
    ask(kelaboId, "summary", timeoutMs, language ? { language } : {});

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
   *  inline — factored out for the journey handlers below, which all
   *  need it, without touching those two's already-tested bodies. */
  function attachedOrPreparing(conn, kelaboId) {
    return c.state.tunnelByKelabo.get(kelaboId) === conn || c.state.prepByKelabo.get(kelaboId) === conn;
  }

  // --- direct journey attachment (docs 20 §12.3) ----------------------------

  /**
   * Whether this identity may attach to the journey directly — the same
   * access rule rest-api's `resolveAccess` applies to every journey read
   * (docs 20 §3.2), never widened: owner, or same-tenant on a public journey,
   * or on a private journey's `ACCESSOR#` roster. Being host or invitee of a
   * *linked kelabo* is deliberately not enough: that grant is kelabo-scoped
   * and already served by attaching to the kelabo.
   *
   * The rule itself lives in `journeys.js` as `resolveJourneyAccess`, shared
   * with the journey channel's HTTP handlers (docs 20 §19) — an agent over
   * `/rig` and a member over HTTP are the same question asked by two
   * credentials, and this used to be the only copy of the answer.
   */
  async function mayAttachJourney(conn, meta) {
    const role = await resolveJourneyAccess(c, meta, { identity: conn.identity, tenant: conn.tenant });
    return role !== "none";
  }

  /**
   * Serve `journey_attach` (docs 20 §12.3): bind this connection to a journey
   * with no kelabo involved. No transcript ever flows from this — the
   * attachment only widens which journeys the `journey_*` requests below may
   * resolve to. A journey in another tenant answers `journey_not_found`, not
   * `not_journey_member`, so an id cannot be probed for existence.
   */
  async function onJourneyAttach(conn, frame) {
    const { requestId, journeyId } = frame;
    const meta = await getJourneyMeta(c, journeyId).catch((err) => {
      c.logError("journey_attach_meta_failed", err, { journeyId });
      return null;
    });
    if (!meta || (meta.tenantId && conn.tenant && meta.tenantId !== conn.tenant)) {
      sendDown(conn.ws, { type: "journey_briefing", requestId, resolved: "journey_not_found" });
      return;
    }
    if (!(await mayAttachJourney(conn, meta))) {
      c.log("journey_attach_denied", { journeyId, identity: conn.identity });
      sendDown(conn.ws, { type: "journey_briefing", requestId, resolved: "not_journey_member" });
      return;
    }
    conn.journeys.set(journeyId, meta.title || "");
    c.log("agent_journey_attached", { journeyId, identity: conn.identity, runtime: conn.agent.runtime });
    await sendJourneyBriefing(conn, requestId, meta);
  }

  /** The journey briefing — for a direct attachment this is the whole of the
   *  agent's starting context, the role `sendBriefing` plays for a kelabo. */
  async function sendJourneyBriefing(conn, requestId, meta) {
    const journeyId = meta.journeyId;
    const [description, links] = await Promise.all([
      latestDescription(c, journeyId).catch(() => ""),
      queryJourneyLinks(c, journeyId).catch(() => []),
    ]);
    sendDown(conn.ws, {
      type: "journey_briefing",
      requestId,
      resolved: "ok",
      journeyId,
      title: meta.title || "",
      visibility: meta.visibility,
      status: meta.status,
      description: clip(description, CONTEXT_DESCRIPTION_CLIP),
      health: meta.health ?? null,
      progress: typeof meta.progress === "number" ? meta.progress : null,
      aiCanPost: !!meta.aiCanPost,
      counts: {
        kelaboCount: meta.kelaboCount || 0,
        documentCount: meta.documentCount || 0,
        reportCount: meta.reportCount || 0,
        boardMessageCount: meta.boardMessageCount || 0,
        accessorCount: meta.accessorCount || 0,
      },
      kelabos: links.map((l) => ({
        kelaboId: l.kelaboId,
        title: l.titleSnapshot || "Untitled kelabo",
        ...(l.linkedAt ? { linkedAt: l.linkedAt } : {}),
      })),
    });
  }

  function onJourneyDetach(conn, frame) {
    const ids = frame.journeyId ? [frame.journeyId] : [...conn.journeys.keys()];
    for (const journeyId of ids) {
      if (conn.journeys.delete(journeyId)) {
        c.log("agent_journey_detached", { journeyId, identity: conn.identity });
      }
    }
  }

  /** Resolve against this connection's *direct* journey attachments — the
   *  same ok/no_journey/ambiguous/journey_not_found answers
   *  `resolveJourneyForKelabo` gives for a kelabo's links, so every handler
   *  below renders one shape regardless of which mode the request came from. */
  function resolveDirectJourney(conn, journeyId) {
    if (journeyId) {
      // Not-attached and nonexistent read the same, deliberately.
      if (!conn.journeys.has(journeyId)) return { resolved: "journey_not_found", journeys: [] };
      return { resolved: "ok", journeyId };
    }
    if (conn.journeys.size === 0) return { resolved: "no_journey", journeys: [] };
    if (conn.journeys.size > 1) {
      return {
        resolved: "ambiguous",
        journeys: [...conn.journeys].map(([id, title]) => ({ journeyId: id, title: title || "Untitled journey" })),
      };
    }
    return { resolved: "ok", journeyId: conn.journeys.keys().next().value };
  }

  /**
   * One answer to "which journey does this request mean" for every
   * `journey_*` handler (docs 20 §12.3), across both modes:
   *
   *   * `kelaboId` present — the kelabo path, exactly as before: the caller
   *     must be attached to (or preparing for) that kelabo, and the journey
   *     resolves against the kelabo's own links. Falls back to the
   *     connection's direct attachments only when the kelabo path found
   *     nothing, so a live kelabo's own journey always wins.
   *   * `kelaboId` absent — the direct path: resolves against the journeys
   *     this connection attached to with `journey_attach`.
   *
   * Returns `null` only for the drop case (naming a kelabo the connection is
   * not attached to) — the caller logs and sends nothing, exactly what the
   * per-handler attachment checks did before.
   */
  async function resolveJourneyRequest(conn, frame) {
    const { kelaboId, journeyId } = frame;
    if (kelaboId) {
      if (!attachedOrPreparing(conn, kelaboId)) return null;
      const viaKelabo = await resolveJourneyForKelabo(c, kelaboId, journeyId).catch((err) => {
        c.logError("journey_resolve_failed", err, { kelaboId });
        return { resolved: "no_journey", journeys: [] };
      });
      if (viaKelabo.resolved === "ok") return viaKelabo;
      // An explicit journeyId that is not one of the kelabo's links may still
      // be a journey this connection attached to directly.
      if (journeyId && conn.journeys.has(journeyId)) return { resolved: "ok", journeyId };
      // A kelabo with no links does not blind a session that also holds
      // direct attachments.
      if (viaKelabo.resolved === "no_journey" && conn.journeys.size > 0) {
        return resolveDirectJourney(conn, journeyId);
      }
      return viaKelabo;
    }
    return resolveDirectJourney(conn, journeyId);
  }

  /** Serve `kelabo_journey_info` (docs 20 §12.2). */
  async function onJourneyInfoRequest(conn, frame) {
    const { kelaboId, requestId } = frame;
    const resolution = await resolveJourneyRequest(conn, frame);
    if (!resolution) {
      c.log("journey_info_request_from_unattached", { kelaboId, identity: conn.identity });
      return;
    }
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
      description: clip(description, JOURNEY_INFO_DESCRIPTION_CLIP),
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
    const { kelaboId, requestId, entryType, before, limit } = frame;
    const resolution = await resolveJourneyRequest(conn, frame);
    if (!resolution) {
      c.log("journey_timeline_request_from_unattached", { kelaboId, identity: conn.identity });
      return;
    }
    if (resolution.resolved !== "ok") {
      sendDown(conn.ws, { type: "journey_timeline", requestId, kelaboId, ...resolution, entries: [] });
      return;
    }
    let entries = [];
    try {
      entries = await queryJourneyTimeline(c, resolution.journeyId, {
        type: entryType,
        before,
        limit: limit || 20,
        viewer: conn.identity,
      });
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
    const { kelaboId, requestId } = frame;
    const resolution = await resolveJourneyRequest(conn, frame);
    if (!resolution) {
      c.log("journey_board_request_from_unattached", { kelaboId, identity: conn.identity });
      return;
    }
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
        content: clip(m.content || "", JOURNEY_BOARD_CLIP),
        ...(m.createdBy ? { createdBy: m.createdBy } : {}),
        ...(m.createdAt ? { createdAt: m.createdAt } : {}),
      })),
    });
  }

  /**
   * Serve `kelabo_journey_context` (docs 20 §12.3) — the one-call bundle: the
   * same shape agent/journeyContext.js pushes into the in-ECS agent's system
   * prompt each turn, pulled on demand. Every collection carries an explicit
   * clip; the full text of one document or report is the two handlers below.
   */
  async function onJourneyContextRequest(conn, frame) {
    const { kelaboId, requestId } = frame;
    const resolution = await resolveJourneyRequest(conn, frame);
    if (!resolution) {
      c.log("journey_context_request_from_unattached", { kelaboId, identity: conn.identity });
      return;
    }
    if (resolution.resolved !== "ok") {
      sendDown(conn.ws, { type: "journey_context", requestId, kelaboId, ...resolution });
      return;
    }
    const journeyId = resolution.journeyId;
    const meta = await getJourneyMeta(c, journeyId).catch(() => null);
    if (!meta) {
      sendDown(conn.ws, { type: "journey_context", requestId, kelaboId, resolved: "journey_not_found", journeys: [] });
      return;
    }
    const [description, board, documents, kelabos, reports] = await Promise.all([
      latestDescription(c, journeyId).catch(() => ""),
      activeBoardMessages(c, journeyId, CONTEXT_BOARD_LIMIT).catch(() => []),
      activeDocuments(c, journeyId, CONTEXT_DOCUMENTS_LIMIT).catch(() => []),
      linkedKelaboSummaries(c, journeyId).catch(() => []),
      // Served for this connection's own identity, so a private report
      // (docs 20 §6.4) is in the bundle only when the attached developer is
      // the one who asked it.
      listReadyReports(c, journeyId, CONTEXT_REPORTS_LIMIT, conn.identity).catch(() => []),
    ]);
    sendDown(conn.ws, {
      type: "journey_context",
      requestId,
      kelaboId,
      resolved: "ok",
      journeys: [],
      journeyId,
      title: meta.title || "",
      status: meta.status,
      description: clip(description, CONTEXT_DESCRIPTION_CLIP),
      health: meta.health ?? null,
      progress: typeof meta.progress === "number" ? meta.progress : null,
      aiCanPost: !!meta.aiCanPost,
      board: board.map((m) => ({ content: clip(m.content, CONTEXT_BOARD_CLIP) })),
      documents: documents.map((d) => ({
        docId: d.docId,
        title: d.title || "",
        excerpt: clip(d.content, CONTEXT_DOCUMENT_EXCERPT),
        ...(typeof d.sizeBytes === "number" ? { sizeBytes: d.sizeBytes } : {}),
      })),
      // When the request came through a kelabo, that kelabo's own minutes are
      // not "other kelabos in this journey" — same exclusion the push context
      // applies to the kelabo currently live.
      kelabos: kelabos.filter((k) => k.kelaboId !== kelaboId),
      reports: reports.map((r) => ({
        reportId: r.reportId,
        question: clip(r.question, CONTEXT_REPORT_QUESTION_CLIP),
        answer: clip(r.answer, CONTEXT_REPORT_ANSWER_CLIP),
      })),
    });
  }

  /** Serve `kelabo_journey_kelabos` (docs 20 §12.3): every linked kelabo
   *  reduced to its stored minutes — the same minutes-not-transcripts
   *  reduction `kelabo_history` applies, granted here by journey membership
   *  the way the push context already grants it to the in-ECS agent. */
  async function onJourneyKelabosRequest(conn, frame) {
    const { kelaboId, requestId } = frame;
    const resolution = await resolveJourneyRequest(conn, frame);
    if (!resolution) {
      c.log("journey_kelabos_request_from_unattached", { kelaboId, identity: conn.identity });
      return;
    }
    if (resolution.resolved !== "ok") {
      sendDown(conn.ws, { type: "journey_kelabos", requestId, kelaboId, ...resolution, entries: [] });
      return;
    }
    let entries = [];
    try {
      entries = await linkedKelaboSummaries(c, resolution.journeyId, JOURNEY_KELABOS_LIMIT);
    } catch (err) {
      c.logError("journey_kelabos_query_failed", err, { kelaboId, journeyId: resolution.journeyId });
    }
    sendDown(conn.ws, { type: "journey_kelabos", requestId, kelaboId, resolved: "ok", journeys: [], entries });
  }

  /** Serve `kelabo_journey_documents` (docs 20 §12.3): the list without
   *  content, or one document's full text when `docId` names it. A removed
   *  document is structurally excluded, same rule as everywhere else. */
  async function onJourneyDocumentsRequest(conn, frame) {
    const { kelaboId, requestId, docId } = frame;
    const resolution = await resolveJourneyRequest(conn, frame);
    if (!resolution) {
      c.log("journey_documents_request_from_unattached", { kelaboId, identity: conn.identity });
      return;
    }
    if (resolution.resolved !== "ok") {
      sendDown(conn.ws, { type: "journey_documents", requestId, kelaboId, ...resolution, documents: [] });
      return;
    }
    const journeyId = resolution.journeyId;
    if (docId) {
      const doc = await getJourneyDocument(c, journeyId, docId).catch((err) => {
        c.logError("journey_document_read_failed", err, { kelaboId, journeyId, docId });
        return null;
      });
      if (!doc || doc.removed) {
        sendDown(conn.ws, { type: "journey_documents", requestId, kelaboId, resolved: "document_not_found", journeys: [], documents: [] });
        return;
      }
      sendDown(conn.ws, {
        type: "journey_documents",
        requestId,
        kelaboId,
        resolved: "ok",
        journeys: [],
        documents: [
          {
            docId: doc.docId,
            title: doc.title || "",
            ...(doc.addedBy ? { addedBy: doc.addedBy } : {}),
            ...(doc.addedAt ? { addedAt: doc.addedAt } : {}),
            ...(typeof doc.sizeBytes === "number" ? { sizeBytes: doc.sizeBytes } : {}),
            content: doc.content || "",
          },
        ],
      });
      return;
    }
    let docs = [];
    try {
      docs = await activeDocuments(c, journeyId, JOURNEY_DOCUMENTS_LIMIT);
    } catch (err) {
      c.logError("journey_documents_query_failed", err, { kelaboId, journeyId });
    }
    sendDown(conn.ws, {
      type: "journey_documents",
      requestId,
      kelaboId,
      resolved: "ok",
      journeys: [],
      documents: docs.map((d) => ({
        docId: d.docId,
        title: d.title || "",
        ...(d.addedBy ? { addedBy: d.addedBy } : {}),
        ...(d.addedAt ? { addedAt: d.addedAt } : {}),
        ...(typeof d.sizeBytes === "number" ? { sizeBytes: d.sizeBytes } : {}),
      })),
    });
  }

  /** Serve `kelabo_journey_reports` (docs 20 §12.3): the list of ready
   *  reports without answers, or one report's full question and answer when
   *  `reportId` names it. Pending/failed reports are never served. */
  async function onJourneyReportsRequest(conn, frame) {
    const { kelaboId, requestId, reportId } = frame;
    const resolution = await resolveJourneyRequest(conn, frame);
    if (!resolution) {
      c.log("journey_reports_request_from_unattached", { kelaboId, identity: conn.identity });
      return;
    }
    if (resolution.resolved !== "ok") {
      sendDown(conn.ws, { type: "journey_reports", requestId, kelaboId, ...resolution, reports: [] });
      return;
    }
    const journeyId = resolution.journeyId;
    if (reportId) {
      const report = await getJourneyReport(c, journeyId, reportId, conn.identity).catch((err) => {
        c.logError("journey_report_read_failed", err, { kelaboId, journeyId, reportId });
        return null;
      });
      if (!report || report.status !== "ready") {
        sendDown(conn.ws, { type: "journey_reports", requestId, kelaboId, resolved: "report_not_found", journeys: [], reports: [] });
        return;
      }
      sendDown(conn.ws, {
        type: "journey_reports",
        requestId,
        kelaboId,
        resolved: "ok",
        journeys: [],
        reports: [
          {
            reportId: report.reportId,
            question: report.question || "",
            ...(report.requestedAt ? { requestedAt: report.requestedAt } : {}),
            ...(report.generatedBy ? { generatedBy: report.generatedBy } : {}),
            visibility: report.visibility === "private" ? "private" : "public",
            answer: report.answer || "",
          },
        ],
      });
      return;
    }
    let reports = [];
    try {
      reports = await listReadyReports(c, journeyId, JOURNEY_REPORTS_LIMIT, conn.identity);
    } catch (err) {
      c.logError("journey_reports_query_failed", err, { kelaboId, journeyId });
    }
    sendDown(conn.ws, {
      type: "journey_reports",
      requestId,
      kelaboId,
      resolved: "ok",
      journeys: [],
      reports: reports.map((r) => ({
        reportId: r.reportId,
        question: r.question || "",
        ...(r.requestedAt ? { requestedAt: r.requestedAt } : {}),
        ...(r.generatedBy ? { generatedBy: r.generatedBy } : {}),
        visibility: r.visibility === "private" ? "private" : "public",
      })),
    });
  }

  /** Serve `kelabo_journey_report_submit` (docs 20 §12.2) — the agent's own
   *  synthesis, stored directly with no LLM round trip. */
  async function onJourneyReportSubmit(conn, frame) {
    const { kelaboId, requestId, question, answer } = frame;
    const resolution = await resolveJourneyRequest(conn, frame);
    if (!resolution) {
      c.log("journey_report_submit_from_unattached", { kelaboId, identity: conn.identity });
      return;
    }
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
    const { kelaboId, requestId, content, msgId } = frame;
    const resolution = await resolveJourneyRequest(conn, frame);
    if (!resolution) {
      c.log("journey_post_from_unattached", { kelaboId, identity: conn.identity });
      return;
    }
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
