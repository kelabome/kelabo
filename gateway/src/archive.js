import { archiveSchema } from "@kelabo/contracts";
import {
  getMeta,
  updateMeta,
  queryUtt,
  queryContrib,
  queryKelaboItems,
  putHistoryRow,
  putParticipantIndex,
  deleteHostActive,
  putArchiveObject,
  putMinutes,
  getMinutes,
} from "./db.js";
import { parseMinutesJson } from "./agent/serverAgentRunner.js";
import { settleKelaboJoin } from "./journeys.js";

export async function endKelabo(c, kelaboId, { retry = false } = {}) {
  const meta = await getMeta(c, kelaboId);
  if (!meta) return { status: 404, body: { error: "kelabo_not_found" } };
  // A kelabo can be "ended" and still have no record: the control plane marks
  // it ended whether or not this call got through (it must, or an unreachable
  // Gateway would strand it live forever), and this is the only thing that
  // writes the archive. `retry` is that second attempt, and it is not the same
  // as ending twice — `archivePending` on META is what says the first one never
  // landed, and it is cleared below.
  const resuming = retry && meta.archivePending === true;
  if (meta.status === "ended" && !resuming) return { status: 409, body: { error: "already_ended" } };

  // A resumed end keeps the moment the kelabo actually stopped. Stamping
  // `Date.now()` on the retry would silently stretch the kelabo by however long
  // the Gateway was unreachable, and that number is on the record forever.
  const endedAt = (resuming && typeof meta.endedAt === "number" ? meta.endedAt : null) ?? Date.now();
  const agentRuntime = c.tunnel.attachedRuntime(kelaboId);

  // Use any minutes already generated during the kelabo (e.g. via the
  // "Generate minutes" button); do NOT block on generating a fresh summary here.
  // The summary is produced asynchronously afterwards so the kelabo closes fast.
  let minutes = null;
  let sessionArchive = null;
  if (agentRuntime) {
    sessionArchive = await c.tunnel.requestDevArchive(kelaboId);
  }
  if (meta.hasMinutes) {
    minutes = await getMinutes(c, kelaboId).catch(() => null);
  }

  const transcript = sessionArchive?.transcript ?? (await queryUtt(c, kelaboId)).map((i) => ({
    kelaboId,
    clientId: i.clientId ?? "",
    speaker: i.speaker,
    text: i.text,
    tStart: i.tStart,
    tEnd: i.tEnd,
    isFinal: true,
    tenantId: i.tenantId,
    ...(i.source ? { source: i.source } : {}),
    // Wall clock, so the record can show which DAY a line was said — a kelabo
    // can span days, and meeting-relative offsets stop meaning anything then.
    ...(typeof i.at === "number" ? { at: i.at } : {}),
  }));
  const board = sessionArchive?.board ?? (await queryContrib(c, kelaboId)).map((i) => ({
    id: i.id ?? `${kelaboId}:${i.SK}`,
    kelaboId,
    tag: i.tag,
    kind: i.kind,
    title: i.title,
    to: i.to,
    markdown: i.markdown,
    sources: i.sources,
    author: i.author,
    origin: i.origin,
    at: i.at,
    tenantId: i.tenantId,
  }));

  const participants = (sessionArchive?.participants ?? meta.participants ?? []).map((p) => ({
    identity: p.identity,
    displayName: p.displayName ?? p.identity,
    isGuest: !!p.isGuest,
  }));

  const archive = {
    archiveId: kelaboId,
    kelaboId,
    title: sessionArchive?.title ?? meta.title ?? "",
    host: sessionArchive?.host ?? meta.hostIdentity ?? "",
    participants,
    startedAt: sessionArchive?.startedAt ?? meta.startedAt ?? meta.createdAt ?? endedAt,
    endedAt,
    transcript,
    board,
    ...(minutes ? { minutes } : {}),
    ...(meta.isCall ? { isCall: true } : {}),
    tenantId: meta.tenantId,
  };
  const valid = archiveSchema.safeParse(archive);
  if (!valid.success) c.log("archive_schema_warning", { kelaboId, issues: valid.error.issues.slice(0, 3) });

  const s3Key = `${c.config.archiveKeyPrefix}/${archive.host}/${archive.archiveId}.json`;
  try {
    await putArchiveObject(c, s3Key, archive);
  } catch (err) {
    c.logError("archive_s3_put_failed", err, { kelaboId });
    return { status: 500, body: { error: "internal_error" } };
  }

  // Whether the record exists. Reported back so the control plane knows
  // whether to leave `archivePending` set — a swallowed failure here is the
  // record silently not existing, which is what this whole path is about.
  let archived = false;
  try {
    await putHistoryRow(c, {
      archiveId: archive.archiveId,
      kelaboId,
      title: archive.title,
      host: archive.host,
      startedAt: archive.startedAt,
      endedAt: archive.endedAt,
      participantIdentities: participants.map((p) => p.identity),
      participantCount: participants.length,
      boardCount: board.length,
      hasMinutes: !!minutes,
      ...(archive.isCall ? { isCall: true } : {}),
      s3Key,
      tenantId: archive.tenantId,
    });
    for (const p of participants) {
      if (p.isGuest) continue;
      await putParticipantIndex(c, archive, p, { hasMinutes: !!(minutes || meta.hasMinutes) }).catch((err) =>
        c.logError("participant_index_failed", err, { kelaboId, identity: p.identity })
      );
    }
    archived = true;
  } catch (err) {
    c.logError("history_write_failed", err, { kelaboId });
  }

  const ttl = Math.floor(endedAt / 1000) + (c.config.retentionDays ?? 30) * 86400;
  try {
    await updateMeta(c, kelaboId, {
      status: "ended",
      endedAt,
      hasMinutes: !!(minutes || meta.hasMinutes),
      tenantStatus: `${meta.tenantId ?? ""}#ended`,
      // Cleared only once the row is actually there, so a second retry still
      // finds something to resume.
      ...(archived ? { archivePending: null } : { archivePending: true }),
      ttl,
    });
    await deleteHostActive(c, meta.hostIdentity);
  } catch (err) {
    c.logError("meta_end_update_failed", err, { kelaboId });
  }

  // Settle kelaboJoinCount for every journey this kelabo is linked to (docs
  // 20 §10 — closing the half deferred when linking-an-already-ended-kelabo
  // was first built). Independent of whether the history write above
  // succeeded: a journey's roster reflects this kelabo having happened
  // either way, and `settleKelaboJoin` is itself safe to call more than once
  // (see its own comment) so this cannot double-count on a retried end.
  try {
    const links = await queryKelaboItems(c, kelaboId, "JOURNEY#");
    const participantIdentities = participants.map((p) => p.identity);
    for (const link of links) {
      await settleKelaboJoin(c, link.journeyId, kelaboId, participantIdentities).catch((err) =>
        c.logError("journey_join_settle_failed", err, { kelaboId, journeyId: link.journeyId })
      );
    }
  } catch (err) {
    c.logError("journey_link_lookup_failed", err, { kelaboId });
  }

  // Drop the call roster before closing the streams: `ended` ends every SSE
  // response, and each close would otherwise fire a per-peer "left" fan-out
  // into a room that no longer has subscribers.
  c.rtcRoom?.closeKelabo(kelaboId);
  // Per-kelabo caption bookkeeping dies with the kelabo.
  c.state.lastCaption.delete(kelaboId);
  c.sseHub.ended(kelaboId, { reason: "ended" });
  c.log("kelabo_ended", { kelaboId, mode: agentRuntime || "server", utterances: transcript.length, contributions: board.length });

  // Generate the summary/minutes asynchronously so ending the kelabo is fast.
  // The dev-mode tunnel must stay open until the summary is requested, so
  // endTunnel (which closes it) is deferred until after the async work below.
  // Discard any buffered (not yet LLM-submitted) turn — minutes are generated
  // from the persisted transcript, so the buffer is no longer needed.
  c.messageBuffer?.drop(kelaboId);
  if (!minutes) {
    generateMinutesInBackground(c, kelaboId, archive, s3Key, agentRuntime)
      .catch((err) => c.logError("async_minutes_failed", err, { kelaboId }))
      .finally(() => {
        c.agentDispatcher.drop(kelaboId);
        c.tunnel.endTunnel(kelaboId);
      });
  } else {
    c.agentDispatcher.drop(kelaboId);
    c.tunnel.endTunnel(kelaboId);
  }

  return { status: 200, body: { ok: true, archived, archiveId: archive.archiveId, s3Key } };
}

async function generateMinutesInBackground(c, kelaboId, archive, s3Key, agentRuntime) {
  let minutes = null;
  if (agentRuntime) {
    const summary = await c.tunnel.requestDevSummary(kelaboId).catch(() => null);
    if (summary) minutes = parseMinutesJson(summary.text, kelaboId, agentRuntime);
  } else if (c.state.agentWorkers.has(kelaboId)) {
    minutes = await c.agentDispatcher.summarize(kelaboId).catch(() => null);
  }
  if (!minutes) return;

  // Untitled kelabo? Adopt the AI-generated title from the minutes and mark
  // it as generated, so the records list can label it.
  const UNTITLED = new Set(["", "untitled kelabo"]);
  const titleGenerated = !!minutes.title && UNTITLED.has((archive.title || "").trim().toLowerCase());
  if (titleGenerated) {
    archive.title = minutes.title;
    await updateMeta(c, kelaboId, { title: minutes.title, titleGenerated: true }).catch((err) =>
      c.logError("title_meta_update_failed", err, { kelaboId })
    );
  }

  // Persist the minutes doc and mark the kelabo as having minutes.
  await putMinutes(c, minutes).catch((err) => c.logError("minutes_put_failed", err, { kelaboId }));
  await updateMeta(c, kelaboId, { hasMinutes: true }).catch((err) =>
    c.logError("minutes_meta_update_failed", err, { kelaboId })
  );
  // Merge minutes into the archived object and re-write it.
  try {
    await putArchiveObject(c, s3Key, { ...archive, minutes });
  } catch (err) {
    c.logError("archive_minutes_merge_failed", err, { kelaboId });
  }
  // Update the history row's hasMinutes flag.
  await putHistoryRow(c, {
    archiveId: archive.archiveId,
    kelaboId,
    title: archive.title,
    ...(titleGenerated ? { titleGenerated: true } : {}),
    host: archive.host,
    startedAt: archive.startedAt,
    endedAt: archive.endedAt,
    participantIdentities: archive.participants.map((p) => p.identity),
    participantCount: archive.participants.length,
    boardCount: (archive.board || []).length,
    hasMinutes: true,
    ...(archive.isCall ? { isCall: true } : {}),
    s3Key,
    tenantId: archive.tenantId,
  }).catch((err) => c.logError("history_minutes_update_failed", err, { kelaboId }));
  // The records list reads participant-index rows — propagate the flag there too.
  for (const p of archive.participants) {
    if (p.isGuest) continue;
    await putParticipantIndex(c, archive, p, { hasMinutes: true, titleGenerated }).catch((err) =>
      c.logError("participant_index_minutes_failed", err, { kelaboId, identity: p.identity })
    );
  }
  c.log("minutes_generated_async", { kelaboId, generatedBy: minutes.generatedBy });
}

/**
 * Tear down a scheduled kelabo the REST API just cancelled (docs 18 §2.4). The
 * durable state — `status: "cancelled"` on META, the TTL — is already written by
 * REST; this is the in-process half. It notifies a prep-bound agent, drops every
 * per-kelabo map, and closes any streams. Unlike `endKelabo` there is no
 * archive, no minutes and no history row: a cancelled kelabo never happened.
 *
 * `prepByKelabo` is cleared here — the one map `endKelabo` never touches — so a
 * prep binding for a cancelled kelabo does not linger.
 */
export async function cancelKelabo(c, kelaboId) {
  const meta = await getMeta(c, kelaboId);
  if (!meta) return { status: 404, body: { error: "kelabo_not_found" } };

  // Tell any attached/prep agent the kelabo is gone before dropping bindings.
  c.tunnel.notifyKelabo(kelaboId, "cancelled");

  c.state.prepByKelabo.delete(kelaboId);
  c.state.tunnelByKelabo.delete(kelaboId);
  c.state.promotedByKelabo.delete(kelaboId);
  c.state.lastCaption.delete(kelaboId);

  // Same ordering rationale as endKelabo: drop the call roster before closing
  // the streams so `ended` does not fire a per-peer "left" into an empty room.
  c.rtcRoom?.closeKelabo(kelaboId);
  c.sseHub.ended(kelaboId, { reason: "cancelled" });
  c.messageBuffer?.drop(kelaboId);
  c.agentDispatcher.drop(kelaboId);

  c.log("kelabo_cancelled", { kelaboId });
  return { status: 200, body: { ok: true, status: "cancelled" } };
}

/**
 * Re-notify a prep-bound agent that a scheduled kelabo moved (docs 18 §3.3).
 * The new time lives on META (written by REST); the agent will re-read the
 * briefing. Nothing is torn down — the kelabo still exists.
 */
export async function rescheduleKelabo(c, kelaboId) {
  const meta = await getMeta(c, kelaboId);
  if (!meta) return { status: 404, body: { error: "kelabo_not_found" } };
  c.tunnel.notifyKelabo(kelaboId, "rescheduled", { scheduledAt: meta.scheduledAt });
  c.log("kelabo_rescheduled", { kelaboId, scheduledAt: meta.scheduledAt });
  return { status: 200, body: { ok: true, status: "scheduled" } };
}
