# Component: Gateway (the one ECS)

**Runtime:** a single ECS Fargate service (`desiredCount: 1`), a plain `node:http`
server + a `ws` WebSocket server. Behind an ALB (idle timeout 240s). **This is the
only ECS in the system.** **Trust:** the data plane + the agent host — it carries
all live traffic (captions, board fan-out, dev-mode tunnel) **and runs the
server-agent in an in-task worker**.

Why ECS not Lambda: (a) it holds **in-process, single-task state** (connection map,
SSE subscriber sets); (b) it terminates **long-lived WSS + SSE**; (c) it runs the
**agent loop with no 15-minute cap**. All impossible on Lambda.

> **Dropped from the prior art:** the opencode-in-browser reverse-proxy. No
> `http_request`/`http_stream_*` framing, no request correlation, no proxy
> session-guard, no directory-pinning-for-proxy. The tunnel is **caption/reply/
> lifecycle only**. (ARCHITECTURE §15.5, §15.10.)

---

## 1. Responsibilities

1. **Board fan-out (all kelabos):** accept captions (`POST /caption`), deliver
   Contributions to browsers via a per-kelabo SSE hub (`GET /caption/replies`).
2. **Server-agent (in-task worker):** for kelabos with no developer, run the
   main/sub agent + trigger gate and post `[LLM_CON]` Contributions to the SSE
   hub — in-process, no cross-service hop. (see [05-agent-mcp.md](./05-agent-mcp.md))
3. **Agent tunnel (dev mode):** maintain one authenticated WSS tunnel per attached
   agent bridge (`/rig`), send transcript down, receive structured contributions
   up. Runtime-agnostic — see [16-agent-bridge.md](./16-agent-bridge.md). **No
   HTTP proxy.**
4. **Speaker identity stamping:** derive speaker from the participant cookie
   (per-user) or accept the diarization label (room).
5. **Archive:** on kelabo end, persist transcript + board to history (DynamoDB +
   S3).
6. **Journey duties (docs 20):** generate journey reports on behalf of the REST
   API (the LLM key is readable here and nowhere else — the control plane's role
   can see only *that* `CRED#llm` exists, §6.1 of docs 20), push linked-journey
   context into the agent's system prompt, serve the dev-mode journey tools
   over the tunnel, and settle journey contributor counts on kelabo end — §6a.

---

## 2. Listener surface

| Path | Method | Purpose | Auth |
|------|--------|---------|------|
| `/health` | GET | ALB liveness | 🔓 |
| `/caption` | POST | browser sends a finalized utterance (or manual note) | participant cookie |
| `/caption/rename` | POST | rename the kelabo from the room UI | participant cookie |
| `/caption/replies?kelaboId=` | GET (SSE) | browser subscribes to the board | participant cookie |
| `/presence/stream` | GET (SSE) | contact presence stream (docs 18 §5) — one per open tab, not kelabo-scoped | session cookie |
| `/rtc/join`, `/rtc/leave`, `/rtc/ice`, `/rtc/media`, `/rtc/signal`, `/rtc/sfu/session`, `/rtc/sfu/tracks`, `/rtc/sfu/renegotiate`, `/rtc/sfu/tracks/close` | POST/PUT | conference-audio signalling ([15-conference-rtc.md](./15-conference-rtc.md)) | participant cookie |
| `/rig` | GET (WS upgrade) | a developer's agent bridge opens the tunnel | agent token in the first frame (`aud: kelabo-agent`) |
| `/internal/kelabos/:id/end` | POST | REST Lambda signals kelabo end (finalize + archive) | internal app JWT |
| `/internal/kelabos/:id/minutes` | POST | REST Lambda requests a minutes job | internal app JWT |
| `/internal/kelabos/:id/cancel`, `.../reschedule` | POST | REST Lambda signals a scheduled kelabo cancelled / rescheduled | internal app JWT |
| `/internal/kelabos/:id/ring`, `.../ring/answer`, `.../ring/cancel` | POST | REST Lambda asks the Gateway to deliver / answer / cancel a ring over presence streams (docs 18 §6) | internal app JWT |
| `/internal/journeys/:id/report` | POST | REST Lambda asks for a journey report to be generated (docs 20 §6.1) — §6a | internal app JWT |
| `/internal/config/reload` | POST | REST Lambda signals that operational config was published: re-read it and re-init the agent worker (§6b, docs 23) | internal app JWT |

That's the whole surface. Board history backfill is served by the **REST API**
(`GET /kelabos/:id/board`), not here — the Gateway only streams the live tail. The
`/internal/*` endpoints sit on the same ALB listener but require the internal app
JWT (HS256, Secrets Manager key, `aud:"gateway-internal"`, minted by the REST
Lambda); anything else gets 401.

---

## 3. In-process state (why it's one task)

| Structure | Shape | Purpose |
|-----------|-------|---------|
| `tunnelByKelabo` | `Map<kelaboId, Conn>` | the agent **attending** each kelabo — transcript routes here |
| `prepByKelabo` | `Map<kelaboId, Conn>` | the agent **preparing for** a scheduled kelabo. Separate map on purpose: `caption.js` never reads it, so a prep binding cannot receive transcript (docs 16 §5) |
| `sseSubscribers` | `Map<kelaboId, Set<{res, participantId}>>` | board subscribers per kelabo. The identity travels with the subscription so mesh signalling can address one peer, a dropped stream can remove them from the call, and the **live roster** below can be derived |
| `promotedByKelabo` | `Map<kelaboId, {runtime, sessionRef, workspace, …}>` | which local agent session is bound (dev mode); runtime-agnostic |
| `agentWorkers` | `Map<kelaboId, WorkerHandle>` | in-task agent context per active server-mode kelabo |

All ephemeral; durable state lives in DynamoDB/S3.

One further piece of in-process state is **not** per-kelabo: `c.opConfig`, the
60-second cache over the published operational configuration (§6b). Unlike
everything above it survives a kelabo ending, and unlike everything above a
failed read keeps serving the last good value rather than emptying. On task restart, agent bridges
reconnect (`register`), browsers re-open EventSource + backfill via REST, and
agent context reloads from the kelabos table.

---

## 4. Agent tunnel — the Kelabo Agent Protocol

JSON frames over WSS `/rig`, between the Gateway and a developer's local agent
bridge. Full design: [16-agent-bridge.md](./16-agent-bridge.md). Schemas:
[10-data-contracts.md](../10-data-contracts.md) §3, `contracts/src/frames.js`.

Runtime-agnostic — nothing here names a coding agent, and `sessionRef` /
`workspace` are opaque strings the Gateway stores and never interprets.

**Up (bridge → Gateway):**
| type | payload | meaning |
|------|---------|---------|
| `register` | `{ token, agent:{runtime,version,label} }` | authenticate; `aud: kelabo-agent`, revocation checked once |
| `heartbeat` | `{}` | every 30s |
| `attach` | `{ kelaboId, runtime, sessionRef, workspace }` | bind this agent session to a kelabo |
| `contribution` | `{ kelaboId, markdown, to, title, kind, sources?, ref? }` | a board post; `ref` makes a retry idempotent |
| `summary` | `{ requestId, kelaboId, text }` | the minutes, answering a `request` |
| `archive` | `{ requestId, archive }` | answers a down `request{kind:"archive"}` (§9), never unsolicited; optional — the Gateway's own copy is authoritative |
| `rename` | `{ kelaboId, title }` | rename the kelabo |
| `board_request` | `{ requestId, kelaboId }` | read the board |
| `history_request` | `{ requestId, kelaboId }` | read the minutes of the host's past kelabos (host opt-in, `historyEnabled`) |
| `journey_attach` / `journey_detach` | `{ requestId, journeyId }` / `{ journeyId? }` | bind/unbind this connection to a journey directly — no kelabo, no transcript (docs 20 §12.3); authorized like rest-api's `resolveAccess` |
| `journey_info_request` / `journey_context_request` / `journey_kelabos_request` / `journey_documents_request` / `journey_reports_request` / `journey_timeline_request` / `journey_board_request` | `{ requestId, kelaboId?, journeyId?, … }` | the dev-mode journey read tools (docs 20 §12.2, §12.3) — §6a. `kelaboId` present resolves against that kelabo's links; absent, against the connection's direct journey attachments |
| `journey_report_submit` | `{ requestId, kelaboId?, journeyId?, question, answer }` | store the agent's own synthesis as a report — no LLM round-trip |
| `journey_post` | `{ requestId, kelaboId?, journeyId?, content, msgId? }` | write/edit a journey board message, gated by `aiCanPost` |
| `detach` | `{ kelaboId? }` | leave |

**Down (Gateway → bridge):**
| type | payload | meaning |
|------|---------|---------|
| `registered` | `{ agentId, kelaboId }` | accepted; `kelaboId` is empty — the Gateway does not guess |
| `rejected` | `{ reason }` | auth or authorization failure |
| `briefing` | `{ kelaboId, status, title, host, scheduledAt?, note, invitees[], participants[], journeys[] }` | everything the agent needs on attach; `journeys` names the kelabo's journey memberships (docs 20 §12.3) |
| `transcript` | `{ kelaboId, messageId, seq, speaker, text, at, final, human }` | one sealed speaker message |
| `kelabo` | `{ kelaboId, event, title? }` | started / ended / renamed |
| `request` | `{ kind, requestId, kelaboId }` | summary or archive, correlated |
| `board` | `{ requestId, kelaboId, contributions[] }` | answer to `board_request` |
| `history` | `{ requestId, kelaboId, enabled, entries[] }` | answer to `history_request`; `enabled:false` = the host never opted in, served by the same loader as the in-ECS agent's memory (`agent/history.js`) |
| `journey_briefing` | `{ requestId, resolved, journeyId?, title, description, aiCanPost, counts?, kelabos[] }` | answer to `journey_attach` — the direct attachment's whole starting context |
| `journey_info` / `journey_context` / `journey_kelabos` / `journey_documents` / `journey_reports` / `journey_timeline` / `journey_board` / `journey_report_submitted` / `journey_posted` | `{ requestId, kelaboId, resolved, journeys[], … }` | answers to the journey frames above; `resolved` says how the journey was found ([10-data-contracts.md](../10-data-contracts.md) §3.2a) |
| `ping` | `{}` | liveness |

**Attach has two modes, decided by the kelabo's status and never by the client:**

| Status | Registered in | Transcript |
|---|---|---|
| `scheduled` | `state.prepByKelabo` | none — briefing only |
| `active` | `state.tunnelByKelabo` | yes |

`caption.js` consults **only** `tunnelByKelabo`, so an agent preparing for a
scheduled kelabo is structurally unable to receive transcript, even after the
kelabo goes live. Attending is a second, deliberate attach (docs 16 §5).

*(No `http_request`/`http_response`/`http_stream_*`.)*

---

## 5. Caption fan-out — the always-present path

```
browser POST /caption {kelaboId, text, isFinal:true}
  │  (Gateway derives speaker from participant cookie — never trusts body,
  │   except room mode where it accepts the diarization label)
  ▼
Gateway appends UTT to DynamoDB, then routes by kelabo mode:
  ├─ DEV MODE (a local agent is attending):
  │     `transcript` frame down tunnel → bridge queue → the developer's agent →
  │     `contribution` frame up → SSE hub → browsers
  └─ SERVER MODE (no agent attached):
        hand to in-task agent worker → trigger gate → main/sub agent →
        [LLM_CON] Contribution → SSE hub → browsers
```

The choice is made **per caption**, from live in-process state. Attach and detach
also publish an SSE `agent` event, because this used to be entirely invisible: a
bridge that dropped mid-kelabo handed the room back to the server agent with
nothing on screen to say so.

SSE hub keys strictly on the **server-known kelaboId**, never a value claimed in a
frame. Every fanned Contribution is also **persisted** (`CONTRIB#`) so late-comers
can backfill — including ones written before the kelabo started.

### 5.1 Live roster — who is in the kelabo *now*

`sseSubscribers` is the only thing that knows. The kelabo META's `participants`
is an **append-only join ledger** — nobody is ever removed from it — so it
answers "who has ever been here", which is the right number for an ended kelabo
and the wrong one for a live room. The call roster (`state.rtcRooms`) cannot
answer it either: a **board-only** participant holds a stream and never calls
`/rtc/join`.

So `sseHub` derives it and fans a `roster` event `{count, participants[]}`:

- on subscribe (so a tab learns the headcount immediately — the REST API is a
  Lambda and cannot see this state), and again whenever it changes;
- deduplicated **by identity**, so two tabs of one person are one person;
- a departure is deferred by `rtc.disconnectGraceSeconds` (default 20s), the
  same window the call uses before `peer_away`, so a reload does not make the
  number visibly dip and recover;
- suppressed when nothing changed, so an EventSource reconnect emits no events.

The assistant and a paired coding agent are **not** in it: neither holds an SSE
stream (the bridge is on WSS `/rig`). They have their own chip in the room.
Tests: `gateway/test/roster.mjs`.

---

## 6. In-task agent worker

- The server-agent runs in a **worker thread / child process** inside this task,
  isolated from the socket/SSE event loop so a long agent run can't block
  connection handling.
- One worker context per active server-mode kelabo (`agentWorkers`); holds the
  rolling transcript window and can keep an in-flight search alive (no 15-min cap).
- Streams partial Contributions to the SSE hub as they arrive (direct local call).
- Concurrency cap per task; if exceeded, runs queue. The cap itself is a
  published value now (`agent.maxConcurrentRuns`, `0` = unlimited).
- `ensureWorker()` resolves the model **and** the gate/orchestrator knobs from
  published config on every call and re-inits the worker when either changed;
  `reconfigure()` pushes a change into a *running* worker on demand (§6b). Interface + internals in
  [05-agent-mcp.md](./05-agent-mcp.md).
- **Scale-out (future):** the worker moves to a dedicated agent ECS service sharded by the same
  kelabo affinity as the Gateway; the Gateway then only fans out. Same
  `AgentRunner` contract.

---

## 6a. Journey integration (docs 20)

Four pieces, all in this task because they need what only the Gateway has —
the LLM secret, the live agent context, the tunnel, and the archive hook.

- **Report generation** — `POST /internal/journeys/:id/report` →
  `generateJourneyReport` (`gateway/src/journeys.js`), run inline (no worker
  thread, no dev-tunnel): a bounded synthesis over rows already in DynamoDB.
  The task role has **read+write on the journeys table**
  (`gateway-ecs-stack.js`), so the handler reads the journey's own context
  directly, builds an explicitly *budgeted* prompt (`buildContext()` — per-item
  caps and limits, docs 20 §6.2, unlike the unbounded main-agent thread), calls
  the LLM via `agent/llm.js`, and writes the `REPORT#` row back `ready` or
  `failed` — never left `pending`. This runs here and not in rest-api because
  the LLM credential is used where the call is made. rest-api's role *could*
  read `CRED#llm` in fact since it gained a credential-write console (docs 08
  §6c, docs 23 §5) — the attribute fence that once made this a hard boundary no
  longer binds — but the arrangement stands on its own terms, and reversing it
  to follow a grant that widened for an unrelated reason would be the wrong
  lesson. docs 20 §6.1.
- **Agent context push** — `agent/journeyContext.js`, sibling to `history.js`,
  loaded in `runner.js`'s `ensureContext()` on every turn, no opt-in flag. For
  up to `JOURNEY_LIMIT = 3` linked journeys (found via the kelabo's own
  `JOURNEY#` mirror rows) it builds a digest from the same reducers a report
  uses: latest description, health/progress, active board messages, active
  documents (clipped harder than a report gets — this cost is paid every turn),
  and *other* linked kelabos reduced to their minutes. `persona.js` renders it
  as a `JOURNEY CONTEXT:` system-prompt section — reference material, not
  instructions, wrapped in the same untrusted framing as transcript.
  **It supersedes `historyEnabled`:** `ensureContext()` loads journey context
  first and gates `loadKelaboHistory()` on `historyStillApplies(meta,
  journeys)` — false the moment the *reduced, reachable* journey result is
  non-empty, so a dangling link still falls back to host history rather than
  leaving the agent with neither (docs 20 §12.1).
- **Dev-mode journey tools** — five new KAP frame pairs in `tunnel.js` (§4
  tables) serve `kelabo_journey_info/timeline/board/report_submit/post`. Reads
  call straight into `journeys.js`'s reducers; the two writes are its own
  exports (`submitJourneyReport`, `postJourneyBoardMessage`). An omitted
  `journeyId` resolves against the kelabo's own links
  (`resolveJourneyForKelabo`); an explicit one is trusted **only if it is one
  of that kelabo's links** — never a bare lookup key. `journey_post` enforces
  the journey's `aiCanPost` gate (docs 20 §12.2).
- **Contributor settling** — `archive.js`'s `endKelabo`, after archiving,
  queries the ending kelabo's `JOURNEY#` mirror rows and calls
  `settleKelaboJoin()` (`journeys.js`) per linked journey, bumping every
  participant's `kelaboJoinCount`. Idempotent against end-retry
  (`archivePending`/`resuming`): a `SETTLED#<kelaboId>` marker written with
  `attribute_not_exists(SK)` means a resumed end bumps nobody twice
  (docs 20 §10).

---

## 6b. Operational configuration (docs 23)

`gateway/src/opconfig.js`. One cache per task over `PK = OPCONFIG` in
`kelabo-<env>-config`, 60-second TTL, `Query` only and fenced in IAM to that one
partition — the admin roster shares the table and is the control plane's alone.
`Scan` is not merely withheld: it cannot be constrained by
`dynamodb:LeadingKeys`, so a Scan grant would hand this internet-facing task the
list of every identity that may reconfigure the deployment.

**Read `resolved()`, never `current()`.** `current()` is the published document,
in which every unpublished field is `""` or `null`; reading a field off it
directly is how a deployment that published only its model ends up running with
no cooldown and no deadline. `resolved()` folds it over this task's own
environment config, which is what every consumer wants. Consumers go through
`effectiveConfig(c)` — or `effectiveConfigNow(c)`, the last-known fold, for the
few call sites that live inside a callback and cannot await (a stream's `close`
handler scheduling an eviction) — and **never** `c.config.rtc.x` directly:
a direct read does not fail, it silently pins the bootstrap, and
`gateway/test/opconfig.mjs` reads the sources to keep that from regressing.

A read that fails serves the **last version read successfully**, never the seeded
defaults — a task that silently reverted to bootstrap values mid-call would be
far harder to diagnose than one running slightly stale settings.

**The reload is an optimisation of the wait, not the mechanism.**
`POST /internal/config/reload` invalidates the cache and calls
`agentDispatcher.reconfigure()`. The task converges within the TTL whether or not
that call arrives, which is why the control plane treats a failure as a log line.
What it buys is the case the TTL covers badly: `ensureWorker` only reconfigures
when it is called, so in a **quiet kelabo** a published model change would sit
unapplied for as long as nobody spoke. The route carries no body — it is a "look
again", not a value — so nothing an administrator typed reaches this task except
through the table.

---

## 7. Speaker identity stamping

- **Per-user capture:** speaker = participant display name (from the cookie).
- **Room capture:** browser attached an STT diarization label (`A/B/C`); Gateway
  forwards it as the speaker. **Trust note:** the label is accepted from the client
  body — trusted-but-unverified; a malicious room client could forge speaker tags.
  Accepted (room capture is a convenience mode); per-user capture is the
  identity-safe mode.
- **Dev mode:** the resolved speaker travels on the `transcript` frame, and the
  bridge composes `[hh:mm:ss] <Speaker>: <text>` into one envelope per batch. The
  older `part.metadata.kelaboSpeaker` stamping is gone — it was opencode-specific
  and needed a plugin at the far end to be readable at all.

---

## 8. Tunnel lifecycle state machine

```
bridge connects /rig ──► register{token, agent}
   verify signature + aud + revocation row ──► registered{agentId, kelaboId:""}
   attach{kelaboId} ──► briefing{...}; prep or attending, by kelabo status
   heartbeat (30s) ──► staleness sweep at 90s
   kelabo ended ──► kelabo{event:"ended"} (down); the socket STAYS OPEN so the
                     minutes can still arrive
   unexpected close ──► bridge reconnects with backoff and re-sends `attach`,
                        so a dropped socket does not cost the developer a /kstart
```

The agent token is `aud: kelabo-agent`, minted only by the device-code pairing
flow, and its revocation row is read **once per connection** — signature and
expiry come free with the JWT, and a table read per frame would be absurd.

---

## 9. Kelabo end & archive

On end (host `POST /kelabos/:id/end` → REST sets status + calls
`POST /internal/kelabos/:id/end`):
1. Dev mode: send `request{kind:"archive"}`, then later `request{kind:"summary"}`
   and wait (≤60s) for a `summary` bearing the same `requestId`. Server mode: ask
   the agent worker to summarize. The correlation matters: the previous protocol
   recovered the summary by intercepting the next board post, so a contribution
   sent at the wrong moment silently became the minutes.
2. Build `Archive {archiveId,title,startedAt,endedAt,participants,transcript,board,
   minutes?}`; write history row (DynamoDB, incl. `participant-index`) + full JSON to
   S3 (`archives/<host>/<archiveId>.json`).
3. Settle `kelaboJoinCount` on every journey the kelabo is linked to
   (`settleKelaboJoin`, idempotent via the `SETTLED#` marker — §6a), independent
   of whether the archive write itself succeeded: the journey's roster reflects
   the kelabo having happened either way.
4. Emit SSE `ended` to subscribers; detach the agent; drop the agent worker. The
   socket is deliberately left open past `ended` so a late summary still lands.

---

## 10. Interfaces summary

| Peer | Direction | Transport | Contract |
|------|-----------|-----------|----------|
| SPA | in | POST `/caption`, GET SSE `/caption/replies` | participant cookie; `CaptionPost`/`Contribution` |
| Agent bridge | both | WSS `/rig`, KAP frames | §4, [16](./16-agent-bridge.md) |
| Agent worker | in-process | function call / worker messages | [05-agent-mcp.md](./05-agent-mcp.md) |
| DynamoDB/S3 | out | append UTT/CONTRIB, archive | [08-database.md](../08-database.md) |
| REST API | indirect | shares cookie format + DynamoDB; serves board backfill | [02-rest-api.md](./02-rest-api.md) |

---

## 11. Scaling & limits

**Today (single task):** `desiredCount:1`, no horizontal scale (in-process state + agent
worker). A kelabo = one optional tunnel + N SSE subscribers + at most one agent
worker. ALB idle 240s; 30s heartbeats. Known ceiling: heavy agent CPU shares the
task — cap concurrent agent runs, size the task, isolate in a worker.

**Scale-out (future):** multiple tasks with **kelabo affinity** — all connections
of one kelabo are directed to the **same task**. A kelabo is assigned to a task at
creation (consistent hash over `kelaboId`); the task registers its endpoint in
DynamoDB; REST (`join`, board backfill, stt-token) returns the task-specific base
URL, and the ALB routes per-task (host/path rules). Task loss = reassign the
kelabo; agent bridges re-register and browsers reconnect + backfill via REST —
identical semantics to a single-task restart. The agent may also move to its own ECS
service sharded by the same affinity. The frame + SSE + Contribution contracts are
unchanged; single-task self-host is the degenerate case (one task, affinity is
trivial).
