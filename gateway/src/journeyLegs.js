// The journey legs' HTTP surface (docs 20 §19) — list and create legs,
// post, page, edit, delete, pin, and advance a read cursor.
//
// Why these live on the Gateway and not in rest-api, which owns every other
// journey route: this is the per-message hot path, and it is the same split
// the kelabo already makes. Captions POST here; kelabos are created over
// there. What stays in rest-api is the journey *list*, because that is where
// the three-bucket discovery query and its two GSIs already are.
//
// Authenticated by the browser SESSION cookie, like `/presence/stream` and
// unlike everything else on this server — a journey has no participant
// cookie, no join link and no guests. Membership is a property of the
// identity, resolved by `resolveJourneyAccess`, which the `/rig` tunnel
// shares.
import {
  addressesAssistant,
  cursorsByLeg,
  journeyMessageBodySchema,
  journeyLegBodySchema,
  journeyReadBodySchema,
  legUnread,
  COOKIE_SESSION,
} from "@kelabo/contracts";
import { parseCookies, verifySessionCookie } from "./cookies.js";
import { readJson, send } from "./caption.js";
import {
  getJourneyMeta,
  resolveJourneyAccess,
  listJourneyLegs,
  createJourneyLeg,
  ensureDefaultLeg,
  getJourneyLeg,
  renameJourneyLeg,
  putJourneyMessage,
  queryJourneyMessages,
  editJourneyMessage,
  deleteJourneyMessage,
  pinJourneyMessage,
  resolveJourneyMentions,
  answerJourneyMention,
  getJourneyReadCursor,
  listJourneyReadCursors,
  advanceJourneyReadCursor,
  MESSAGE_PAGE_LIMIT,
} from "./journeys.js";

/**
 * `/journeys/<id>/legs[/<legId>[/messages[/<msgId>[/pin]]|/read]]`.
 *
 * Matched as one pattern because CORS and routing must agree about which
 * requests are covered, and a second regex is a second thing to keep in step.
 * Ids are path segments, which is why a message id uses a hyphen rather than
 * the `#` every other sort key in the partition uses.
 */
export const JOURNEY_LEGS_PATH =
  /^\/journeys\/([^/]+)\/legs(?:\/([^/]+))?(?:\/(messages|read))?(?:\/([^/]+))?(\/pin)?$/;

/**
 * Resolve the caller and their access in one step, or write the response and
 * return null.
 *
 * A journey the caller may not read answers 404, never 403: `journey_not_found`
 * and "not yours" are the same answer, so an id cannot be probed for existence
 * by watching which error comes back. This is the rule `onJourneyAttach`
 * already applies on the tunnel, applied here for the same reason.
 */
async function authorize(c, req, res, journeyId, { needWrite }) {
  const cookies = parseCookies(req);
  const key = await c.getCookieKey();
  const session = verifySessionCookie(cookies[COOKIE_SESSION], key);
  if (!session) {
    send(res, 401, { error: "unauthenticated" });
    return null;
  }

  const meta = await getJourneyMeta(c, journeyId).catch((err) => {
    c.logError("journey_chat_meta_failed", err, { journeyId });
    return null;
  });
  const role = await resolveJourneyAccess(c, meta, {
    identity: session.identity,
    tenant: session.tenantId,
  });
  if (role === "none") {
    send(res, 404, { error: "journey_not_found" });
    return null;
  }

  // A completed journey is frozen for writes and open for reads — the same
  // `requireActive` rule rest-api applies to every other journey write. This
  // is the whole of "the context stays available as long as it has not
  // ended": completing a journey closes its legs, and reopening it opens
  // them back up, with nothing archived or moved in between.
  if (needWrite && meta.status === "completed") {
    send(res, 409, { error: "journey_completed" });
    return null;
  }

  return { session, meta, role };
}

export async function handleJourneyLegs(c, req, res, match, url) {
  const [, journeyId, legId, kind, msgId, pin] = match;
  const method = req.method;

  if (!legId) {
    if (method === "GET") return getLegs(c, req, res, journeyId);
    if (method === "POST") return postLeg(c, req, res, journeyId);
    return send(res, 404, { error: "not_found" });
  }
  if (!kind) {
    if (method === "PATCH") return patchLeg(c, req, res, journeyId, legId);
    return send(res, 404, { error: "not_found" });
  }
  // `/read` takes no sub-path. Without the guard `POST …/read/pin` would fall
  // through and quietly act as a mark-read.
  if (kind === "read") {
    if (method !== "POST" || msgId || pin) return send(res, 404, { error: "not_found" });
    return postRead(c, req, res, journeyId, legId);
  }
  if (method === "POST" && msgId && pin) return pinMessage(c, req, res, journeyId, legId, msgId);
  if (pin) return send(res, 404, { error: "not_found" });
  if (method === "GET" && !msgId) return getMessages(c, req, res, journeyId, legId, url);
  if (method === "POST" && !msgId) return postMessage(c, req, res, journeyId, legId);
  if (method === "PATCH" && msgId) return patchMessage(c, req, res, journeyId, legId, msgId);
  if (method === "DELETE" && msgId) return deleteMessage(c, req, res, journeyId, legId, msgId);
  return send(res, 404, { error: "not_found" });
}

// --- legs ----------------------------------------------------------------

/**
 * The journey's legs, each with this reader's own unread count.
 *
 * The default leg is created here if it is missing, which is what makes a
 * journey that predates legs — or one nobody has spoken in — open to a
 * usable list rather than an empty one. Skipped on a completed journey, where
 * writes are refused anyway and creating one would be the only write that
 * slipped through.
 */
async function getLegs(c, req, res, journeyId) {
  const auth = await authorize(c, req, res, journeyId, { needWrite: false });
  if (!auth) return undefined;

  try {
    let legs = await listJourneyLegs(c, journeyId);
    if (!legs.length && auth.meta.status !== "completed") {
      await ensureDefaultLeg(c, journeyId, auth.session.identity);
      legs = await listJourneyLegs(c, journeyId);
    }
    const cursors = cursorsByLeg(await listJourneyReadCursors(c, journeyId, auth.session.identity));
    return send(res, 200, {
      legs: legs.map((t) => ({ ...t, ...legUnread(t, cursors[t.legId]) })),
    });
  } catch (err) {
    c.logError("journey_legs_read_failed", err, { journeyId });
    return send(res, 500, { error: "internal_error" });
  }
}

async function postLeg(c, req, res, journeyId) {
  const auth = await authorize(c, req, res, journeyId, { needWrite: true });
  if (!auth) return undefined;

  let body;
  try {
    body = await readJson(req);
  } catch {
    return send(res, 400, { error: "bad_request" });
  }
  const parsed = journeyLegBodySchema.safeParse(body);
  if (!parsed.success) return send(res, 400, { error: "bad_request", detail: parsed.error.issues });

  try {
    const { leg } = await createJourneyLeg(c, journeyId, {
      title: parsed.data.title.trim(),
      identity: auth.session.identity,
    });
    c.log("journey_leg_created", { journeyId, legId: leg.legId, by: auth.session.identity });
    return send(res, 201, { leg: { ...leg, unread: 0, mentions: 0 } });
  } catch (err) {
    c.logError("journey_leg_create_failed", err, { journeyId });
    return send(res, 500, { error: "internal_error" });
  }
}

async function patchLeg(c, req, res, journeyId, legId) {
  const auth = await authorize(c, req, res, journeyId, { needWrite: true });
  if (!auth) return undefined;

  let body;
  try {
    body = await readJson(req);
  } catch {
    return send(res, 400, { error: "bad_request" });
  }
  const parsed = journeyLegBodySchema.safeParse(body);
  if (!parsed.success) return send(res, 400, { error: "bad_request", detail: parsed.error.issues });

  try {
    const result = await renameJourneyLeg(c, journeyId, legId, { title: parsed.data.title.trim() });
    if (!result.ok) return send(res, 404, { error: result.reason });
    return send(res, 200, { ok: true });
  } catch (err) {
    c.logError("journey_leg_rename_failed", err, { journeyId, legId });
    return send(res, 500, { error: "internal_error" });
  }
}

// --- messages ---------------------------------------------------------------

/**
 * One page of a leg, plus this identity's own read position.
 *
 * The cursor rides the same response as the messages deliberately: a client
 * that had to make a second call to find out where it had got to would render
 * the whole leg as unread for one frame on every open.
 */
async function getMessages(c, req, res, journeyId, legId, url) {
  const auth = await authorize(c, req, res, journeyId, { needWrite: false });
  if (!auth) return undefined;

  const before = url.searchParams.get("before") || "";
  const since = url.searchParams.get("since") || "";
  const limitParam = Math.floor(Number(url.searchParams.get("limit")));
  const limit = Number.isFinite(limitParam) && limitParam > 0 ? limitParam : MESSAGE_PAGE_LIMIT;

  let page;
  let cursor;
  let leg;
  try {
    [page, cursor, leg] = await Promise.all([
      queryJourneyMessages(c, journeyId, legId, { before, since, limit }),
      getJourneyReadCursor(c, journeyId, auth.session.identity, legId),
      getJourneyLeg(c, journeyId, legId),
    ]);
  } catch (err) {
    c.logError("journey_messages_read_failed", err, { journeyId, legId });
    return send(res, 500, { error: "internal_error" });
  }
  if (!leg) return send(res, 404, { error: "leg_not_found" });

  const me = auth.session.identity;
  const counts = legUnread(leg, cursor);
  return send(res, 200, {
    ...page,
    legId,
    title: leg.title || "",
    // `mentionsMe` is stamped here rather than left to the client to work out
    // from `mentions`: the server already resolved the handles against the
    // roster, and a client re-deriving it would be a second implementation of
    // the matching rule that could disagree with the badge count below.
    messages: page.messages.map((m) => (m.mentions?.includes(me) ? { ...m, mentionsMe: true } : m)),
    messageCount: leg.messageCount || 0,
    lastMessageAt: leg.lastMessageAt || 0,
    lastReadAt: cursor?.lastReadAt || 0,
    unreadCount: counts.unread,
    unreadMentions: counts.mentions,
  });
}

async function postMessage(c, req, res, journeyId, legId) {
  const auth = await authorize(c, req, res, journeyId, { needWrite: true });
  if (!auth) return undefined;

  let body;
  try {
    body = await readJson(req);
  } catch {
    return send(res, 400, { error: "bad_request" });
  }
  const parsed = journeyMessageBodySchema.safeParse(body);
  if (!parsed.success) return send(res, 400, { error: "bad_request", detail: parsed.error.issues });

  const leg = await getJourneyLeg(c, journeyId, legId).catch(() => null);
  if (!leg) return send(res, 404, { error: "leg_not_found" });

  let message;
  try {
    // Resolved server-side against the journey's own people (§19.8), never
    // taken from the client: the mention list is what raises somebody else's
    // badge, so a client that supplied it could notify anyone it liked.
    const mentions = await resolveJourneyMentions(c, journeyId, legId, auth.meta, parsed.data.text).catch(
      (err) => {
        // A mention is an enhancement to a message, not a precondition for it.
        c.logError("journey_mention_resolve_failed", err, { journeyId, legId });
        return [];
      }
    );
    message = await putJourneyMessage(c, journeyId, legId, {
      text: parsed.data.text,
      author: auth.session.identity,
      mentions,
    });
  } catch (err) {
    c.logError("journey_message_write_failed", err, { journeyId, legId });
    return send(res, 500, { error: "internal_error" });
  }

  c.log("journey_message_posted", {
    journeyId,
    legId,
    msgId: message.msgId,
    author: message.author,
    mentions: message.mentions?.length || 0,
  });

  // Fire and forget, AFTER the response: the person who asked already has
  // their message on screen, and a model call is not something to hold a
  // request open for.
  //
  // `kind === "message"` is load-bearing, not defensive. The assistant's own
  // reply can contain the string "@kelabo" — quoting the question back is the
  // obvious way for it to do so — and dispatching on that is an unbounded
  // loop that bills the deployment for every turn of it.
  if (message.kind === "message" && addressesAssistant(parsed.data.text)) {
    answerJourneyMention(c, journeyId, legId, auth.meta, {
      text: parsed.data.text,
      identity: auth.session.identity,
    }).catch((err) => c.logError("journey_answer_failed", err, { journeyId, legId }));
  }

  return send(res, 201, { message });
}

async function patchMessage(c, req, res, journeyId, legId, msgId) {
  const auth = await authorize(c, req, res, journeyId, { needWrite: true });
  if (!auth) return undefined;

  let body;
  try {
    body = await readJson(req);
  } catch {
    return send(res, 400, { error: "bad_request" });
  }
  const parsed = journeyMessageBodySchema.safeParse(body);
  if (!parsed.success) return send(res, 400, { error: "bad_request", detail: parsed.error.issues });

  let result;
  try {
    result = await editJourneyMessage(c, journeyId, legId, msgId, {
      text: parsed.data.text,
      identity: auth.session.identity,
    });
  } catch (err) {
    c.logError("journey_message_edit_failed", err, { journeyId, legId, msgId });
    return send(res, 500, { error: "internal_error" });
  }
  if (!result.ok) {
    return send(res, result.reason === "journey_message_not_found" ? 404 : 403, { error: result.reason });
  }
  return send(res, 200, { message: result.message });
}

async function deleteMessage(c, req, res, journeyId, legId, msgId) {
  const auth = await authorize(c, req, res, journeyId, { needWrite: true });
  if (!auth) return undefined;

  let result;
  try {
    result = await deleteJourneyMessage(c, journeyId, legId, msgId, {
      identity: auth.session.identity,
      isLead: auth.role === "owner",
    });
  } catch (err) {
    c.logError("journey_message_delete_failed", err, { journeyId, legId, msgId });
    return send(res, 500, { error: "internal_error" });
  }
  if (!result.ok) {
    return send(res, result.reason === "journey_message_not_found" ? 404 : 403, { error: result.reason });
  }
  return send(res, 200, { message: result.message });
}

/**
 * Pin a message to the board (§19.7).
 *
 * A member write, not an assistant one, so `aiCanPost` does not apply — that
 * flag gates the assistant editing a curated surface unsupervised, and this is
 * a person promoting something they can already read.
 */
async function pinMessage(c, req, res, journeyId, legId, msgId) {
  const auth = await authorize(c, req, res, journeyId, { needWrite: true });
  if (!auth) return undefined;

  let result;
  try {
    result = await pinJourneyMessage(c, journeyId, legId, msgId, { identity: auth.session.identity });
  } catch (err) {
    c.logError("journey_message_pin_failed", err, { journeyId, legId, msgId });
    return send(res, 500, { error: "internal_error" });
  }
  if (!result.ok) {
    return send(res, result.reason === "journey_message_not_found" ? 404 : 409, { error: result.reason });
  }
  c.log("journey_message_pinned", { journeyId, legId, msgId, boardMsgId: result.msgId });
  // Idempotent: pinning twice returns the board message that already exists,
  // rather than putting a second copy of the same words on the board.
  return send(res, result.already ? 200 : 201, { boardMsgId: result.msgId, pinnedAs: result.msgId });
}

/**
 * Advance the read cursor. Writable on a completed journey — marking a frozen
 * leg as read is not a write to the journey's content, and refusing it
 * would leave a badge nobody could ever clear.
 */
async function postRead(c, req, res, journeyId, legId) {
  const auth = await authorize(c, req, res, journeyId, { needWrite: false });
  if (!auth) return undefined;

  let body;
  try {
    body = await readJson(req);
  } catch {
    return send(res, 400, { error: "bad_request" });
  }
  const parsed = journeyReadBodySchema.safeParse(body);
  if (!parsed.success) return send(res, 400, { error: "bad_request", detail: parsed.error.issues });

  try {
    // The counters the cursor is differenced against are read here, never
    // taken from the client: they are what the badge is computed from, and a
    // client that sent its own would be choosing its own unread total.
    const [leg, cursor] = await Promise.all([
      getJourneyLeg(c, journeyId, legId),
      getJourneyReadCursor(c, journeyId, auth.session.identity, legId).catch(() => null),
    ]);
    if (!leg) return send(res, 404, { error: "leg_not_found" });
    await advanceJourneyReadCursor(c, journeyId, auth.session.identity, legId, {
      at: parsed.data.at,
      msgId: parsed.data.msgId,
      messageCount: leg.messageCount || 0,
      mentionCount: cursor?.mentionCount || 0,
    });
  } catch (err) {
    c.logError("journey_read_advance_failed", err, { journeyId, legId });
    return send(res, 500, { error: "internal_error" });
  }
  return send(res, 200, { ok: true });
}
