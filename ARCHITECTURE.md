# Kelabo — Architecture Design

Open source and self-hostable in your own AWS account.

A real-time kelabo assistant. A **main agent** listens to the entire
conversation; when it detects a request or a difficulty, it dispatches a
**sub-agent** to search (web / MCP / code). The sub-agent's result is processed
by the main agent, which posts a concise answer to the kelabo's shared message
board. For developers, this agent is customized to run inside their **opencode**
session against their private codebase.

---

## 1. Product decisions

- **Name:** Kelabo.
- **Main-agent / sub-agent pattern:** a single main agent owns the conversation
  context and *orchestrates* sub-agents; sub-agents do the searching, main agent
  synthesizes and posts. (Not a flat "classifier → tool" pipeline.)
- **Developer mode attaches the developer's *own* interactive agent** (opencode,
  Claude Code) — Kelabo never spawns it, configures a model, installs an MCP
  server or approves a tool call. Kelabo supplies a token and a channel; every
  permission prompt appears in the developer's own terminal. The interface is
  three contracts (wire protocol, MCP tools, a per-runtime injection adapter):
  [`docs/components/16-agent-bridge.md`](./docs/components/16-agent-bridge.md).
- **Audio goes browser → the STT provider directly** (not through the Kelabo
  server) to cut cost and server load. The server receives **transcripts**, not
  audio. STT is a pluggable boundary with two providers, Deepgram and Soniox
  ([`docs/components/06-stt.md`](./docs/components/06-stt.md)).
- **Kelabo hosts the conference call, on Cloudflare Realtime, with two
  transports** (§16, docs 15). `sfu` (default) relays media through Cloudflare's
  edge and scales; `mesh` ("secure kelabo", host opt-in at creation) keeps media
  peer-to-peer so **no server can decrypt it**, capped at
  `rtc.meshMaxParticipants` — joiners past the cap are **refused, never silently
  moved to the SFU**. `mesh` is a *media* guarantee only: transcription, board,
  agent and persistence are identical in both modes. Audio never reaches Kelabo's
  own infrastructure in either mode; the Gateway relays signalling and nothing
  else. **Video** was initially reserved here and has since shipped (camera +
  screen share on both transports, docs 15 §8).
- **In developer mode, trigger detection does NOT run on the server.** The
  developer's opencode session (with their chosen LLM) does its own listening /
  triggering. The server just relays transcript in and contributions out.
- **Auth = passwordless, multi-provider, long sessions.**
  - **Providers:** email **OTP** *and* **social SSO (Google / Apple / …)**, both
    behind one `AuthProvider` abstraction, both minting the same session. No
    passwords, ever.
  - **Long sessions, no re-OTP every open:** a short-lived **session JWT** (~1h) plus
    a long-lived, **rotating, revocable refresh token** (~30–90 days, httpOnly). The
    SPA refreshes silently; the user only re-authenticates (OTP/social) roughly
    monthly, or on logout / device revocation. Slack-like.
  - **Domain allow-list applies to all providers** (self-host): a social login whose
    verified email domain isn't allowed is rejected.
  - **Enterprise SSO** (per-tenant SAML/OIDC federation) is not built; the
    `AuthProvider` seam leaves room for it.
- **Guests join via link** with just a **display name**; name is saved in the
  browser and auto-populates next time.
- **System-tray / OS notifications from the browser** for new board messages, so a
  participant need not keep a tab focused (or open at all, within browser limits).
- **Kelabo minutes** generated on demand when the **host** requests, at any time.
- **Persistence:** sessions + transcripts (+ minutes if generated) can be saved;
  **registered** participants can access records. Guests cannot.
- **Journeys** ([`docs/20-journey.md`](./docs/20-journey.md)): a persistent
  container linking related kelabos, so context — minutes, documents, Q&A
  reports — carries between meetings instead of starting cold each time.
- **MCP config:** the **host's personal** MCP servers, managed in common
  Settings (`/me/mcp`), apply to every kelabo they host; the host can opt out
  per kelabo at creation. Org-wide MCP and groups/ACLs are not built.
- **Serverless-first, but ONE ECS gateway is accepted, and it also hosts the
  agent.** The real-time transport (caption fan-out + shared board SSE) needs
  in-process, single-task connection state, so we run **exactly one ECS Fargate
  service** (the Gateway, `desiredCount: 1`). **The server-agent
  also runs inside this ECS task** (in a worker thread / child process) rather than
  on Lambda — Lambda's 15-minute cap would kill long sub-agent searches and lose
  in-progress work. Lambda is used only for short, bounded control-plane calls (OTP,
  token mint, kelabo CRUD). Everything else is managed services.
  - *Ceiling to watch:* a heavy agent run shares the task with socket/SSE handling;
    isolate it in a worker, cap concurrent agent runs per task, size the task
    adequately. The `AgentRunner` seam lets a larger deployment split the agent
    into its own ECS service later without a rewrite.
- **No opencode-in-browser surface (dropped).** The valuable parts are STT
  injection + the agent loop + posting results back to the board. A
  browser-embedded opencode UI / xterm and its HTTP/SSE reverse-proxy are **not
  built**. The dev-mode tunnel carries **captions + replies + lifecycle
  only** (no `http_request`/`http_stream_*` framing). Reserved for a possible future
  behind the same tunnel, but no design burden now.
- **Late-comers see prior board messages.** The board is persisted; on entry the SPA
  **backfills** via `GET /kelabos/:id/board` then subscribes to the live SSE tail.
  Same endpoint covers SSE-reconnect gaps.
- **Scale-out (future, unbuilt):** multiple Gateway/agent tasks with **kelabo
  affinity** — all connections of one kelabo (browser captions + SSE, dev tunnel,
  agent worker) are directed to the **same task**. A kelabo is assigned to a task at
  creation (consistent hash on `kelaboId`); the task registers its endpoint in
  DynamoDB, and REST (`join`, board, stt-token) hands clients that task-specific
  base URL. Failover = reassign the kelabo and let clients reconnect (identical
  semantics to a single-task restart). **ALB stays**, with per-task routing. The
  single-task deployment is the degenerate case (one task, affinity is trivial).
- **Registration is restricted to one allowed email domain**; any holder of an
  address in that domain can register via OTP.
- **Multi-tenant is reserved, not built:** the schema, tenant boundaries and
  config seams keep space for a multi-domain deployment so it stays additive,
  not a rewrite.
- **Tenant = verified email domain.** `tenantId = <email-domain>`. Everyone at
  `@company.com` is one org; active-kelabo listing + isolation query by
  `tenantId`. Self-host is a single tenant (`allowedEmailDomain`). (Downside:
  individuals on shared domains like gmail land in one "org" — acceptable for now.)
- **Dev-mode commands are `/kstart` and `/kend`**.
- **No desktop/native app.** OS notifications are delivered via the web app +
  Service Worker only.
- **Prior art:** a working v0 of this exact system exists internally
  (browser STT → opencode kelabo-bot → shared reply feed). Kelabo reuses its
  proven patterns (§15), changing: STT provider (a pluggable boundary — Deepgram
  or Soniox, not AWS Transcribe),
  auth (OTP, not Cognito hosted-UI SSO), and config (one file, dev/staging/prod,
  tagged).
- **Stack:** Vite + React + Tailwind (frontend). **Node.js + pure JS**
  (not TS) where possible, front and back.
- **Infra:** AWS CDK, **one config file** drives the *stack* (no hard-coded
  values in source). Three standalone environments: **dev / staging / prod**.
  Every resource **tagged with the endpoint name** (e.g. `dev`).
- **Operational settings are published, not deployed** (docs 23). The test is
  whether CloudFormation needs the value at synth: an account, a region, a
  domain, the gateway's size — config file. A model, a rate limit, a TTL, a
  provider — a row in `kelabo-<env>-config`, changed from `/admin` in seconds.
  Published wins, the config file is the bootstrap, so a deployment that has
  published nothing behaves exactly as its file says.
- **Who may publish is deploy-time and only deploy-time.** `rootAdminEmail`,
  empty fails closed. Everything else operational is editable from a web page,
  so the one value governing who may edit must not be.

---

## 2. Does audio hit the Kelabo server? — No.

> **Amended when conference audio was added (§16).** This section's claim still
> holds for *Kelabo's* infrastructure, and that is what it was always about. But
> Kelabo now hosts the call itself, so the honest, unabbreviated statement is:
> **no audio ever reaches Kelabo's AWS infrastructure**, in any mode. In `sfu`
> mode the call is relayed by Cloudflare's edge, and an SFU terminates DTLS-SRTP,
> so Cloudflare *can* decrypt it. In `mesh` mode nothing but the participants
> can. Transcription is unchanged either way: each browser still streams only its
> own microphone, direct to the STT provider.


**Browser captures mic → connects directly to the STT provider (Deepgram or
Soniox) → receives diarized transcript in the browser → sends only finalized
`Utterance` events to the server (`POST /caption` over HTTPS).**

Consequences (all good for the constraints above):
- Server never processes audio → far less CPU/bandwidth/cost, and easier to run
  serverless.
- STT cost/usage is per client connection (each browser opens its own provider
  session), attributable per participant. Each client runs a local VAD gate so
  only speech is billed — a participant is silent for most of a kelabo. How that
  saving lands is the provider's business: Deepgram bills the audio it receives
  (silence is held with `KeepAlive` instead of being transcribed), Soniox bills
  stream wall-clock (the client starts/stops billable streams on speech edges)
  (`spa/src/capture/vad.js`, docs 06).
- **Key handling:** the browser must not hold a long-lived provider key. A tiny
  Lambda mints a short-lived credential (a Deepgram temporary token, a Soniox
  temporary API key) from the server-side key in the `stt` credential slot
  (`CRED#stt`, docs 08 §6c) that the browser uses to open its provider socket.
  This is the only audio-related server touchpoint, and it's cheap + serverless.

So the data plane is: **audio path = browser↔STT provider**; **control/text path =
browser↔the server (transcripts, board, agent I/O)**.

---

## 3. Trigger location differs by mode

| | Server-agent mode (typical user) | Developer mode (opencode) |
|---|---|---|
| Who listens to full transcript | **Main agent on server** | **opencode session on dev's machine** |
| Who detects request/difficulty | Server main agent | opencode (dev's chosen LLM) |
| Who runs sub-agent searches | Server sub-agents (web/MCP) | opencode sub-agents (code/local MCP) |
| What crosses the server | transcript in, contribution out | transcript in, contribution out |
| Private data exposure | server sees transcript | **code never leaves laptop** |

The server's job in developer mode is pure relay + fan-out. This keeps the two
modes behind the **same interfaces** (§5) even though the "brain" lives in
different places.

---

## 4. Main-agent / sub-agent model

```
                 full transcript (finalized utterances, rolling window)
                                     │
                                     ▼
                          ┌────────────────────┐
                          │      MAIN AGENT      │  owns conversation context,
                          │  (server OR opencode)│  decides when help is needed,
                          └─────────┬────────────┘  synthesizes final answer
                            dispatch│  (task spec)
                     ┌──────────────┼───────────────┐
                     ▼              ▼                ▼
              ┌────────────┐ ┌────────────┐  ┌────────────┐
              │ Sub-agent  │ │ Sub-agent  │  │ Sub-agent  │
              │  web search│ │  MCP (Jira/ │  │  code search│
              │            │ │  wiki/etc) │  │ (dev mode)  │
              └─────┬──────┘ └─────┬──────┘  └─────┬──────┘
                    └──────────────┼───────────────┘
                                   ▼  raw findings
                          ┌────────────────────┐
                          │  MAIN AGENT (synth) │  → concise Contribution
                          └─────────┬───────────┘
                                    ▼
                              BoardSink → all participants
```

- **Server-agent mode:** main + sub agents are server-side (Lambda-invoked LLM
  calls + MCP). Sub-agent search is where latency lives; main agent streams the
  synthesized answer to the board.
- **Developer mode:** the *entire* box above runs inside opencode on the laptop;
  only the final `Contribution` is pushed to the server for fan-out.

---

## 5. Core interfaces (keep both modes unified)

```js
// Utterance: produced in the BROWSER (post-STT), sent to server.
/** @typedef {{
 *  kelaboId: string, clientId: string, speaker: string,
 *  text: string, tStart: number, tEnd: number, isFinal: boolean
 * }} Utterance */

// Contribution: agent output, fanned out to the board.
/** @typedef {{
 *  id: string, tag: "LLM_CON"|"note",
 *  kind: "answer"|"link"|"code"|"clarify"|"minutes",
 *  to: string,        // "all" (default) | participant display name; visible to all
 *  title: string,     // short title; board renders collapsed until expanded
 *  markdown: string, sources?: {title:string,url?:string}[], confidence?: number
 * }} Contribution */
```

Three seams (pure-JS modules with a documented contract, no TS interfaces):
1. **AudioSource** — always the browser+STT provider; emits `Utterance`.
2. **AgentRunner** — `ServerAgentRunner` (server main/sub agents) or
   `OpencodeAgentRunner` (relay to the dev's opencode). Server code calls the same
   `run(ctx)` and gets `Contribution`s either way.
3. **BoardSink** — `SSEBoardSink` (REST backfill + SSE live tail). Chat bridges
   later, same contract.

---

## 6. Auth & join flow

- **Registered users (OTP):**
  - Enter email → Lambda checks domain allow-list (self-host: single allowed
    domain) → emails a 6-digit OTP → verify → issue session JWT.
  - No passwords anywhere. Cognito **custom auth flow** (OTP via email) fits and is
    serverless; or a lightweight custom OTP table if we want zero Cognito. See §10.
- **Guests (link join):**
  - Open invite link → prompt for **display name** only → join.
  - Name persisted in `localStorage`, auto-filled next time.
  - Guests: ephemeral, no record access.
- **Reserved for multi-tenant:** every user/session row carries a `tenantId`
  (in single-domain self-host it is effectively constant), so multi-tenant is
  additive.

---

## 7. Notifications (system tray / OS)

- Use the **Web Notifications API** + a **Service Worker** so the browser can raise
  OS-level notifications for new board messages even when the tab is unfocused.
- True "no tab open at all" is **not possible from a pure web app** — the browser
  must be running and the SW registered. Honest limit: we can do *unfocused tab /
  background*, not *browser fully closed*. For always-on tray without a browser,
  a small optional desktop companion would be required. What ships is Web
  Notifications + SW (works for "don't need to stare at the tab").

---

## 8. Persistence & minutes

- **Sessions & transcripts:** stored in DynamoDB (see §9). Ephemeral for guests;
  retained for registered participants of that session.
- **Minutes on demand:** host clicks "Generate minutes" at any time → Lambda runs
  the main agent over the stored transcript → stores a `minutes` Contribution +
  document; downloadable, and visible to registered participants.
- **Access control:** registered participant of the session ⇒ can read its
  record. Guests ⇒ no. Org-wide/group ACLs are not built.

---

## 9. AWS architecture (Lambda control plane + one ECS Gateway)

Two planes (§15.1): a **Lambda control plane** (human-facing REST, short bounded
calls) and **one ECS Gateway data plane** (all live traffic + the server-agent).

```
Browser (Vite/React SPA on CloudFront + S3)
   │  audio  ├────────────────────────────────► STT provider (Deepgram/Soniox, direct)
   │  (short-lived STT credential from REST Lambda)
   │
   │  HTTPS REST (auth, kelabos, join, records, board backfill, stt-token)
   ▼
API Gateway (HTTP API) ──► REST Lambda (control plane) ──► DynamoDB / S3 / SES / Secrets
                                      │ POST /internal/* (internal app JWT)
                                      ▼
SPA ── POST /caption · SSE /caption/replies ──►  Gateway ECS (Fargate ×1, ALB)
Connector (dev laptop) ── WSS /rig ──────────►   · caption fan-out + per-kelabo SSE hub
                                                 · in-task server-agent worker (no time cap)
                                                 · dev-mode caption tunnel · archive writer
```

- **Control plane (Lambda):** OTP/social auth + refresh rotation, kelabo CRUD, join,
  records, minutes requests, board backfill, STT credential mint. All short and
  bounded — the 15-minute cap is irrelevant here. It reaches the Gateway through
  authenticated internal endpoints (`POST /internal/kelabos/:id/end`,
  `/internal/kelabos/:id/minutes`) so kelabo lifecycle and agent jobs signaled via
  REST take effect on the stateful data plane. `POST /internal/config/reload` is
  the one that is not about a kelabo: it tells the Gateway an administrator
  published operational config, and is best-effort — the task converges on the
  60-second cache anyway (docs 23 §6.1).
- **Data plane (Gateway, the one ECS):** holds the in-process `kelaboId→WS/SSE`
  maps, terminates long-lived WSS tunnels + SSE streams, runs the server-agent in an
  in-task worker with no time cap, writes archives. `desiredCount:1` — see
  §15.5 for why it can't be Lambda.
- **Scale-out (if ever needed) = kelabo affinity, not pub/sub:** each kelabo is
  assigned to one Gateway task at creation (consistent hash on `kelaboId`); the
  task registers its endpoint in DynamoDB and REST hands clients that task's base
  URL, so every connection of a kelabo (browser caption/SSE, dev tunnel, agent
  worker) lands on the same task. Failover = reassign + reconnect, the same
  semantics as a single-task restart.

DynamoDB tables (full schema: `docs/08-database.md`): `kelabos` (single-table per
kelabo: `META` + `UTT#` / `CONTRIB#` / `MINUTES` / `PROMOTION`), `users`, `otp`,
`refresh`, `history`, `mcp`, `contacts`, `credentials`, `journeys`, `config`
(published operational settings + the admin roster); an S3 archive bucket holds
full transcripts past the 400KB item cap. Every item carries `tenantId`.

---

## 10. Auth mechanism choice

Two serverless options; pick one:

- **A. Cognito custom-auth OTP** — passwordless email OTP via Cognito custom auth
  Lambdas (Define/Create/Verify challenge). Pros: managed tokens, JWT, ready for
  multi-tenant (user pools per tenant later). Cons: Cognito custom-auth is
  fiddly.
- **B. Home-grown OTP + JWT** — DynamoDB `OTP#` table + SES + a sign Lambda issuing
  our own JWT. Pros: simplest, fewest moving parts, fully in "one config file"
  control. Cons: we own token security; multi-tenant is manual.

Recommendation: **B** (simplest, serverless, no Cognito quirks), with the auth
module behind an interface so **A** could back a multi-tenant deployment without
changing callers.

---

## 11. Config: two tiers — what CDK builds, what the deployment publishes

`config/kelabo.json` (or `.mjs` exporting an object) is the single source of
truth **consumed by CDK**. Nothing environment-specific is hard-coded in source.

It is no longer the single source of truth for the *running* deployment. Every
value below that application code reads at request time — `llm`, `stt`, `mail`,
the agent knobs, `rtc`, `otp`, `joinCode`, `auth`, `allowedEmailDomain`,
`retentionDays` — is **publishable operational config** (docs 23) and appears
here only as the bootstrap a deployment falls back to until somebody publishes.
What genuinely stays deploy-time is what CloudFormation reads at synth, plus
`rootAdminEmail`.

```jsonc
{
  "app": "kelabo",
  "environments": {
    "dev":     { "endpoint": "dev",     "domain": "kelabo-dev.example.com",
                 "allowedEmailDomain": "example.com",
                 "stt":      { "provider": "deepgram" },
                 "llm":      { "provider": "deepseek" },
                 "ses":      { "fromAddress": "otp@kelabo-dev.example.com" },
                 "retentionDays": 30, "tenantId": "self" },
    "staging": { "endpoint": "staging", "domain": "kelabo-staging.example.com", "...": "..." },
    "prod":    { "endpoint": "prod",    "domain": "kelabo.example.com",         "...": "..." }
  }
}
```

Rules baked into CDK:
- `cdk deploy` takes `-c env=dev|staging|prod`; loads that block only.
- Each env is a **standalone stack set** (isolated resources).
- **Every resource tagged** `endpoint=<env>` (plus `app=kelabo`) via
  `Tags.of(app).add(...)` at the app root.
- Secrets are **referenced by name**, never inlined. Supplier keys are not in
  config at all — a *publish* picks the provider, and the key is a row in the
  credentials table addressed by slot, set from `/admin` → Suppliers or, for a
  deployment nobody can sign in to yet, `make credential-set` (docs 08 §6c).
- **`rootAdminEmail`** at the root of the file: the one identity that may
  administer the deployment. Empty fails closed.
- Multi-tenant slots in by promoting `tenantId` from constant to per-user.

---

## 12. Frontend (Vite + React + Tailwind, pure JS)

- SPA on **S3 + CloudFront**.
- Panels in one window: **Capture** (mic + short-lived STT credential connect +
  diarization toggle from current prototype) and **Board** (live contributions).
- **Service Worker** for OS notifications.
- Guest join screen (name only, `localStorage`).
- Host controls: "Generate minutes", session settings. MCP lives in common
  Settings (host-personal), not in the kelabo room.
- Pure **JSX/JS** (no TS) by design; use JSDoc for the shared typedefs.

---

## 13. License

MIT (see `README.md`).

---

## 14. Conflicts / honest caveats to resolve

1. **"System tray from browser" has a hard limit.** A web app can raise OS
   notifications for an *unfocused/background tab* via a Service Worker, but **not
   when the browser is fully closed**. If you truly want tray icons with the
   browser closed, that requires a small native/desktop companion. What ships
   delivers "you don't need to watch the tab," not "no browser at all."
2. **Direct-to-STT + "developer trigger not on server"** means in dev mode the
   transcript must also reach the developer's opencode. Two options: (a) browser
   sends transcript to server, server relays to the Connector/Rig; (b)
   browser/Connector peer path. (a) is simpler and keeps one transport — recommended.
3. **RESOLVED — real-time transport = one ECS Gateway.** Rather than API Gateway
   WebSocket + `@connections`, Kelabo adopts the prior art's proven **single
   Fargate Gateway** (§15.5): it holds the in-process `sessionId→WS` map, request
   correlation, and per-session SSE subscriber sets, and terminates long-lived WSS
   tunnels + SSE (ALB idle 240s). `desiredCount:1`, no horizontal scale. This
   is the only ECS service; everything else stays Lambda.
4. **OTP cost/deliverability:** SES must be out of sandbox in prod; dev/staging can
   use verified addresses. Rate-limit OTP issuance (abuse + cost).
5. **STT credentials are short-lived** (a Deepgram temp token, a Soniox
   temporary API key); the browser must fetch a fresh one per session. Cheap,
   but it's a required round-trip before capture.
6. **Pure JS (no TS) for shared contracts** loses compile-time safety on the
   `Utterance`/`Contribution` seams; mitigate with JSDoc typedefs + runtime
   validation (e.g. zod) at the server boundary.
7. **Dev-mode prompt injection:** any participant (including a name-only guest) can
   send captions or manual notes that become prompts to the dev's opencode — an
   agent with **read access to the dev's private repos** that can post results via
   `[LLM_CON]`. A crafted caption could attempt to exfiltrate code. Mitigations:
   transcript text is treated as *data, not instructions* in the kelabo-bot
   persona; `bash`/`edit` stay denied; consider a host allow-list for who may join
   dev-mode kelabos. See `docs/components/04-connector-rig.md` §5.

---

## 15. Prior art — proven patterns from the internal v0

The internal v0 is a working prototype of this exact product: browser captures
audio, streams it directly to a cloud STT, captions flow to an **opencode
`kelabo-bot` agent**, and the agent's replies fan out to a shared reply feed.
**We reuse its architecture almost wholesale.** Kelabo's deltas are: pluggable STT
(Deepgram or Soniox; the v0 uses AWS Transcribe), OTP auth (the v0 uses Cognito hosted-UI SSO), and
one-file/tagged CDK config. Everything below is extracted from the actual v0
source and is directly applicable.

> Note: the v0 has **only** the developer/opencode mode. Kelabo's server-agent
> mode (main+sub agents on Lambda) is the new part; it plugs into the same
> Gateway/board seam described here.

### 15.1 Component topology (adopt as-is)

| Kelabo component | v0 equivalent | Runtime | Role |
|---|---|---|---|
| Portal SPA | `frontend/` | S3 + CloudFront | login, session list, join, **capture panel + board** |
| Control-plane API | `lambda/` | Lambda + API GW HTTP API | auth, `/me`, `/sessions`, `/join`, `/history`, STT-token vend |
| **Gateway (the one ECS)** | `gateway/` | ECS Fargate, `ws` + `node:http`, `desiredCount:1` | browser↔opencode HTTP/SSE reverse-proxy over one WSS tunnel per host; caption channel; SSE reply hub |
| Agent bridge | `connector/` | spawned over stdio by the dev's own coding agent | WSS client to Gateway; the MCP tool surface the agent sees; transcript injection. Not a daemon — see docs 16 |
| Rig | `rig/` | Docker on dev PC | `opencode serve` + repos + creds + kelabo-bot |
| Orchestrator | `orchestrator/` | ECS (hosted workspace) | **not adopted** — RunTask ephemeral hosted rigs; skipped |

**Control plane vs data plane** (keep this split): the **Lambda** is the control
plane (human REST, no live traffic); the **Gateway ECS** is the data plane (all
live opencode HTTP/SSE + captions/replies). This is *why* there's one ECS and why
it can't be Lambda — see §15.5.

### 15.2 opencode interfacing (concrete, proven)

- opencode runs as a local server: `opencode serve --hostname 127.0.0.1 --port
  4096`. One port serves UI + JSON + SSE. Set
  `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true` so the agent can dispatch
  `Task(..., background: true)` research calls (this IS the main/sub-agent pattern).
- Two client surfaces into it, both over `http://localhost:4096`:
  - **Raw HTTP** (`node:http`, no SDK) for: `GET /global/health` (readiness gate),
    `PUT /auth/:providerID` (one-time model-credential handoff, payload
    `{type:'api', key}`), `GET /session/:id` (resolve `projectID`+`directory`), and
    a verbatim proxy of arbitrary paths.
  - **Official SDK** `@opencode-ai/sdk` (`createOpencodeClient({baseUrl})`) for the
    higher-level surface: `event.subscribe()` (SSE bus), `session.prompt({path:{id},
    body:{agent, parts, model?}})`, `session.message(s)`, `session.get/update`.
- **Two hard-won gotchas to copy:**
  1. Proxying SSE (`/event`) **must** use `timeoutMs: 0`; opencode's `/event` has no
     replay-since, so a default inactivity timeout silently kills live updates.
  2. Every proxied request is pinned with header `x-opencode-directory:
     <bound-session-directory>` so all participants share **one** realtime `/event`
     stream (per-directory opencode instance).
- **Model auth is NOT in `opencode.json`** — handed off at runtime via
  `PUT /auth/:id`. Base config generated per Rig:
  ```json
  { "$schema": "https://opencode.ai/config.json",
    "autoshare": false, "default_agent": "kelabo-bot",
    "permission": { "skill": { "*": "allow" } } }
  ```

### 15.3 The `kelabo-bot` agent — reuse this system prompt

The v0's agent frontmatter (permissions) and system prompt are directly reusable
as Kelabo's **main agent** persona. Key design points baked into it:

- **Default to silence.** The agent stays invisible unless a participant *directly
  addresses it* (it judges intent from natural language — no rigid trigger word).
  This IS the "hybrid trigger," but implemented as agent judgment rather than a
  separate classifier. For Kelabo's cost concerns we may still add a cheap
  pre-gate, but the persona already enforces "silence is default."
- **Transcript convention (adopt verbatim):** captions arrive as
  `[transcript] [Speaker] <message>`.
- **Post marker (Kelabo extension):** a reply the agent wants on the shared board
  must be tagged as an LLM contribution — start with a line `[LLM_CON]`, then
  `to: <all|participant display name>` and `title: <short one-liner>` header lines,
  then the body. `to` is `all` when unsure, else the participant the info addresses
  (still visible to everyone); `title` lets the board render the post collapsed.
  Anything without `[LLM_CON]` stays session-only (internal). This is Kelabo's
  `Contribution` fan-out gate (replaces the v0's `[POST-TO-CHAT]`).
- **Background research (adopt):** the agent uses `Task(background:true)` for
  sub-agent searches; results return later as `<task>` messages it reads silently.
  → This is Kelabo's **main-agent/sub-agent** model, already working.
- **Kelabo end (adopt):** the token `:KELABO-END` triggers a full summary
  (topics, decisions, action items, open questions, findings). → Kelabo's
  **minutes-on-demand**: host action injects `:KELABO-END`, summary is stored (and
  NOT posted to chat — it omits `[LLM_CON]`).

Permission block (frontmatter) to reuse: `read/glob/grep/list/webfetch/websearch/
task/skill/todowrite: allow`; `bash: deny`, `edit: deny`. (Kelabo server-agent mode
mirrors these; developer mode inherits whatever the dev's opencode allows.)

Two slash commands, installed as opencode command templates + plugins:
- `/kstart`: activates/promotes the current opencode session into the kelabo.
- `/kend`: ends it, triggers finalize + archive.

### 15.4 Speaker identity tagging (the exact mechanism)

opencode plugin hooks get no HTTP headers, so identity is stamped upstream:
1. **Gateway** intercepts `POST /session/:id/{message,prompt_async}` and writes
   `part.metadata.kelaboSpeaker = <participant email local-part>` onto each text
   part (`identityTag.js stampIdentity`).
2. A **Rig opencode plugin** hooks `chat.message`, reads that metadata back, and
   prepends `[name] ` to the visible text.

For Kelabo: the **speaker** field already comes from either (a) per-user capture
(authenticated identity) or (b) STT diarization label (room mode). We keep the
same "stamp identity as message metadata, plugin re-reads it" pattern so the agent
sees `[transcript] [Alice] …` regardless of source; the metadata field is
`kelaboSpeaker`.

> **Superseded:** the metadata-stamping pattern went away with the proxy. The
> bridge now composes speaker-labelled transcript itself, inside the
> `<kelabo-transcript>` envelope (docs 16 §3); `part.metadata.kelaboSpeaker` is
> gone.

### 15.5 Why the Gateway is ECS (and stays `desiredCount:1`)

The Gateway holds **in-process, single-task state** that Lambda can't:
- `kelaboId → live WebSocket` map (the dev-mode tunnel to each Rig),
- per-kelabo **SSE subscriber sets** for the board fan-out,
- **the in-task agent worker** and its per-kelabo rolling context (server mode).

Plus it terminates **long-lived WSS tunnels and SSE streams** (ALB idle 240s) and
runs the agent loop with **no 15-minute cap**. Inherently stateful/persistent → one
Fargate task, no horizontal scaling. Kelabo accepts this as its single ECS
service.

> **Change from the v0:** the opencode-in-browser reverse-proxy is **dropped**, so
> the `pendingRequests` correlation and `http_request`/`http_stream_*` framing no
> longer exist. The tunnel is caption/reply/lifecycle only.

**Frame protocol over the WSS tunnel — superseded by
[`docs/components/16-agent-bridge.md`](./docs/components/16-agent-bridge.md).**
The v0-derived shape below named opencode on the wire (`session_bound
{opencodeSessionId, …}`, `caption_reply`) and carried the board gate as the text
marker `[LLM_CON]` and the end-of-kelabo signal as the in-band caption token
`:KELABO-END`. All three had to go for a second runtime to exist at all:

- Up (bridge→Gateway): `register {token, agent}`, `heartbeat`,
  `attach {kelaboId, runtime, sessionRef, workspace}`,
  `contribution {kelaboId, markdown, to, title, kind, sources?, ref?}`,
  `summary {requestId, …}`, `archive {requestId, …}`, `rename`,
  `board_request`, `detach`.
- Down (Gateway→bridge): `registered`, `rejected`, `briefing`,
  `transcript {messageId, seq, speaker, text, at, human}`, `kelabo {event}`,
  `request {kind, requestId}`, `board`, `ping`.
- *(No `http_request`/`http_response`/`http_stream_*` — the proxy is not built.)*

**Caption fan-out path:** browser `POST /caption {kelaboId,text}` (cookie auth) →
Gateway derives speaker from the cookie (never trusts body) → routes by mode:
- **dev mode:** `transcript` frame down tunnel → the bridge's queue coalesces →
  one `<kelabo-transcript untrusted="true">` envelope injected into the
  developer's live session (`prompt_async` on opencode, a `claude/channel`
  notification on Claude Code) → the agent calls `kelabo_post` → `contribution`
  frame up.
- **server mode:** handed to the **in-task agent worker** (§15.6a) → `[LLM_CON]`
  Contribution returned in-process.
Either way → Gateway per-kelabo **SSE hub** `GET /caption/replies?kelaboId=…`
(EventSource, `withCredentials`) → board. **Late-comers/backfill:** SPA first calls
`GET /kelabos/:id/board` (persisted Contributions) then subscribes to the SSE tail.

### 15.6 STT: swap AWS Transcribe → a pluggable STT provider (the one real change)

The v0's pattern (keep the *shape*, change the provider):
- Lambda vends a **short-lived presigned/temp credential** to the browser
  (`POST /sessions/:id/transcribe-stream` → 60s SigV4 `wss://transcribestreaming…`).
  Audio goes **browser → STT directly**; audio never touches the deployment’s infra.
- Browser capture: `getUserMedia` → `AudioContext` @16kHz → `ScriptProcessorNode` →
  Float32→Int16 PCM ~100ms frames → WS to STT (matches our current `index.html`
  prototype exactly).

Kelabo change: replace the Transcribe presign Lambda with an **STT credential
mint** behind a provider boundary (`rest-api/src/stt/<id>.js`; server key in the
`stt` credential slot). The Deepgram provider mints a short-lived
token via `/v1/auth/grant`; the Soniox provider mints a temporary API key via
`/v1/auth/temporary-api-key`. The browser opens the provider's socket directly
with that credential (`SttSession {provider, url, token, …}`). Diarized
`Utterance`s (final only) are POSTed to the Gateway `/caption` endpoint exactly
like the v0. **Audio still never touches Kelabo infra.** Full design:
[`docs/components/06-stt.md`](./docs/components/06-stt.md).

### 15.6a Server-agent runs INSIDE the Gateway ECS (not Lambda)

New vs the v0 (which is dev-mode only). For kelabos with no developer, the
`ServerAgentRunner` runs **in the Gateway task**, in a **worker thread / child
process** isolated from the socket/SSE event loop:
- **Why not Lambda:** 15-minute hard cap kills long sub-agent searches and loses
  in-progress work; a warm per-kelabo context is cheaper to keep than to reload.
- **Benefits:** no time cap, can hold an in-flight search, streams partial
  `Contribution`s straight to the local SSE hub (no cross-service round-trip), reuses
  the same `kelabo-bot` persona and `[LLM_CON]` gate.
- **Isolation/ceiling:** cap concurrent agent runs per task; size the Fargate task
  for agent CPU; keep the cheap trigger gate quick. If a heavy agent contends with
  connection handling, that's the known ceiling.
- **Scale-out split (future):** move the agent into its own long-lived ECS service sharded by
  the same **kelabo affinity** as the Gateway (each task serves its assigned
  kelabos); the `AgentRunner` interface makes this a deployment change, not a
  rewrite.

Lambda keeps only short, bounded control-plane work (OTP/social callback, refresh,
STT-token mint, kelabo CRUD, records) where 15 minutes is irrelevant.

### 15.7 Auth: passwordless multi-provider + long rotating sessions

The v0 uses server-side Authorization-Code+PKCE against Cognito Hosted UI, mints
**plaintext base64url JSON cookies** (Kelabo names them `kelabo_session`,
`kelabo_participant`), re-validated against DynamoDB on every use (no JWT
authorizer at API GW). The Rig tunnel is the only place a Cognito JWT signature
is verified (at `register`).

Kelabo keeps the **cookie + DynamoDB re-validation** model (simple, serverless) but
changes the front and the lifetime:
- **Providers, behind one `AuthProvider` interface:** email **OTP** and
  **social OIDC** (Google/Apple/…). Both verify an email, enforce the self-host
  **domain allow-list**, upsert the user, and mint the same session. Enterprise SSO
  federation is not built.
- **Long sessions, no re-auth every open:** short **session JWT** (~1h) in
  `kelabo_session`, plus a long-lived **rotating refresh token** (~30–90d) in
  `kelabo_refresh` (httpOnly). SPA refreshes silently; user re-auths only ~monthly
  or on logout/revocation. Refresh tokens are one-time (rotated on use), stored
  hashed, and revocable (logout-everywhere).
- **Guests** still get a `kelabo_participant` cookie at `/join` scoped to
   `Domain=.<env-domain>` (per-env, e.g. `.kelabo-dev.example.com`), name-only, no refresh token.
- Cookie shapes in `docs/10-data-contracts.md`.

### 15.8 DynamoDB schema (adopt the v0's, add `tenantId`)

- **kelabos** — single-table per kelabo (`KELABO#<id>` + `META`/`UTT#`/`CONTRIB#`/
  `MINUTES`/`PROMOTION`). GSI `status-index` for the active list; **partitioned by
  `tenantId`** so a multi-domain deployment lists only same-domain kelabos
  (self-host = one tenant).
  Persisted `CONTRIB#` items enable board backfill for late-comers.
- **history** — PK `archiveId`; no TTL (permanent); GSI `participant-index` for "my
  records"; Gateway is sole writer.
- **users** — `USER#<email>`; profile; registered only (guests ephemeral).
- **otp** — `OTP#<email>` code (hashed) + TTL + rate counters (new).
- **refresh-tokens** — `RT#<tokenId>` hashed, rotating, revocable (new; enables long
  sessions without re-OTP).
- **mcp** — host-personal MCP config (`MCP#host#<identity>`; org scope not built).
- **`tenantId = <email-domain>`** on every item (self-host: single domain).
- **S3 archives bucket** — full transcripts (bypass 400KB item cap), key
  `archives/<host>/<archiveId>.json`.

### 15.9 CDK: what to reuse vs. change

Reuse the v0's stack decomposition: DNS (import zone), ACM certs (home region +
us-east-1 for CloudFront via `crossRegionReferences:true`), DynamoDB, Lambda +
API GW HTTP API (`/{proxy+}`, no JWT authorizer), **Gateway ECS**
(`ApplicationLoadBalancedFargateService`, `desiredCount:1`, health `/health`, ALB
idle 240s, default VPC public subnets/no NAT for cost), CloudFront Portal
(S3+OAC+SPA-fallback). Rig/Connector are Docker images.

Kelabo changes to CDK:
- **One config file** `config/kelabo.json` keyed by env (the v0's config
  only populated `dev`); Kelabo populates dev/staging/prod
  as **standalone stack sets**.
- **Tag every resource** `endpoint=<env>` + `app=kelabo` at the app root.
- **Gateway task sized for the in-task agent** (more CPU/mem than the v0's
  256/512; the agent worker lives here).
- Drop the **Cognito** stack (OTP + social OIDC instead); drop
  **hosted-workspace/orchestrator** stacks; **drop the opencode-surface
  CloudFront stack** (surface not built).
- Add: **STT credential-mint** Lambda + **SES** (OTP email) + **otp** table +
  **refresh-tokens** table + **social OIDC** client secrets (Google/Apple).
- **Scale-out (future):** raise `desiredCount` with **kelabo-affinity routing**
  (per-task endpoints registered in DynamoDB, handed out by REST; ALB per-task
  routing rules); optionally add a dedicated agent ECS service sharded by the
  same affinity.

### 15.10 What to explicitly NOT carry over

- AWS Transcribe / SigV4 presign (→ short-lived STT provider credential).
- Cognito hosted UI + PKCE + `mode=rig`/`mode=launch` blobs (→ OTP + social OIDC).
- Orchestrator + hosted-workspace + PTY/TUI server (not adopted).
- **opencode-in-browser surface + its HTTP/SSE reverse-proxy** — the
  `http_request`/`http_stream_*` framing, directory-pinning, proxy session-guard,
  and opencode-surface CloudFront. Value is STT-in + agent loop + board post-back;
  the surface adds complexity without much value. Reserved behind the tunnel for a
  possible future; **not built**.
- Recall.ai kelabo-bot bridge — never existed for us.
- `crossRegionReferences` complexity can stay (needed for CloudFront ACM in
  us-east-1).

---

## 16. Conference audio (Cloudflare Realtime)

Full component design: [`docs/components/15-conference-rtc.md`](./docs/components/15-conference-rtc.md).

Kelabo hosts the kelabo's call. Two transports, chosen by the host at creation
and **fixed for the life of the kelabo** (changing it midway would revoke the
guarantee people joined under):

- **`sfu`** (default) — Cloudflare Realtime SFU. One published track per
  participant, everyone pulls everyone. Scales.
- **`mesh`** ("secure kelabo") — full-mesh WebRTC. Media flows peer-to-peer
  under DTLS-SRTP and **no server, ours or Cloudflare's, can decrypt it**.
  Cloudflare TURN may relay, but a relay cannot decrypt, so the guarantee holds.

### The three decisions worth restating

1. **The mesh cap refuses; it does not downgrade.** Past
   `rtc.meshMaxParticipants` (default 5, publishable) a joiner gets `409 mesh_room_full` and
   keeps the board and transcript. Spilling over to the SFU would quietly break
   the promise the host chose.
2. **`mesh` secures media only.** Transcription, the board, the agent and persistence
   are unchanged. A secure kelabo is not an off-the-record kelabo.
3. **STT stays per-browser.** Each participant transcribes only their own mic;
   the call carries playback audio and is never a transcription source. That is
   what keeps speaker attribution exact and the STT bill per-participant.

### Where it lives

Signalling rides the **existing SSE stream** (a new `rtc` event) plus `POST
/rtc/*` on the Gateway — no new transport, no new connection. The Gateway also
proxies the Cloudflare SFU API so the app credentials never reach a browser, and
it resolves the caller's session id from its own peer record rather than the
request body, so a client cannot drive a session it does not own. Presence is
in-process (`state.rtcRooms`), like `sseSubscribers`; the durable half is
`rtcMode` on the kelabo META.

### Consequences to watch

- `desiredCount: 1` is now load-bearing for RTC signalling too. Any future
  kelabo-affinity scale-out (§1, §15.5) must route RTC connections with the rest.
- STT spend rises: a hosted call means everyone is genuinely on it for the
  whole kelabo, rather than several people sharing one room mic. The VAD gate
  still bounds it.
- Mesh sizing is calibrated for audio. **Video multiplies per-peer uplink and
  the cap must drop accordingly.**

### Reserved for video — since shipped (docs 15 §8)

`Peer.tracks` is an open kind→trackName map, `addLocalTrack(kind, track)` is the
single insertion point on both transports, the SFU proxy is track-generic,
`ParticipantTile` reserves a fixed media box, and `config.rtc.video` is plumbed
end-to-end. Video was added exactly this way — camera and screen share are each
one more published track, and `rtc.video` defaults to `true`. It is publishable
op-config now (docs 23) — and the canonical reason that fold's "unset" sentinel
is `null` rather than falsiness: `false` means *audio only* and a truthiness
check would discard it. Like every `rtc.*` default it applies to a **new**
kelabo; an existing one keeps the `rtcMode` stamped on its META.
