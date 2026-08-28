// Kelabo Agent Protocol (KAP) — the frames carried over WSS /rig between the
// Gateway and a developer's local agent bridge (docs 16).
//
// The protocol is deliberately runtime-agnostic: nothing here names opencode,
// Claude Code or any other coding agent. `sessionRef` and `workspace` are opaque
// strings the Gateway stores and never interprets, so adding a runtime is an
// adapter in the bridge rather than a change to this file.
//
// Two things are absent on purpose:
//   * `[LLM_CON]`. A contribution is structured. Marker parsing cannot tell a
//     deliberate board post from the agent answering the developer's own typed
//     question, and in an interactive session both happen in one transcript.
//   * `:KELABO-END`. Summary and archive are requestId-correlated `request`
//     frames. As an in-band caption token it fired on any caption merely
//     *containing* the string, and the reply had to be stolen off the board.
import { z } from "zod";
import { archiveSchema, contributionSourceSchema, kelaboParticipantSchema } from "./schemas.js";

// ---------------------------------------------------------------------------
// Up: bridge -> Gateway
// ---------------------------------------------------------------------------

/** Who is on the other end. Free-form strings: the Gateway logs and displays
 *  these, and must not branch on them. */
export const agentInfoSchema = z.object({
  runtime: z.string().min(1).max(64),
  version: z.string().max(64).default(""),
  // Shown on the board next to the agent's posts, e.g. "alice's opencode".
  label: z.string().max(80).default(""),
});

export const frameRegisterSchema = z.object({
  type: z.literal("register"),
  token: z.string().min(1),
  agent: agentInfoSchema,
});

export const frameHeartbeatSchema = z.object({
  type: z.literal("heartbeat"),
});

/** Bind this agent session to a kelabo. Whether the binding receives transcript
 *  is decided by the kelabo's status on the Gateway, never by the client. */
export const frameAttachSchema = z.object({
  type: z.literal("attach"),
  kelaboId: z.string().min(1),
  runtime: z.string().min(1).max(64),
  // Opaque handle for the runtime's own session. Empty is legal: a runtime that
  // pushes into "the session that spawned me" (a Claude Code channel) has no id
  // to give, and the previous protocol rejected those frames outright.
  sessionRef: z.string().max(256).default(""),
  workspace: z.string().max(1024).default(""),
});

// A board card, in any of its states. One lookup is one card: it appears as
// `working` the moment the agent takes the question, and the same frame type
// later carries the answer. That is the same lifecycle the in-ECS agent already
// publishes (docs 14 §5) — a dev agent joins the existing channel rather than
// getting a second one.
//
// `markdown` is optional here because a `working` card has no body yet. The
// "a finished card must say something" rule is enforced at the Gateway, not in
// this schema: a discriminated-union member has to stay a plain object.
export const frameContributionSchema = z.object({
  type: z.literal("contribution"),
  kelaboId: z.string().min(1),
  markdown: z.string().default(""),
  to: z.string().max(80).default("all"),
  title: z.string().max(200).default(""),
  kind: z.enum(["answer", "link", "code", "clarify", "note"]).default("answer"),
  sources: z.array(contributionSourceSchema).max(20).optional(),
  // Which card this frame writes to. Stable across a card's updates, and scoped
  // to the sending connection: the Gateway maps it to the real contribution id,
  // so an agent can only ever address a card it opened itself.
  card: z.string().min(1).max(128).optional(),
  status: z.enum(["working", "done", "skipped"]).default("done"),
  // The live status line, and the trail of what has been done so far. Both are
  // dropped when the card finishes — see the SPA's board reducer.
  progress: z.string().max(200).optional(),
  steps: z.array(z.string().max(200)).max(6).optional(),
  // Why nothing is coming, on a `skipped` card.
  reason: z.string().max(300).optional(),
  // Client-side idempotency key, so a retry after a dropped socket does not
  // double-post.
  ref: z.string().max(128).optional(),
});

export const frameSummarySchema = z.object({
  type: z.literal("summary"),
  requestId: z.string().min(1),
  kelaboId: z.string().min(1),
  // Raw model output. The Gateway parses it with the same tolerant reader it
  // uses for the server agent, so a half-formed answer still yields minutes.
  text: z.string(),
});

export const frameArchiveSchema = z.object({
  type: z.literal("archive"),
  requestId: z.string().min(1),
  archive: archiveSchema,
});

export const frameRenameSchema = z.object({
  type: z.literal("rename"),
  kelaboId: z.string().min(1),
  title: z.string().min(1).max(200),
});

/** Read the kelabo's board. Served over the tunnel rather than the REST board
 *  route, whose participant cookie cannot exist before a kelabo starts — and
 *  seeing its own earlier posts is exactly what a preparing agent needs. */
export const frameBoardRequestSchema = z.object({
  type: z.literal("board_request"),
  requestId: z.string().min(1),
  kelaboId: z.string().min(1),
});

/** Read the minutes of the host's past kelabos. Answered only when the host
 *  opted in at creation (`historyEnabled`) — the same gate, and the same
 *  minutes-not-transcripts reduction, as the in-ECS agent's memory of earlier
 *  kelabos, so the tunnel never widens what the host already granted. */
export const frameHistoryRequestSchema = z.object({
  type: z.literal("history_request"),
  requestId: z.string().min(1),
  kelaboId: z.string().min(1),
});

export const frameDetachSchema = z.object({
  type: z.literal("detach"),
  kelaboId: z.string().min(1).optional(),
});

// --- journey pull tools (docs 20 §12.2) -------------------------------------
//
// A kelabo may be linked to more than one journey (docs 20 §4.3's mirror has
// no cap — `JOURNEY_LIMIT` in agent/journeyContext.js bounds only how many
// feed the system prompt). None of these carry a required journeyId for that
// reason: an omitted one resolves against the kelabo's own links, the same
// "enumerate rather than guess" idiom `kelabo_join`'s omitted kelaboId
// already uses — see `resolved`/`journeys` on each response below.
//
// `kelaboId` is optional on every one of these (docs 20 §12.3): a session may
// be attached to a journey *directly* (`journey_attach`, below) with no kelabo
// at all — the offline "work between kelabos" mode. Present, it means "resolve
// against that kelabo's links, which I must be attached to"; absent, "resolve
// against this connection's own journey attachments".

/**
 * Bind this agent session to a journey directly — no kelabo required, no
 * transcript ever flows. This is the offline mode (docs 20 §12.3): read the
 * journey's accumulated context, work in the developer's own session, and
 * post the outcome to the journey's board. requestId-correlated (answered by
 * `journey_briefing`) rather than answered with `rejected`, because unlike a
 * kelabo attach it can be one of several and a bare `rejected` cannot say
 * which request it refuses.
 */
export const frameJourneyAttachSchema = z.object({
  type: z.literal("journey_attach"),
  requestId: z.string().min(1),
  journeyId: z.string().min(1),
});

export const frameJourneyDetachSchema = z.object({
  type: z.literal("journey_detach"),
  // Omitted: detach from every journey this connection is attached to.
  journeyId: z.string().min(1).optional(),
});

export const frameJourneyInfoRequestSchema = z.object({
  type: z.literal("journey_info_request"),
  requestId: z.string().min(1),
  kelaboId: z.string().min(1).optional(),
  journeyId: z.string().min(1).optional(),
});

/**
 * The one-call context load (docs 20 §12.3): the same bundle the in-ECS
 * agent's system prompt gets pushed per turn (agent/journeyContext.js) —
 * description, status, pinned board, document excerpts, linked kelabos
 * reduced to their minutes, recent reports — served on demand to a dev
 * agent. Clipped Gateway-side; the full text of one document or report is
 * `journey_documents_request`/`journey_reports_request` below.
 */
export const frameJourneyContextRequestSchema = z.object({
  type: z.literal("journey_context_request"),
  requestId: z.string().min(1),
  kelaboId: z.string().min(1).optional(),
  journeyId: z.string().min(1).optional(),
});

/** The journey's linked kelabos, each reduced to its stored minutes — the
 *  same minutes-not-transcripts reduction `history_request` already applies
 *  to a host's past kelabos, so this never widens what a kelabo's own
 *  participants granted (docs 20 §12.3). */
export const frameJourneyKelabosRequestSchema = z.object({
  type: z.literal("journey_kelabos_request"),
  requestId: z.string().min(1),
  kelaboId: z.string().min(1).optional(),
  journeyId: z.string().min(1).optional(),
});

/** Without `docId`: the list (titles and sizes, no content). With one: that
 *  document's full text — pull-on-demand, where the push context clips to an
 *  excerpt (docs 20 §12.3). */
export const frameJourneyDocumentsRequestSchema = z.object({
  type: z.literal("journey_documents_request"),
  requestId: z.string().min(1),
  kelaboId: z.string().min(1).optional(),
  journeyId: z.string().min(1).optional(),
  docId: z.string().min(1).optional(),
});

/** Without `reportId`: the list of ready reports (questions, no answers).
 *  With one: that report's full question and answer. */
export const frameJourneyReportsRequestSchema = z.object({
  type: z.literal("journey_reports_request"),
  requestId: z.string().min(1),
  kelaboId: z.string().min(1).optional(),
  journeyId: z.string().min(1).optional(),
  reportId: z.string().min(1).optional(),
});

/** `entryType`, not `type` — the frame's own discriminator already owns
 *  that name; this is the timeline's `type` filter (docs 20 §9.2's `?type=`)
 *  under a different key so the two cannot collide on the wire. */
export const frameJourneyTimelineRequestSchema = z.object({
  type: z.literal("journey_timeline_request"),
  requestId: z.string().min(1),
  kelaboId: z.string().min(1).optional(),
  journeyId: z.string().min(1).optional(),
  entryType: z.string().max(40).optional(),
  before: z.number().optional(),
  limit: z.number().int().min(1).max(100).optional(),
});

export const frameJourneyBoardRequestSchema = z.object({
  type: z.literal("journey_board_request"),
  requestId: z.string().min(1),
  kelaboId: z.string().min(1).optional(),
  journeyId: z.string().min(1).optional(),
});

/** The agent's own synthesis, stored directly — no server-side LLM round
 *  trip (docs 20 §12.2's `kelabo_journey_report_submit`, structurally
 *  `kelabo_post`'s fire-and-forget shape with a requestId added: unlike a
 *  board post there is a real failure mode (no such journey) the tool must
 *  be able to tell the model about, so it is request/response like `board`/
 *  `history` rather than fire-and-forget like `contribution`). */
export const frameJourneyReportSubmitSchema = z.object({
  type: z.literal("journey_report_submit"),
  requestId: z.string().min(1),
  kelaboId: z.string().min(1).optional(),
  journeyId: z.string().min(1).optional(),
  question: z.string().min(1).max(2000),
  answer: z.string().min(1).max(8000),
});

/** Write or edit a pinned journey board message. Same request/response
 *  reasoning as `journey_report_submit` above, plus a real permission gate
 *  (`aiCanPost`, docs 20 §7) whose "off" the tool must be able to report —
 *  the same "a real answer, not an error" shape `history`'s `enabled:false`
 *  already uses. */
export const frameJourneyPostSchema = z.object({
  type: z.literal("journey_post"),
  requestId: z.string().min(1),
  kelaboId: z.string().min(1).optional(),
  journeyId: z.string().min(1).optional(),
  content: z.string().min(1).max(4000),
  msgId: z.string().min(1).optional(),
});

/** Discriminated union of all bridge -> Gateway frames. Unknown fields ignored. */
export const upFrameSchema = z.discriminatedUnion("type", [
  frameRegisterSchema,
  frameHeartbeatSchema,
  frameAttachSchema,
  frameContributionSchema,
  frameSummarySchema,
  frameArchiveSchema,
  frameRenameSchema,
  frameBoardRequestSchema,
  frameHistoryRequestSchema,
  frameDetachSchema,
  frameJourneyAttachSchema,
  frameJourneyDetachSchema,
  frameJourneyInfoRequestSchema,
  frameJourneyContextRequestSchema,
  frameJourneyKelabosRequestSchema,
  frameJourneyDocumentsRequestSchema,
  frameJourneyReportsRequestSchema,
  frameJourneyTimelineRequestSchema,
  frameJourneyBoardRequestSchema,
  frameJourneyReportSubmitSchema,
  frameJourneyPostSchema,
]);

// ---------------------------------------------------------------------------
// Down: Gateway -> bridge
// ---------------------------------------------------------------------------

export const frameRegisteredSchema = z.object({
  type: z.literal("registered"),
  agentId: z.string(),
  // The kelabo this agent is already bound to, if the Gateway restored one.
  // Empty means "nothing bound yet"; the bridge attaches explicitly.
  kelaboId: z.string().default(""),
});

export const frameRejectedSchema = z.object({
  type: z.literal("rejected"),
  reason: z.string(),
});

export const briefingInviteeSchema = z.object({
  displayName: z.string(),
  email: z.string().optional(),
  response: z.enum(["accepted", "declined", "pending"]).default("pending"),
  isHost: z.boolean().default(false),
});

/** Everything the agent needs to start working, delivered once on attach. For a
 *  scheduled kelabo this is the whole of its context: there is no transcript. */
export const frameBriefingSchema = z.object({
  type: z.literal("briefing"),
  kelaboId: z.string().min(1),
  status: z.enum(["scheduled", "active"]),
  title: z.string().default(""),
  host: z.string().default(""),
  scheduledAt: z.number().optional(),
  durationMinutes: z.number().optional(),
  startedAt: z.number().optional(),
  // The host's free-text agenda note. Host-authored, unlike everything else here.
  note: z.string().default(""),
  invitees: z.array(briefingInviteeSchema).default([]),
  participants: z.array(kelaboParticipantSchema).default([]),
  // The journeys this kelabo is linked to (docs 20 §12.3) — membership only,
  // so the agent knows there is journey context worth pulling with the
  // kelabo_journey_* tools rather than having to probe for it.
  journeys: z.array(z.object({ journeyId: z.string(), title: z.string() })).default([]),
});

/** One sealed speaker message. `messageId`/`seq` carry the speaker's own message
 *  boundaries (docs 13) so the bridge can coalesce without re-deriving them. */
export const frameTranscriptSchema = z.object({
  type: z.literal("transcript"),
  kelaboId: z.string().min(1),
  messageId: z.string().default(""),
  seq: z.number().default(0),
  speaker: z.string(),
  text: z.string(),
  at: z.number(),
  final: z.boolean().default(true),
  // True for a participant's typed board note rather than spoken words.
  human: z.boolean().default(false),
});

export const frameKelaboSchema = z.object({
  type: z.literal("kelabo"),
  kelaboId: z.string().min(1),
  // `cancelled`/`rescheduled` reach an agent that was *preparing* for a
  // scheduled kelabo (docs 18 §2.4, §3.3): it must learn the kelabo is gone or
  // has moved, since it will otherwise sit on a briefing that no longer holds.
  event: z.enum(["started", "ended", "renamed", "cancelled", "rescheduled"]),
  title: z.string().optional(),
  // Present on `rescheduled`: the new intended start (epoch ms).
  scheduledAt: z.number().optional(),
});

export const frameRequestSchema = z.object({
  type: z.literal("request"),
  kind: z.enum(["summary", "archive"]),
  requestId: z.string().min(1),
  kelaboId: z.string().min(1),
  // On `summary`: the language the minutes should be written in, as an English
  // language name ("Chinese"), resolved from the host's settings by the
  // Gateway. Absent when unknown — the bridge then asks for the transcript's
  // dominant language, mirroring the server agent's own fallback. Without this
  // the dev-mode minutes language was undefined behaviour: whatever language
  // the developer's model happened to pick (docs 21 §4.3).
  language: z.string().optional(),
});

export const frameBoardSchema = z.object({
  type: z.literal("board"),
  requestId: z.string().min(1),
  kelaboId: z.string().min(1),
  contributions: z.array(z.object({
    id: z.string(),
    title: z.string(),
    to: z.string(),
    markdown: z.string(),
    author: z.string(),
    at: z.number(),
  })).default([]),
});

export const frameHistorySchema = z.object({
  type: z.literal("history"),
  requestId: z.string().min(1),
  kelaboId: z.string().min(1),
  // False when the host never opted in — distinct from opted-in-but-empty,
  // so the agent can tell the developer which of the two it is.
  enabled: z.boolean().default(true),
  entries: z.array(z.object({
    kelaboId: z.string(),
    title: z.string(),
    endedAt: z.number().nullable().default(null),
    summary: z.string().default(""),
    decisions: z.array(z.string()).default([]),
    actionItems: z.array(z.string()).default([]),
  })).default([]),
});

export const framePingSchema = z.object({
  type: z.literal("ping"),
});

// --- journey pull tool responses (docs 20 §12.2) ----------------------------
//
// `resolved` carries the outcome of resolving *which* journey, before any
// tool-specific payload: "ok" (the rest of the frame is populated),
// "no_journey" (this kelabo is linked to none), "ambiguous" (linked to more
// than one and no journeyId was given — `journeys` lists the candidates),
// or "journey_not_found" (an explicit journeyId that is not one of this
// kelabo's links). `journey_posted` adds two outcomes of its own: the
// `aiCanPost` gate, and an edit naming a message that does not exist or is
// archived — the agent bridge can create or edit a message, never archive
// or unarchive one; that stays a human action via the SPA/REST.
//
// `kelaboId` on every response below is `.default("")` rather than required:
// a request made from a direct journey attachment (docs 20 §12.3) names no
// kelabo, and the response echoes that absence.
const journeyRef = z.object({ journeyId: z.string(), title: z.string() });

export const frameJourneyInfoSchema = z.object({
  type: z.literal("journey_info"),
  requestId: z.string().min(1),
  kelaboId: z.string().default(""),
  resolved: z.enum(["ok", "no_journey", "ambiguous", "journey_not_found"]),
  journeys: z.array(journeyRef).default([]),
  journeyId: z.string().optional(),
  title: z.string().optional(),
  visibility: z.enum(["public", "private"]).optional(),
  status: z.enum(["active", "completed"]).optional(),
  description: z.string().default(""),
  health: z.enum(["green", "yellow", "red"]).nullable().optional(),
  progress: z.number().nullable().optional(),
  counts: z
    .object({
      kelaboCount: z.number().default(0),
      documentCount: z.number().default(0),
      reportCount: z.number().default(0),
      boardMessageCount: z.number().default(0),
      accessorCount: z.number().default(0),
    })
    .optional(),
});

export const frameJourneyTimelineSchema = z.object({
  type: z.literal("journey_timeline"),
  requestId: z.string().min(1),
  kelaboId: z.string().default(""),
  resolved: z.enum(["ok", "no_journey", "ambiguous", "journey_not_found"]),
  journeys: z.array(journeyRef).default([]),
  entries: z
    .array(
      z.object({
        type: z.string(),
        summary: z.string(),
        actor: z.string().optional(),
        at: z.number(),
      })
    )
    .default([]),
  nextBefore: z.number().optional(),
});

export const frameJourneyBoardSchema = z.object({
  type: z.literal("journey_board"),
  requestId: z.string().min(1),
  kelaboId: z.string().default(""),
  resolved: z.enum(["ok", "no_journey", "ambiguous", "journey_not_found"]),
  journeys: z.array(journeyRef).default([]),
  messages: z
    .array(
      z.object({
        msgId: z.string(),
        content: z.string(),
        createdBy: z.string().optional(),
        createdAt: z.number().optional(),
      })
    )
    .default([]),
});

export const frameJourneyReportSubmittedSchema = z.object({
  type: z.literal("journey_report_submitted"),
  requestId: z.string().min(1),
  kelaboId: z.string().default(""),
  resolved: z.enum(["ok", "no_journey", "ambiguous", "journey_not_found"]),
  journeys: z.array(journeyRef).default([]),
  reportId: z.string().optional(),
});

export const frameJourneyPostedSchema = z.object({
  type: z.literal("journey_posted"),
  requestId: z.string().min(1),
  kelaboId: z.string().default(""),
  resolved: z.enum([
    "ok",
    "no_journey",
    "ambiguous",
    "journey_not_found",
    "ai_posting_disabled",
    "message_not_found",
    "already_archived",
  ]),
  journeys: z.array(journeyRef).default([]),
  msgId: z.string().optional(),
  version: z.number().optional(),
});

// --- direct journey attachment + one-call context (docs 20 §12.3) -----------

const journeyCountsSchema = z.object({
  kelaboCount: z.number().default(0),
  documentCount: z.number().default(0),
  reportCount: z.number().default(0),
  boardMessageCount: z.number().default(0),
  accessorCount: z.number().default(0),
});

/**
 * The answer to `journey_attach`. `resolved` carries the outcome the way the
 * journey pull responses already do: "ok" (attached, the rest is populated),
 * "journey_not_found" (no such journey — also what a journey in another
 * tenant looks like, deliberately), or "not_journey_member" (it exists, the
 * caller is neither owner nor accessor). For a direct attachment this is the
 * whole of the agent's starting context, the same role `briefing` plays for
 * a kelabo attach.
 */
export const frameJourneyBriefingSchema = z.object({
  type: z.literal("journey_briefing"),
  requestId: z.string().min(1),
  resolved: z.enum(["ok", "journey_not_found", "not_journey_member"]),
  journeyId: z.string().optional(),
  title: z.string().default(""),
  visibility: z.enum(["public", "private"]).optional(),
  status: z.enum(["active", "completed"]).optional(),
  description: z.string().default(""),
  health: z.enum(["green", "yellow", "red"]).nullable().optional(),
  progress: z.number().nullable().optional(),
  // Whether the journey's owner lets an agent write to its board — carried
  // here so the agent knows before it drafts a post, not after.
  aiCanPost: z.boolean().default(false),
  counts: journeyCountsSchema.optional(),
  // The linked kelabos, membership only — their minutes come from
  // `journey_kelabos_request` when actually needed.
  kelabos: z
    .array(z.object({ kelaboId: z.string(), title: z.string(), linkedAt: z.number().optional() }))
    .default([]),
});

/** One linked kelabo reduced to its minutes — the same shape `history`'s
 *  entries carry, minus `endedAt` (a journey link stores `linkedAt`). */
const journeyKelaboEntrySchema = z.object({
  kelaboId: z.string(),
  title: z.string(),
  linkedAt: z.number().optional(),
  hasMinutes: z.boolean().default(false),
  summary: z.string().default(""),
  decisions: z.array(z.string()).default([]),
  actionItems: z.array(z.string()).default([]),
});

export const frameJourneyContextSchema = z.object({
  type: z.literal("journey_context"),
  requestId: z.string().min(1),
  kelaboId: z.string().default(""),
  resolved: z.enum(["ok", "no_journey", "ambiguous", "journey_not_found"]),
  journeys: z.array(journeyRef).default([]),
  journeyId: z.string().optional(),
  title: z.string().default(""),
  status: z.enum(["active", "completed"]).optional(),
  description: z.string().default(""),
  health: z.enum(["green", "yellow", "red"]).nullable().optional(),
  progress: z.number().nullable().optional(),
  aiCanPost: z.boolean().default(false),
  board: z.array(z.object({ content: z.string() })).default([]),
  // Excerpts, not full text — `journey_documents` below is the full read.
  documents: z
    .array(z.object({ docId: z.string(), title: z.string(), excerpt: z.string().default(""), sizeBytes: z.number().optional() }))
    .default([]),
  kelabos: z.array(journeyKelaboEntrySchema).default([]),
  reports: z
    .array(z.object({ reportId: z.string(), question: z.string(), answer: z.string().default("") }))
    .default([]),
});

export const frameJourneyKelabosSchema = z.object({
  type: z.literal("journey_kelabos"),
  requestId: z.string().min(1),
  kelaboId: z.string().default(""),
  resolved: z.enum(["ok", "no_journey", "ambiguous", "journey_not_found"]),
  journeys: z.array(journeyRef).default([]),
  entries: z.array(journeyKelaboEntrySchema).default([]),
});

/** `document_not_found` is a real answer (an explicit docId that names no
 *  active document), same shape `journey_posted`'s edit failures use. */
export const frameJourneyDocumentsSchema = z.object({
  type: z.literal("journey_documents"),
  requestId: z.string().min(1),
  kelaboId: z.string().default(""),
  resolved: z.enum(["ok", "no_journey", "ambiguous", "journey_not_found", "document_not_found"]),
  journeys: z.array(journeyRef).default([]),
  documents: z
    .array(
      z.object({
        docId: z.string(),
        title: z.string(),
        addedBy: z.string().optional(),
        addedAt: z.number().optional(),
        sizeBytes: z.number().optional(),
        // Present only on a single-document read (docId given).
        content: z.string().optional(),
      })
    )
    .default([]),
});

export const frameJourneyReportsSchema = z.object({
  type: z.literal("journey_reports"),
  requestId: z.string().min(1),
  kelaboId: z.string().default(""),
  resolved: z.enum(["ok", "no_journey", "ambiguous", "journey_not_found", "report_not_found"]),
  journeys: z.array(journeyRef).default([]),
  reports: z
    .array(
      z.object({
        reportId: z.string(),
        question: z.string(),
        requestedAt: z.number().optional(),
        generatedBy: z.string().optional(),
        // A private report reaches the agent only when the attached identity
        // is the one who asked it (docs 20 §6.4) — carried so the agent can
        // say so rather than quoting it to the room as shared material.
        visibility: z.enum(["public", "private"]).default("public"),
        // Present only on a single-report read (reportId given).
        answer: z.string().optional(),
      })
    )
    .default([]),
});

/** Discriminated union of all Gateway -> bridge frames. */
export const downFrameSchema = z.discriminatedUnion("type", [
  frameRegisteredSchema,
  frameRejectedSchema,
  frameBriefingSchema,
  frameTranscriptSchema,
  frameKelaboSchema,
  frameRequestSchema,
  frameBoardSchema,
  frameHistorySchema,
  framePingSchema,
  frameJourneyInfoSchema,
  frameJourneyTimelineSchema,
  frameJourneyBoardSchema,
  frameJourneyReportSubmittedSchema,
  frameJourneyPostedSchema,
  frameJourneyBriefingSchema,
  frameJourneyContextSchema,
  frameJourneyKelabosSchema,
  frameJourneyDocumentsSchema,
  frameJourneyReportsSchema,
]);

/** @param {string|Buffer} raw @returns {{ok:true, frame:object}|{ok:false, error:string}} */
export function parseUpFrame(raw) {
  return parseFrame(raw, upFrameSchema);
}

/** @param {string|Buffer} raw @returns {{ok:true, frame:object}|{ok:false, error:string}} */
export function parseDownFrame(raw) {
  return parseFrame(raw, downFrameSchema);
}

function parseFrame(raw, schema) {
  let obj;
  try {
    obj = JSON.parse(String(raw));
  } catch {
    return { ok: false, error: "invalid_json" };
  }
  const r = schema.safeParse(obj);
  return r.success ? { ok: true, frame: r.data } : { ok: false, error: r.error.message };
}
