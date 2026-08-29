# 09 — Data Flows

Sequence diagrams for every key flow. Components: **SPA**, **REST** (Lambda),
**Gateway** (ECS, hosts the server-agent worker), **agent bridge** + the developer's own coding agent (dev
laptop), the **STT provider** (Deepgram or Soniox — [components/06-stt.md](components/06-stt.md)),
**DynamoDB/S3**, **SES**, social **OIDC** providers, and — in §15 — an
**admin** (a signed-in administrator at `/admin`).

Legend: `──▶` request, `◀──` response/event, `···` async/background.

---

## 1. OTP login

```
SPA            REST            SES         DynamoDB
 │  POST /auth/otp/request {email}          │
 │───────────────▶│ validate domain         │
 │                │ put OTP#<email>(ttl) ───▶│
 │                │ SendEmail ──▶ SES        │
 │◀───────────────│ 200 {resendInSeconds}    │
 │  (user reads code)                        │
 │  POST /auth/otp/verify {email,code}       │
 │───────────────▶│ get OTP#<email> ◀────────│
 │                │ check code/attempts       │
 │                │ delete OTP; upsert USER ─▶│
 │                │ establishSession: mint session JWT
 │                │   + put RT#<id> (refresh) ▶│
 │◀───────────────│ 200 {identity} +Set-Cookie ×2 (session+refresh)│
 │  navigate Home                            │
```
Failure branches: `domain_not_allowed` (403 at request), `invalid_code`/
`code_expired`/`too_many_attempts` (at verify), `rate_limited` (429).

## 1a. Social login (Google/Apple)

```
SPA              REST                 Provider(OIDC)      DynamoDB
 │ click "Continue with Google"        │                  │
 │ GET /auth/oidc/google/start ───────▶│ PKCE+state cookie │
 │◀ 302 to provider ───────────────────│                  │
 │ ───────────────────────────────────▶│ user consents     │
 │◀ 302 /auth/oidc/google/callback?code │                  │
 │ ───────────────────────────────────▶│ exchange code ───▶│ verify id_token
 │                REST: verified email; ENFORCE domain allow-list
 │                upsert USER; establishSession (+RT) ─────▶│
 │◀ 302 / +Set-Cookie ×2                │                  │
```
Disallowed domain → `domain_not_allowed` page (e.g. a random gmail on a
`@company.com` self-host).

## 1b. Silent refresh (no re-login every open)

```
SPA                         REST                    DynamoDB
 │ app load → GET /me                                │
 │───────────────▶│ 401 (session expired)            │
 │ POST /auth/refresh (kelabo_refresh cookie)         │
 │───────────────▶│ get RT#<id> (hash) ◀─────────────│
 │                │ valid? rotate: new RT, revoke old ▶│
 │                │ mint fresh session JWT            │
 │◀ 200 {identity} +Set-Cookie ×2                     │
 │ continue as logged-in                              │
 │ (reused/rotated token ⇒ revoke chain ⇒ 401 → Login)│
```
A background timer refreshes just before the ~1h session expiry; users re-auth only
~monthly (refresh expiry) or after logout.

---

## 2. Create kelabo (host)

```
SPA            REST            DynamoDB
 │ POST /kelabos {title}        │
 │──────────────▶│ conditional put META (guard activeHost) ─▶│
 │◀──────────────│ 200 {kelaboId,joinUrl,status:active}     │
 │ show share-link dialog; navigate /m/:id                    │
```
A host may run several live kelabos at once — a second create is a genuinely
new kelabo (the one-active-per-host `already_active` bounce was removed
2026-07-31).

---

## 3. Join (guest or registered)

```
SPA               REST              DynamoDB
 │ GET /kelabos/:id (public)        │
 │────────────────▶│ get META ◀──────│
 │◀────────────────│ {title,status}   │
 │ user picks name+mode              │
 │ POST /kelabos/:id/join {name,mode}│   mode ∈ {audio-board, board-only}
 │────────────────▶│ verify active    │
 │                 │ identity: session? else guest:<uuid>
 │                 │ append participants[] ─▶│
 │                 │ mint kelabo_participant  │
 │◀────────────────│ 200 {gatewayBaseUrl} +Cookie│
 │ navigate /m/:id                                             │
 │ save name → localStorage                                    │
```
*(No opencode-tab mode.)*

## 3a. Board backfill on entry (late-comer)

```
SPA                         REST                 Gateway
 │ enter /m/:id                                   │
 │ GET /kelabos/:id/board?limit=50 ─▶│ read CONTRIB# │
 │◀ {contributions, nextSince}        │            │
 │ render prior AI messages; note lastAt          │
 │ open EventSource /caption/replies?kelaboId ──▶│ live tail
 │◀ contribution (at > lastAt) ───────────────────│
 │ (de-dupe by at across handoff)                 │
```
A person joining at minute 20 sees earlier AI posts, then live ones.

---

## 4. Capture → board — SERVER-AGENT mode (no developer)

```
SPA          REST         STT           Gateway       Agent        DynamoDB
 │ POST /kelabos/:id/stt-token          │             │            │
 │──────────▶│ mint credential ◀─Secrets │             │            │
 │◀──────────│ SttSession {provider,url,token,params}  │            │
 │ open WSS ─────────────▶│ (audio, direct)            │            │
 │ mic PCM ··············▶│                            │            │
 │◀── diarized results ───│                            │            │
 │ (interim → UI only)                                  │            │
 │ final Utterance                                      │            │
 │ POST /caption {kelaboId,text,isFinal} ▶│           │            │
 │                        Gateway: speaker from cookie  │            │
 │                        append UTT ───────────────────────────────▶│
 │                        hand to IN-TASK agent worker ▶│            │
 │                                    (same ECS task)   │ gate INFO_GAP?│
 │                                          │ main→sub-agents (web/MCP)│
 │                                          │  (long search OK, no 15m cap)
 │                                          │ synthesize Contribution  │
 │                        ◀ Contribution (local call) ·│ ([LLM_CON])     │
 │                        append CONTRIB ───────────────────────────▶│
 │◀ SSE contribution ─────│ fan-out to subscribers (partials stream)  │
 │ render on board; SW notify if unfocused                            │
```
Notes: the agent runs **in the Gateway ECS task** (worker thread) — no cross-service
hop, no 15-min limit, partials stream to the board. Only `[LLM_CON]`
contributions are fanned; the cheap gate keeps the agent idle on `NONE`; rolling
window kept in the worker (rehydrated from DynamoDB on restart).

---

## 5. Capture → board — DEVELOPER mode (an agent is attending)

```
SPA        Gateway        kelabo-mcp        the developer's agent
 │ POST /caption {text,isFinal} ▶│           │                     │
 │            speaker from cookie │           │                     │
 │            transcript frame ──▶│ queue.push│                     │
 │                                │ (coalesce while the agent is    │
 │                                │  busy — one batch in flight)    │
 │                                │ <kelabo-transcript> ───────────▶│
 │                                │           (silence-first; the   │
 │                                │            developer approves   │
 │                                │            each tool call)      │
 │                                │◀ kelabo_post tool call ─────────│
 │            contribution ◀──────│                                 │
 │◀ SSE contribution ─────────────│ (Gateway SSE hub)               │
 │ render "from local repo" chip                                    │
```

The trigger runs **inside the developer's agent**, not on the server. Code never
leaves the laptop; only transcript in and structured contributions out cross the
tunnel. Injection is the one runtime-specific step: `prompt_async` on opencode, a
`claude/channel` notification on Claude Code (docs 16 §4).

---

## 5a. Preparing for a kelabo that has not started

```
agent            kelabo-mcp        Gateway            DynamoDB
 │ kelabo_join(scheduledId) ▶│      │                  │
 │                           │ attach ────────────────▶│ status = "scheduled"
 │                           │      │ → prepByKelabo  │ (NOT tunnelByKelabo)
 │                           │◀ briefing (agenda, invitees, RSVPs)
 │◀ <kelabo-briefing> (silent, costs no turn)
 │ … investigates the local repo …
 │ kelabo_post(finding) ────▶│ contribution ─────────▶│ put CONTRIB# ▶│
                                     (no SSE subscribers yet — it just persists)
```

`caption.js` reads only `tunnelByKelabo`, so a preparing agent **cannot** receive
transcript, even once the kelabo goes live. When it starts, nothing happens
automatically: the developer calls `kelabo_join` again to attend, or does not, and
the findings are already at the top of the board either way (docs 16 §5).

---

## 6. Session handover (`/kstart`, opencode only)

```
dev(opencode)   plugin        kelabo-mcp(:4190)   Gateway
 │ types /kstart                │                  │
 │ command.execute.before ─────▶│ POST /session    │
 │        {sessionId, baseUrl}  │                  │
 │◀ push [kelabo-system]{bound} │                  │
 │ model relays one sentence, then calls kelabo_join
 │                              │ attach ─────────▶│ put PROMOTION ▶│
```

A **handover, not a join.** The plugin exists only because the bridge is a separate
process and cannot discover either value on its own: an opencode TUI assigns its
server a random port, and a plugin hook is the only place the session id is
available. Joining is `kelabo_join`, which the agent calls. Claude Code needs no
equivalent — its channel targets the session that spawned the bridge.

---

## 7. Collaboration-surface flow — not built

*(There is no collaboration-surface flow — the opencode-in-browser tab and its
HTTP/SSE proxy are not built. The tunnel carries transcript, contributions and
lifecycle only.)*

---

## 8. Minutes (host requests, any time)

```
SPA           REST              Gateway                  DynamoDB
 │ POST /kelabos/:id/minutes ▶│                         │
 │            (host only)      │ POST /internal/kelabos/:id/minutes
 │                             │────────────────▶│       │
 │                             │                 │ server: summarize via in-task worker
 │                             │                 │ dev: request{kind:"summary",requestId}
 │                             │                 │   ◀ summary{requestId, text}
 │                             │                 │ put MINUTES ─────────────▶│ (hasMinutes=true)
 │◀ 200 {queued}               │                 │       │
 │ (SPA polls record / shows when ready)                  │
```
Minutes are stored, **not** fanned to the board. In dev mode the agent returns
them through `kelabo_minutes`, correlated by `requestId` — a deliberate tool call
rather than a board post the Gateway intercepts, which is how a contribution sent
at the wrong moment used to become the minutes.

---

## 9. Kelabo end + archive

```
SPA        REST        Gateway        agent bridge/AgentWorker  DynamoDB   S3
 │ POST /kelabos/:id/end ▶│           │                    │          │
 │        (host) set status=ended ────────────────────────▶│          │
 │        POST /internal/kelabos/:id/end ▶│               │          │
 │                         │ dev: request{kind:"archive"}; ◀ archive   │
 │                         │      later request{kind:"summary"}; ◀ summary
 │                         │ server: ask in-task agent worker to summarize
 │                         │ build Archive                             │
 │                         │ put history row (+participant-index) ─────▶│
 │                         │ put full JSON ───────────────────────────────▶│
 │                         │ settle kelaboJoinCount per linked journey │
 │                         │   (idempotent — §14c)                     │
 │                         │ SSE 'ended' to subscribers; drop worker   │
 │◀ 200 {ended}            │ kelabo{event:"ended"} down; socket STAYS  │
 │                         │ open so a late summary still lands        │
 │ show 'ended' overlay + record link (registered)                     │
```

---

## 10. Board reconnect (SSE drop)

```
SPA                    REST                 Gateway
 │ EventSource error (drop)                   │
 │ GET /kelabos/:id/board?since=<lastAt> ▶ backfill gap
 │◀ missed contributions                       │
 │ GET /caption/history?kelaboId ───────────▶│ persisted messages
 │◀ { transcriptAccess, utterances }          │ (entitlement-filtered)
 │ re-open GET /caption/replies?kelaboId ───▶│ resume live tail
 │◀ contributions                              │
```
Gateway SSE has no replay, so the SPA closes the gap via the REST board endpoint
(`?since=<lastAt>`) and the Gateway's `/caption/history` before/around
re-subscribing. History rows carry the speaker's `messageId`, and the SPA's
transcript reducer ignores an id it already sealed — so backfill-after-reconnect
cannot duplicate a message that also arrived live. The same fetch runs on first
mount, which is what fills the panel for someone (re)entering mid-kelabo.

`/caption/history` pages backwards for rooms that outlive one sitting: no
cursor returns the newest page, `before=<nextBefore>` returns the next older
one, `hasMore` says when to stop. The SPA's "Load earlier messages" button
walks this; its cursor only ever moves older, so a reconnect's newest-page
refetch cannot reset a reader who has paged back.

**Transcript entitlement.** Both `/caption/history` and the SSE fan-out apply
one rule (`transcriptEntitled`, gateway/src/caption.js): a guest on a deployment
with `guestTranscriptAccess: false` receives typed messages only — speech never
reaches their connection. The SPA's Messages/Transcript tab split is a *view* of
this; the enforcement is server-side.

---

## 11. Tunnel reconnect (agent bridge)

```
kelabo-mcp                     Gateway
 │ ws close (unexpected)         │
 │ backoff ─▶ /rig register{token, agent}
 │◀ registered{agentId}          │
 │ re-send attach{kelaboId} if still bound
 │ (rejected: invalid_token / agent_token_revoked ⇒ stop, no reconnect)
```

Re-sending `attach` is what makes a dropped socket a non-event: the Gateway's
binding is in-process and does not survive a restart either, so without the replay
the developer would have to run `/kstart` again mid-kelabo.

---

## 12. Notification (SW)

```
SPA tab(unfocused)     ServiceWorker        OS
 │ SSE contribution        │                │
 │ postMessage ───────────▶│ showNotification│──▶ tray/banner
 │                         │◀ click          │
 │◀ focus + scroll board ──│                 │
```
Limit: only while a browser tab is open (browser-closed tray would need a
desktop app, which is not built).

---

## 13. STT credential refresh (long kelabo)

```
SPA                     REST / STT provider
 │ credential near expiry / socket closed     │
 │ POST /kelabos/:id/stt-token ▶ mint fresh   │
 │◀ SttSession ; reopen WSS to the provider    │
```
Mute → close socket (stop billing); unmute → fresh credential + reopen. When
and how a billable stream idles or renews between utterances is the
provider's transport's business — billed audio ≈ speech, not kelabo length
(06 §3.1, §4).

---

## 14. Journey flows (docs 20)

### 14a. Journey report — a member asks a question

```
SPA           REST                Gateway                LLM       DynamoDB(journeys)
 │ POST /journeys/:id/reports {question} ▶│                │           │
 │              │ put REPORT# (pending); ADD reportRequestCount ───────▶│
 │              │ POST /internal/journeys/:id/report ▶│    │           │
 │              │                    │ read META/DESC#/BOARDMSG#/DOC#/LINK#-minutes ◀│
 │              │                    │ buildContext() — budgeted, docs 20 §6.2
 │              │                    │ call ────────────▶│            │
 │              │                    │ update REPORT# ready|failed ───▶│
 │              │◀ done              │                    │           │
 │◀ 200 {reportId, status:"pending"} │                    │           │
 │ GET /journeys/:id/reports/:reportId ▶│ read ◀──────────────────────│
 │◀ {question, answer, status}       │                    │           │
```
Generation runs in the Gateway because only its task role may read the LLM
secret (docs 20 §6.1). The row always ends `ready` or `failed`; the one
failure the Gateway cannot observe — being unreachable at all — is written by
REST as `failed: gateway_unreachable`.

### 14b. Agent turn — journey context supersedes host history

```
Gateway(runner)                 DynamoDB
 │ ensureContext(kelaboId)         │
 │ query KELABO#<id> JOURNEY#* ───▶│ (mirror rows, up to JOURNEY_LIMIT=3)
 │ per journey: digest = description/health/board/documents/other minutes
 │ historyStillApplies(meta, journeys)?
 │   journeys non-empty ⇒ skip loadKelaboHistory()
 │   journeys empty/unreachable ⇒ load it if historyEnabled
 │ system prompt += "JOURNEY CONTEXT:" section
```
Gated on the *reduced, reachable* result, not the raw link count, so a
dangling journey link falls back to host history rather than leaving the
assistant with neither (docs 20 §12.1). Evaluated fresh every turn.

### 14c. Kelabo end — contributor settling

```
Gateway(archive.js)                       DynamoDB(journeys)
 │ endKelabo: archive written, then        │
 │ query KELABO#<id> JOURNEY#* mirrors     │
 │ per journey: settleKelaboJoin()         │
 │   put SETTLED#<kelaboId> (attribute_not_exists) ▶│
 │   marker fresh ⇒ ADD kelaboJoinCount per participant ▶│
 │   marker exists ⇒ no-op (resumed end)   │
```
Independent of whether the archive write succeeded — a journey's roster
reflects the kelabo having happened either way — and idempotent against
`endKelabo`'s retry machinery via the marker (docs 20 §10).

### 14d. Offline journey work — dev agent, no kelabo (docs 20 §12.3)

```
Dev agent (bridge)                Gateway(tunnel)            DynamoDB(journeys)
 │ GET /agent/journeys ▶ REST     │                            │
 │ journey_attach {journeyId} ───▶│ mayAttachJourney            │
 │                                │  owner / public-tenant / ACCESSOR# ◀─│
 │ ◀── journey_briefing (description, counts, linked kelabos)  │
 │ journey_context_request ──────▶│ digest: board/docs/minutes ◀│
 │ journey_documents_request {docId} ▶│ full document text ◀───│
 │   … developer's agent codes and tests locally …             │
 │ journey_post {content} ───────▶│ aiCanPost? ⇒ BOARDMSG# + TL# ▶│
 │ journey_detach ───────────────▶│                             │
```
No transcript ever flows from a journey attachment; the posted outcome is
what the journey's next kelabo — server- or dev-mode — sees in its context.

---

## 15. Operational configuration (docs 23)

### 15a. Publishing a config version

```
 admin            SPA            REST (Lambda)          DDB config        Gateway
 │ edit /admin ──▶│               │                      │                │
 │ Publish + note─▶│ POST /admin/config {config, note}    │                │
 │                │──────────────▶│ requireAdmin         │                │
 │                │               │ zod validate ────────┤ (reject ⇒ 400, │
 │                │               │                      │  nothing written)
 │                │               │ Query OPCONFIG ─────▶│                │
 │                │               │◀──── head = vN ──────│                │
 │                │               │ PutItem V#(N+1)  ───▶│ ConditionExpression:
 │                │               │                      │ attribute_not_exists
 │                │               │◀── ok ───────────────│                │
 │                │               │ opConfig.invalidate()│                │
 │                │               │ POST /internal/config/reload ────────▶│ invalidate
 │                │               │                      │                │ reconfigure()
 │                │               │◀───────── {reconfigured} ─────────────│
 │                │◀ {version, gatewayReloaded} ─────────│                │
 │◀ "Live now" ───│               │                      │                │
```

Two things this diagram is drawn to show.

**The conditional write is the append-only guarantee.** If another administrator
published between the Query and the Put, the condition fails and the caller gets
`409 version_conflict` — reload and publish on top of theirs. A blind retry would
overwrite a change *and* the record of who made it.

**The reload is not the mechanism.** It is best-effort: the write is already
durable, so `gatewayReloaded: false` still means the publish succeeded, and the
console says "the gateway will pick this up within a minute" instead of claiming
otherwise. Other warm Lambda containers are in the same position — nothing
signals them, and they converge on their own 60-second cache. That asymmetry
(the publisher sees it instantly, everyone else within a minute) is the honest
shape of this flow.

### 15b. Rotating a supplier key

```
 admin            SPA            REST (Lambda)       DDB credentials
 │ paste key ────▶│ PUT /admin/credentials/:slot {fields}
 │                │──────────────▶│ requireAdmin      │
 │                │               │ validateCredentialFields  (unknown ⇒ 400)
 │                │               │ GetItem CRED#slot▶│
 │                │               │◀── existing ──────│
 │                │               │ MERGE {…existing, …fields}
 │                │               │ required check on the MERGED object
 │                │               │ PutItem ─────────▶│ (version+1, rotatedBy)
 │                │◀ status (booleans only) ──────────│
 │                │               │ log credential_rotated {by, slot, field NAMES}
```

No reload and no version chain: a key is not a decision anyone needs the history
of. Both services pick it up on their **5-minute** credential cache — a different
window from §15a's 60 seconds, and the reason "I rotated the key and it still
fails" is usually just early.

The merge is the whole point of the shape: an empty box means *leave this one
alone*, so the form can render a slot without the operator re-pasting keys they
are not changing, and rotating Soniox cannot silently drop Deepgram.

### 15c. Granting an administrator

```
 root             SPA            REST (Lambda)          DDB config
 │ email ────────▶│ POST /admin/roster {email}
 │                │──────────────▶│ requireRoot ⇒ 403 for a granted admin
 │                │               │ reject if == rootAdminEmail (already_root)
 │                │               │ PutItem ADMIN#<email> ──▶│
 │                │◀ {email, grantedBy} ──────────────────────│
 │                │               │ log admin_granted
```

Root-only in both directions. A granted administrator who could grant would be
root after one hop; one who could revoke could remove the others and then the
record of having done so. Root itself is `rootAdminEmail` — deploy-time, and
empty fails closed.
