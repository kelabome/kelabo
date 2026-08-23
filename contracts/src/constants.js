export const COOKIE_SESSION = "kelabo_session";
export const COOKIE_REFRESH = "kelabo_refresh";
export const COOKIE_PARTICIPANT = "kelabo_participant";
// Identifies which guest RSVP row a returning invitee owns, so a second visit
// changes their answer instead of creating a second person. Signed, because
// otherwise anyone holding the link could rewrite a stranger's reply.
export const COOKIE_RSVP = "kelabo_rsvp";
export const COOKIE_OIDC = "kelabo_oidc";
// Short-lived stash for an in-flight MCP OAuth authorization (state + PKCE
// verifier), mirroring COOKIE_OIDC. Cleared on callback.
export const COOKIE_MCP_OAUTH = "kelabo_mcp_oauth";

export const INTERNAL_JWT_AUD = "gateway-internal";
// A developer's local agent bridge (docs 16). A third token family shares the
// cookie signing key, so every verifier must check `aud` — checking `role`
// alone would let one family be presented as another.
export const AGENT_JWT_AUD = "kelabo-agent";
export const AGENT_JWT_ROLE = "dev";

// Device-code pairing (`kelabo login`). The user code is what a human types
// into the portal, so it avoids characters that are ambiguous in a terminal
// font: no 0/O, no 1/I/L.
export const AGENT_USER_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const AGENT_USER_CODE_LENGTH = 8;
export const AGENT_DEVICE_CODE_TTL_SECONDS = 600;
export const AGENT_DEVICE_POLL_SECONDS = 5;

// Join code: what you read down a phone so somebody can get into the kelabo you
// are already in. A kelabo URL is an unguessable id and unspeakable out loud;
// this is six characters, alternating letter and digit (`A5B4C7`), which is
// short enough to say once and be heard right.
//
// Same font-ambiguity exclusions as the device code above — no I/L/O, no 0/1 —
// which is not fussiness: the failure mode is a person reading "1" and another
// typing "l", and neither of them ever finding out why it did not work.
//
// The alternation is doing real work too. It halves the alphabet a listener has
// to disambiguate at each position (they know whether to expect a letter or a
// digit), and it makes a malformed code detectable before any lookup.
export const JOIN_CODE_LETTERS = "ABCDEFGHJKMNPQRSTUVWXYZ";
export const JOIN_CODE_DIGITS = "23456789";
export const JOIN_CODE_PAIRS = 3;
export const JOIN_CODE_LENGTH = JOIN_CODE_PAIRS * 2;
// Two minutes. The code is deliberately far weaker than the URL it stands for
// (23*8 per pair, ~7.1M in total, versus a 128-bit id), so the window and the
// per-IP redeem cap — not the length — are what make guessing pointless.
export const JOIN_CODE_TTL_SECONDS = 120;

// `[LLM_CON]` and `:KELABO-END` are no longer part of the agent wire protocol
// (docs 16 §2.A). They survive here because the opencode adapter still parses
// the marker as a fallback, and the server agent still renders it.
export const LLM_CON_MARKER = "[LLM_CON]";
export const KELABO_END_TOKEN = ":KELABO-END";
export const KELABO_SYSTEM_PREFIX = "[kelabo-system]";

export const JOIN_MODES = ["audio-board", "board-only"];

// Conference transport for a kelabo's live audio (docs 15).
//   sfu  - Cloudflare Realtime SFU relays media through Cloudflare's edge. Scales.
//   mesh - full-mesh WebRTC; media stays peer-to-peer under DTLS-SRTP and no
//          server (ours or Cloudflare's) can decrypt it. Capped at
//          rtc.meshMaxParticipants *units*, where a participant is one unit and
//          an active screen share is another — a share is one more uplink to
//          every peer, which is exactly what the cap exists to bound. Joiners
//          and shares past the cap are refused, never silently downgraded to
//          `sfu`.
export const RTC_MODES = ["sfu", "mesh"];

// Track names published to the SFU / carried across mesh peer connections. The
// per-peer `tracks` map is keyed by media kind, so video and screen share
// slot in beside the audio track without a protocol change.
export const RTC_TRACK_AUDIO = "mic";
export const RTC_TRACK_VIDEO = "cam";
export const RTC_TRACK_SCREEN = "screen";

export const ERROR_CODES = [
  "unauthenticated",
  "refresh_invalid",
  "oidc_failed",
  "domain_not_allowed",
  "rate_limited",
  "invalid_email",
  "invalid_code",
  "code_expired",
  "too_many_attempts",
  "kelabo_not_found",
  "kelabo_ended",
  "not_host",
  "already_ended",
  "already_active",
  "name_required",
  "not_a_participant",
  "record_not_found",
  "stt_unavailable",
  "rtc_unavailable",
  "mesh_room_full",
  // The kelabo's transport could not be resolved (META unreadable) and the
  // room is not in memory. Failing the join beats guessing the mode: guessing
  // `sfu` for a mesh kelabo would silently revoke the peer-to-peer guarantee.
  "rtc_mode_unavailable",
  "peer_not_found",
  "email_not_verified",
  "internal_error",
  "bad_request",
  "forbidden",
  "mcp_not_found",
  "mcp_oauth_failed",
  "mcp_oauth_unsupported",
  "kelabo_not_started",
  "authorization_pending",
  "device_code_invalid",
  "device_code_expired",
  // Join codes. `join_code_invalid` covers malformed and unknown alike — a
  // redeemer must not learn from the error whether a code they guessed exists.
  "join_code_invalid",
  "join_code_expired",
  "agent_token_revoked",
  "not_invited",
  // Cancel/reschedule (docs 18 §2, §3). `kelabo_cancelled` is distinct from
  // `kelabo_ended`: a caller who arrives at a cancelled kelabo must be told it
  // was called off, not that it is over. `not_scheduled` guards both operations,
  // which act only on a kelabo still in the scheduled state.
  "kelabo_cancelled",
  "not_scheduled",
  "nothing_to_change",
  // Contacts (docs 18 §4). Favouriting is same-org only; external contacts
  // 501 until a multi-domain deployment enables them.
  "not_a_colleague",
  "external_contacts_unavailable",
  // Huddle / ring (docs 18 §6). You may only ring a same-org colleague or an
  // accepted contact; nobody rung must be offline for the ring to reach them.
  "no_contact",
  "no_targets",
  // Journey (docs 20). `not_journey_owner` guards owner-only actions (delete,
  // visibility, complete/reopen, accessor management); `forbidden` covers the
  // broader member-required check. `kelabo_in_journey` is the purge guard —
  // a kelabo linked into any journey survives a host purge until unlinked.
  "journey_not_found",
  "not_journey_owner",
  "journey_completed",
  "not_completed",
  "not_private",
  "kelabo_in_journey",
  "not_kelabo_member",
  "board_message_not_found",
  "document_not_found",
  "already_archived",
  "report_not_found",
];

// Journey visibility (docs 20 §3.2): `public` grants full rights to every
// identity sharing the journey's `tenantId`, computed fresh, never stored —
// the same derivation doc 18 uses for "same org". `private` keeps an
// explicit ACCESSOR# roster instead.
export const JOURNEY_VISIBILITIES = ["public", "private"];
// `completed` freezes every write until an owner `reopen`s it (docs 20 §3.1).
export const JOURNEY_STATUSES = ["active", "completed"];

// A developer's local agent attached or detached. Makes a change that used to
// be invisible visible: a dropped bridge silently handed the kelabo back to
// the server agent on the next caption.
export const SSE_EVENT_AGENT = "agent";
export const SSE_EVENT_CONTRIBUTION = "contribution";
export const SSE_EVENT_DEBUG = "debug";
export const SSE_EVENT_ENDED = "ended";
export const SSE_EVENT_PING = "ping";
export const SSE_EVENT_RTC = "rtc";
export const SSE_EVENT_RENAME = "rename";
// Who is attached to THIS kelabo right now, derived from live SSE streams.
// Named `roster` rather than `presence` because `presence` is already the
// contact-presence stream's event name (docs 18 §5), which is per-identity and
// kelabo-agnostic. Distinct from the RTC roster: a board-only participant holds
// a stream but never joins the call, so only this one counts them.
export const SSE_EVENT_ROSTER = "roster";
export const SSE_EVENT_UTTERANCE = "utterance";
