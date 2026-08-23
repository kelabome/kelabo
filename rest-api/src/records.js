import { S3Client, GetObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { cutoffFromAge } from "@kelabo/contracts/retention";
import { err } from "./errors.js";

// A purge deletes an unbounded amount of data, so cap the work per request and
// let the caller loop. Keeps us well inside the Lambda timeout and makes the
// operation resumable instead of half-finished on a timeout.
const MAX_PURGE_PER_CALL = 50;

export function createRecords({ config, db, s3 }) {
  const client =
    s3 || new S3Client({ region: config.region || process.env.AWS_REGION });

  async function listRecords({ identity }) {
    const items = await db.listRecordsByParticipant(identity);
    const seen = new Set();
    const rows = [];
    for (const it of items) {
      // Participant-index rows use a composite key
      // (archiveId = "PARTICIPANT#<identity>#<realArchiveId>") whose `kelaboId`
      // attribute holds the real archive id. Use that so the record link resolves.
      // `meetingId` is the pre-rename spelling — rows written before 2026-07-31
      // still carry it, and reading it is the difference between old records
      // opening and old records breaking.
      const archiveId = it.kelaboId || it.meetingId || it.archiveId;
      if (seen.has(archiveId)) continue;
      seen.add(archiveId);
      rows.push({ archiveId, it });
    }
    // hasMinutes/participantCount on index rows are only populated for archives
    // written after those fields existed — read the authoritative history row
    // instead (also self-heals rows written before the flag was propagated).
    const records = await Promise.all(
      rows.map(async ({ archiveId, it }) => {
        const main = await db.getHistory(archiveId).catch(() => null);
        return {
          archiveId,
          title: main?.title ?? it.title,
          titleGenerated: !!(main?.titleGenerated ?? it.titleGenerated),
          startedAt: main?.startedAt ?? it.startedAt,
          endedAt: main?.endedAt ?? it.endedAt,
          participantCount: main?.participantCount ?? it.participantCount,
          boardCount: main?.boardCount ?? it.boardCount ?? 0,
          hasMinutes: !!(main?.hasMinutes ?? it.hasMinutes),
          isCall: !!(main?.isCall ?? it.isCall),
        };
      })
    );
    return { records };
  }

  // --- record search (title + minutes full text) ---------------------------
  // Titles come from the Dynamo list and are cheap. Minutes live inside the
  // archive JSON in S3, so that pass is one GET per record — bounded by a cap
  // on how many archives a single search will open, and by an in-process text
  // cache: an archive is immutable once written, so its extracted text never
  // goes stale and never needs fetching twice per warm process.
  const MINUTES_CACHE_MAX = 300;
  const MINUTES_SCAN_CAP = 40;
  const minutesCache = new Map(); // archiveId -> { text, lower } | null

  /** Every human-readable string in a minutes document, flattened. Key-based
   *  skip list rather than a shape walk, so records from before the richer
   *  minutes schema still search. */
  function minutesTextFrom(minutes) {
    const parts = [];
    const walk = (v, key) => {
      if (v == null) return;
      if (typeof v === "string") {
        if (key === "kelaboId" || key === "generatedBy" || key === "url" || key === "due") return;
        parts.push(v);
      } else if (Array.isArray(v)) v.forEach((x) => walk(x, key));
      else if (typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, k);
    };
    walk(minutes, "");
    return parts.join(" · ");
  }

  async function minutesTextOf(archiveId) {
    if (minutesCache.has(archiveId)) return minutesCache.get(archiveId);
    let entry = null;
    try {
      const row = await db.getHistory(archiveId);
      if (row?.s3Key) {
        const archive = await readArchiveObject(row.s3Key);
        if (archive?.minutes) {
          const text = minutesTextFrom(archive.minutes);
          entry = { text, lower: text.toLowerCase() };
        }
      }
    } catch {
      entry = null;
    }
    if (minutesCache.size >= MINUTES_CACHE_MAX) minutesCache.delete(minutesCache.keys().next().value);
    minutesCache.set(archiveId, entry);
    return entry;
  }

  async function searchRecords({ identity, q }) {
    const query = String(q || "").trim().toLowerCase();
    if (query.length < 2) return { results: [] };
    const { records: all } = await listRecords({ identity });
    const brief = (r) => ({
      archiveId: r.archiveId,
      title: r.title,
      endedAt: r.endedAt,
      participantCount: r.participantCount,
      hasMinutes: r.hasMinutes,
      isCall: !!r.isCall,
    });

    const results = [];
    const titleMissed = [];
    for (const r of all) {
      if ((r.title || "").toLowerCase().includes(query)) results.push({ ...brief(r), matched: "title" });
      else titleMissed.push(r);
    }

    // Minutes pass over whatever the title pass did not already claim, most
    // recent first — the record someone is hunting by content is far more
    // often last week's than last year's.
    const withMinutes = titleMissed.filter((r) => r.hasMinutes).sort((a, b) => (b.endedAt || 0) - (a.endedAt || 0));
    const candidates = withMinutes.slice(0, MINUTES_SCAN_CAP);
    const hits = await Promise.all(
      candidates.map(async (r) => {
        const entry = await minutesTextOf(r.archiveId);
        const idx = entry ? entry.lower.indexOf(query) : -1;
        if (idx === -1) return null;
        const start = Math.max(0, idx - 40);
        const end = Math.min(entry.text.length, idx + query.length + 60);
        const snippet = (start > 0 ? "…" : "") + entry.text.slice(start, end) + (end < entry.text.length ? "…" : "");
        return { ...brief(r), matched: "minutes", snippet };
      })
    );
    results.push(...hits.filter(Boolean));
    results.sort((a, b) => (b.endedAt || 0) - (a.endedAt || 0));
    // Honest about bounded coverage: the SPA can say "older minutes not searched".
    return { results, minutesCapped: withMinutes.length > candidates.length };
  }

  async function readArchiveObject(s3Key) {
    const res = await client.send(
      new GetObjectCommand({ Bucket: config.archiveBucket, Key: s3Key })
    );
    const text = await res.Body.transformToString();
    return JSON.parse(text);
  }

  async function getRecord({ identity, archiveId }) {
    const row = await db.getHistory(archiveId);
    if (!row) throw err(404, "record_not_found");
    const allowed =
      row.host === identity ||
      (row.participantIdentities || []).includes(identity);
    if (!allowed) throw err(403, "not_a_participant");

    let archive = null;
    if (row.s3Key) {
      try {
        archive = await readArchiveObject(row.s3Key);
      } catch (e) {
        console.warn(JSON.stringify({ level: "warn", msg: "archive s3 fetch failed", archiveId, error: String(e) }));
      }
    }
    // A kelabo's `JOURNEY#` mirror (docs 20 §4.3) outlives its own ending —
    // only a purge deletes it (§14.3's guard is exactly this fact) — so a
    // record can still say which journeys it is part of. Same `{id, title,
    // visibility}` shape as GET /kelabos/:id, and the same `row.kelaboId ||
    // archiveId` resolution `purgeOne` above already uses for this id.
    const journeys = (await db.listKelaboJourneyLinks(row.kelaboId || archiveId).catch(() => [])).map((l) => ({
      id: l.journeyId,
      title: l.journeyTitleSnapshot || "",
      visibility: l.journeyVisibilitySnapshot,
    }));
    return {
      archiveId,
      title: row.titleGenerated ? row.title : (archive?.title ?? row.title),
      titleGenerated: !!row.titleGenerated,
      startedAt: archive?.startedAt ?? row.startedAt,
      endedAt: archive?.endedAt ?? row.endedAt,
      host: archive?.host ?? row.host,
      participants: archive?.participants ?? [],
      transcript: archive?.transcript ?? [],
      board: archive?.board ?? [],
      ...(archive?.minutes ? { minutes: archive.minutes } : {}),
      journeys,
    };
  }

  async function deleteArchiveObject(s3Key) {
    await client.send(new DeleteObjectCommand({ Bucket: config.archiveBucket, Key: s3Key }));
  }

  /**
   * Irreversibly delete one record and everything behind it.
   *
   * Ordering matters: the history row is deleted LAST. If we die halfway, the
   * row still points at the kelabo/archive so a retry can finish the job.
   * Deleting it first would strip the only pointer to the S3 key and the
   * participant list, orphaning both forever.
   */
  async function purgeOne(row) {
    const archiveId = row.archiveId;
    const kelaboId = row.kelaboId || archiveId;

    // A kelabo linked into a journey survives its host's purge (docs 20
    // §14.3) — the host must unlink it from every journey first. This only
    // ever runs on the host-purge path (the caller has already confirmed
    // `isHost`); a participant dropping their own copy never reaches here
    // and is never blocked by it.
    const journeyLinks = await db.listKelaboJourneyLinks(kelaboId).catch(() => []);
    if (journeyLinks.length) throw err(409, "kelabo_in_journey");

    if (row.s3Key) {
      // A missing object is a success for our purposes — the goal is "gone".
      await deleteArchiveObject(row.s3Key).catch((e) => {
        if (e?.name !== "NoSuchKey" && e?.$metadata?.httpStatusCode !== 404) throw e;
      });
    }

    const items = await db.deleteKelaboPartition(kelaboId);
    if (row.host) await db.deleteHostGuardIfKelabo(row.host, kelaboId);

    // Every participant's view of this record disappears with it; leaving these
    // behind would show phantom rows in their list that 404 when opened.
    for (const identity of row.participantIdentities || []) {
      await db.deleteParticipantIndexRow(identity, archiveId);
    }
    await db.deleteHistoryRow(archiveId);
    return { items };
  }

  /**
   * Purge the caller's records older than `value` `unit`s.
   *
   * Ownership rules — a record is shared between its host and its participants,
   * so "delete" cannot mean the same thing for both:
   *   • host        -> full purge (S3 object, kelabos partition, history row,
   *                    and every participant's index row)
   *   • participant -> only their OWN index row is removed, so the record leaves
   *                    their list while the host's copy is untouched. A guest
   *                    must never be able to destroy the host's minutes.
   *
   * `dryRun` returns the identical report without deleting anything.
   */
  async function purgeRecords({ identity, value, unit, dryRun = false, now = Date.now() }) {
    const cutoff = cutoffFromAge(value, unit, now);

    const items = await db.listRecordsByParticipant(identity);
    const seen = new Set();
    const candidates = [];
    for (const it of items) {
      // `meetingId` is the pre-rename spelling — rows written before 2026-07-31
      // still carry it, and reading it is the difference between old records
      // opening and old records breaking.
      const archiveId = it.kelaboId || it.meetingId || it.archiveId;
      if (seen.has(archiveId)) continue;
      seen.add(archiveId);
      // The index row's endedAt is the GSI sort key and always present; fall
      // back to startedAt so a malformed row is never treated as age 0 (which
      // would make it eligible for deletion by default).
      const endedAt = it.endedAt ?? it.startedAt;
      if (!Number.isFinite(endedAt) || endedAt >= cutoff) continue;
      candidates.push({ archiveId, endedAt });
    }
    candidates.sort((a, b) => a.endedAt - b.endedAt); // oldest first

    const batch = candidates.slice(0, MAX_PURGE_PER_CALL);
    const purged = [];
    const removedFromList = [];
    const skipped = [];
    const failed = [];

    for (const c of batch) {
      const row = await db.getHistory(c.archiveId).catch(() => null);
      if (!row) {
        // Index row with no authoritative row behind it: a leftover. Removing it
        // is the whole fix, and it is safe because it is the caller's own row.
        if (!dryRun) await db.deleteParticipantIndexRow(identity, c.archiveId).catch(() => {});
        removedFromList.push({ archiveId: c.archiveId, reason: "orphan_index_row" });
        continue;
      }
      const isHost = row.host === identity;
      const entry = { archiveId: c.archiveId, title: row.title ?? null, endedAt: row.endedAt ?? c.endedAt };

      // Never delete under a kelabo that has not finished — records only exist
      // post-end, but a stale/rewritten row must not take a live kelabo with it.
      if (!row.endedAt) {
        skipped.push({ ...entry, reason: "not_ended" });
        continue;
      }

      if (!isHost) {
        if (!dryRun) {
          await db
            .deleteParticipantIndexRow(identity, c.archiveId)
            .catch((e) => failed.push({ ...entry, error: String(e?.message || e) }));
        }
        removedFromList.push({ ...entry, reason: "not_host" });
        continue;
      }

      if (dryRun) {
        purged.push(entry);
        continue;
      }
      try {
        const { items: deleted } = await purgeOne(row);
        purged.push({ ...entry, items: deleted });
      } catch (e) {
        failed.push({ ...entry, error: String(e?.message || e) });
      }
    }

    return {
      dryRun,
      cutoff,
      matched: candidates.length,
      remaining: Math.max(0, candidates.length - batch.length),
      purged,
      removedFromList,
      skipped,
      failed,
    };
  }

  /**
   * Delete a single record on the caller's behalf.
   *
   * Same ownership rules as the bulk purge — a host destroys the record, a
   * participant only drops it from their own list — but addressed by id and
   * with no age cutoff, so the SPA can offer "remove this one" directly.
   *
   * Returns how it was handled so the caller can word its confirmation
   * honestly ("deleted" vs "removed from your list").
   */
  async function deleteRecord({ identity, archiveId }) {
    // Authorises as a side effect: getRecord throws 403/404 unless the caller
    // is the host or a participant, so we never act on someone else's record.
    await getRecord({ identity, archiveId });

    const row = await db.getHistory(archiveId).catch(() => null);
    if (!row) {
      // Orphan index row: removing it is the whole fix, and it is the caller's.
      await db.deleteParticipantIndexRow(identity, archiveId).catch(() => {});
      return { archiveId, outcome: "removed_from_list", reason: "orphan_index_row" };
    }
    // A live kelabo must never be taken down by a record deletion.
    if (!row.endedAt) throw err(409, "not_ended", "This kelabo has not ended yet.");

    if (row.host !== identity) {
      await db.deleteParticipantIndexRow(identity, archiveId);
      return { archiveId, outcome: "removed_from_list", reason: "not_host" };
    }
    const { items } = await purgeOne(row);
    return { archiveId, outcome: "purged", items };
  }

  return { listRecords, getRecord, searchRecords, purgeRecords, deleteRecord };
}
