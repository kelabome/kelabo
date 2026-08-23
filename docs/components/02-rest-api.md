# Component: REST API (control plane)

**Runtime:** single Lambda (Node 20) behind API Gateway **HTTP API** with a
`/{proxy+}` catch-all; a tiny in-code router dispatches by method + path. **Trust:** the control plane. It handles human-facing REST — auth,
kelabos, join, records, and minting the Deepgram token. It **never** carries live
audio/board traffic (that's the Gateway).

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
6. **Deepgram token** — vend a short-lived streaming token to the browser.
7. **Identity** — `/me`, `/logout`, `/logout-all`.
8. **Minutes** — host-triggered minutes request.

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
  `config.allowedEmailDomain` (self-host: exactly one). If allowed, generate a
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
  (reject if the email domain ∉ `allowedEmailDomain` — a random gmail on a
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

### 3.5 Deepgram token

#### `POST /kelabos/:id/stt-token` 🎟
Mint a short-lived Deepgram streaming token for the browser.
- **Behavior:** require valid participant cookie + kelabo `active`. Call Deepgram
  `GET /v1/token` (or temporary-key API) using the server key from Secrets Manager;
  return the temp token + connection params. Details in
  [06-deepgram.md](./06-deepgram.md).
- **200:** `{ token, expiresInSeconds, params: { model, diarize_model, ... } }`
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
`DELETE /me/mcp/:name/oauth` 🔑. Pasted bearer tokens are written to Secrets
Manager under `kelabo/<env>/mcp/<identity>/<name>`; items store only `secretRef`.

### 3.6 Health

#### `GET /health` 🔓 → `{ ok: true, version }`

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
| `agent` | agent-bridge device-code pairing; token list/revoke; attachable-kelabo discovery (docs 16 §6) |
| `records` | archive read + access control; S3 fetch for large transcripts |
| `deepgramToken` | mint temp STT token from server key |
| `db` | DynamoDB access (see [08-database.md](../08-database.md)) |
| `config` | load env-injected config (allowed domain, table names, secrets ARNs) |

Auth backends live behind the `AuthProvider` interface so **social OIDC** and **OTP**
share one path, and **enterprise SSO** / Cognito can be added without
touching route handlers (ARCHITECTURE §15.7).

---

## 5. Error code index (stable strings)

`unauthenticated, refresh_invalid, oidc_failed, domain_not_allowed, rate_limited,
invalid_email, invalid_code, code_expired, too_many_attempts, kelabo_not_found,
kelabo_ended, not_host, already_ended, name_required, not_a_participant,
record_not_found, stt_unavailable`.

---

## 6. IAM (least privilege)

- DynamoDB: RW on kelabos/users/otp/refresh/mcp/contacts tables; read on history;
  read S3 archive bucket. Plus a deliberately narrow `dynamodb:DeleteItem` on
  history and `s3:DeleteObject` on archive objects (for `POST /records/purge`) —
  the API still cannot *write* history rows or archives, which stay gateway-owned.
- SES: `ses:SendEmail`, fenced by a `ses:FromAddress` condition — and granted
  **only when `mail.provider` is `ses`**. A deployment sending through another
  provider gets a read grant on `kelabo/<env>/mail` instead, so it cannot still
  send from the SES identity long after it stopped meaning to.
- Secrets Manager: read Deepgram key, cookie/JWT signing key, social OIDC client
  secrets (Google/Apple); Create/Put/Get/Delete/Describe on secrets under the
  `kelabo/<env>/mcp/` prefix (host-pasted MCP bearer tokens).
- No `transcribe:*` (we use Deepgram, not AWS Transcribe).
