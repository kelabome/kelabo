import { randomUUID } from "node:crypto";
import { RTC_MODES } from "@kelabo/contracts";
import { err } from "./errors.js";

/**
 * Scheduled kelabos, invitations and RSVPs.
 *
 * A scheduled kelabo is not a new kind of thing — it is a kelabo with
 * `status: "scheduled"`, in the same partition, under the same id. That is the
 * whole reason a link can be shared a week early and still be the right link
 * when the kelabo starts: nothing is created or migrated at start time, a
 * status flips. It also means the existing `status-index` lists them, the
 * existing join flow admits people, and ending one archives it, all unchanged.
 *
 * Invitations live beside the meta as `INVITE#<key>` items, where the key is an
 * email address for someone who has one and `g:<uuid>` for a guest who only
 * ever gave a name. One query over the prefix lists everybody, whichever they
 * are.
 */
export function createScheduling({ config, db, mailer, internal }) {
  const tenantOf = (identity) => identity.split("@")[1].toLowerCase();

  // A conditional write that lost its guard surfaces either as a bare
  // ConditionalCheckFailedException or, inside a transaction, as a
  // TransactionCanceledException carrying that reason.
  const isConditionFailure = (e) =>
    e.name === "ConditionalCheckFailedException" ||
    (e.name === "TransactionCanceledException" &&
      (e.CancellationReasons || []).some((r) => r.Code === "ConditionalCheckFailed"));

  function toScheduledSummary(item, invites) {
    const counts = { accepted: 0, declined: 0, pending: 0 };
    for (const i of invites || []) counts[i.response || "pending"]++;
    return {
      kelaboId: item.kelaboId,
      title: item.title,
      status: item.status,
      scheduledAt: item.scheduledAt,
      durationMinutes: item.durationMinutes,
      note: item.note,
      hostIdentity: item.hostIdentity,
      joinUrl: config.joinUrl(item.kelaboId),
      inviteUrl: config.inviteUrl(item.kelaboId),
      rsvp: counts,
    };
  }

  async function schedule({ identity, displayName, body }) {
    const tenantId = tenantOf(identity);
    const now = Date.now();
    const kelaboId = randomUUID();
    const invitees = [...new Set((body.invitees || []).map((e) => e.trim().toLowerCase()).filter(Boolean))];

    const meta = {
      kelaboId,
      status: "scheduled",
      title: body.title.trim(),
      hostIdentity: identity,
      createdAt: now,
      scheduledAt: body.scheduledAt,
      durationMinutes: body.durationMinutes ?? 30,
      note: body.note?.trim() || undefined,
      participants: [],
      mode: "unknown",
      isDeveloperPresent: false,
      hasMinutes: false,
      // Zero, NOT null, and this matters: `status-index` sorts on `startedAt`
      // as a Number, and DynamoDB silently declines to index an item whose key
      // attribute is missing or of another type. A null here does not throw —
      // it just means the kelabo is written, is readable by id, and never
      // appears in any list, which is the worst kind of bug. Zero is a Number,
      // sorts before every real start time, and is falsy everywhere the room
      // asks "has this started".
      startedAt: 0,
      hostJoinedAt: null,
      mcpEnabled: body.mcpEnabled !== false,
      // Opt-IN, so `=== true` rather than `!== false`: an absent field means no,
      // and every kelabo created before this existed means no too.
      historyEnabled: body.historyEnabled === true,
      rtcMode: RTC_MODES.includes(body.rtcMode) ? body.rtcMode : config.rtc.defaultMode,
      tenantId,
      tenantStatus: `${tenantId}#scheduled`,
    };

    await db.createScheduledKelabo(meta);

    // The host counts as attending their own kelabo; saying so up front means
    // the list never reads "nobody has replied" about a kelabo its owner
    // obviously intends to attend.
    await db.putInvite(kelaboId, {
      inviteKey: identity,
      email: identity,
      displayName: displayName || identity,
      isGuest: false,
      isHost: true,
      response: "accepted",
      invitedAt: now,
      respondedAt: now,
    });

    const inviteUrl = config.inviteUrl(kelaboId);
    const results = [];
    for (const email of invitees) {
      if (email === identity) continue;
      await db.putInvite(kelaboId, {
        inviteKey: email,
        email,
        isGuest: false,
        response: "pending",
        invitedAt: now,
      });
      // One bad address must not lose the whole schedule — the kelabo is
      // created either way and the host is told which invitations failed. But
      // the reason must survive: swallowing it left "was the mail sent?"
      // answerable only from SES metrics, and the commonest cause by far —
      // an SES account still in sandbox, which rejects every unverified
      // recipient — looked identical to every other failure.
      let sent = true;
      let reason;
      try {
        await mailer.sendInvite({
          to: email,
          hostName: displayName || identity,
          title: meta.title,
          scheduledAt: meta.scheduledAt,
          durationMinutes: meta.durationMinutes,
          note: meta.note,
          inviteUrl,
        });
      } catch (e) {
        sent = false;
        reason = e.code || e.name || "send_failed";
      }
      results.push({ email, sent, ...(reason ? { reason } : {}) });
    }

    return {
      status: 200,
      body: {
        kelaboId,
        title: meta.title,
        status: "scheduled",
        scheduledAt: meta.scheduledAt,
        joinUrl: config.joinUrl(kelaboId),
        inviteUrl,
        invited: results,
        failed: results.filter((r) => !r.sent).map((r) => r.email),
      },
    };
  }

  async function listScheduled({ identity }) {
    // Everything at the tenant is visible in the index; a host's own list is
    // what the rail shows, and being invited to one is what puts it in yours
    // — including an invite from a kelabo hosted at someone else's tenant
    // entirely, which sameTenant's index can never reach (docs 18 §2.8).
    const { sameTenant, crossTenant } = await db.listKelabosByStatusForIdentity(identity, "scheduled");
    const items = [...sameTenant, ...crossTenant];
    const withInvites = await Promise.all(
      items.map(async (m) => {
        const invites = await db.listInvites(m.kelaboId);
        return { meta: m, invites };
      })
    );
    const visible = withInvites.filter(
      ({ meta, invites }) =>
        meta.hostIdentity === identity || invites.some((i) => i.inviteKey === identity)
    );
    return {
      scheduled: visible
        .map(({ meta, invites }) => ({
          ...toScheduledSummary(meta, invites),
          isHost: meta.hostIdentity === identity,
          myResponse: invites.find((i) => i.inviteKey === identity)?.response || null,
        }))
        .sort((a, b) => a.scheduledAt - b.scheduledAt),
    };
  }

  /** Host-only detail: who was invited and what they said. */
  async function getScheduled({ kelaboId, identity }) {
    const meta = await db.getKelaboMeta(kelaboId);
    if (!meta) throw err(404, "kelabo_not_found");
    const invites = await db.listInvites(kelaboId);
    const isHost = meta.hostIdentity === identity;
    if (!isHost && !invites.some((i) => i.inviteKey === identity)) throw err(403, "forbidden");
    // Docs 20 §4.3/§11 touch-up — same shape and reasoning as GET /kelabos/:id.
    const journeys = (await db.listKelaboJourneyLinks(kelaboId).catch(() => [])).map((l) => ({
      id: l.journeyId,
      title: l.journeyTitleSnapshot || "",
      visibility: l.journeyVisibilitySnapshot,
    }));
    return {
      ...toScheduledSummary(meta, invites),
      isHost,
      journeys,
      invites: await Promise.all(
        invites.map(async (i) => ({
          email: i.email,
          displayName: i.displayName,
          isGuest: !!i.isGuest,
          isHost: !!i.isHost,
          response: i.response || "pending",
          respondedAt: i.respondedAt,
          avatarVariant: i.email && !i.isGuest
            ? Number((await db.getUserSettings(i.email).catch(() => null))?.settings?.avatar) || 0
            : 0,
        }))
      ),
    };
  }

  async function start({ kelaboId, identity }) {
    const meta = await db.getKelaboMeta(kelaboId);
    if (!meta) throw err(404, "kelabo_not_found");
    if (meta.hostIdentity !== identity) throw err(403, "forbidden");
    if (meta.status === "active") {
      // Idempotent: a second click, or a retry after a dropped response, should
      // land the host in the kelabo rather than on an error.
      return { status: 200, body: { kelaboId, status: "active", joinUrl: config.joinUrl(kelaboId) } };
    }
    if (meta.status !== "scheduled") throw err(410, "kelabo_ended");

    const startedAt = Date.now();
    try {
      await db.startScheduledKelabo({
        kelaboId,
        tenantId: meta.tenantId,
        startedAt,
      });
    } catch (e) {
      const conditionFailed =
        e.name === "ConditionalCheckFailedException" ||
        (e.name === "TransactionCanceledException" &&
          (e.CancellationReasons || []).some((r) => r.Code === "ConditionalCheckFailed"));
      if (!conditionFailed) throw e;
      // The kelabo is no longer scheduled: a second click / retry raced this
      // one, or it was cancelled. (A host running another live kelabo is fine
      // now — the one-live-per-host guard is gone.)
      const fresh = await db.getKelaboMeta(kelaboId);
      if (fresh?.status === "active") {
        return { status: 200, body: { kelaboId, status: "active", joinUrl: config.joinUrl(kelaboId) } };
      }
      if (fresh?.status === "cancelled") throw err(409, "kelabo_cancelled");
      throw err(409, "not_scheduled");
    }
    return { status: 200, body: { kelaboId, status: "active", startedAt, joinUrl: config.joinUrl(kelaboId) } };
  }

  /**
   * Cancel a scheduled kelabo (docs 18 §2). Host-only, scheduled-only. "Cancel"
   * is deliberately distinct from "end": end archives a live kelabo; cancel
   * disposes of one that never happened, sets a TTL so the row self-expires, and
   * emails the invitees. A live or already-cancelled kelabo is refused with a
   * status-accurate error rather than falling through to a misleading one.
   */
  async function cancel({ kelaboId, identity, reason }) {
    const meta = await db.getKelaboMeta(kelaboId);
    if (!meta) throw err(404, "kelabo_not_found");
    if (meta.hostIdentity !== identity) throw err(403, "not_host");
    if (meta.status === "active") throw err(409, "already_active");
    if (meta.status === "cancelled") throw err(409, "kelabo_cancelled");
    if (meta.status !== "scheduled") throw err(409, "not_scheduled");

    const cancelledAt = Date.now();
    const ttl = Math.floor(cancelledAt / 1000) + config.retentionDays * 86400;
    try {
      await db.cancelScheduledKelabo({ kelaboId, tenantId: meta.tenantId, cancelledAt, reason, ttl });
    } catch (e) {
      // Lost the race to a "Start now" (or a concurrent cancel). Re-read and
      // report what actually happened rather than a generic condition failure.
      if (!isConditionFailure(e)) throw e;
      const fresh = await db.getKelaboMeta(kelaboId);
      if (fresh?.status === "active") throw err(409, "already_active");
      if (fresh?.status === "cancelled") throw err(409, "kelabo_cancelled");
      throw err(409, "not_scheduled");
    }

    // Tell a prep-bound agent the kelabo is gone; best-effort.
    try {
      await internal.cancelKelabo(kelaboId, identity);
    } catch (e) {
      console.warn(JSON.stringify({ level: "warn", msg: "gateway cancel call failed", kelaboId, error: String(e) }));
    }

    // Notify invitees who have an address, except the host. Per-recipient and
    // non-fatal, exactly like the invite loop.
    const invites = await db.listInvites(kelaboId);
    for (const inv of invites) {
      if (!inv.email || inv.isHost) continue;
      try {
        await mailer.sendCancellation({
          to: inv.email,
          hostName: meta.hostIdentity,
          title: meta.title,
          scheduledAt: meta.scheduledAt,
          reason,
        });
      } catch (e) {
        console.warn(JSON.stringify({ level: "warn", msg: "cancellation email failed", to: inv.email, error: String(e) }));
      }
    }

    return { status: 200, body: { kelaboId, status: "cancelled" } };
  }

  /**
   * Reschedule a scheduled kelabo (docs 18 §3). Host-only, scheduled-only. Any
   * of time/duration/title/note may change; an empty body is `nothing_to_change`.
   * When the *time* moves, non-host RSVPs reset to pending and a reschedule email
   * goes out — a new time invalidates "I can attend"; a title fix does not.
   */
  async function reschedule({ kelaboId, identity, body }) {
    const meta = await db.getKelaboMeta(kelaboId);
    if (!meta) throw err(404, "kelabo_not_found");
    if (meta.hostIdentity !== identity) throw err(403, "not_host");
    if (meta.status === "active") throw err(409, "already_active");
    if (meta.status === "cancelled") throw err(409, "kelabo_cancelled");
    if (meta.status !== "scheduled") throw err(409, "not_scheduled");

    const updates = {};
    if (typeof body.durationMinutes === "number") updates.durationMinutes = body.durationMinutes;
    if (typeof body.title === "string" && body.title.trim()) updates.title = body.title.trim();
    if (typeof body.note === "string") updates.note = body.note.trim() || undefined;
    const timeMoved = typeof body.scheduledAt === "number" && body.scheduledAt !== meta.scheduledAt;
    if (timeMoved) {
      updates.scheduledAt = body.scheduledAt;
      updates.previousScheduledAt = meta.scheduledAt;
      updates.rescheduledAt = Date.now();
    }
    if (Object.keys(updates).length === 0) throw err(400, "nothing_to_change");

    try {
      await db.rescheduleKelabo({ kelaboId, updates });
    } catch (e) {
      if (!isConditionFailure(e)) throw e;
      const fresh = await db.getKelaboMeta(kelaboId);
      if (fresh?.status === "active") throw err(409, "already_active");
      if (fresh?.status === "cancelled") throw err(409, "kelabo_cancelled");
      throw err(409, "not_scheduled");
    }

    if (timeMoved) {
      await db.resetInviteResponses(kelaboId);
      const invites = await db.listInvites(kelaboId);
      for (const inv of invites) {
        if (!inv.email || inv.isHost) continue;
        try {
          await mailer.sendReschedule({
            to: inv.email,
            hostName: meta.hostIdentity,
            title: updates.title || meta.title,
            scheduledAt: body.scheduledAt,
            previousScheduledAt: meta.scheduledAt,
            durationMinutes: updates.durationMinutes ?? meta.durationMinutes,
            inviteUrl: config.inviteUrl(kelaboId),
          });
        } catch (e) {
          console.warn(JSON.stringify({ level: "warn", msg: "reschedule email failed", to: inv.email, error: String(e) }));
        }
      }
      // The prep-bound agent's briefing named a time that no longer holds.
      try {
        await internal.rescheduleKelabo?.(kelaboId, identity);
      } catch (e) {
        console.warn(JSON.stringify({ level: "warn", msg: "gateway reschedule call failed", kelaboId, error: String(e) }));
      }
    }

    return {
      status: 200,
      body: {
        kelaboId,
        status: "scheduled",
        scheduledAt: updates.scheduledAt ?? meta.scheduledAt,
        durationMinutes: updates.durationMinutes ?? meta.durationMinutes,
        title: updates.title ?? meta.title,
        rsvpsReset: timeMoved,
      },
    };
  }

  /**
   * Add or remove invitees on a scheduled kelabo (docs 18 §3.5). Host-only,
   * scheduled-only — the same guard cancel and reschedule use. Takes the
   * *full* desired list rather than an add list and a remove list, both
   * because that is what `EmailPicker`'s controlled `value` already is on the
   * SPA side, and because a client-computed diff can be wrong (a chip removed
   * and re-added in the same edit, a race with another tab) in a way a
   * server-computed one cannot.
   *
   * The host and any guest-only RSVP (`inviteKey` starting `g:`, someone who
   * answered the link without an account) are outside this diff entirely:
   * neither was ever something the host "invited" by typing an address, so
   * neither can be added or removed through this route.
   */
  async function updateInvitees({ kelaboId, identity, displayName, body }) {
    const meta = await db.getKelaboMeta(kelaboId);
    if (!meta) throw err(404, "kelabo_not_found");
    if (meta.hostIdentity !== identity) throw err(403, "not_host");
    if (meta.status === "active") throw err(409, "already_active");
    if (meta.status === "cancelled") throw err(409, "kelabo_cancelled");
    if (meta.status !== "scheduled") throw err(409, "not_scheduled");

    const desired = new Set(
      (body.invitees || []).map((e) => e.trim().toLowerCase()).filter((e) => e && e !== identity)
    );
    const invites = await db.listInvites(kelaboId);
    const current = new Set(invites.filter((i) => i.email && !i.isGuest && !i.isHost).map((i) => i.email));

    const toAdd = [...desired].filter((e) => !current.has(e));
    const toRemove = [...current].filter((e) => !desired.has(e));
    if (toAdd.length === 0 && toRemove.length === 0) throw err(400, "nothing_to_change");

    const now = Date.now();
    const inviteUrl = config.inviteUrl(kelaboId);
    const hostName = displayName || identity;

    // Added first, removed second — an address moved between the two lists
    // by mistake (typo'd, fixed, re-typed) ends up simply invited, not
    // invited-then-immediately-uninvited.
    const added = [];
    for (const email of toAdd) {
      await db.putInvite(kelaboId, { inviteKey: email, email, isGuest: false, response: "pending", invitedAt: now });
      let sent = true;
      let reason;
      try {
        await mailer.sendInvite({
          to: email,
          hostName,
          title: meta.title,
          scheduledAt: meta.scheduledAt,
          durationMinutes: meta.durationMinutes,
          note: meta.note,
          inviteUrl,
        });
      } catch (e) {
        sent = false;
        reason = e.code || e.name || "send_failed";
      }
      added.push({ email, sent, ...(reason ? { reason } : {}) });
    }

    const removed = [];
    for (const email of toRemove) {
      await db.removeInvite(kelaboId, email);
      let sent = true;
      let reason;
      try {
        await mailer.sendUninvite({ to: email, hostName, title: meta.title, scheduledAt: meta.scheduledAt });
      } catch (e) {
        sent = false;
        reason = e.code || e.name || "send_failed";
      }
      removed.push({ email, sent, ...(reason ? { reason } : {}) });
    }

    return {
      status: 200,
      body: {
        kelaboId,
        added,
        removed,
        failed: [...added, ...removed].filter((r) => !r.sent).map((r) => r.email),
      },
    };
  }

  /**
   * What an invitee sees before they answer. Deliberately readable without a
   * session — the whole point of the link is that it reaches people who have no
   * account — and deliberately thin: a title, a time, who is asking. Not the
   * guest list, which is not an invitee's business.
   */
  async function getInvitation({ kelaboId, identity, rsvpKey }) {
    const meta = await db.getKelaboMeta(kelaboId);
    if (!meta) throw err(404, "kelabo_not_found");
    const key = identity || rsvpKey;
    const mine = key ? await db.getInvite(kelaboId, key) : null;
    const invites = await db.listInvites(kelaboId);
    return {
      kelaboId,
      title: meta.title,
      status: meta.status,
      scheduledAt: meta.scheduledAt,
      durationMinutes: meta.durationMinutes,
      note: meta.note,
      hostIdentity: meta.hostIdentity,
      joinUrl: config.joinUrl(kelaboId),
      // Enough to know whether anyone else is coming, without naming them.
      going: invites.filter((i) => i.response === "accepted").length,
      myResponse: mine?.response || null,
      myName: mine?.displayName || null,
      // A signed-in user never has to type their name; a guest does, once.
      needsName: !identity && !mine,
    };
  }

  async function rsvp({ kelaboId, body, identity, displayName, rsvpKey }) {
    const meta = await db.getKelaboMeta(kelaboId);
    if (!meta) throw err(404, "kelabo_not_found");
    if (meta.status === "ended") throw err(410, "kelabo_ended");
    // A cancelled kelabo used to accept RSVPs (the guard was `ended` only),
    // which let someone reply "attending" to a kelabo that was called off.
    if (meta.status === "cancelled") throw err(409, "kelabo_cancelled");

    let inviteKey = identity || rsvpKey;
    let isGuest = !identity;
    let name = identity ? displayName || identity : body.displayName?.trim();

    if (isGuest) {
      const existing = rsvpKey ? await db.getInvite(kelaboId, rsvpKey) : null;
      // A guest changing their mind keeps the name they already gave, so the
      // second answer does not demand it again.
      if (!name) name = existing?.displayName;
      if (!name) throw err(400, "name_required");
      if (!inviteKey) inviteKey = `g:${randomUUID()}`;
    }

    const now = Date.now();
    const existing = await db.getInvite(kelaboId, inviteKey);
    await db.putInvite(kelaboId, {
      ...(existing || {}),
      inviteKey,
      email: identity || existing?.email,
      displayName: name,
      isGuest,
      isHost: !!existing?.isHost,
      response: body.response,
      invitedAt: existing?.invitedAt || now,
      respondedAt: now,
    });

    return { kelaboId, response: body.response, displayName: name, inviteKey, isGuest };
  }

  /**
   * Colleagues to suggest: the people registered at the caller's own email
   * domain. Everyone in a domain can see everyone else in it — that is the
   * point of a shared workspace — and the tenant is the partition key, so the
   * query cannot reach another domain.
   *
   * Addresses are stored whole, so a bare local part ("ma") and a partial
   * address ("ma@their-dom") are the same prefix query.
   */
  async function suggestPeople({ identity, prefix }) {
    const tenantId = tenantOf(identity);
    const q = (prefix || "").trim().toLowerCase();
    const items = await db.listUsersByTenant(tenantId, q, 8);
    // Surface favourite state on each result so a colleague can be pinned or
    // unpinned straight from a search result (docs 18 §4.1a) without a second
    // round-trip. Best-effort: a favourites read failure must not break search.
    let favSet = new Set();
    try {
      const favs = await db.listFavourites(identity);
      favSet = new Set(favs.map((f) => f.peer));
    } catch {
      favSet = new Set();
    }
    const visible = items.filter((u) => u.email && u.email !== identity);
    return {
      suggestions: await Promise.all(
        visible.map(async (u) => ({
          email: u.email,
          displayName: u.displayName,
          favourited: favSet.has(u.email),
          // Settings are not projected on the tenant index; ≤8 parallel reads.
          avatarVariant: Number((await db.getUserSettings(u.email).catch(() => null))?.settings?.avatar) || 0,
        }))
      ),
    };
  }

  return {
    schedule,
    listScheduled,
    getScheduled,
    start,
    cancel,
    reschedule,
    updateInvitees,
    getInvitation,
    rsvp,
    suggestPeople,
  };
}
