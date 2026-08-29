# Component: REST API (control plane)

**Runtime:** single Lambda (Node 20) behind API Gateway **HTTP API** with a
`/{proxy+}` catch-all; a tiny in-code router dispatches by method + path. **Trust:** the control plane. It handles human-facing REST — auth,
kelabos, join, records, journeys, and minting the STT credential. It **never**
carries live audio/board traffic (that's the Gateway).

No API-Gateway JWT authorizer: the Lambda validates its own **httpOnly cookies**
against DynamoDB on every call (simple, serverless).

---

## 1. Responsibilities

1. **Auth (passwordless, multi-provider)** — email **OTP** *and* **social OIDC**
   (Google/Apple/…), both behind one `AuthProvider` interface, both minting the same
   session. **Long sessions:** short session JWT + long **rotating refresh token**,
   so users don't re-auth every open.
2. **Kelabos** — create, list (active + own, tenant-scoped), end (host).
3. **Join** — mint a participant cookie for a kelabo (registered or guest).
4. **Board backfill** — serve persisted Contributions so late-comers see prior AI
   messages before subscribing to the live SSE tail.
5. **Records** — list/read archived kelabos + minutes (registered participants).
6. **STT credential** — vend a short-lived, provider-shaped streaming credential
   to the browser ([06-stt.md](./06-stt.md)).
7. **Identity** — `/me`, `/logout`, `/logout-all`.
8. **Minutes** — host-triggered minutes request.
9. **Journeys** — the full CRUD + sub-resource surface of docs 20 (§3.5c).

It does **not**: run agents (that's the Gateway's in-task worker), hold WSS/SSE
connections, or process audio.

---

## 2. Cross-cutting conventions

- **Base path:** all under the API origin (its own CloudFront behaviors on the
  Portal distribution). Content-Type `application/json`.
- **Auth cookies (httpOnly, SameSite=Lax, Secure):**
  - `kelabo_session` = short-lived session JWT `{kind:'identity', identity, tenantId,
    exp}` (**~1h**) — set on auth + on refresh.
  - `kelabo_refresh` = opaque refresh token id (**~30–90d**, `Domain=.<env-domain>`) —
    set on auth; **rotated on every use**, stored **hashed** in the refresh-tokens
    table, revocable. This is what avoids re-OTP every open.
  - `kelabo_participant` = `{kind:'participant', kelaboId, identity, tenantId,
    isGuest, exp}` (~12h, `Domain=.<env-domain>`) — set on join; **no refresh token**.
  - Cookie `Domain` is **per-env** (`.kelabo-dev.example.com`, `.kelabo-staging.example.com`, …) so
    environments never share or overwrite cookies on the common parent domain.
  - Session/participant payloads = base64url JSON **HS256-signed** (key in Secrets
    Manager); re-validated against DynamoDB on every use. Shapes in
    [10-data-contracts.md](../10-data-contracts.md).
- **`tenantId = <verified email domain>`** (self-host: the single allowed domain).
  Stamped on everything; a multi-domain deployment scopes queries by it.
- **Errors:** JSON `{ error: <code>, message?: <string> }` with appropriate HTTP
  status. Error codes are stable strings (table per endpoint).
- **Rate limiting:** OTP endpoints are rate-limited per email + per IP (abuse +
  SES cost). Implemented via a DynamoDB counter with TTL.
- **CORS:** the SPA is same-site via CloudFront; the Gateway `/caption*` endpoints
  are cross-origin and handled by the Gateway, not here.

## 2a. REST → Gateway internal calls

The REST Lambda is stateless; the Gateway holds live kelabo state. Control
actions that touch live state must reach it synchronously:

| Call | Purpose |
|------|---------|
| `POST <gatewayBase>/internal/kelabos/:id/end` | finalize + archive a kelabo |
| `POST <gatewayBase>/internal/kelabos/:id/minutes` | run a summary job now |
| `POST <gatewayBase>/internal/kelabos/:id/cancel` | notify a scheduled kelabo's cancellation |
| `POST <gatewayBase>/internal/kelabos/:id/reschedule` | notify a schedule change |
| `POST <gatewayBase>/internal/kelabos/:id/ring(/answer\|/cancel)` | deliver / answer / cancel a ring over the targets' presence streams (docs 18 §6) |
| `POST <gatewayBase>/internal/journeys/:id/report` | generate a journey report (docs 20 §6.1) — the credential is used where the call is made, so the synthesis runs there rather than here |
| `POST <gatewayBase>/internal/config/reload` | an administrator published operational config: re-read it now and re-init the agent worker (docs 23 §6.1). **The one call here that is best-effort** — the write is already durable and the Gateway converges on its 60-second cache anyway, so a failure is logged and the publish still succeeds |

All are authenticated with an **internal app JWT** minted by the Lambda (HS256,
Secrets Manager key, short exp, `aud:"gateway-internal"`); the Gateway rejects them
otherwise. `gatewayBase` comes from config (today: the single Gateway's URL; a
scaled-out deployment would resolve the kelabo's assigned task endpoint from the
kelabos table).

---

## 3. Endpoint catalog

Legend: 🔓 no auth · 🔑 session cookie · 🎟 participant cookie · 👑 host-only.

### 3.1 Auth & identity

#### `POST /auth/otp/request` 🔓
Request an OTP for an email.
- **Body:** `{ email }`
- **Behavior:** validate email; check `email` domain against
  the **resolved** allowed domain — published op-config folded over
  `config.allowedEmailDomain`, so widening it is a publish and not a deploy
  (docs 23) — self-host: exactly one. If allowed, generate a
  6-digit code, store `OTP#<email>` with TTL (e.g. 10 min) + attempt counter, send
  via SES. Always return 200 with a generic body to avoid email enumeration *unless*
  the domain is disallowed (then explicit).
- **200:** `{ ok: true, resendInSeconds: 30 }`
- **Errors:** `domain_not_allowed` (403), `rate_limited` (429),
  `invalid_email` (400).

#### `POST /auth/otp/verify` 🔓
Verify a code, log in.
- **Body:** `{ email, code }`
- **Behavior:** load `OTP#<email>`; check code + not expired + attempts left;
  on success delete OTP, upsert `USER#<email>`, then **`establishSession(email)`**
  (§3.1a) → set `kelabo_session` + `kelabo_refresh`.
- **200:** `{ identity: { email, displayName }, tenantId }` + Set-Cookie ×2
- **Errors:** `invalid_code` (401), `code_expired` (401),
  `too_many_attempts` (429).

#### `GET /auth/oidc/:provider/start` 🔓  (provider ∈ google | apple | …)
Begin social login.
- **Behavior:** generate PKCE + state, stash in a short httpOnly `kelabo_oidc`
  cookie, 302 to the provider's authorize endpoint (client id/secret from Secrets
  Manager per provider).
- **302** to provider.

#### `GET /auth/oidc/:provider/callback` 🔓
- **Behavior:** verify state; exchange code at the provider token endpoint; verify
  the ID token; extract **verified email**; **enforce the domain allow-list**
  (reject if the email domain ∉ the resolved allowed domain, the same value the
  OTP path reads so the two cannot disagree — a random gmail on a
  `@company.com` self-host is rejected); upsert `USER#<email>`;
  `establishSession(email)`; 302 → `/`.
- **Errors:** `domain_not_allowed` (403 page), `oidc_failed` (401 page).

#### `POST /auth/refresh` 🔓 (uses `kelabo_refresh` cookie)
Silently renew the session; **rotates** the refresh token.
- **Behavior:** look up `RT#<id>` (hashed) → valid & not revoked & not expired →
  issue a **new** refresh token (invalidate the old — one-time use), mint a fresh
  `kelabo_session`. Reuse of an already-rotated token ⇒ treat as theft: revoke the
  whole chain.
- **200:** `{ identity, tenantId }` + Set-Cookie ×2
- **401:** `refresh_invalid` (SPA → Login).

#### `GET /me` 🔑
- **200:** `{ identity: { email, displayName }, tenantId }`
- **401:** `{ error: 'unauthenticated' }` — SPA then tries `/auth/refresh` once
  before falling back to Login.

#### `GET /logout` 🔓
Revoke the current `kelabo_refresh`, clear `kelabo_session`/`kelabo_refresh`
(+ participant), 302 → `/`.

#### `POST /logout-all` 🔑
Revoke **all** refresh tokens for the identity (sign out every device).
- **200:** `{ ok: true }`

##### 3.1a `establishSession(email)` (internal helper)
Mints `kelabo_session` (short JWT) + creates a `RT#<id>` refresh token
(hashed, ~30–90d, optionally longer for "remember this device"), sets both cookies.
Used by OTP verify, social callback, and refresh (with rotation).

### 3.2 Kelabos

#### `POST /kelabos` 🔑
Create a kelabo (caller becomes host).
- **Body:** `{ title?, translation?: { enabled: boolean, targetLang?: string } }`
  (`translation` reserved; `targetLang` omitted ⇒ kelabo major language, auto-detected).
- **Behavior:** create `KELABO#<id>` with `status='active'`, `hostIdentity`,
  `createdAt`, `tenantId`. Generate `kelaboId` (or use host-email convention —
  see note). Return share link.
- **200:** `{ kelaboId, title, joinUrl, status:'active' }`
- **Note:** the prior art used host-email as the session PK (one active per
  host). Kelabo generates a `kelaboId` and, since 2026-07-31, has **no
  one-active-per-host guard** — a host may run several live kelabos, and a
  second create is a genuinely new one. Decision recorded in
  [08-database.md](../08-database.md).

#### `PATCH /kelabos/:id` 👑 🔒 (reserved)
Update host-controlled kelabo settings mid-kelabo.
- **Body:** `{ translation?: { enabled: boolean, targetLang?: string } }`
- **Behavior:** host-only; persists on `KELABO#<id>` and is pushed to the Gateway
  (an internal settings push — reserved alongside this endpoint; today's internal
  surface is end/minutes/cancel/reschedule/ring only, §2a) so in-flight caption
  translation picks it up; clients re-render existing `tr` lines on next backfill.
- **Errors:** `not_host` (403), `kelabo_ended` (410).

#### `GET /kelabos` 🔑
- **200:** `{ active: [KelaboSummary], mine: [KelaboSummary] }`
- `KelaboSummary` = `{ kelaboId, title, status, participantCount, startedAt,
  hostIdentity, hasMinutes }`. Backed by GSI `status-index`.

#### `GET /kelabos/:id` 🔓 (limited) / 🎟 (full)
Fetch kelabo metadata (for the Join screen and room header).
- **200 (public subset):** `{ kelaboId, title, status }` — enough to render Join.
- **200 (with participant cookie):** adds `hostIdentity, participants,
  gatewayBaseUrl, isDeveloperPresent`.
- **404:** `kelabo_not_found`; **410:** `kelabo_ended`.

#### `POST /kelabos/:id/end` 👑
End a kelabo.
- **Behavior:** caller must be host. Set `status='ended'`, `endedAt`, set TTL for
  cleanup; signal the Gateway via **`POST <gatewayBase>/internal/kelabos/:id/end`**
  (internal app JWT — see §2a) so it finalizes: dev mode sends `requestId`-correlated
  `request {kind:"archive"}` / `request {kind:"summary"}` frames down the tunnel
  (answered via `archive` / `kelabo_minutes` — docs 16 §2.A), server mode asks the
  in-task worker to summarize, then the Gateway writes the archive (history row +
  S3) and emits SSE `ended`. The summary may run here or on explicit minutes
  request.
- **200:** `{ kelaboId, status:'ended' }`
- **Errors:** `not_host` (403), `already_ended` (409).

#### `POST /kelabos/:id/minutes` 👑
Request minutes at any time.
- **Behavior:** host-only; call **`POST <gatewayBase>/internal/kelabos/:id/minutes`**
  (internal app JWT). The Gateway runs the summary over the stored transcript —
  in-task worker with `:KELABO-END` semantics (server mode) or a
  `request {kind:"summary", requestId}` frame down the tunnel answered by the
  agent's `kelabo_minutes` (dev mode — docs 16 §2.A) — and stores the result as a
  `MINUTES` record (`hasMinutes=true`).
- **200:** `{ status:'queued' }` (SPA polls record or receives via board as an
  internal note — minutes are NOT posted to the board).
- **Errors:** `not_host` (403).

#### `GET /kelabos/:id/board?since=<at>&limit=<n>` 🎟
Board backfill for late-comers and SSE-reconnect gaps.
- **Behavior:** require participant cookie + kelabo exists. Return persisted
  `Contribution`s (newest N, or those after `since`). The SPA calls this **before**
  opening the SSE stream so a person joining at minute 20 sees earlier AI messages.
- **200:** `{ contributions: [Contribution], nextSince?: number }`
- **Errors:** `kelabo_not_found` (404).

### 3.2a Scheduling & invitations

Scheduled kelabos, invitations and RSVPs (`scheduling.js` — a scheduled kelabo is
the same kelabo with `status:'scheduled'`, so the link shared a week early is
still the right link; see [18-contacts-presence-lifecycle.md](../18-contacts-presence-lifecycle.md)):

- `POST /kelabos/schedule` 🔑 — create a scheduled kelabo.
- `GET /kelabos/scheduled` 🔑 / `GET /kelabos/:id/scheduled` — list / read one.
- `POST /kelabos/:id/start-scheduled` 👑 — flip `scheduled → active`.
- `POST /kelabos/:id/cancel` 👑 / `POST /kelabos/:id/reschedule` 👑 — also pushed
  to the Gateway (`/internal/kelabos/:id/cancel|reschedule`, §2a).
- `GET /kelabos/:id/invitation` 🔑 / `POST /kelabos/:id/rsvp` 🔑 — invitation
  detail + RSVP.

### 3.2b Huddles & ring

Instant calls (`huddle.js`, docs 18 §6) — a huddle is an ordinary active kelabo:

- `POST /huddles` 🔑 — start an instant kelabo and ring contacts into it.
- `POST /kelabos/:id/ring` 🔑 — ring more people into a live kelabo; delivered by
  the Gateway over presence streams (`/internal/kelabos/:id/ring`, §2a).
- `POST /kelabos/:id/ring/answer` 🔑 / `POST /kelabos/:id/ring/cancel` 🔑 —
  accept/decline a ring / cancel it.

### 3.3 Join

#### `POST /kelabos/:id/join` 🔓 (guest) / 🔑 (registered)
- **Body:** `{ displayName, mode }` where `mode ∈ {audio-board, board-only}`.
- **Behavior:** validate kelabo is `active`. Determine `identity`: registered →
  from session cookie; guest → synthesized guest id `guest:<uuid>` with the given
  `displayName`. Append to `participants[]` (append-only). Mint
  `kelabo_participant` cookie.
- **200:** `{ kelaboId, gatewayBaseUrl, participant: { identity,
  displayName, isGuest } }` + `Set-Cookie: kelabo_participant`.
  - `gatewayBaseUrl` = the origin the SPA uses for `/caption` + `/caption/replies`.
  - *(No `opencodeUrl` — the opencode-in-browser surface is not built.)*
- **Errors:** `kelabo_not_found` (404), `kelabo_ended` (410),
  `name_required` (400).

### 3.4 Records

#### `GET /records` 🔑
List archived kelabos the caller participated in or hosted.
- **200:** `{ records: [RecordSummary] }`,
  `RecordSummary = { archiveId, title, startedAt, endedAt, participantCount,
  hasMinutes }`.

#### `GET /records/:archiveId` 🔑
- **Behavior:** verify caller is a registered participant/host of that archive
  (server-side check); load metadata + transcript + board + minutes (transcript may
  come from S3 for large kelabos).
- **200:** `{ archiveId, title, startedAt, endedAt, host, participants,
  transcript: [Utterance], board: [Contribution], minutes?: MinutesDoc }`
- **Errors:** `not_a_participant` (403), `record_not_found` (404).

### 3.5 STT credential

#### `POST /kelabos/:id/stt-token` 🎟
Mint a short-lived STT streaming credential for the browser.
- **Behavior:** require valid participant cookie + kelabo `active`. The
  provider-neutral core (`rest-api/src/stt/index.js`) reads the long-lived key
  from the `stt` credential slot (`CRED#stt`) and dispatches to the configured
  provider's mint (`rest-api/src/stt/<id>.js` — Deepgram or Soniox); every
  failure maps to `stt_unavailable`. Details in [06-stt.md](./06-stt.md).
- **200:** `SttSession` = `{ provider, url, token, expiresInSeconds, params }`
  — `params` are provider-shaped and opaque to the core.
- **Errors:** `kelabo_ended` (410), `stt_unavailable` (502).

### 3.5a Contacts & people

`contacts.js` (docs 18 §4): `GET /contacts` 🔑 (colleagues derived from the users
table + the caller's favourites), `POST /contacts/favourites` 🔑,
`DELETE /contacts/favourites/:email` 🔑, `GET /people/search` 🔑. External
cross-org contacts return 501 unless `config.contacts.external` is set.

### 3.5b Host MCP settings (`/me/mcp`)

Host-personal MCP server config ([05-agent-mcp.md](./05-agent-mcp.md) §5, §7a):
`GET /me/mcp` 🔑, `PUT /me/mcp` 🔑, `DELETE /me/mcp/:name` 🔑,
`POST /me/mcp/probe` 🔑, plus the OAuth connect flow —
`GET /me/mcp/:name/oauth/start` 🔑, `GET /me/mcp/oauth/callback` 🔑,
`DELETE /me/mcp/:name/oauth` 🔑. Pasted bearer tokens are written to the mcp
table as `SECRET#<name>` rows, in the same partition as the `SERVER#<name>` they
belong to; no route returns one, and `GET /me/mcp` reports `hasSecret`.

### 3.5c Journeys (docs 20)

`rest-api/src/journeys.js`, same `createApp(deps)` factory convention as
`kelabos.js`/`records.js`. Every route requires a session (🔑); *per-journey*
access is then resolved fresh inside `journeys.js` on every request — owner →
public-tenant-match (`identity.tenantId === journey.tenantId`) → private
`ACCESSOR#<identity>` point-read → 403 — never a cached membership flag
(docs 20 §3.2). Full semantics, permission matrix and item shapes:
[20-journey.md](../20-journey.md) §3, §11.

| Method | Path | Purpose |
|---|---|---|
| POST / GET | `/journeys` | Create `{title, description?, visibility}` / list `{mine, accessible, public}` |
| GET / PATCH / DELETE | `/journeys/:id` | Detail (counts, description head, `myRole`) / title-visibility (owner) / cascading delete (owner, docs 20 §14.1) |
| POST | `/journeys/:id/complete` \| `/reopen` | Status flip (owner); `completed` freezes every write |
| GET/POST/DELETE | `/journeys/:id/accessors[/:identity]` | Private roster — member reads, owner writes |
| POST/GET/DELETE | `/journeys/:id/kelabos[/:kelaboId]` | Link (`{kelaboId}`, caller must be host/participant of *that* kelabo) / linked list / unlink |
| POST + GET | `/journeys/:id/description[/history]` | New immutable version / version list |
| POST + GET | `/journeys/:id/status[/history]` | Health/progress snapshot (docs 20 §5) / version list |
| GET/POST/PATCH | `/journeys/:id/board[/:msgId]` (+ `/archive`, `/unarchive`, `/history`) | Pinned messages; archive is soft and reversible (docs 20 §7) |
| GET/POST/DELETE | `/journeys/:id/documents[/:docId]` | Pasted-text documents; removal is soft, one-way (docs 20 §8) |
| POST + GET | `/journeys/:id/reports[/:reportId]` | Ask a free-text question / list / read one (docs 20 §6) |
| GET | `/journeys/:id/timeline?type=&before=&limit=` | Backward-cursor timeline (docs 20 §9.2) |
| GET | `/journeys/:id/contributors` | Per-person rollups (docs 20 §10) |

*(Not built, deliberately: `POST .../reports/:reportId/apply-status` and
`GET /journeys/search` — docs 20 §17 for the first; the second is designed in
docs 20 §11 but has no route yet.)*

**Report generation does not run in this Lambda.** `POST /journeys/:id/reports`
writes the `pending` `REPORT#` row, bumps the requester's rollup, then *awaits*
`POST <gatewayBase>/internal/journeys/:id/report` (§2a) — the LLM key is
readable only by the Gateway's task role, by design; this Lambda's role can ask
whether `CRED#llm` is set but not what it is (§6), so the synthesis happens
there (docs 20 §6.1 records the correction). The Gateway
writes the row `ready` or `failed`, never leaves it `pending`; the one failure
it cannot observe — being unreachable at all — is written here as
`failed: gateway_unreachable`. The response carries only `{reportId, status}`;
the client re-fetches the finished row via GET.

**Touch-ups to existing endpoints:**

- `POST /kelabos` / `POST /kelabos/schedule` bodies accept optional
  `journeyIds: string[]` (max 10) — best-effort links at creation, reported
  back as `journeyLinks` per journey.
- `GET /kelabos/:id` (and `/scheduled`) responses gain
  `journeys: [{id, title, visibility}]` — the link-time snapshot from the
  kelabo's own `JOURNEY#` mirror rows, feeding the "Part of: …" chips.
- `DELETE /records/:archiveId`, **host-purge outcome only**: 409
  `kelabo_in_journey` while a `JOURNEY#` mirror row on the kelabo points at a
  journey that still exists and is live — unlink from every journey first
  (docs 20 §14.3). A mirror whose journey is deleted (or reduced to a
  phantom META) is treated as no link and tidied in passing. The
  participant-only "drop from my list" outcome is untouched.

### 3.6 Health

#### `GET /health` 🔓 → `{ ok: true, version }`

### 3.7 Deployment administration (docs 23)

Seven routes. Every one re-checks the caller server-side; the SPA hides its menu
entry as a courtesy, not as the control.

| Route | Who | Notes |
|---|---|---|
| `GET /admin/whoami` | any session | `{ admin, root, rootConfigured }` |
| `GET /admin/config` | admin | `{ published, effective, status, versions[] }` |
| `POST /admin/config` | admin | body `{ config, note }` → `{ version, publishedBy, note, gatewayReloaded }` |
| `GET /admin/credentials` | admin | slot status + field descriptors. **Never a value** |
| `PUT /admin/credentials/:slot` | admin | body `{ fields }`; merges |
| `GET /admin/roster` | **root** | `{ root, admins[] }` |
| `POST /admin/roster`, `DELETE /admin/roster/:email` | **root** | grant / revoke |

**`whoami` answers a non-admin instead of refusing them.** It is what the app
asks on load to decide whether to render the menu entry, so a 403 there would be
a 403 on every page load for every ordinary user. It discloses nothing but
whether *you* are an administrator.

**The publish body is the whole document, not a patch.** A patch needs a way to
say "unset this field", which is exactly the `null`-versus-absent distinction the
fold turns on (docs 23 §2.1); sending the complete document means the console's
form state *is* the version. `note` is required by the route rather than the
schema — the seeded default has nothing to explain, a human always does.

There is no `GET /admin/config/history`: history is the `versions` array inside
`GET /admin/config`, because the console renders both on one screen and two
round trips would let them disagree.

**Failure modes worth knowing:** `409 version_conflict` when two administrators
publish at once (reload and publish on top of theirs — a blind retry would
overwrite); `400 note_required` / `invalid_config`; `400 unknown_field` /
`no_fields` / `missing_field` and `404 unknown_slot` on a credential write.
Everything refuses with `403 forbidden` when the caller is not an administrator,
including when the roster simply could not be read — "we could not check"
resolves to "no".

---

## 4. Internal modules (Lambda)

| Module | Responsibility |
|--------|----------------|
| `router` | method+path dispatch over `/{proxy+}` (`:param` segments) |
| `cookies` | sign/verify/parse cookies (HS256, key from Secrets Manager) |
| `authProvider` | interface with `otp` + `oidcSocial` backends; both `establishSession` |
| `otp` | generate/store/verify codes; rate-limit counters |
| `mail/` | every outbound mail. `messages.js` says what each one contains, a transport (`ses.js`, `mailersend.js`) says how it travels, `index.js` picks one per send and supplies the from-address. `mime.js` is SES-only — its `Simple` content cannot carry the inline logo |
| `oidc` | social login start/callback (Google/Apple); PKCE; token exchange; domain enforce |
| `sessions` | `establishSession`, refresh-token issue/rotate/revoke; `logout-all` |
| `jwt` | mint/verify the app JWT embedded in cookies |
| `kelabos` | create/list/end/minutes; one-active-per-host guard; board backfill |
| `join` | participant cookie minting; guest id synthesis; participants append |
| `scheduling` | scheduled kelabos, invitations, RSVPs (`status:'scheduled'` flips at start — same id, same link) |
| `huddle` | instant "ring" calls: `create` (dial into a new kelabo) + `ringInto` (ring into a live one) |
| `contacts` | colleagues (derived from the users table) + one-way favourites; external contacts gated (501) |
| `mcpOauth` | MCP OAuth 2.1 client: discovery (RFC 9728/8414), dynamic registration (RFC 7591), PKCE authorize + callback |
| `agent` | agent-bridge device-code pairing; token list/revoke; attachable-kelabo and attachable-journey discovery (`GET /agent/kelabos`, `GET /agent/journeys` — docs 16 §6, docs 20 §12.3) |
| `records` | archive read + access control; S3 fetch for large transcripts |
| `journeys` | the docs 20 surface: lifecycle, access checks, link/unlink, description/status versions, board, documents, reports (pending row + Gateway dispatch), timeline, contributor rollups |
| `stt/` | STT credential minting: provider-neutral core (`index.js`) + one mint per provider (`deepgram.js`, `soniox.js`) — [06-stt.md](./06-stt.md) |
| `admin` | the docs 23 control plane: the roster (root-only), publishing config versions, and writing supplier credentials. Holds the only `credentials.put()` call in `src/` |
| `opconfig` | one 60-second cache per container over `PK = OPCONFIG`. `resolved()` / `effective()` fold a published version over `config`; handlers call them **per request**, never at construction |
| `db` | DynamoDB access (see [08-database.md](../08-database.md)) |
| `config` | load env-injected config (table names, secrets ARNs, `rootAdminEmail`) — the **bootstrap** half of a two-tier resolution; the published half is `opconfig` |

Auth backends live behind the `AuthProvider` interface so **social OIDC** and **OTP**
share one path, and **enterprise SSO** / Cognito can be added without
touching route handlers (ARCHITECTURE §15.7).

---

## 5. Error code index (stable strings)

`unauthenticated, refresh_invalid, oidc_failed, domain_not_allowed, rate_limited,
invalid_email, invalid_code, code_expired, too_many_attempts, kelabo_not_found,
kelabo_ended, not_host, already_ended, name_required, not_a_participant,
record_not_found, stt_unavailable, kelabo_in_journey` — plus the journey codes
of docs 20 (`not_journey_owner`, `journey_completed`,
`not_message_author_or_lead`, `not_document_owner_or_lead`, …) and the admin
codes of docs 23 (`forbidden`, `bad_email`, `already_root`, `cannot_revoke_root`,
`note_required`, `invalid_config`, `version_conflict`, `unknown_slot`,
`unknown_field`, `no_fields`, `missing_field`).

---

## 6. IAM (least privilege)

- DynamoDB: RW on kelabos/users/otp/refresh/mcp/contacts/journeys tables; read on
  history; read S3 archive bucket. Plus a deliberately narrow `dynamodb:DeleteItem` on
  history and `s3:DeleteObject` on archive objects (for `POST /records/purge`) —
  the API still cannot *write* history rows or archives, which stay gateway-owned.
- DynamoDB, the `config` table: `grantReadWriteData` — this is the component
  that publishes operational-config versions and maintains the admin roster
  (docs 08 §6d, docs 23). Append-only is a property of the *code*: the publish
  `PutItem` is conditional on the key not existing, so a version cannot be
  overwritten even though IAM would allow it. The one `DeleteItem` this role
  makes here is a revoked administrator — access control, not configuration.
- SES: `ses:SendEmail`, **unconditional**, fenced by a `ses:FromAddress`
  `StringLike` condition on `*@<sending domain>`.

  Both of those changed when mail became publishable, and for one reason: **a
  deploy-time IAM decision cannot follow a run-time value.** Granting this only
  when `mail.provider === "ses"` was right while the provider was a deploy-time
  fact; now an administrator publishes it, and a deployment whose config still
  said `mailersend` while the published version said `ses` would hold no send
  permission and fail every sign-in code — with the publish itself having
  reported success. `StringEquals` on the exact address had the same problem:
  publishing a new sender would become an AccessDenied on every send.

  What survives: this function still cannot send as another verified identity in
  the account, and SES independently refuses any domain it has not verified. The
  cost is that a typo in the local part now sends successfully from an address
  that does not exist (docs 23 §8).
- Credentials table: `dynamodb:GetItem` and `PutItem`, in **three statements**,
  plus `kms:Decrypt` **and `kms:Encrypt`** on the table's customer-managed key.

  | Slots | Grant | What this role can learn |
  |---|---|---|
  | `CRED#stt`, `CRED#mail` | `GetItem`, `LeadingKeys`-fenced, no attribute condition | the **values** — it mints STT tokens and sends mail with them |
  | `CRED#llm`, `CRED#rtc` | `GetItem` + `ForAllValues:StringEquals dynamodb:Attributes` = `CREDENTIAL_STATUS_ATTRS` + `StringEquals dynamodb:Select = SPECIFIC_ATTRIBUTES` | **only that they exist** — a whole-item read is AccessDenied |

  The second row is what makes the capability map (docs 19 §3) answerable
  without the key being readable here: `CREDENTIAL_STATUS_ATTRS`
  (`contracts/src/credentials.js`, imported by both `rest-api/src/db.js`'s
  `getCredentialStatus` and `infra/lib/lambda-stack.js`, so policy and
  projection cannot drift) is the row minus `value`, and it carries a
  non-secret `configured` marker written beside the credential. An
  attribute-scoped `GetItem` is `DescribeSecret`; an unscoped one is
  `GetSecretValue`. `Select` is pinned as well as `Attributes` because
  `dynamodb:Attributes` fences the attributes a request *names*, so a `GetItem`
  naming none would return everything and satisfy `ForAllValues` vacuously.

  **The third statement makes the second one inert, and that was a deliberate
  trade.** `/admin` → Suppliers sets and rotates every slot, so this role now
  holds whole-item `GetItem` plus `PutItem` on all four `CRED#` partitions — and
  IAM unions `Allow`, so the attribute fence above no longer restricts anything.
  The property it describes (this role can know the LLM key exists but not read
  it) is **not true** in this build and cannot be while a credential-write
  console exists. The first two statements are kept in
  `infra/lib/lambda-stack.js` unchanged, because they are the exact description
  of what this role would need if the console were removed: delete the third and
  the boundary returns with nothing else to unpick. The reason it went is that a
  self-hoster with no shell cannot run `make credential-set`, and a console that
  configures everything except the four keys the product needs is not a console.

  Still deliberately **no `Scan`** — the one call that returns every credential
  in the deployment at once — **no `Query`**, and **no `DeleteItem`** (a
  credential is replaced, never removed, so a compromised admin session cannot
  take transcription down with no way back). The slots are enumerated from
  `CREDENTIAL_SLOTS` rather than matched as `CRED#*`, so an undesigned partition
  key fails closed instead of being silently covered.

  **What replaced the fence is an application limit: no route returns a
  credential value.** `credentials.getRaw` exists and `src/admin.js` never calls
  it — `test/admin.mjs` asserts that by reading the source. A key is written from
  the console and never read back, so a stolen admin session can break this
  deployment without exfiltrating the supplier keys it runs on. Every write logs
  `credential_rotated` naming the caller, the slot and the field *names*.
  (The private SaaS branch additionally has a root-only reveal route; master
  deliberately does not.)
- Secrets Manager: read the cookie/JWT signing key, the social OIDC client
  secrets (Google/Apple) and the CloudFront→API origin secret. Nothing else —
  the supplier keys (llm/stt/rtc/mail) and the host-pasted MCP bearer tokens
  both moved to DynamoDB, and the five statements they needed are gone
  (`infra/lib/lambda-stack.js`).
- No `transcribe:*` (STT is an external provider, not AWS Transcribe).
