// The journey channel's HTTP surface (docs 20 §19) — post, page, edit,
// delete, and advance a read cursor.
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
  journeyMessageBodySchema,
  journeyReadBodySchema,
  COOKIE_SESSION,
} from "@kelabo/contracts";
import { parseCookies, verifySessionCookie } from "./cookies.js";
import { readJson, send } from "./caption.js";
import {
  getJourneyMeta,
  resolveJourneyAccess,
  putJourneyMessage,
  queryJourneyMessages,
  editJourneyMessage,
  deleteJourneyMessage,
  pinJourneyMessage,
  resolveJourneyMentions,
  getJourneyReadCursor,
  advanceJourneyReadCursor,
  MESSAGE_PAGE_LIMIT,
} from "./journeys.js";

/** `/journeys/<id>/messages`, `/journeys/<id>/messages/<msgId>`, and
 *  `/journeys/<id>/read`. Ids are path segments, which is why a channel
 *  message id uses a hyphen rather than the `#` every other sort key in the
 *  partition uses. */
export const JOURNEY_CHAT_PATH = /^\/journeys\/([^/]+)\/(messages|read)(?:\/([^/]+))?(\/pin)?$/;

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
  // ended": completing a journey closes its channel, and reopening it opens
  // the channel back up, with nothing archived or moved in between.
  if (needWrite && meta.status === "completed") {
    send(res, 409, { error: "journey_completed" });
    return null;
  }

  return { session, meta, role };
}

export async function handleJourneyChat(c, req, res, match, url) {
  const [, journeyId, kind, msgId, pin] = match;
  const method = req.method;

  // `/read` takes no sub-path. Without the guard `POST /journeys/x/read/pin`
  // would fall in here and quietly act as a mark-read.
  if (kind === "read") {
    if (method !== "POST" || msgId || pin) return send(res, 404, { error: "not_found" });
    return postRead(c, req, res, journeyId);
  }
  if (method === "POST" && msgId && pin) return pinMessage(c, req, res, journeyId, msgId);
  if (pin) return send(res, 404, { error: "not_found" });
  if (method === "GET" && !msgId) return getMessages(c, req, res, journeyId, url);
  if (method === "POST" && !msgId) return postMessage(c, req, res, journeyId);
  if (method === "PATCH" && msgId) return patchMessage(c, req, res, journeyId, msgId);
  if (method === "DELETE" && msgId) return deleteMessage(c, req, res, journeyId, msgId);
  return send(res, 404, { error: "not_found" });
}

/**
 * One page of the channel, plus this identity's own read position.
 *
 * The cursor rides the same response as the messages deliberately: a client
 * that had to make a second call to find out where it had got to would render
 * the whole channel as unread for one frame on every open.
 */
async function getMessages(c, req, res, journeyId, url) {
  const auth = await authorize(c, req, res, journeyId, { needWrite: false });
  if (!auth) return undefined;

  const before = url.searchParams.get("before") || "";
  const since = url.searchParams.get("since") || "";
  const limitParam = Math.floor(Number(url.searchParams.get("limit")));
  const limit = Number.isFinite(limitParam) && limitParam > 0 ? limitParam : MESSAGE_PAGE_LIMIT;

  let page;
  let cursor;
  try {
    [page, cursor] = await Promise.all([
      queryJourneyMessages(c, journeyId, { before, since, limit }),
      getJourneyReadCursor(c, journeyId, auth.session.identity),
    ]);
  } catch (err) {
    c.logError("journey_messages_read_failed", err, { journeyId });
    return send(res, 500, { error: "internal_error" });
  }

  const me = auth.session.identity;
  return send(res, 200, {
    ...page,
    // `mentionsMe` is stamped here rather than left to the client to work out
    // from `mentions`: the server already resolved the handles against the
    // roster, and a client re-deriving it would be a second implementation of
    // the matching rule that could disagree with the badge count below.
    messages: page.messages.map((m) => (m.mentions?.includes(me) ? { ...m, mentionsMe: true } : m)),
    messageCount: auth.meta.messageCount || 0,
    lastMessageAt: auth.meta.lastMessageAt || 0,
    lastReadAt: cursor?.lastReadAt || 0,
    // Never negative: a cursor written before a message was deleted, or
    // before this counter existed at all, must read as "nothing unread"
    // rather than as a negative badge.
    unreadCount: Math.max(0, (auth.meta.messageCount || 0) - (cursor?.messageCountAtRead || 0)),
    // The same O(1) difference, counted per person (§19.8). Kept separate
    // because the two mean different things to a reader: unread is "there is
    // something here", unread mentions is "somebody wants you".
    mentionCount: cursor?.mentionCount || 0,
    unreadMentions: Math.max(0, (cursor?.mentionCount || 0) - (cursor?.mentionCountAtRead || 0)),
  });
}

async function postMessage(c, req, res, journeyId) {
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

  let message;
  try {
    // Resolved server-side against the journey's own people (§19.8), never
    // taken from the client: the mention list is what raises somebody else's
    // badge, so a client that supplied it could notify anyone it liked.
    const mentions = await resolveJourneyMentions(c, journeyId, auth.meta, parsed.data.text).catch(err => {
      // A mention is an enhancement to a message, not a precondition for it.
      c.logError("journey_mention_resolve_failed", err, { journeyId });
      return [];
    });
    message = await putJourneyMessage(c, journeyId, {
      text: parsed.data.text,
      author: auth.session.identity,
      mentions,
    });
  } catch (err) {
    c.logError("journey_message_write_failed", err, { journeyId });
    return send(res, 500, { error: "internal_error" });
  }

  c.log("journey_message_posted", {
    journeyId,
    msgId: message.msgId,
    author: message.author,
    mentions: message.mentions?.length || 0,
  });
  // Phase 2 fans this out over the presence stream. Until then the write is
  // complete and correct on its own, and clients poll — the ordering matters:
  // nothing about the fan-out may be load-bearing for the message existing.
  return send(res, 201, { message });
}

async function patchMessage(c, req, res, journeyId, msgId) {
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
    result = await editJourneyMessage(c, journeyId, msgId, {
      text: parsed.data.text,
      identity: auth.session.identity,
    });
  } catch (err) {
    c.logError("journey_message_edit_failed", err, { journeyId, msgId });
    return send(res, 500, { error: "internal_error" });
  }
  if (!result.ok) {
    return send(res, result.reason === "journey_message_not_found" ? 404 : 403, { error: result.reason });
  }
  return send(res, 200, { message: result.message });
}

async function deleteMessage(c, req, res, journeyId, msgId) {
  const auth = await authorize(c, req, res, journeyId, { needWrite: true });
  if (!auth) return undefined;

  let result;
  try {
    result = await deleteJourneyMessage(c, journeyId, msgId, {
      identity: auth.session.identity,
      isLead: auth.role === "owner",
    });
  } catch (err) {
    c.logError("journey_message_delete_failed", err, { journeyId, msgId });
    return send(res, 500, { error: "internal_error" });
  }
  if (!result.ok) {
    return send(res, result.reason === "journey_message_not_found" ? 404 : 403, { error: result.reason });
  }
  return send(res, 200, { message: result.message });
}

/**
 * Pin a channel message to the board (§19.7).
 *
 * A member write, not an assistant one, so `aiCanPost` does not apply — that
 * flag gates the assistant editing a curated surface unsupervised, and this is
 * a person promoting something they can already read.
 */
async function pinMessage(c, req, res, journeyId, msgId) {
  const auth = await authorize(c, req, res, journeyId, { needWrite: true });
  if (!auth) return undefined;

  let result;
  try {
    result = await pinJourneyMessage(c, journeyId, msgId, { identity: auth.session.identity });
  } catch (err) {
    c.logError("journey_message_pin_failed", err, { journeyId, msgId });
    return send(res, 500, { error: "internal_error" });
  }
  if (!result.ok) {
    return send(res, result.reason === "journey_message_not_found" ? 404 : 409, { error: result.reason });
  }
  c.log("journey_message_pinned", { journeyId, msgId, boardMsgId: result.msgId });
  // Idempotent: pinning twice returns the board message that already exists,
  // rather than putting a second copy of the same words on the board.
  return send(res, result.already ? 200 : 201, { boardMsgId: result.msgId, pinnedAs: result.msgId });
}

/**
 * Advance the read cursor. Writable on a completed journey — marking a frozen
 * channel as read is not a write to the journey's content, and refusing it
 * would leave a badge nobody could ever clear.
 */
async function postRead(c, req, res, journeyId) {
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
    // The mention counter lives on the cursor row itself, so clearing the
    // mention badge means reading the row we are about to overwrite.
    const cursor = await getJourneyReadCursor(c, journeyId, auth.session.identity).catch(() => null);
    await advanceJourneyReadCursor(c, journeyId, auth.session.identity, {
      at: parsed.data.at,
      msgId: parsed.data.msgId,
      // Snapshotted from META as the server sees it, never from the client:
      // the count is the thing the badge is differenced against, and a client
      // that sent its own would be choosing its own unread total.
      messageCount: auth.meta.messageCount || 0,
      mentionCount: cursor?.mentionCount || 0,
    });
  } catch (err) {
    c.logError("journey_read_advance_failed", err, { journeyId });
    return send(res, 500, { error: "internal_error" });
  }
  return send(res, 200, { ok: true });
}
