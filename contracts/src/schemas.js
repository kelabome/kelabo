import { z } from "zod";
import { RTC_MODES, JOURNEY_VISIBILITIES } from "./constants.js";

export const utteranceSchema = z.object({
  kelaboId: z.string().min(1),
  clientId: z.string().min(1),
  speaker: z.string().min(1),
  text: z.string().min(1),
  tStart: z.number().nonnegative(),
  tEnd: z.number().nonnegative(),
  isFinal: z.boolean(),
  tenantId: z.string().optional(),
  lang: z.string().optional(),
  tr: z.string().optional(),
  // How the words came to exist — same meaning as captionPostSchema.source.
  // Absent means "speech": the field was introduced 2026-08 and rows written
  // before it exist only for spoken words, so absence and "speech" are the
  // same statement. Carried through persistence and the archive so the record
  // (and its download) can tell a typed line from a transcribed one.
  source: z.enum(["speech", "typed"]).optional(),
  // Wall-clock ms. Absent on rows persisted before 2026-08; the record view
  // falls back to meeting-relative offsets for those.
  at: z.number().optional(),
});

export const captionPostSchema = z.object({
  kelaboId: z.string().min(1).max(128),
  text: z.string().min(1).max(8000),
  isFinal: z.literal(true),
  speaker: z.string().max(64).optional(),
  // Display name of the capturing participant (used to attribute the utterance
  // to a real person when diarization is off).
  displayName: z.string().max(64).optional(),
  // True when the captured stream is diarized (speaker carries an A/B label).
  diarized: z.boolean().optional(),
  tStart: z.number().nonnegative().default(0),
  tEnd: z.number().nonnegative().default(0),
  // What kind of thing this caption is (docs 13). A `delta` is an append to a
  // message still being spoken: relayed to the room for live display, then
  // forgotten. A `sealed` message is the whole, immutable message: persisted and
  // handed to the agent. These are genuinely different operations, so they are
  // named rather than inferred from a combination of booleans — recombining
  // flags at the far end is how one message ended up rendered twice.
  // `turnComplete`/`ephemeral` below are the pre-`kind` spelling, kept so an
  // older client keeps working.
  //   tail   – the provider's current guess at the words being spoken. Replaces the
  //            previous guess; relayed for liveness only.
  //   delta  – words the provider confirmed. Appended; relayed for liveness only.
  //   sealed – the whole, immutable message. Persisted and handed to the agent.
  kind: z.enum(["tail", "delta", "sealed"]).optional(),
  // Position of a delta within its message, so redelivery is detectable.
  seq: z.number().int().nonnegative().optional(),
  // Why the message sealed (silence, gate_close, max_open_ms, …) — diagnostics only.
  reason: z.string().max(32).optional(),
  // True when this caption is a complete speaker turn (a closed chat bubble),
  // not a fragment — only these are eligible for LLM processing.
  turnComplete: z.boolean().optional(),
  // Identifies the speaker's message that this caption belongs to. Live
  // fragments and the sealed message that follows them share one id, so every
  // receiver reproduces exactly the message boundaries the *speaker* decided
  // instead of re-grouping fragments by speaker — which merged a whole kelabo
  // into one ever-growing bubble.
  messageId: z.string().max(64).optional(),
  // Live-display fragment: fan it out to the other participants so the room sees
  // speech as it happens, but do NOT persist it, buffer it, or hand it to the
  // agent. Sealing a message can wait up to a minute (docs 13), which is far too
  // long for the room to wait — but the agent must still only ever receive whole
  // messages. The sealed post that follows does the persisting and dispatching.
  ephemeral: z.boolean().optional(),
  human: z.boolean().optional(),
  // How the words came to exist. "speech" is the STT provider's transcription of a
  // microphone; "typed" is a participant who wrote the message in the room's
  // transcript panel. Both are things a person said to the kelabo and are
  // handled identically downstream — persisted, fanned out to the room, handed
  // to the agent.
  //
  // It is NOT `human`, which is a different operation entirely: `human` posts a
  // note to the *board* and never enters the transcript. A typed message is
  // speech somebody typed, so it belongs in the record of what was said.
  //
  // Only sealed captions carry it — there is no such thing as a typed delta.
  source: z.enum(["speech", "typed"]).optional(),
});

export const contributionSourceSchema = z.object({
  title: z.string(),
  url: z.string().optional(),
});

export const contributionSchema = z.object({
  id: z.string(),
  kelaboId: z.string(),
  tag: z.enum(["LLM_CON", "note"]),
  kind: z.enum(["answer", "link", "code", "clarify", "minutes", "note"]),
  title: z.string(),
  to: z.string(),
  markdown: z.string(),
  sources: z.array(contributionSourceSchema).optional(),
  confidence: z.number().optional(),
  author: z.string(),
  // Where the answer was produced. "local" is any agent running on a
  // developer's own machine; `runtime` names which one. "opencode" predates
  // `runtime` and is still read from persisted rows written before docs 16.
  origin: z.enum(["server", "opencode", "local"]).optional(),
  // Which coding agent produced it ("opencode", "claude-code", …) and the label
  // its owner gave it. Display only — nothing branches on these.
  runtime: z.string().optional(),
  agentLabel: z.string().optional(),
  // Lifecycle status for progressive rendering:
  //   working - ephemeral in-progress placeholder (not persisted)
  //   done    - (or absent) a final, persisted contribution
  //   skipped - the agent woke up and decided not to post, or a worker came back
  //             with nothing. Ephemeral like "working", but it stays on screen
  //             with its reason instead of vanishing: a card that disappears
  //             looks like a bug, and "why did it give up?" is the single most
  //             common question about the assistant.
  status: z.enum(["working", "done", "skipped"]).optional(),
  // Live progress line for a "working" card ("Fetching nasdaq.com…"), and the
  // steps taken so far. Both are ephemeral — they exist to make a card that is
  // busy for 20s look busy rather than stuck.
  progress: z.string().optional(),
  steps: z.array(z.string()).optional(),
  // Why a "skipped" card was not posted, in one plain sentence.
  reason: z.string().optional(),
  at: z.number(),
  tenantId: z.string().optional(),
});

export const captionRenameSchema = z.object({
  kelaboId: z.string().min(1).max(128),
  // The diarization label being renamed, e.g. "A", "B".
  from: z.string().min(1).max(8),
  // The human display name to apply, e.g. "Alice". Empty string clears it.
  to: z.string().max(64),
});

// User settings synced across devices (stored on the user row).
//
// Every key the SPA pushes (spa/src/settings.js KEY_MAP) has to be listed here:
// zod strips what it does not know, so a key missing from this object is a
// setting that silently never syncs.
export const userSettingsSchema = z.object({
  name: z.string().max(64).optional(),
  theme: z.enum(["light", "dark"]).optional(),
  scheme: z.string().max(16).optional(),
  notif: z.boolean().optional(),
  // Room chimes (join/leave/message). On unless explicitly off.
  sounds: z.boolean().optional(),
  finalOnly: z.boolean().optional(),
  sttLang: z.string().max(16).optional(),
  vad: z.boolean().optional(),
  // Mute the mic whenever this tab goes to the background.
  muteHidden: z.boolean().optional(),
  joinMuted: z.boolean().optional(),
  joinCamera: z.boolean().optional(),
  // Identicon re-roll (a stringified small integer, like every non-boolean
  // key the SPA pushes). "0"/absent = the default avatar derived from the
  // email alone; anything else salts the seed. Server-side readers coerce
  // with Number() and treat NaN as 0.
  avatar: z.string().max(8).optional(),
});

export const settingsPutBodySchema = z.object({
  settings: userSettingsSchema,
  updatedAt: z.number().nonnegative().optional(),
});

// Minutes are a document, not a set of labels. The first version listed topic
// names and finding headlines, which reads as an index to a kelabo nobody
// wrote up: "Navigation", "Accessibility" tells a reader who missed the kelabo
// nothing. Every section now carries the substance — what was actually said,
// why a decision went the way it did, what a finding was and where it came
// from — and `summary` is the paragraph you read if you read nothing else.
//
// Legacy archives stored plain strings for topics/decisions/findings;
// parseMinutesJson normalizes those into these shapes, and the UI still
// tolerates a bare string so an old record renders.
const minutesTopicSchema = z.object({
  title: z.string(),
  // Several sentences: the substance of the discussion, positions taken, the
  // disagreement if there was one.
  detail: z.string().optional(),
  speakers: z.array(z.string()).optional(),
});

const minutesDecisionSchema = z.object({
  text: z.string(),
  rationale: z.string().optional(),
});

const minutesFindingSchema = z.object({
  text: z.string(),
  // Which research task produced it, and what it cited.
  sources: z.array(z.object({ title: z.string(), url: z.string().optional() })).optional(),
});

export const minutesDocSchema = z.object({
  kelaboId: z.string(),
  // AI-generated short kelabo title (used when the kelabo was created untitled).
  title: z.string().optional(),
  // Narrative overview of the whole kelabo — the part a reader who missed it
  // actually reads.
  summary: z.string().optional(),
  topics: z.array(minutesTopicSchema),
  decisions: z.array(minutesDecisionSchema),
  actionItems: z.array(z.object({ text: z.string(), owner: z.string().optional(), due: z.string().optional() })),
  openQuestions: z.array(z.string()),
  findings: z.array(minutesFindingSchema),
  generatedAt: z.number(),
  generatedBy: z.string(),
});

export const kelaboParticipantSchema = z.object({
  identity: z.string(),
  displayName: z.string(),
  isGuest: z.boolean(),
});

export const archiveSchema = z.object({
  archiveId: z.string(),
  kelaboId: z.string(),
  title: z.string(),
  host: z.string(),
  participants: z.array(kelaboParticipantSchema),
  startedAt: z.number(),
  endedAt: z.number(),
  transcript: z.array(utteranceSchema),
  board: z.array(contributionSchema),
  minutes: minutesDocSchema.optional(),
  tenantId: z.string().optional(),
});

export const otpRequestBodySchema = z.object({
  email: z.string().email().max(254),
});

export const otpVerifyBodySchema = z.object({
  email: z.string().email().max(254),
  code: z.string().regex(/^\d{6}$/),
});

export const createKelaboBodySchema = z.object({
  title: z.string().max(80).optional(),
  translation: z.object({
    enabled: z.boolean(),
    targetLang: z.string().max(16).optional(),
  }).optional(),
  // Host opt-out: when false, the kelabo runs without the host's personal MCP servers.
  mcpEnabled: z.boolean().optional(),
  // Conference transport. Omitted means the environment default (config.rtc.defaultMode).
  rtcMode: z.enum(RTC_MODES).optional(),
  // Host opt-IN: let the assistant read the minutes of the host's own past
  // kelabos, so it can answer "what did we decide about this last time".
  //
  // Opt-in, and default OFF, unlike `mcpEnabled` — deliberately. This one
  // carries a *different* kelabo's contents into this one, in front of whoever
  // is in the room now, who may be a guest who was not at that kelabo. That is
  // a decision a host has to actually make, and a default that quietly said yes
  // would be making it for them every time.
  historyEnabled: z.boolean().optional(),
  // Link into one or more existing journeys at creation time (docs 20 §11).
  // No membership check is needed here beyond zod: the caller is about to
  // become this kelabo's host, which already satisfies journeys.linkKelabo's
  // own "host or participant of the target" requirement.
  journeyIds: z.array(z.string().min(1).max(64)).max(10).optional(),
});

// A scheduled kelabo is the same kelabo in an earlier state, not a different
// entity: same partition, same id, same join link. That is what lets a link be
// shared before the kelabo exists as a live thing and still work once it does.
export const scheduleKelaboBodySchema = createKelaboBodySchema.extend({
  title: z.string().min(1).max(80),
  // Epoch ms. When it is *meant* to start — the host may start whenever.
  scheduledAt: z.number().int().positive(),
  durationMinutes: z.number().int().min(5).max(24 * 60).optional(),
  // Addresses to invite. Bounded because each one costs an email.
  invitees: z.array(z.string().email().max(160)).max(50).optional(),
  note: z.string().max(500).optional(),
});

// Cancel a scheduled kelabo (docs 18 §2). Host-only; the optional reason is
// carried into the cancellation email so invitees learn why.
export const cancelKelaboBodySchema = z.object({
  reason: z.string().max(200).optional(),
});

// Reschedule a scheduled kelabo (docs 18 §3). Every field is optional but at
// least one must be present — the handler rejects an empty body with
// `nothing_to_change`, which zod cannot express on its own. Fields mirror
// scheduleKelaboBodySchema so the same DateTimePicker drives both.
export const rescheduleKelaboBodySchema = z.object({
  scheduledAt: z.number().int().positive().optional(),
  durationMinutes: z.number().int().min(5).max(24 * 60).optional(),
  title: z.string().min(1).max(80).optional(),
  note: z.string().max(500).optional(),
});

// Add or remove invitees on a scheduled kelabo (docs 18 §3.5) — the route
// `ScheduledKelabo.jsx`'s reschedule form named and deferred. The *full*
// desired list, same field as `scheduleKelaboBodySchema`'s own `invitees`:
// the handler diffs it against who is currently invited rather than the
// caller tracking an add list and a remove list separately, which is also
// what lets the SPA hand it `EmailPicker`'s value unchanged.
export const updateInviteesBodySchema = z.object({
  invitees: z.array(z.string().email().max(160)).max(50),
});

// Huddle / ring (docs 18 §6). Start an instant kelabo and ring online contacts
// into it. `invitees` are emails (same-org colleagues or accepted contacts);
// bounded because each is a live push.
export const huddleBodySchema = z.object({
  invitees: z.array(z.string().email().max(160)).min(1).max(20),
  title: z.string().max(80).optional(),
  // A private call is an ordinary active kelabo that stays out of the tenant's
  // public "Live now" list. The join link still works for anyone who has it —
  // private means unlisted, not locked.
  private: z.boolean().optional(),
});

// Ring more people into a kelabo that is already live (docs 18 §6) — the
// "invite an online contact into this kelabo" action.
export const ringBodySchema = z.object({
  invitees: z.array(z.string().email().max(160)).min(1).max(20),
});

export const RING_RESPONSES = ["accepted", "declined"];
export const ringAnswerBodySchema = z.object({
  response: z.enum(RING_RESPONSES),
});

// "pending" is a real answer you can give, not just the absence of one: the
// invitation list lets someone un-accept or un-decline (notes #8), and without
// it the only way back from a wrong click is to give the opposite wrong answer.
// It is also the value a reschedule resets everyone to, so the three states were
// already the vocabulary — only the write path was missing one.
export const RSVP_RESPONSES = ["accepted", "declined", "pending"];

// `displayName` is required for a guest and ignored for a signed-in user, whose
// name the session already carries — the route decides which applies, because
// only it knows whether there is a session.
export const rsvpBodySchema = z.object({
  response: z.enum(RSVP_RESPONSES),
  displayName: z.string().min(1).max(64).optional(),
});

export const rsvpCookieSchema = z.object({
  kind: z.literal("rsvp"),
  kelaboId: z.string().min(1).max(128),
  inviteKey: z.string().min(1).max(160),
  exp: z.number(),
});

export const joinBodySchema = z.object({
  displayName: z.string().min(1).max(64),
  mode: z.enum(["audio-board", "board-only"]),
});

export const sessionCookieSchema = z.object({
  kind: z.literal("identity"),
  identity: z.string(),
  tenantId: z.string(),
  exp: z.number(),
});

export const participantCookieSchema = z.object({
  kind: z.literal("participant"),
  kelaboId: z.string(),
  identity: z.string(),
  tenantId: z.string(),
  isGuest: z.boolean(),
  exp: z.number(),
});

// ---------------------------------------------------------------------------
// Conference audio (docs 15). Both transports share one signalling surface on
// the Gateway; the mode decides which half of it a client uses.
// ---------------------------------------------------------------------------

// SDP blobs are the largest thing crossing this boundary. The cap is generous
// (a many-track offer with ICE candidates inlined) but bounded, so a malformed
// or hostile client cannot make the Gateway buffer arbitrarily.
const sdpString = z.string().min(1).max(128_000);

export const sessionDescriptionSchema = z.object({
  type: z.enum(["offer", "answer"]),
  sdp: sdpString,
});

// One track in an SFU tracks/new request. `location: "local"` publishes a track
// the caller is sending (identified by `mid` on their own transceiver);
// `location: "remote"` pulls a track another participant published.
//
// Name the *participant*, not their session: the Gateway holds the roster, so
// it resolves the current session id itself. A client can only ever know the
// session id it was last told about, and that goes stale the moment the
// publisher rebuilds — after a reload, or after a session died — which showed
// up as a `403` on an otherwise clean reconnect, because two people reloading
// within a few seconds of each other is enough for one roster snapshot to
// describe a session that no longer exists.
//
// `sessionId` remains accepted so a browser holding an older bundle keeps
// working through a deploy; it is checked against the roster exactly as before.
// Prefer `participantId` — it cannot go stale, and it removes the client's
// ability to name a raw session at all, which is the abuse vector §4 exists to
// close.
export const rtcTrackSchema = z.object({
  location: z.enum(["local", "remote"]),
  trackName: z.string().min(1).max(64),
  mid: z.string().max(16).optional(),
  participantId: z.string().min(1).max(320).optional(),
  sessionId: z.string().min(1).max(128).optional(),
  // Media kind this track carries. The field exists so video and screen share
  // need no protocol change beside audio.
  kind: z.enum(["audio", "video", "screen"]).default("audio"),
});

const kelaboScoped = { kelaboId: z.string().min(1).max(128) };

export const rtcJoinBodySchema = z.object({ ...kelaboScoped });
export const rtcLeaveBodySchema = z.object({ ...kelaboScoped });
export const rtcIceBodySchema = z.object({ ...kelaboScoped });

// Whether this participant's microphone and camera are switched on.
//
// This is the one thing about a call that genuinely cannot be read from the
// media. Muting is `track.enabled = false`, which is a local decision the
// browser never puts on the wire, and switching a camera off is
// `replaceTrack(null)` on a sender that stays negotiated — through an SFU the
// receiving side is not reliably told either happened. It sees packets stop,
// which is indistinguishable from a bad network, so a muted peer looked exactly
// like a silent one and a camera that went off left its last frame frozen on
// the tile for the rest of the kelabo.
//
// All fields are optional so any can be reported without claiming anything
// about the others.
//
// `screen` is also how a mesh room admits a share: in mesh mode the Gateway
// never sees the media or the SDP, so this report is the only place the
// participants-plus-shares cap can be enforced. A client asks (`screen: true`)
// BEFORE publishing and a full room answers 409 `mesh_room_full`.
export const rtcMediaBodySchema = z.object({
  ...kelaboScoped,
  audio: z.boolean().optional(),
  video: z.boolean().optional(),
  screen: z.boolean().optional(),
});

// Authoritative membership snapshot, fetched by the reconcile loop. Events are
// single-delivery; a `peer_joined` lost to a throttled tab otherwise skews the
// client's roster for the rest of the kelabo.
export const rtcRosterBodySchema = z.object({ ...kelaboScoped });

// Mesh only: an offer/answer/ICE candidate addressed to exactly one peer. The
// Gateway relays it verbatim to that peer's SSE stream and to nobody else.
// Which of the sender's transceivers carries what, keyed by `mid`.
//
// Needed because a camera and a shared screen are both plain `video` tracks on
// the wire: the receiving side gets two indistinguishable m-lines and no way to
// decide which deserves its own tile. The SFU has no such problem — it names
// tracks ("cam" / "screen") and the roster carries the name — so this exists
// purely so mesh can tell the same two things apart, and the two transports can
// keep behaving identically. The Gateway relays it without reading it.
const trackKindsSchema = z.record(z.string().max(16), z.enum(["audio", "video", "screen"]));

export const rtcSignalBodySchema = z.object({
  ...kelaboScoped,
  to: z.string().min(1).max(128),
  signal: z.discriminatedUnion("type", [
    z.object({ type: z.literal("offer"), sdp: sdpString, kinds: trackKindsSchema.optional() }),
    z.object({ type: z.literal("answer"), sdp: sdpString, kinds: trackKindsSchema.optional() }),
    z.object({
      type: z.literal("ice"),
      candidate: z.string().max(4000),
      sdpMid: z.string().max(64).nullable().optional(),
      sdpMLineIndex: z.number().int().nonnegative().nullable().optional(),
    }),
    z.object({ type: z.literal("bye") }),
  ]),
});

export const rtcSfuSessionBodySchema = z.object({
  ...kelaboScoped,
  sessionDescription: sessionDescriptionSchema.optional(),
});

export const rtcSfuTracksBodySchema = z.object({
  ...kelaboScoped,
  sessionDescription: sessionDescriptionSchema.optional(),
  tracks: z.array(rtcTrackSchema).min(1).max(64),
});

export const rtcRenegotiateBodySchema = z.object({
  ...kelaboScoped,
  sessionDescription: sessionDescriptionSchema,
});

export const rtcCloseTracksBodySchema = z.object({
  ...kelaboScoped,
  tracks: z.array(z.object({ mid: z.string().max(16) })).min(1).max(64),
  sessionDescription: sessionDescriptionSchema.optional(),
  force: z.boolean().optional(),
});

// A participant present on the call, as broadcast in the `rtc` SSE roster.
// `tracks` maps media kind -> published track name and is deliberately open:
// { audio: "mic" }, plus video and screen when published.
export const rtcPeerSchema = z.object({
  participantId: z.string().min(1),
  displayName: z.string().max(64).default(""),
  isGuest: z.boolean().default(false),
  sfuSessionId: z.string().optional(),
  tracks: z.record(z.string(), z.string()).default({}),
  joinedAt: z.number(),
});

// How the gateway authenticates to this MCP server:
//   none   - no credentials
//   bearer - a static token the host pasted, held in Secrets Manager (secretRef)
//   oauth  - OAuth 2.1 per the MCP authorization spec; tokens live in the mcp
//            table under SK=TOKEN#<name> and are refreshed by the gateway
export const mcpAuthTypes = ["none", "bearer", "oauth"];

// Discovery result cached on the server item so neither the gateway nor a later
// refresh has to re-run RFC 9728/8414 discovery on every use.
export const mcpOauthMetaSchema = z.object({
  issuer: z.string(),
  authorizationEndpoint: z.string(),
  tokenEndpoint: z.string(),
  registrationEndpoint: z.string().nullish(),
  // RFC 8707 canonical resource URI — MUST be replayed on every token request.
  resource: z.string(),
  scope: z.string().nullish(),
});

export const mcpServerSchema = z.object({
  name: z.string().min(1),
  transport: z.enum(["http", "local"]),
  url: z.string().optional(),
  headers: z.record(z.string()).optional(),
  secretRef: z.string().optional(),
  authType: z.enum(["none", "bearer", "oauth"]).optional(),
  oauth: mcpOauthMetaSchema.optional(),
  enabled: z.boolean(),
});

// Persisted at PK=MCP#host#<identity>, SK=TOKEN#<name>. Encrypted at rest by the
// table's customer-managed KMS key. Never returned by the API.
export const mcpOauthTokenSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string().nullable(),
  tokenType: z.string(),
  scope: z.string().nullable(),
  expiresAt: z.number().nullable(),
  obtainedAt: z.number(),
});

// Persisted at PK=MCP#client, SK=AS#<issuer>. One dynamic client registration
// per authorization server, shared by every user of this deployment.
export const mcpClientRegistrationSchema = z.object({
  issuer: z.string(),
  clientId: z.string(),
  clientSecret: z.string().nullable(),
  redirectUri: z.string(),
  registrationAccessToken: z.string().nullish(),
  registrationClientUri: z.string().nullish(),
  createdAt: z.number(),
});

export const mcpConfigSchema = z.object({
  servers: z.array(mcpServerSchema),
});

// Host-managed personal MCP server upsert (PUT /me/mcp). `secret` is an auth
// token written to Secrets Manager; it is never stored in DynamoDB or returned
// by the API. Omit it to keep the existing secret.
export const mcpServerPutBodySchema = z.object({
  name: z.string().min(1).max(64).regex(/^[\w.-]+$/, "name may contain letters, digits, _, ., -"),
  url: z.string().url().max(512),
  headers: z.record(z.string()).optional(),
  enabled: z.boolean().optional(),
  secret: z.string().max(2048).optional(),
  authType: z.enum(["none", "bearer", "oauth"]).optional(),
});

// POST /me/mcp/probe — ask the server (unauthenticated) whether it speaks OAuth,
// so the SPA can show "Connect" instead of a token field before anything is saved.
export const mcpProbeBodySchema = z.object({
  url: z.string().url().max(512),
});

export const retentionUnits = ["days", "weeks", "months", "years"];

// POST /me/records/purge — irreversibly delete the caller's records older than
// `value` `unit`s. `dryRun` reports exactly what WOULD go without deleting;
// destructive by omission is not acceptable here, so clients preview first.
export const purgeRecordsBodySchema = z.object({
  // >= 1: `0 days` would mean "everything", which must be a deliberate choice
  // made with an explicit age, not an accidental empty form field. <= 99
  // regardless of unit — three digits' worth of typo (e.g. "999" meant to be
  // "99") is exactly the kind of accidental over-broad purge this bound
  // exists to catch before it reaches the confirmation step.
  value: z.number().int().min(1).max(99),
  unit: z.enum(["days", "weeks", "months", "years"]),
  dryRun: z.boolean().optional(),
});

// --- agent bridge pairing (docs 16 §6) --------------------------------------

// POST /agent/device/code — `kelabo login` asks for a code. Unauthenticated:
// the bridge has no credential yet, which is the point of the flow.
export const agentDeviceCodeBodySchema = z.object({
  runtime: z.string().min(1).max(64),
  label: z.string().max(80).optional(),
});

// POST /agent/device/token — the bridge polls with the device code it was given.
export const agentDeviceTokenBodySchema = z.object({
  deviceCode: z.string().min(1).max(256),
});

// POST /agent/device/approve — the developer, signed in to the portal, approves
// the code their terminal printed. Loose on formatting because a human typed it.
export const agentApproveBodySchema = z.object({
  userCode: z.string().min(1).max(32),
});

// POST /join-code/redeem — somebody types the code they were told. Loose here
// on purpose: case, spaces and dashes are the typist's, and normalising them is
// the server's job (rest-api/src/joinCode.js), not a reason to 400.
export const joinCodeRedeemBodySchema = z.object({
  code: z.string().min(1).max(32),
});

export const modelConfigSchema = z.object({
  provider: z.string(),
  model: z.string(),
  smallModel: z.string(),
});

// --- speech-to-text session (the STT provider boundary) ---------------------

// What POST /kelabos/:id/stt-token returns. Validated on the way OUT, not in:
// the risk here is not a malicious client but a provider module that returns
// the wrong shape, and the symptom of that is a browser opening a socket to
// nowhere — no error at any level, no transcript, nothing to look at. Failing
// in the Lambda instead makes a broken provider a 502 with a stack trace.
//
// `params` is unvalidated by design: what is in it belongs entirely to the
// provider, and enumerating the keys here would put every provider's wire
// format back into shared code.
export const sttSessionSchema = z.object({
  provider: z.string().min(1).max(64),
  url: z.string().url().startsWith("wss://"),
  token: z.string().min(1),
  expiresInSeconds: z.number().int().positive(),
  params: z.record(z.unknown()),
});

// --- Journey (docs 20) -------------------------------------------------------
//
// A persistent container linking related kelabos so description, decisions
// and documents carry from one meeting to the next, for people and the
// agent. Full design: docs/20-journey.md.

export const createJourneyBodySchema = z.object({
  title: z.string().min(1).max(80),
  // The free-text description's first version. Optional: a journey may be
  // created empty and described later.
  description: z.string().max(20000).optional(),
  visibility: z.enum(JOURNEY_VISIBILITIES).default("private"),
});

// Every field optional; the handler rejects an empty body with
// `nothing_to_change`, which zod cannot express on its own — the same
// contract rescheduleKelaboBodySchema already uses. `avatarVariant` is the
// identicon re-roll, same shape as the personal one in userSettingsSchema —
// a client-chosen salt, owner-only to set (docs 20 §13).
export const patchJourneyBodySchema = z.object({
  title: z.string().min(1).max(80).optional(),
  visibility: z.enum(JOURNEY_VISIBILITIES).optional(),
  avatarVariant: z.number().int().min(0).max(999999).optional(),
  // Owner-only gate on whether an attached agent may post to the board on
  // its own initiative (docs 20 §7) — independent of human write rights.
  // Default off, same reasoning as historyEnabled: a human-curated,
  // always-visible surface being edited unsupervised is a decision an
  // owner has to actually make.
  aiCanPost: z.boolean().optional(),
});

// POST /journeys/:id/status — health/progress (docs 20 §5), a combined
// snapshot rather than two independently-versioned fields: people report
// them together ("60%, yellow, because X"). Every field optional; the
// handler rejects a body with none of the three present. `null` explicitly
// clears a field back to "unset" — genuinely absent, not defaulted.
export const journeyStatusBodySchema = z.object({
  health: z.enum(["green", "yellow", "red"]).nullable().optional(),
  progress: z.number().int().min(0).max(100).nullable().optional(),
  note: z.string().max(500).optional(),
});

// POST /journeys/:id/description — a new, immutable version. `changeNote` is
// the human's own one-line "why", shown beside the version in history.
export const journeyDescriptionBodySchema = z.object({
  markdown: z.string().min(1).max(20000),
  changeNote: z.string().max(200).optional(),
});

// POST /journeys/:id/accessors — owner-only, private journeys only.
export const journeyAccessorBodySchema = z.object({
  identity: z.string().email().max(254),
});

// POST /journeys/:id/kelabos — the caller must already be host or
// participant of the kelabo being linked (checked server-side, not here).
export const journeyLinkKelaboBodySchema = z.object({
  kelaboId: z.string().min(1).max(128),
});

// POST /journeys/:id/reports — a free-text question, answered by synthesis
// over the journey's own content (docs 20 §6). Generation happens in the
// Gateway (the LLM credential is gateway-owned); this only validates the ask.
export const journeyReportBodySchema = z.object({
  question: z.string().min(1).max(2000),
});

// POST /journeys/:id/board, PATCH .../board/:msgId — a pinned message,
// mutable in place with every edit kept (docs 20 §7). Same body shape for
// create and edit.
export const journeyBoardMessageBodySchema = z.object({
  content: z.string().min(1).max(4000),
});

// POST /journeys/:id/documents — pasted/typed text, not file upload (docs
// 20 §8). 200,000 chars is comfortably inside the 400KB DynamoDB item cap
// with the rest of the item's fields; content over that has nowhere to go
// yet — S3 overflow (the same split the kelabo archive already uses) is
// not built in this pass, so a document that large is refused rather than
// silently truncated.
export const journeyDocumentBodySchema = z.object({
  title: z.string().min(1).max(160),
  content: z.string().min(1).max(200_000),
});
