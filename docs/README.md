# Kelabo — Design Documents

Detailed design following `../ARCHITECTURE.md`. Read the architecture doc first
(high-level design, locked decisions, and the prior-art mapping in §15).
These documents drill into each **system component** and the **interfaces between
them**.

## What "component" means here

A component is a top-level building block of the system with its own runtime,
responsibilities, and interfaces — **not** a React UI widget. The components are:

```
        ┌──────────────┐  REST+auth (HTTPS)  ┌───────────────────┐
        │     SPA      │◄───────────────────►│   REST API        │
        │ (browser app)│  board backfill      │ (Lambda control)  │
        └──────┬───────┘                     └─────────┬─────────┘
   audio (WSS) │  board (SSE tail) + caption (POST)    │ read/write
   direct      │            ▲                          ▼
        ┌──────▼───────┐    │                    ┌───────────┐
        │  Deepgram    │    │                    │ DynamoDB  │
        │  (STT, ext.) │    │                    │  + S3     │
        └──────────────┘    │                    └───────────┘
                            │
                    ┌───────┴──────────────────┐  WSS tunnel   ┌───────────────┐
                    │        Gateway (one ECS)  │◄─────────────►│ Agent bridge  │
                    │  connections + SSE hub    │ caption-only  │ (dev's laptop)│
                    │  + in-task AGENT worker ──┼──┐(dev mode)   └──────┬────────┘
                    └───────────────────────────┘  │                   │ loopback HTTP
                            │ web search + MCP       │                  ▼
                            ▼ (org/host)             │           ┌───────────────┐
                    (server-agent mode)              │           │ Rig: opencode │
                                                     │           │  kelabo-bot  │
                                                     └───────────┴───────────────┘
```

Not drawn above: the **conference call** (doc 15). Kelabo hosts the kelabo's
audio over **Cloudflare Realtime** — `sfu` (relayed by Cloudflare's edge) or
`mesh` (peer-to-peer, nothing but the participants can decrypt it). Signalling
rides the SSE stream already shown plus `POST /rtc/*` on the Gateway; **no audio
ever reaches the deployment's infra in either mode**. STT is unchanged: each browser still
transcribes only its own mic.

Notes: the **server-agent runs inside the Gateway ECS task** (no Lambda 15-min cap).
**No opencode-in-browser surface / proxy** — the tunnel is caption/reply/lifecycle
only. Scaling the Gateway beyond one task would use **kelabo affinity** (all of a
kelabo's connections directed to the same task — now including RTC).

## Index

Docs are numbered in one sequence in reading order. The number is the identity;
the folder only says whether a doc is about a **component** (`components/`) or is
**cross-cutting** (this folder). Start at 01, or jump to the component you care
about.

### Component docs (`components/`) — 01–07, 14–17
| # | Doc | Component | Runtime |
|---|-----|-----------|---------|
| 01 | [01-spa.md](./components/01-spa.md) | SPA (browser app) — responsibilities, screen map, its outbound interfaces, UI/UX spec | S3 + CloudFront |
| 02 | [02-rest-api.md](./components/02-rest-api.md) | REST API (control plane) — every endpoint, auth, req/resp, errors | Lambda + API GW HTTP API |
| 03 | [03-gateway.md](./components/03-gateway.md) | Gateway — caption channel, SSE board hub, caption-only tunnel, **in-task agent worker**, frame protocol, in-proc state | ECS Fargate ×1 |
| 04 | [04-connector-rig.md](./components/04-connector-rig.md) | Rig — the prepackaged container for people who do not configure a coding agent themselves. One way in to dev mode; see 16 for the interface | dev laptop (Docker) |
| 05 | [05-agent-mcp.md](./components/05-agent-mcp.md) | LLM/MCP/Agent layer — main+sub agent, ServerAgentRunner (**in the ECS task**), MCP layering, providers, trigger | Gateway ECS (server mode) / opencode (dev mode) |
| 06 | [06-deepgram.md](./components/06-deepgram.md) | Deepgram STT integration — temp token, direct streaming, diarization, Utterance production | external + Lambda token minter |
| 07 | [07-cdk-infra.md](./components/07-cdk-infra.md) | CDK / Infra — stacks, resources, one config file, envs, tagging, secrets | AWS CDK |
| 14 | [14-agent-orchestration.md](./components/14-agent-orchestration.md) | Main-agent / sub-agent split — roles, both system prompts, brief/result contracts, per-agent chat-history construction, result nesting by `task_id`, summary provenance | Gateway ECS (server mode) |
| 15 | [15-conference-rtc.md](./components/15-conference-rtc.md) | Conference audio — `sfu` vs `mesh` transports, the shared-microphone invariant, `rtc` SSE signalling, SFU proxy ownership rules, perfect negotiation, video seams | browser WebRTC + Cloudflare Realtime, signalled by Gateway ECS |
| 16 | [16-agent-bridge.md](./components/16-agent-bridge.md) | Agent bridge — the interface between Kelabo and a developer's **own** coding agent: the KAP wire protocol, the MCP tool surface, the opencode and Claude Code adapters, device-code pairing, kelabo prep | dev laptop, spawned by the agent |
| 17 | [17-agent-distribution.md](./components/17-agent-distribution.md) | Distributing the bridge as `@kelabome/agents` on npm — one package and one `kelabo` for every runtime, the runtime registry, the invertible key-only install, `setup`/`status`/`uninstall`/`reset`, and what the build does with `@kelabo/contracts` | dev laptop, `npm i -g` |

### Cross-cutting docs (this folder) — 08–10, 13, 18–20
| # | Doc | Covers |
|---|-----|--------|
| 08 | [08-database.md](./08-database.md) | DynamoDB tables, keys, GSIs, TTLs, S3 layout, every access pattern, item shapes |
| 09 | [09-data-flows.md](./09-data-flows.md) | Sequence diagrams for every key flow: OTP, social, join, board backfill, capture→board, dev-mode, minutes, archive, reconnect |
| 10 | [10-data-contracts.md](./10-data-contracts.md) | The interfaces BETWEEN components: `Utterance`, `Contribution`, WSS frames, SSE events, cookies/refresh, JWT, JSDoc typedefs + zod |
| 13 | [13-transcript-lifecycle.md](./13-transcript-lifecycle.md) | The one transcript reducer: nouns, stages and the invariants enforced in code |
| 18 | [18-contacts-presence-lifecycle.md](./18-contacts-presence-lifecycle.md) | Cancel/reschedule a kelabo; org + external **contacts**; **presence** (who is online, in-kelabo); the huddle/ring — storage, routes, SSE scope |
| 19 | [19-optional-capabilities.md](./19-optional-capabilities.md) | Every provider/feature can be absent: the rung ladder, on/off/degraded, server-computes-client-renders, public-repo-mechanism/private-repo-policy |
| 20 | [20-journey.md](./20-journey.md) | **Journey** — a persistent container linking related kelabos so decisions, documents and Q&A history carry from one meeting to the next, for people and the agent: data model, visibility/permissions, timeline, reports, message board, documents, contributor stats, agent context injection |

## Conventions across all docs

- **Language:** frontend + backend are **pure JS (no TS)**. Shared types are
  **JSDoc typedefs** (doc 10), validated with zod at trust boundaries.
- **Speaker source:** a `speaker` is either an authenticated identity (per-user
  capture) or a Deepgram diarization label `A/B/C` (room capture). Treated
  identically downstream.
- **Board gate (mode-split):** **server mode** — an agent reply reaches the shared
  board only if tagged as an LLM contribution: an `[LLM_CON]` line, then
  `to: <all|participant>` and `title: <one-liner>` headers (contracts/src/llmcon.js;
  an extension of the prior art's `kelabo-bot` marker). Else it's session-internal.
  **Dev mode** — the agent posts via the `kelabo_post` MCP tool; the marker is
  deliberately not on the wire.
- **Transcript convention:** captions given to the agent are formatted
  `[transcript] [Speaker] <text>`.
- **Kelabo end (mode-split):** **server mode** — the internal token `:KELABO-END`
  triggers the agent's full summary (minutes), which omits `[LLM_CON]`.
  **Dev mode** — the token is not on the wire; summary/archive arrive as
  `requestId`-correlated `request` frames the bridge answers.
- **Dev commands:** `/kstart` (a handover — bind session to kelabo; opencode-only,
  Claude Code needs no equivalent) and `/kend` (end).
- **Auth:** passwordless — email **OTP** or **social OIDC** (Google/Apple) — with
  short session JWT + long **rotating refresh token** (silent refresh; no re-login
  every open; no passwords).
- **Board backfill:** late-comers `GET /kelabos/:id/board` then subscribe to the
  live SSE tail.
- **No opencode-in-browser surface** (STT-in + agent loop + board
  post-back is the value); dev-mode tunnel is caption-only.
- **Env/tag:** every AWS resource tagged `app=kelabo` and `endpoint=<env>`,
  `<env> ∈ {dev, staging, prod}`.
- **`tenantId = verified email domain`:** on every persisted item; single tenant for
  self-host; a multi-domain deployment scopes listing/isolation by it.
