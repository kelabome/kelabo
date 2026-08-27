# 10 — Data Contracts (interfaces between components)

The wire/shape contracts every component agrees on. Pure JS, so these are **JSDoc
typedefs**; validate with **zod** at trust boundaries (SPA→Gateway, Connector↔
Gateway, REST inputs). One source module `contracts/` shared by frontend + backend.

---

## 1. Core domain objects

### 1.1 Utterance
Produced in the **browser** after the STT provider; the unit of transcript.
```js
/**
 * @typedef {Object} Utterance
 * @property {string}  kelaboId
 * @property {string}  clientId    // capture device instance (uuid per tab)
 * @property {string}  speaker     // identity display name (per-user) OR "A"/"B" (room diarization)
 * @property {string}  text
 * @property {number}  tStart      // ms since kelabo start
 * @property {number}  tEnd
 * @property {boolean} isFinal     // only finals are persisted / sent to agent
 * @property {string}  [tenantId]  // stamped server-side
 * @property {string}  [lang]      // reserved: BCP-47 language auto-detected by the STT provider
 * @property {string}  [tr]        // reserved: translation into the host-chosen target language
 */
```
Rules: only `isFinal:true` cross the network to the Gateway. `speaker` is treated
identically regardless of source.

### 1.2 Contribution
Agent output; the unit of the board.
```js
/**
 * @typedef {Object} Contribution
 * @property {string} id
 * @property {string} kelaboId
 * @property {"LLM_CON"|"note"} tag   // LLM_CON = LLM contribution; note = human manual note
 * @property {"answer"|"link"|"code"|"clarify"|"minutes"|"note"} kind
 * @property {string} title             // short informative title; board renders the
 *                                      // contribution collapsed (title only) until expanded
 * @property {string} to                // "all" (default when unsure) | display name of the
 *                                      // participant the info addresses; visible to everyone
 * @property {string} markdown          // rendered on the board (expanded body)
 * @property {Array<{title:string,url?:string}>} [sources]
 * @property {number} [confidence]
 * @property {string} author            // "assistant" | participant identity (manual note)
 * @property {"server"|"opencode"|"local"} [origin]  // which runner produced it
 * @property {number} at                // epoch ms
 * @property {string} [tenantId]
 */
```
Board gate: only agent replies whose raw text begins with an `[LLM_CON]` line become
fanned-out Contributions (marker and `to:`/`title:` header lines stripped; see §2).
`kind:"minutes"` is stored, never fanned. Human manual notes use `tag:"note"` and
need no marker.

### 1.3 MinutesDoc
```js
/**
 * @typedef {Object} MinutesDoc
 * @property {string} kelaboId
 * @property {string[]} topics
 * @property {string[]} decisions
 * @property {Array<{text:string,owner?:string}>} actionItems
 * @property {string[]} openQuestions
 * @property {string[]} findings
 * @property {number} generatedAt
 * @property {string} generatedBy   // "server" | "opencode" | "local"
 */
```

---

## 2. Transcript formatting (agent I/O)

- **Into the agent:** each caption becomes `[transcript] [<Speaker>] <text>`.
- **Kelabo end (server mode):** the literal token `:KELABO-END` (optionally with
  a "generate a full summary" instruction) triggers minutes. This is an internal
  prompt token of the server agent only — it is **not on the wire** in dev mode,
  where summary/archive are `requestId`-correlated `request` frames (§3.3).
- **Board opt-in (out of the agent):** a reply the agent wants on the board **must**
  be tagged as an LLM contribution — start with a line exactly `[LLM_CON]`, followed
  by two header lines and then the body:
  ```
  [LLM_CON]
  to: all
  title: Retry limit is 5 — retry.js:12
  <markdown body>
  ```
  - `to:` — `all` when the agent is unsure who the info is for; otherwise the
    **display name of the kelabo participant** the information is addressed to.
    The post is **visible to everyone** regardless; `to` is a targeting hint only.
  - `title:` — a short, informative one-liner; the board renders the contribution
    as a **collapsed small message box** showing just the title (and `to`), so the
    full content is not revealed until expanded.
  The marker and header lines are stripped before fan-out (`to`/`title` become
  Contribution fields; the body becomes `markdown`). Anything without `[LLM_CON]`
  stays session-internal.
- **Dev mode does not use `[LLM_CON]`.** A developer's local agent posts through
  the structured `contribution` frame (§3), because in a shared interactive
  session a text marker cannot distinguish a deliberate board post from the agent
  answering the developer's own typed question. The marker survives only as an
  opencode-adapter fallback and in the server agent's own output.
- **Speaker attribution (dev mode):** the bridge composes one envelope per batch,
  `[hh:mm:ss] <Speaker>: <text>` inside `<kelabo-transcript untrusted="true">`
  (docs 16 §3). The older `part.metadata.kelaboSpeaker` stamping is gone: it was
  opencode-specific and needed a plugin at the far end to be readable at all.

---

## 3. Kelabo Agent Protocol frames (bridge ↔ Gateway)

The WSS `/rig` protocol between the Gateway and a developer's local agent bridge.
Full design: [`components/16-agent-bridge.md`](./components/16-agent-bridge.md).
Schemas: `contracts/src/frames.js`, zod discriminated unions in both directions.

All frames: `{ type: string, ...payload }`, JSON.

**Runtime-agnostic on purpose.** Nothing here names opencode, Claude Code or any
other coding agent. `sessionRef` and `workspace` are opaque strings the Gateway
stores and never interprets, so supporting a new runtime is an adapter in the
bridge rather than a protocol change.

### 3.1 Up (bridge → Gateway)
```js
/** @typedef {{type:"register", token:string,
 *             agent:{runtime:string, version:string, label:string}}} FrameRegister */
/** @typedef {{type:"heartbeat"}} FrameHeartbeat */
/** @typedef {{type:"attach", kelaboId:string, runtime:string,
 *             sessionRef:string, workspace:string}} FrameAttach */
/** @typedef {{type:"contribution", kelaboId:string, markdown:string, to:string,
 *             title:string, kind:string,
 *             sources?:{title:string,url?:string}[], ref?:string}} FrameContribution */
/** @typedef {{type:"summary", requestId:string, kelaboId:string, text:string}} FrameSummary */
/** @typedef {{type:"archive", requestId:string, archive:Archive}} FrameArchive */
/** @typedef {{type:"rename", kelaboId:string, title:string}} FrameRename */
/** @typedef {{type:"board_request", requestId:string, kelaboId:string}} FrameBoardRequest */
/** @typedef {{type:"history_request", requestId:string, kelaboId:string}} FrameHistoryRequest */
/** @typedef {{type:"journey_attach", requestId:string, journeyId:string}} FrameJourneyAttach */
/** @typedef {{type:"journey_detach", journeyId?:string}} FrameJourneyDetach */
/** kelaboId is optional on every journey_*_request (docs 20 §12.3): present
 *  means "resolve against that kelabo's links"; absent means "resolve against
 *  this connection's own direct journey attachments". */
/** @typedef {{type:"journey_info_request", requestId:string, kelaboId?:string,
 *             journeyId?:string}} FrameJourneyInfoRequest */
/** @typedef {{type:"journey_context_request", requestId:string, kelaboId?:string,
 *             journeyId?:string}} FrameJourneyContextRequest */
/** @typedef {{type:"journey_kelabos_request", requestId:string, kelaboId?:string,
 *             journeyId?:string}} FrameJourneyKelabosRequest */
/** @typedef {{type:"journey_documents_request", requestId:string, kelaboId?:string,
 *             journeyId?:string, docId?:string}} FrameJourneyDocumentsRequest */
/** @typedef {{type:"journey_reports_request", requestId:string, kelaboId?:string,
 *             journeyId?:string, reportId?:string}} FrameJourneyReportsRequest */
/** @typedef {{type:"journey_timeline_request", requestId:string, kelaboId?:string,
 *             journeyId?:string, entryType?:string, before?:number,
 *             limit?:number}} FrameJourneyTimelineRequest */
/** @typedef {{type:"journey_board_request", requestId:string, kelaboId?:string,
 *             journeyId?:string}} FrameJourneyBoardRequest */
/** @typedef {{type:"journey_report_submit", requestId:string, kelaboId?:string,
 *             journeyId?:string, question:string, answer:string}} FrameJourneyReportSubmit */
/** @typedef {{type:"journey_post", requestId:string, kelaboId?:string,
 *             journeyId?:string, content:string, msgId?:string}} FrameJourneyPost */
/** @typedef {{type:"detach", kelaboId?:string}} FrameDetach */
```

### 3.2 Down (Gateway → bridge)
```js
/** @typedef {{type:"registered", agentId:string, kelaboId:string}} FrameRegistered */
/** @typedef {{type:"rejected", reason:string}} FrameRejected */
/** @typedef {{type:"briefing", kelaboId:string, status:"scheduled"|"active",
 *             title:string, host:string, scheduledAt?:number, durationMinutes?:number,
 *             startedAt?:number, note:string,
 *             invitees:{displayName:string,email?:string,response:string,isHost:boolean}[],
 *             participants:{identity:string,displayName:string,isGuest:boolean}[],
 *             journeys:{journeyId:string,title:string}[]}} FrameBriefing */
/** @typedef {{type:"transcript", kelaboId:string, messageId:string, seq:number,
 *             speaker:string, text:string, at:number, final:boolean,
 *             human:boolean}} FrameTranscript */
/** @typedef {{type:"kelabo", kelaboId:string,
 *             event:"started"|"ended"|"renamed", title?:string}} FrameKelabo */
/** @typedef {{type:"request", kind:"summary"|"archive", requestId:string,
 *             kelaboId:string}} FrameRequest */
/** @typedef {{type:"board", requestId:string, kelaboId:string,
 *             contributions:{id,title,to,markdown,author,at}[]}} FrameBoard */
/** @typedef {{type:"history", requestId:string, kelaboId:string, enabled:boolean,
 *             entries:{kelaboId,title,endedAt,summary,decisions,actionItems}[]}} FrameHistory */
/** @typedef {"ok"|"no_journey"|"ambiguous"|"journey_not_found"} JourneyResolved */
/** @typedef {{type:"journey_info", requestId:string, kelaboId:string,
 *             resolved:JourneyResolved, journeys:{journeyId,title}[],
 *             journeyId?:string, title?:string, visibility?:"public"|"private",
 *             status?:"active"|"completed", description:string,
 *             health?:"green"|"yellow"|"red"|null, progress?:number|null,
 *             counts?:Object}} FrameJourneyInfo */
/** @typedef {{type:"journey_timeline", requestId:string, kelaboId:string,
 *             resolved:JourneyResolved, journeys:{journeyId,title}[],
 *             entries:{type,summary,actor?,at}[], nextBefore?:number}} FrameJourneyTimeline */
/** @typedef {{type:"journey_board", requestId:string, kelaboId:string,
 *             resolved:JourneyResolved, journeys:{journeyId,title}[],
 *             messages:{msgId,content,createdBy?,createdAt?}[]}} FrameJourneyBoard */
/** @typedef {{type:"journey_report_submitted", requestId:string, kelaboId:string,
 *             resolved:JourneyResolved, journeys:{journeyId,title}[],
 *             reportId?:string}} FrameJourneyReportSubmitted */
/** @typedef {{type:"journey_posted", requestId:string, kelaboId:string,
 *             resolved:JourneyResolved|"ai_posting_disabled"|"message_not_found"
 *             |"already_archived", journeys:{journeyId,title}[],
 *             msgId?:string, version?:number}} FrameJourneyPosted */
/** kelaboId on every journey response defaults "" — a request made from a
 *  direct journey attachment (docs 20 §12.3) names no kelabo. */
/** @typedef {{type:"journey_briefing", requestId:string,
 *             resolved:"ok"|"journey_not_found"|"not_journey_member",
 *             journeyId?:string, title:string, visibility?:"public"|"private",
 *             status?:"active"|"completed", description:string,
 *             health?:"green"|"yellow"|"red"|null, progress?:number|null,
 *             aiCanPost:boolean, counts?:Object,
 *             kelabos:{kelaboId,title,linkedAt?}[]}} FrameJourneyBriefing */
/** @typedef {{kelaboId:string, title:string, linkedAt?:number, hasMinutes:boolean,
 *             summary:string, decisions:string[], actionItems:string[]}} JourneyKelaboEntry */
/** @typedef {{type:"journey_context", requestId:string, kelaboId:string,
 *             resolved:JourneyResolved, journeys:{journeyId,title}[],
 *             journeyId?:string, title:string, status?:string, description:string,
 *             health?:string|null, progress?:number|null, aiCanPost:boolean,
 *             board:{content}[], documents:{docId,title,excerpt,sizeBytes?}[],
 *             kelabos:JourneyKelaboEntry[],
 *             reports:{reportId,question,answer}[]}} FrameJourneyContext */
/** @typedef {{type:"journey_kelabos", requestId:string, kelaboId:string,
 *             resolved:JourneyResolved, journeys:{journeyId,title}[],
 *             entries:JourneyKelaboEntry[]}} FrameJourneyKelabos */
/** @typedef {{type:"journey_documents", requestId:string, kelaboId:string,
 *             resolved:JourneyResolved|"document_not_found",
 *             journeys:{journeyId,title}[],
 *             documents:{docId,title,addedBy?,addedAt?,sizeBytes?,content?}[]}} FrameJourneyDocuments */
/** @typedef {{type:"journey_reports", requestId:string, kelaboId:string,
 *             resolved:JourneyResolved|"report_not_found",
 *             journeys:{journeyId,title}[],
 *             reports:{reportId,question,requestedAt?,generatedBy?,answer?}[]}} FrameJourneyReports */
/** @typedef {{type:"ping"}} FramePing */
```

### 3.2a Journey tool frames (docs 20 §12.2, §12.3)

Nine request/response pairs plus a fire-and-forget detach, serving the
dev-mode journey tools (`kelabo_journey_info/context/kelabos/documents/
reports/timeline/board/report_submit/post` and `kelabo_journey_join/leave`).
All the correlated ones carry a `requestId`; even the two *writes* are
request/response, not fire-and-forget like `contribution` — a bad journey or
an `aiCanPost` refusal is a real outcome the calling model needs back ("off
is an answer, not an error", the same shape as `history`'s `enabled:false`).

`resolved` reports how the target journey was found before anything else
happened: `ok`, `no_journey` (nothing in scope), `ambiguous` (more than one
and no `journeyId` given — `journeys` lists the candidates, the same
"enumerate rather than guess" idiom as `kelabo_join`), or
`journey_not_found` (an explicit `journeyId` that is neither one of the
kelabo's links nor one of the connection's direct attachments — an id is
**never** honoured as a bare lookup key). `journey_posted` alone adds
`ai_posting_disabled`, `message_not_found` and `already_archived`;
`journey_documents`/`journey_reports` add `document_not_found`/
`report_not_found` for an explicit id that names nothing active. There is
deliberately no archive/unarchive frame — that stays a human action via
SPA/REST (docs 20 §7, §12.2).

**Two attachment scopes** (docs 20 §12.3): `kelaboId` present on a request
means "resolve against that kelabo's links, which I must be attached to or
preparing for"; absent means "resolve against the journeys this connection
attached to with `journey_attach`". `journey_attach` itself is authorized
like rest-api's `resolveAccess` — owner, public-at-tenant, or private
`ACCESSOR#` roster — and answered with `journey_briefing` (resolved
`ok`/`journey_not_found`/`not_journey_member`); a foreign-tenant journey
reads as `journey_not_found`, so ids cannot be probed. No transcript ever
flows from a journey attachment.

### 3.3 Two things that are deliberately absent

**`[LLM_CON]` is not on the wire.** A contribution is structured. The marker
cannot tell a deliberate board post from the agent answering the *developer's*
own typed question, and in a shared interactive session both appear in one
transcript. It survives only inside the opencode adapter as a fallback.

**`:KELABO-END` is not on the wire.** Summary and archive are
`requestId`-correlated `request` frames. As an in-band caption token it fired on
any caption merely *containing* the string, and the answer was recovered by
intercepting the next board post — so a contribution sent at the wrong moment
silently became the minutes.

> **The tunnel carries transcript, contributions and lifecycle only.** There is
> **no** `http_request` / `http_response` / `http_stream_*` — the
> opencode-in-browser reverse-proxy is not built (ARCHITECTURE §15.10).

---

## 4. SPA ↔ Gateway (board plane)

### 4.1 Caption POST (SPA → Gateway)
`POST /caption`  (participant cookie)
```js
/** @typedef {{kelaboId:string, text:string, isFinal:true, speaker?:string,
 *             tStart:number, tEnd:number, human?:boolean}} CaptionPost */
```
Gateway derives/overrides `speaker` from the cookie in per-user mode; in room mode
it accepts the diarization label. `human:true` marks a manual board note.

### 4.2 Board SSE (Gateway → SPA)
`GET /caption/replies?kelaboId=` (EventSource, `withCredentials`)
- `event: contribution` → `data: <Contribution JSON>`
- `event: ended` → `data: {reason}` (kelabo closed)
- `event: ping` → keep-alive comment lines

---

## 5. REST payloads (see 02-rest-api.md for the full catalog)

```js
/** @typedef {{email:string}} OtpRequestBody */
/** @typedef {{email:string, code:string}} OtpVerifyBody */
/** @typedef {{email:string, displayName:string}} Identity */
/** @typedef {{title?:string,
 *             journeyIds?:string[], // link into existing journeys at creation,
 *                                   // max 10 (docs 20 §11); also on the
 *                                   // schedule body (contracts/src/schemas.js)
 *             translation?:{enabled:boolean, targetLang?:string} /* reserved; targetLang
 *             omitted ⇒ kelabo major language (auto-detected) *&#47;}} CreateKelaboBody */
/** @typedef {{kelaboId:string, title:string,
 *             status:"scheduled"|"active"|"ended"|"cancelled",
 *             joinUrl:string}} KelaboCreated */
/** @typedef {{kelaboId:string, title:string, status:string,
 *             participantCount:number, startedAt:number, hostIdentity:string,
 *             hasMinutes:boolean}} KelaboSummary */
/** @typedef {{displayName:string, mode:"audio-board"|"board-only"}} JoinBody */
/** @typedef {{kelaboId:string, gatewayBaseUrl:string,
 *             participant:{identity:string, displayName:string, isGuest:boolean}}} JoinResult */
/** The STT credential (components/06-stt.md). `provider` is stamped by the
 *  provider-neutral core from the registry key; `params` are provider-shaped
 *  and opaque to everything but that provider's own transport.
 *  @typedef {{provider:string, url:string, token:string,
 *             expiresInSeconds:number, params:Object}} SttSession */
```

Journey additions on existing kelabo payloads (docs 20 §11): `GET /kelabos/:id`
(and `/scheduled`) responses carry `journeys: [{id, title, visibility}]` — the
link-time snapshot from the kelabo's `JOURNEY#` mirror rows — and
`capabilities.stt = { on, provider }` says which STT provider is configured
before the client ever mints (06-stt.md §2). The journey REST bodies
(`createJourneyBodySchema`, `journeyStatusBodySchema`, …) live in
`contracts/src/schemas.js`; endpoint catalog in
[components/02-rest-api.md](./components/02-rest-api.md) §3.5c.

---

## 6. Cookies & sessions

httpOnly, Secure, SameSite=Lax. Signed payloads = base64url JSON HS256 (key from
Secrets Manager); re-validated against DynamoDB on every use.

> **Cookie `Domain` is per-env** (e.g. `.kelabo-dev.example.com`,
> `.kelabo-staging.example.com`, `.kelabo.example.com` for prod) — never the bare
> parent `.example.com` — so dev/staging/prod cookies don't overwrite each other
> or leak tokens across environments.

```js
/** @typedef {{kind:"identity", identity:string, tenantId:string, exp:number}} SessionCookie */
/** @typedef {{kind:"participant", kelaboId:string, identity:string,
 *             tenantId:string, isGuest:boolean, exp:number}} ParticipantCookie */
```
- **`kelabo_session`** — short-lived session JWT (**~1h**). Set on auth + refresh.
- **`kelabo_refresh`** — opaque refresh-token **id** (**~30–90d**,
  `Domain=.<env-domain>`). One-time (rotated on use), stored hashed, revocable. Lets
  users avoid re-authenticating every open — they only OTP/social again ~monthly or
  on logout/revocation. **No password anywhere.**
- **`kelabo_participant`** — (~12h, `Domain=.<env-domain>`). Set on join; guests get
  this only (no refresh).
- **`kelabo_oidc`** — short PKCE/state during a social-login round-trip.

### 6a. Refresh-token record (DynamoDB `RT#<id>`)
```js
/** @typedef {{tokenId:string, identityHash:string, hash:string,
 *             chainId:string, rotatedFrom?:string, revoked:boolean,
 *             expiresAt:number, createdAt:number, tenantId:string}} RefreshToken */
```
Rotation: `/auth/refresh` issues a new token and invalidates the old (`rotatedFrom`).
**Reuse of a rotated token ⇒ theft suspected ⇒ revoke the whole `chainId`.**

### 6b. tenantId
`tenantId = <verified email domain>` (self-host: the single `allowedEmailDomain`).
Stamped on every persisted item and cookie; a multi-domain deployment scopes all
listing/isolation by it.

---

## 7. App JWTs (agent bridge + internal)

Three token families are signed with the **same** HMAC key
(`kelabo/<env>/cookie-key`): browser cookies, the REST→Gateway internal JWT, and
a developer's agent token. `aud` is the only thing that keeps them apart, so
**every verifier must check it** — checking `role` alone accepts a token minted
for a different purpose that happens to carry the same role.

```js
/** @typedef {{sub:string, tenant:string, role:"dev"|"user",
 *             aud:string, iat:number, exp:number}} AppJwt */

/** A developer's agent bridge (docs 16 §6). Minted only by the device-code
 *  pairing flow; `jti` is the revocation key.
 *  @typedef {{sub:string, tenant:string, role:"dev", aud:"kelabo-agent",
 *             jti:string, label:string, iat:number, exp:number}} AgentJwt */
```

| Family | `aud` | Issued by | Verified by |
|---|---|---|---|
| Agent bridge | `kelabo-agent` | `POST /agent/device/token` | `verifyAgentJwt`, plus a revocation read on `AGT#<jti>` |
| REST → Gateway internal | `gateway-internal` | `rest-api/src/internal.js` | `verifyInternalJwt` |

The agent token's revocation row is checked **once per tunnel connection**, not
per frame: signature and expiry come free with the JWT, and a table read per
frame would be absurd. The visible consequence is that revoking an agent already
in a kelabo takes effect when it next reconnects, which the Settings dialog says
plainly rather than promising immediacy.

---

## 8. Archive

```js
/**
 * @typedef {Object} Archive
 * @property {string} archiveId          // = ended kelabo id
 * @property {string} kelaboId
 * @property {string} title
 * @property {string} host
 * @property {Array<{identity:string,displayName:string,isGuest:boolean}>} participants
 * @property {number} startedAt
 * @property {number} endedAt
 * @property {Utterance[]} transcript
 * @property {Contribution[]} board
 * @property {MinutesDoc} [minutes]
 * @property {string} [tenantId]
 */
```
Large transcripts stored in S3 (`archives/<host>/<archiveId>.json`); a summary row in
the history table (see [08-database.md](./08-database.md)).

---

## 9. MCP config

```js
/**
 * @typedef {Object} McpServer
 * @property {string} name
 * @property {"http"|"local"} transport
 * @property {string} [url]
 * @property {Object} [headers]
 * @property {string} [secretRef]   // `<identity>/<name>` — points at the SECRET# row, never the token
 * @property {boolean} enabled
 */
/** @typedef {{servers: McpServer[]}} McpConfig */
```
Effective config (server mode) = the host's `MCP#host#<hostIdentity>` set
(`enabled !== false`), empty when the kelabo meta has `mcpEnabled: false`.

---

## 10. AgentContext / AgentRunner (repeat from agent-mcp for convenience)
```js
/** @typedef {{kelaboId:string, trigger:Utterance, window:Utterance[],
 *             capabilities:string[], mcp:McpConfig, model:ModelConfig}} AgentContext */
/** @typedef {{run:(ctx:AgentContext)=>AsyncIterable<Contribution>}} AgentRunner */
/** @typedef {{provider:string, model:string, smallModel:string}} ModelConfig */
```

---

## 11. Validation policy

| Boundary | Validate |
|----------|----------|
| REST request bodies | zod schemas per endpoint |
| `POST /caption` | `CaptionPost` zod; reject non-final; clamp text length |
| WSS frames (both directions) | discriminated-union zod on `type` |
| SSE payloads | serialized `Contribution`; client tolerates unknown fields |
| Cookies/JWT | signature verify + DynamoDB re-validation |

Unknown fields are ignored (forward-compatible); required fields missing → reject.
