// What the assistant is told about the journey(s) a live kelabo belongs to
// (docs 20 §12.1) — the PUSH half, pinned into the system prompt the same
// way agent/history.js already pins a host's own past-kelabo minutes.
//
// Not independent of that, despite an earlier version of this comment
// saying otherwise: `historyStillApplies()` below is how `runner.js`
// decides that a kelabo linked to any journey gets that journey's context
// instead of `historyEnabled`'s broader, host-scoped one, not alongside
// it — a journey is the narrower, deliberately-linked record for exactly
// the continuity `historyEnabled` exists to provide more diffusely, and
// having the assistant hold both at once serves nobody. See runner.js's
// own comment at the call site for the reasoning in full.
//
// Reuses gateway/src/journeys.js's own reducers — the same rows a journey
// report reads — rather than a second copy of the same reduction.
import { queryKelaboItems } from "../db.js";
import { getJourneyMeta, latestDescription, activeBoardMessages, activeDocuments, linkedKelaboSummaries, listReadyReports } from "../journeys.js";

// Small on purpose, the same reasoning as HISTORY_LIMIT (history.js): this
// is pinned into the system prompt for EVERY turn of the kelabo, so its
// cost is paid continuously, not once on request like a report's context.
export const JOURNEY_LIMIT = 3;
const BOARD_LIMIT = 5;
const OTHER_KELABOS_LIMIT = 5;
// Documents are the newest addition here — found missing entirely from a
// live production report: asked about a term defined only in a linked
// journey's document, the assistant had no way to know that, and correctly
// (given what it could see) dispatched a sub-agent to research it
// externally instead of just answering from the journey it was already
// linked to. Clipped harder per-document than a report's 3,000 chars
// (buildContext, journeys.js) because this is paid on every turn, not once
// on request — three short reference documents, not the whole library.
const DOCUMENT_LIMIT = 3;
const DOCUMENT_CLIP = 800;
// Ready reports were the one §12.3-promised piece this digest omitted: a
// question the journey has already answered (asked from the Helm, or an
// earlier kelabo's synthesis) was invisible to the live assistant, which
// would cheerfully dispatch a fresh lookup for it. Public reports only —
// this digest is read out to a whole room, and a private report belongs to
// the one person who asked it (docs 20 §6.4). Clips match the pull bundle's
// question clip and stay tighter on the answer: per-turn cost, as above.
const REPORT_LIMIT = 3;
const REPORT_QUESTION_CLIP = 200;
const REPORT_ANSWER_CLIP = 600;
const clip = (s, n) => (typeof s === "string" && s.length > n ? s.slice(0, n) + "…" : s || "");

/**
 * Every journey `kelaboId` is linked to (docs 20 §4.3's mirror on the
 * kelabo's own partition — no new table, no new query shape:
 * `queryKelaboItems` already answers `begins_with(SK, "JOURNEY#")`), each
 * reduced to a small, per-turn-affordable digest.
 */
export async function loadJourneyContext(c, kelaboId) {
  const links = await queryKelaboItems(c, kelaboId, "JOURNEY#").catch(() => []);
  const chosen = links.slice(0, JOURNEY_LIMIT);
  const journeys = await Promise.all(
    chosen.map(async (link) => {
      const journeyId = link.journeyId;
      const [meta, description, board, kelabos, documents, reports] = await Promise.all([
        getJourneyMeta(c, journeyId).catch(() => null),
        latestDescription(c, journeyId).catch(() => ""),
        activeBoardMessages(c, journeyId, BOARD_LIMIT).catch(() => []),
        linkedKelaboSummaries(c, journeyId).catch(() => []),
        activeDocuments(c, journeyId, DOCUMENT_LIMIT).catch(() => []),
        listReadyReports(c, journeyId, REPORT_LIMIT).catch(() => []),
      ]);
      if (!meta) return null;
      // A kelabo with nothing to say (no minutes yet, or the live kelabo
      // itself) contributes noise, not context — the same reasoning
      // history.js already applies to a host's own past kelabos.
      const others = kelabos
        .filter((k) => k.kelaboId !== kelaboId && (k.summary || k.decisions.length || k.actionItems.length))
        .slice(0, OTHER_KELABOS_LIMIT);
      return {
        title: meta.title,
        description: clip(description, 1500),
        health: meta.health || null,
        progress: typeof meta.progress === "number" ? meta.progress : null,
        board: board.map((m) => clip(m.content, 300)),
        documents: documents.map((d) => ({ title: d.title, content: clip(d.content, DOCUMENT_CLIP) })),
        kelabos: others,
        reports: reports.map((r) => ({
          question: clip(r.question, REPORT_QUESTION_CLIP),
          answer: clip(r.answer, REPORT_ANSWER_CLIP),
        })),
      };
    })
  );
  return journeys.filter(Boolean);
}

/**
 * Whether `historyEnabled`'s push should still run for this turn (docs 20
 * §12.1) — `false` the moment `journeys` (the *reduced, reachable* result
 * of `loadJourneyContext`, not the raw link count) is non-empty. Checking
 * the reduced result rather than the raw links is deliberate: a dangling
 * or momentarily-unreachable journey link should fall back to
 * `historyEnabled` if the host opted into it, rather than leaving the
 * assistant with neither source — the same "best-effort, never total
 * silence" posture the rest of this pipeline already keeps.
 */
export function historyStillApplies(meta, journeys) {
  return !!meta?.historyEnabled && journeys.length === 0;
}
