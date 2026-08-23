import { randomUUID } from "node:crypto";
import { JOURNEY_VISIBILITIES } from "@kelabo/contracts";
import { err } from "./errors.js";

/**
 * Journey (docs 20): a persistent container linking related kelabos so
 * description, decisions and Q&A history carry from one meeting to the
 * next, for the people in the room and the agent listening.
 *
 * Visibility decides access, and nothing is stored to grant the common
 * case: a `public` journey is fully open to every identity whose
 * `tenantId` matches the journey's — no roster, computed fresh per
 * request, the same derivation doc 18 already uses for "same org". A
 * `private` journey keeps an explicit `ACCESSOR#` roster; being on it
 * grants the same rights minus managing that roster, which — like delete,
 * visibility and complete/reopen — stays owner-only (docs 20 §3.3).
 */
export function createJourneys({ config, db, internal }) {
  const tenantOf = (identity) => identity.split("@")[1].toLowerCase();

  // A conditional write that lost its guard surfaces either as a bare
  // ConditionalCheckFailedException or, inside a transaction, as a
  // TransactionCanceledException — the same shape scheduling.js already
  // checks for.
  const isConditionFailure = (e) =>
    e.name === "ConditionalCheckFailedException" ||
    (e.name === "TransactionCanceledException" &&
      (e.CancellationReasons || []).some((r) => r.Code === "ConditionalCheckFailed"));

  function toSummary(meta) {
    return {
      journeyId: meta.journeyId,
      title: meta.title,
      status: meta.status,
      visibility: meta.visibility,
      ownerIdentity: meta.ownerIdentity,
      avatarVariant: meta.avatarVariant || 0,
      // Optional (docs 20 §5): absent means genuinely unset, not 0%/red.
      health: meta.health ?? null,
      progress: meta.progress ?? null,
      // Owner-only gate on unsupervised agent board posts (docs 20 §7).
      aiCanPost: !!meta.aiCanPost,
      kelaboCount: meta.kelaboCount || 0,
      documentCount: meta.documentCount || 0,
      reportCount: meta.reportCount || 0,
      boardMessageCount: meta.boardMessageCount || 0,
      accessorCount: meta.accessorCount || 0,
      createdAt: meta.createdAt,
      updatedAt: meta.updatedAt,
      completedAt: meta.completedAt || null,
    };
  }

  /**
   * Fresh, per-request access check (docs 20 §3.2) — no cached membership
   * flag, matching how host/participant checks already work on `kelabos`.
   * Order: owner, then public-tenant-match, then private-accessor lookup.
   */
  async function resolveAccess(meta, identity) {
    if (!identity) return { role: "none" };
    if (identity === meta.ownerIdentity) return { role: "owner" };
    if (meta.visibility === "public" && tenantOf(identity) === meta.tenantId) return { role: "member" };
    if (meta.visibility === "private") {
      const accessor = await db.getAccessor(meta.journeyId, identity);
      if (accessor) return { role: "member" };
    }
    return { role: "none" };
  }

  async function requireJourney(journeyId) {
    const meta = await db.getJourneyMeta(journeyId);
    if (!meta) throw err(404, "journey_not_found");
    return meta;
  }

  /** Owner or member; 403 otherwise. Returns the resolved role. */
  async function requireMember(meta, identity) {
    const access = await resolveAccess(meta, identity);
    if (access.role === "none") throw err(403, "forbidden");
    return access.role;
  }

  function requireOwner(meta, identity) {
    if (meta.ownerIdentity !== identity) throw err(403, "not_journey_owner");
  }

  /** Completion freezes every write, no exception (docs 20 §3.1). */
  function requireActive(meta) {
    if (meta.status === "completed") throw err(409, "journey_completed");
  }

  async function createJourney({ identity, body }) {
    const tenantId = tenantOf(identity);
    const now = Date.now();
    const journeyId = randomUUID();
    const visibility = JOURNEY_VISIBILITIES.includes(body.visibility) ? body.visibility : "private";
    const meta = {
      journeyId,
      title: body.title.trim(),
      status: "active",
      visibility,
      ownerIdentity: identity,
      tenantId,
      tenantStatus: `${tenantId}#active`,
      avatarVariant: 0,
      currentDescriptionVersion: 0,
      kelaboCount: 0,
      documentCount: 0,
      reportCount: 0,
      accessorCount: 0,
      createdAt: now,
      updatedAt: now,
    };
    await db.createJourney(meta);
    if (typeof body.description === "string" && body.description.trim()) {
      await writeDescriptionVersion({ meta, identity, markdown: body.description.trim() });
    }
    return { journeyId, title: meta.title, status: meta.status, visibility };
  }

  async function listJourneys({ identity }) {
    const tenantId = tenantOf(identity);
    const [tenantActive, accessorLinks] = await Promise.all([
      db.listJourneysByTenantStatus(tenantId, "active"),
      db.listAccessorJourneys(identity),
    ]);
    const mine = tenantActive.filter((m) => m.ownerIdentity === identity).map(toSummary);
    const mineIds = new Set(mine.map((m) => m.journeyId));

    // Unlike `mine`/`publicJourneys` above, `accessor-index` is keyed only
    // on identity — nothing about `status` participates in it, and
    // completing a journey never touches its `ACCESSOR#` rows — so a
    // completed private journey the caller remains an accessor of would
    // otherwise leak in here (found while adding a picker that must never
    // offer one as a link target, docs 20 §11): filtered explicitly,
    // rather than relying on the GSI to have done it for free the way it
    // does for the other two buckets.
    const accessorMetas = await Promise.all(
      accessorLinks.map((l) => db.getJourneyMeta(String(l.PK).slice("JOURNEY#".length)))
    );
    const accessible = accessorMetas
      .filter((m) => m && m.status === "active" && !mineIds.has(m.journeyId))
      .map(toSummary);

    const publicJourneys = tenantActive
      .filter((m) => m.visibility === "public" && !mineIds.has(m.journeyId))
      .map(toSummary);

    return { mine, accessible, public: publicJourneys };
  }

  async function getJourney({ journeyId, identity }) {
    const meta = await requireJourney(journeyId);
    const role = await requireMember(meta, identity);
    return { ...toSummary(meta), myRole: role };
  }

  async function patchJourney({ journeyId, identity, body }) {
    const meta = await requireJourney(journeyId);
    requireOwner(meta, identity);
    const updates = {};
    if (typeof body.title === "string" && body.title.trim()) updates.title = body.title.trim();
    if (JOURNEY_VISIBILITIES.includes(body.visibility)) updates.visibility = body.visibility;
    if (typeof body.avatarVariant === "number") updates.avatarVariant = body.avatarVariant;
    if (typeof body.aiCanPost === "boolean") updates.aiCanPost = body.aiCanPost;
    if (Object.keys(updates).length === 0) throw err(400, "nothing_to_change");
    updates.updatedAt = Date.now();
    await db.updateJourneyMeta(journeyId, updates);
    return toSummary({ ...meta, ...updates });
  }

  async function completeJourney({ journeyId, identity }) {
    const meta = await requireJourney(journeyId);
    requireOwner(meta, identity);
    // Idempotent: a second click should land on "completed", not an error.
    if (meta.status === "completed") return { journeyId, status: "completed" };
    try {
      await db.completeJourney({
        journeyId,
        tenantId: meta.tenantId,
        completedAt: Date.now(),
        completedBy: identity,
      });
    } catch (e) {
      if (!isConditionFailure(e)) throw e;
      throw err(409, "journey_completed");
    }
    return { journeyId, status: "completed" };
  }

  async function reopenJourney({ journeyId, identity }) {
    const meta = await requireJourney(journeyId);
    requireOwner(meta, identity);
    if (meta.status === "active") return { journeyId, status: "active" };
    try {
      await db.reopenJourney({ journeyId, tenantId: meta.tenantId, reopenedAt: Date.now() });
    } catch (e) {
      if (!isConditionFailure(e)) throw e;
      throw err(409, "not_completed");
    }
    return { journeyId, status: "active" };
  }

  /**
   * Irreversibly delete a journey and everything it owns. Kelabos it was
   * linked to are never touched — only their mirror of this journey goes
   * (docs 20 §14.1). Owner-only, allowed even while completed (deleting a
   * completed journey is not a "write" the freeze in §3.1 is about).
   */
  async function deleteJourney({ journeyId, identity }) {
    const meta = await requireJourney(journeyId);
    requireOwner(meta, identity);
    const links = await db.listJourneyLinks(journeyId);
    await db.deleteJourneyChildren(journeyId);
    for (const link of links) {
      await db.deleteKelaboJourneyMirror(link.kelaboId, journeyId).catch(() => {});
    }
    // META last: a crash before this point leaves a resumable job (the
    // journey still exists and can be deleted again), never an orphan.
    await db.deleteJourneyMeta(journeyId);
    return { journeyId, deleted: true, kelabosUnlinked: links.length };
  }

  // --- accessors (private journeys only) -------------------------------------

  async function listAccessors({ journeyId, identity }) {
    const meta = await requireJourney(journeyId);
    await requireMember(meta, identity);
    const rows = await db.listAccessors(journeyId);
    return { accessors: rows.map((r) => ({ identity: r.identity, addedBy: r.addedBy, addedAt: r.addedAt })) };
  }

  async function addAccessor({ journeyId, identity, body }) {
    const meta = await requireJourney(journeyId);
    requireOwner(meta, identity);
    requireActive(meta);
    if (meta.visibility !== "private") throw err(409, "not_private");
    const target = body.identity.trim().toLowerCase();
    const existing = await db.getAccessor(journeyId, target);
    if (!existing) {
      const now = Date.now();
      await db.putAccessor(journeyId, { identity: target, addedBy: identity, addedAt: now });
      await db.updateJourneyMeta(journeyId, { accessorCount: (meta.accessorCount || 0) + 1, updatedAt: now });
    }
    return { journeyId, identity: target };
  }

  async function removeAccessor({ journeyId, identity, target }) {
    const meta = await requireJourney(journeyId);
    requireOwner(meta, identity);
    requireActive(meta);
    const existing = await db.getAccessor(journeyId, target);
    if (existing) {
      await db.removeAccessor(journeyId, target);
      await db.updateJourneyMeta(journeyId, {
        accessorCount: Math.max(0, (meta.accessorCount || 0) - 1),
        updatedAt: Date.now(),
      });
    }
    return { journeyId, identity: target };
  }

  // --- kelabo membership ------------------------------------------------------

  /**
   * Link an existing kelabo into a journey. The actor must be a member of
   * the journey (public-tenant or private-accessor) AND host/participant of
   * the kelabo being linked — the first authorizes touching this journey,
   * the second stops pulling in a kelabo you had nothing to do with.
   */
  async function linkKelabo({ journeyId, identity, kelaboId }) {
    const meta = await requireJourney(journeyId);
    await requireMember(meta, identity);
    requireActive(meta);
    const kelaboMeta = await db.getKelaboMeta(kelaboId);
    if (!kelaboMeta) throw err(404, "kelabo_not_found");
    const isTargetMember =
      kelaboMeta.hostIdentity === identity ||
      (kelaboMeta.participants || []).some((p) => p.identity === identity);
    if (!isTargetMember) throw err(403, "not_kelabo_member");

    const now = Date.now();
    try {
      await db.linkKelaboToJourney({
        journeyId,
        kelaboId,
        link: {
          kelaboId,
          titleSnapshot: kelaboMeta.title,
          hostIdentitySnapshot: kelaboMeta.hostIdentity,
          linkedBy: identity,
          linkedAt: now,
          statusSnapshot: kelaboMeta.status,
        },
        mirror: {
          journeyId,
          journeyTitleSnapshot: meta.title,
          journeyVisibilitySnapshot: meta.visibility,
          linkedAt: now,
          linkedBy: identity,
        },
      });
    } catch (e) {
      if (!isConditionFailure(e)) throw e;
      // Either already linked (idempotent — land on "linked", not an error)
      // or the journey completed mid-request.
      const existing = await db.getJourneyLink(journeyId, kelaboId);
      if (existing) return { journeyId, kelaboId, linked: true };
      throw err(409, "journey_completed");
    }
    // Only on a genuine new link — the idempotent branch above must not
    // double-post the same event to the timeline.
    await db.putJourneyTimelineEntry(journeyId, {
      type: "kelabo_linked",
      summary: `Linked kelabo: ${kelaboMeta.title}`,
      actor: identity,
      at: now,
      // statusSnapshot lets the SPA route a click at the right shape
      // (docs 20 §9.3/§13) — a point-in-time snapshot, same as the link
      // record's own, not a live value.
      detail: { kelaboId, statusSnapshot: kelaboMeta.status },
    });
    // Contributor stats (docs 20 §10) settle immediately for a kelabo that
    // has already ended — its participant list is final. A kelabo linked
    // while still live settles when it ends instead (not built in this
    // pass: that half needs a hook in the Gateway's own end-of-kelabo path,
    // gateway/src/archive.js, which this change deliberately does not
    // touch — the common case of linking a kelabo that already happened is
    // covered either way).
    if (kelaboMeta.status === "ended") {
      const history = await db.getHistory(kelaboId).catch(() => null);
      for (const p of history?.participantIdentities || []) {
        await db.bumpContributor(journeyId, p, "kelaboJoinCount").catch(() => {});
      }
    }
    return { journeyId, kelaboId, linked: true };
  }

  async function unlinkKelabo({ journeyId, identity, kelaboId }) {
    const meta = await requireJourney(journeyId);
    await requireMember(meta, identity);
    const link = await db.getJourneyLink(journeyId, kelaboId);
    if (!link) throw err(404, "kelabo_not_found");
    await db.unlinkKelaboFromJourney({ journeyId, kelaboId, now: Date.now() });
    await db.putJourneyTimelineEntry(journeyId, {
      type: "kelabo_unlinked",
      summary: `Unlinked kelabo: ${link.titleSnapshot}`,
      actor: identity,
      at: Date.now(),
      detail: { kelaboId, statusSnapshot: link.statusSnapshot },
    });
    return { journeyId, kelaboId, unlinked: true };
  }

  async function listLinkedKelabos({ journeyId, identity }) {
    const meta = await requireJourney(journeyId);
    await requireMember(meta, identity);
    const links = await db.listJourneyLinks(journeyId);
    return {
      kelabos: links.map((l) => ({
        kelaboId: l.kelaboId,
        title: l.titleSnapshot,
        hostIdentity: l.hostIdentitySnapshot,
        linkedBy: l.linkedBy,
        linkedAt: l.linkedAt,
        statusSnapshot: l.statusSnapshot,
      })),
    };
  }

  // --- description (versioned) ------------------------------------------------

  async function writeDescriptionVersion({ meta, identity, markdown, changeNote }) {
    const version = (meta.currentDescriptionVersion || 0) + 1;
    const now = Date.now();
    await db.putJourneyDescriptionVersion(meta.journeyId, {
      version,
      markdown,
      editedBy: identity,
      editedAt: now,
      ...(changeNote ? { changeNote } : {}),
    });
    await db.updateJourneyMeta(meta.journeyId, { currentDescriptionVersion: version, updatedAt: now });
    await db.putJourneyTimelineEntry(meta.journeyId, {
      type: "description",
      summary: changeNote ? `Description updated — ${changeNote}` : "Description updated",
      actor: identity,
      at: now,
      detail: { version },
    });
    return version;
  }

  // --- health/progress status (docs 20 §5) ------------------------------------

  // Timeline prose only — the stored/API value stays "green"/"yellow"/"red"
  // (docs 20 §5's contract, unchanged) everywhere except this one sentence a
  // person actually reads. Kept local rather than shared with the SPA's own
  // HEALTH_LABEL (Journeys.jsx): the two have never shared a source of
  // truth (contracts/src/schemas.js and frames.js already carry two
  // independent copies of the bare enum), and a human-readable timeline
  // sentence is a different job from a chip's short label.
  const HEALTH_PROSE = { green: "Full Steam", yellow: "Shoal Waters", red: "Anchored" };

  /**
   * One combined snapshot per update — health and progress are reported
   * together, not as two independently-drifting fields. An omitted field
   * carries forward from META's own cached copy of the current value;
   * `null` explicitly clears it, which `updateJourneyMeta` turns into a
   * REMOVE (docs 20 §5's "genuinely absent, not defaulted").
   */
  async function writeStatusVersion({ meta, identity, health, progress, note, source, reportId }) {
    const version = (meta.currentStatusVersion || 0) + 1;
    const now = Date.now();
    const resolvedHealth = health !== undefined ? health : meta.health ?? null;
    const resolvedProgress = progress !== undefined ? progress : meta.progress ?? null;
    await db.putJourneyStatusVersion(meta.journeyId, {
      version,
      health: resolvedHealth,
      progress: resolvedProgress,
      ...(note ? { note } : {}),
      setBy: identity,
      setAt: now,
      source: source || "manual",
      ...(reportId ? { reportId } : {}),
    });
    await db.updateJourneyMeta(meta.journeyId, {
      currentStatusVersion: version,
      health: resolvedHealth,
      progress: resolvedProgress,
      updatedAt: now,
    });
    const parts = [];
    if (health !== undefined) parts.push(`health: ${resolvedHealth ? HEALTH_PROSE[resolvedHealth] || resolvedHealth : "cleared"}`);
    if (progress !== undefined) parts.push(`progress: ${resolvedProgress ?? "cleared"}`);
    await db.putJourneyTimelineEntry(meta.journeyId, {
      type: "status",
      summary: parts.length ? `Status updated (${parts.join(", ")})` : "Status updated",
      actor: identity,
      at: now,
      detail: { version, health: resolvedHealth, progress: resolvedProgress },
    });
    return version;
  }

  async function updateStatus({ journeyId, identity, body }) {
    const meta = await requireJourney(journeyId);
    await requireMember(meta, identity);
    requireActive(meta);
    if (body.health === undefined && body.progress === undefined && body.note === undefined) {
      throw err(400, "nothing_to_change");
    }
    const version = await writeStatusVersion({
      meta,
      identity,
      health: body.health,
      progress: body.progress,
      note: body.note?.trim() || undefined,
    });
    return { journeyId, version };
  }

  async function getStatusHistory({ journeyId, identity }) {
    const meta = await requireJourney(journeyId);
    await requireMember(meta, identity);
    const versions = await db.listJourneyStatusVersions(journeyId);
    return { versions: versions.map(({ PK, SK, ...v }) => v) };
  }

  // --- timeline (docs 20 §9) ---------------------------------------------------

  async function getTimeline({ journeyId, identity, type, before, limit }) {
    const meta = await requireJourney(journeyId);
    await requireMember(meta, identity);
    const items = await db.listJourneyTimeline(journeyId, { type, before, limit: limit || 50 });
    const entries = items.map(({ PK, SK, ...e }) => e);
    const nextBefore = entries.length ? entries[entries.length - 1].at : undefined;
    return { entries, ...(nextBefore !== undefined ? { nextBefore } : {}) };
  }

  // --- message board (docs 20 §7) ---------------------------------------------
  //
  // Distinct from a kelabo's own board (CONTRIB# rows, fanned out and never
  // edited): a journey message is edited in place, but every edit is kept —
  // the BOARDMSG#<msgId> item is the current head, the #V# chain behind it
  // is immutable. Member-writable, frozen once completed, same as
  // description and status.

  async function addBoardMessage({ journeyId, identity, body }) {
    const meta = await requireJourney(journeyId);
    await requireMember(meta, identity);
    requireActive(meta);
    const msgId = randomUUID();
    const now = Date.now();
    const content = body.content.trim();
    await db.createBoardMessageHead(journeyId, {
      msgId,
      content,
      createdBy: identity,
      createdAt: now,
      version: 1,
      archived: false,
    });
    await db.putBoardMessageVersion(journeyId, { msgId, version: 1, content, action: "created", actor: identity, at: now });
    await db.updateJourneyMeta(journeyId, { boardMessageCount: (meta.boardMessageCount || 0) + 1, updatedAt: now });
    await db.putJourneyTimelineEntry(journeyId, {
      type: "board_message",
      summary: `Message added: ${content.slice(0, 80)}`,
      actor: identity,
      at: now,
      detail: { msgId, action: "created" },
    });
    return { journeyId, msgId, version: 1 };
  }

  async function editBoardMessage({ journeyId, identity, msgId, body }) {
    const meta = await requireJourney(journeyId);
    await requireMember(meta, identity);
    requireActive(meta);
    const head = await db.getBoardMessageHead(journeyId, msgId);
    if (!head) throw err(404, "board_message_not_found");
    if (head.archived) throw err(409, "already_archived");
    const version = head.version + 1;
    const now = Date.now();
    const content = body.content.trim();
    await db.putBoardMessageHead(journeyId, { ...head, content, version, updatedBy: identity, updatedAt: now });
    await db.putBoardMessageVersion(journeyId, { msgId, version, content, action: "edited", actor: identity, at: now });
    await db.putJourneyTimelineEntry(journeyId, {
      type: "board_message",
      summary: `Message edited: ${content.slice(0, 80)}`,
      actor: identity,
      at: now,
      detail: { msgId, action: "edited" },
    });
    return { journeyId, msgId, version };
  }

  /**
   * Archive a board message (docs 20 §7): hidden from the default view,
   * kept in history, reversible — deliberately not a deletion. `content`
   * is untouched; only `archived`/`archivedBy`/`archivedAt` change, so an
   * unarchive can restore exactly what was there. `editBoardMessage`
   * still refuses to touch an archived message (§7): unarchive first.
   */
  async function archiveBoardMessage({ journeyId, identity, msgId }) {
    const meta = await requireJourney(journeyId);
    await requireMember(meta, identity);
    requireActive(meta);
    const head = await db.getBoardMessageHead(journeyId, msgId);
    if (!head) throw err(404, "board_message_not_found");
    // Only the message's own poster or the journey's lead may archive it —
    // any member may still post/read, but removal is narrower than the
    // general write access §3.3 grants everyone else.
    if (identity !== head.createdBy && identity !== meta.ownerIdentity) {
      throw err(403, "not_message_author_or_lead");
    }
    // Idempotent: archiving an already-archived message lands on the same
    // state rather than an error, and must not post a second timeline entry.
    if (head.archived) return { journeyId, msgId, archived: true };
    const version = head.version + 1;
    const now = Date.now();
    await db.putBoardMessageHead(journeyId, { ...head, archived: true, archivedBy: identity, archivedAt: now, version });
    await db.putBoardMessageVersion(journeyId, { msgId, version, content: head.content, action: "archived", actor: identity, at: now });
    await db.updateJourneyMeta(journeyId, {
      boardMessageCount: Math.max(0, (meta.boardMessageCount || 0) - 1),
      updatedAt: now,
    });
    await db.putJourneyTimelineEntry(journeyId, {
      type: "board_message",
      summary: `Message archived: ${head.content.slice(0, 80)}`,
      actor: identity,
      at: now,
      detail: { msgId, action: "archived" },
    });
    return { journeyId, msgId, archived: true };
  }

  /** The reverse of `archiveBoardMessage` — brings a message back into the
   *  default view with its content untouched. `archivedBy`/`archivedAt`
   *  are dropped rather than kept stale, since they describe a state this
   *  message is no longer in; the version chain (`action: "archived"`)
   *  keeps the full fact regardless. */
  async function unarchiveBoardMessage({ journeyId, identity, msgId }) {
    const meta = await requireJourney(journeyId);
    await requireMember(meta, identity);
    requireActive(meta);
    const head = await db.getBoardMessageHead(journeyId, msgId);
    if (!head) throw err(404, "board_message_not_found");
    // Idempotent, same reasoning as archiveBoardMessage.
    if (!head.archived) return { journeyId, msgId, archived: false };
    const { archivedBy, archivedAt, ...rest } = head;
    const version = head.version + 1;
    const now = Date.now();
    await db.putBoardMessageHead(journeyId, { ...rest, archived: false, version, updatedBy: identity, updatedAt: now });
    await db.putBoardMessageVersion(journeyId, { msgId, version, content: head.content, action: "unarchived", actor: identity, at: now });
    await db.updateJourneyMeta(journeyId, { boardMessageCount: (meta.boardMessageCount || 0) + 1, updatedAt: now });
    await db.putJourneyTimelineEntry(journeyId, {
      type: "board_message",
      summary: `Message unarchived: ${head.content.slice(0, 80)}`,
      actor: identity,
      at: now,
      detail: { msgId, action: "unarchived" },
    });
    return { journeyId, msgId, archived: false };
  }

  /** Every message, archived ones included — an archived message is kept,
   *  never erased; only `boardMessageCount` on META reflects the current,
   *  non-archived count. The caller (the SPA) hides archived ones by
   *  default and offers to reveal them, rather than this endpoint doing
   *  the filtering — the collection is small and unpaginated either way. */
  async function listBoardMessages({ journeyId, identity }) {
    const meta = await requireJourney(journeyId);
    await requireMember(meta, identity);
    const heads = await db.listBoardMessageHeads(journeyId);
    return {
      messages: heads
        .sort((a, b) => b.createdAt - a.createdAt)
        .map(({ PK, SK, ...m }) => m),
    };
  }

  async function getBoardMessageHistory({ journeyId, identity, msgId }) {
    const meta = await requireJourney(journeyId);
    await requireMember(meta, identity);
    const versions = await db.listBoardMessageVersions(journeyId, msgId);
    return { versions: versions.map(({ PK, SK, ...v }) => v) };
  }

  // --- documents (docs 20 §8) --------------------------------------------------
  //
  // Pasted or typed text, not file upload — there is no upload capability
  // anywhere in this codebase (docs 20 §8). Added once, never edited; only
  // soft-removed, per "files can be removed, but the record can't be
  // changed."

  async function addDocument({ journeyId, identity, body }) {
    const meta = await requireJourney(journeyId);
    await requireMember(meta, identity);
    requireActive(meta);
    const docId = randomUUID();
    const now = Date.now();
    const content = body.content;
    const item = {
      docId,
      title: body.title.trim(),
      content,
      sizeBytes: Buffer.byteLength(content, "utf8"),
      addedBy: identity,
      addedAt: now,
      removed: false,
    };
    await db.createDocument(journeyId, item);
    await db.updateJourneyMeta(journeyId, { documentCount: (meta.documentCount || 0) + 1, updatedAt: now });
    await db.putJourneyTimelineEntry(journeyId, {
      type: "document",
      summary: `Document added: ${item.title}`,
      actor: identity,
      at: now,
      detail: { docId },
    });
    return { journeyId, docId };
  }

  async function removeDocument({ journeyId, identity, docId }) {
    const meta = await requireJourney(journeyId);
    await requireMember(meta, identity);
    requireActive(meta);
    const document = await db.getDocument(journeyId, docId);
    if (!document) throw err(404, "document_not_found");
    // Only the document's own poster or the journey's lead may remove it —
    // same narrowing as archiveBoardMessage, for the same reason.
    if (identity !== document.addedBy && identity !== meta.ownerIdentity) {
      throw err(403, "not_document_owner_or_lead");
    }
    if (document.removed) return { journeyId, docId, removed: true }; // idempotent
    const now = Date.now();
    await db.putDocument(journeyId, { ...document, removed: true, removedBy: identity, removedAt: now });
    await db.updateJourneyMeta(journeyId, {
      documentCount: Math.max(0, (meta.documentCount || 0) - 1),
      updatedAt: now,
    });
    await db.putJourneyTimelineEntry(journeyId, {
      type: "document",
      summary: `Document removed: ${document.title}`,
      actor: identity,
      at: now,
      detail: { docId },
    });
    return { journeyId, docId, removed: true };
  }

  /** Every document, removed ones included — same visibility rule as the
   *  message board (§7): `documentCount` on META is the active-only count. */
  async function listDocuments({ journeyId, identity }) {
    const meta = await requireJourney(journeyId);
    await requireMember(meta, identity);
    const docs = await db.listDocuments(journeyId);
    return {
      documents: docs
        .sort((a, b) => b.addedAt - a.addedAt)
        .map(({ PK, SK, ...d }) => d),
    };
  }

  async function getDocument({ journeyId, identity, docId }) {
    const meta = await requireJourney(journeyId);
    await requireMember(meta, identity);
    const document = await db.getDocument(journeyId, docId);
    if (!document) throw err(404, "document_not_found");
    const { PK, SK, ...rest } = document;
    return rest;
  }

  async function updateDescription({ journeyId, identity, body }) {
    const meta = await requireJourney(journeyId);
    await requireMember(meta, identity);
    requireActive(meta);
    const version = await writeDescriptionVersion({
      meta,
      identity,
      markdown: body.markdown.trim(),
      changeNote: body.changeNote?.trim() || undefined,
    });
    return { journeyId, version };
  }

  async function getDescriptionHistory({ journeyId, identity }) {
    const meta = await requireJourney(journeyId);
    await requireMember(meta, identity);
    const versions = await db.listJourneyDescriptionVersions(journeyId);
    return { versions: versions.map(({ PK, SK, ...v }) => v) };
  }

  // --- reports (docs 20 §6) ----------------------------------------------------
  //
  // Generation happens in the Gateway, which holds the LLM credential
  // (rest-api's role only has DescribeSecret on it); this creates the
  // pending row, records the ask, and awaits the Gateway's internal call
  // the same way requestMinutes already does. The client re-fetches the
  // finished row afterward rather than trusting this response's body,
  // matching how a kelabo's own minutes are read back separately too.

  async function requestReport({ journeyId, identity, body }) {
    const meta = await requireJourney(journeyId);
    await requireMember(meta, identity);
    requireActive(meta);
    const reportId = randomUUID();
    const now = Date.now();
    const question = body.question.trim();
    await db.putJourneyReport(journeyId, {
      reportId,
      question,
      requestedBy: identity,
      requestedAt: now,
      status: "pending",
    });
    await db.updateJourneyMeta(journeyId, { reportCount: (meta.reportCount || 0) + 1, updatedAt: now });
    await db.putJourneyTimelineEntry(journeyId, {
      type: "report",
      summary: `Report requested: ${question.slice(0, 80)}`,
      actor: identity,
      at: now,
      detail: { reportId },
    });
    // Counts the act of asking, including a request that later fails.
    await db.bumpContributor(journeyId, identity, "reportRequestCount").catch(() => {});
    try {
      await internal.requestJourneyReport(journeyId, { reportId, question }, identity);
    } catch (e) {
      // The Gateway itself marks a report failed for every reason it can
      // observe (docs 20 §16); this only covers the one it cannot — never
      // having been reachable at all, the same distinction endKelabo's
      // `archivePending` already draws.
      await db.markJourneyReportFailed(journeyId, reportId, "gateway_unreachable");
    }
    return { journeyId, reportId, status: "pending" };
  }

  async function listReports({ journeyId, identity }) {
    const meta = await requireJourney(journeyId);
    await requireMember(meta, identity);
    const reports = await db.listJourneyReports(journeyId);
    return {
      reports: reports
        .sort((a, b) => b.requestedAt - a.requestedAt)
        .map(({ PK, SK, ...r }) => r),
    };
  }

  async function getReport({ journeyId, identity, reportId }) {
    const meta = await requireJourney(journeyId);
    await requireMember(meta, identity);
    const report = await db.getJourneyReport(journeyId, reportId);
    if (!report) throw err(404, "report_not_found");
    const { PK, SK, ...rest } = report;
    return rest;
  }

  // --- contributors (docs 20 §10) ----------------------------------------------

  async function listContributors({ journeyId, identity }) {
    const meta = await requireJourney(journeyId);
    await requireMember(meta, identity);
    const rows = await db.listContributors(journeyId);
    return {
      contributors: rows
        .map(({ PK, SK, ...c }) => c)
        .sort((a, b) => (b.kelaboJoinCount || 0) - (a.kelaboJoinCount || 0)),
    };
  }

  return {
    createJourney,
    listJourneys,
    getJourney,
    patchJourney,
    completeJourney,
    reopenJourney,
    deleteJourney,
    listAccessors,
    addAccessor,
    removeAccessor,
    linkKelabo,
    unlinkKelabo,
    listLinkedKelabos,
    updateDescription,
    getDescriptionHistory,
    updateStatus,
    getStatusHistory,
    getTimeline,
    addBoardMessage,
    editBoardMessage,
    archiveBoardMessage,
    unarchiveBoardMessage,
    listBoardMessages,
    getBoardMessageHistory,
    addDocument,
    removeDocument,
    listDocuments,
    getDocument,
    requestReport,
    listReports,
    getReport,
    listContributors,
  };
}
