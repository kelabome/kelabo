# Component: LLM / MCP / Agent layer

This is the "brain." It exists in **two execution topologies** behind one contract:

- **Server-agent mode** (typical user, no developer present): runs **inside the
  Gateway ECS task** (a worker thread / child process), **not on Lambda** — Lambda's
  15-minute cap would kill long sub-agent searches and lose in-flight work. A main
  agent + sub-agents with web search (currently disabled — §7) and **server-side
  MCP**.
- **Developer mode**: the main/sub agent runs **inside the developer's opencode**
  (see [04-connector-rig.md](./04-connector-rig.md)); this doc's server code is bypassed —
  the Gateway just relays captions/replies over the tunnel. We do **not** run
  opencode in the cloud, and there is **no opencode-in-browser surface**.

Both produce the same output — `Contribution`s (item tag `LLM_CON`, with
`to`/`title`) fanned out by the Gateway SSE hub — but the board gate differs by
mode: server mode gates replies with the `[LLM_CON]` marker; dev mode posts via
the `kelabo_post` tool (docs 16 §2.B). Same `kelabo-bot` persona in both.

---

## 1. The main-agent / sub-agent model

```
 rolling transcript (finalized [Speaker] utterances)
        │
        ▼
 ┌──────────────┐  owns context, decides IF/WHEN to help,
 │  MAIN AGENT  │  synthesizes the final answer, gates board output
 └──────┬───────┘
   dispatch (task spec)   ── background, non-blocking
   ┌─────┼───────────────┐
   ▼     ▼               ▼
 web   MCP (jira/wiki)  code (dev mode only)     ← SUB-AGENTS (web currently off — §7)
   └─────┼───────────────┘
         ▼ raw findings
 ┌──────────────┐
 │ MAIN AGENT   │  synthesize → concise Contribution ([LLM_CON] to/title)
 └──────┬───────┘
        ▼  Gateway SSE hub → board
```

- Main agent = the orchestrator persona (owns transcript + working memory, decides
  silent / answer / dispatch, `[LLM_CON]` gate with `to:`/`title:`, `:KELABO-END`
  summary).
- Sub-agents = stateless research workers, each executing one self-contained brief
  and returning a fixed-format `SubAgentResult`. On the server they are spawned by
  the main agent (parallel tool/LLM runs); in dev mode via opencode
  `Task(background:true)`.

> **Full design:** the two-agent split — both system prompts, the brief/result
> contracts, how each agent's chat history is built, and how sub-agent results nest
> back into the main agent's context keyed by `task_id` — is specified in
> [14-agent-orchestration.md](./14-agent-orchestration.md). This is the implemented
> runtime: `mainAgent.js` (flash orchestrator, one per kelabo) + `subAgent.js`
> (pro workers, ephemeral, hold the web/MCP tools).

---

## 2. `AgentRunner` interface (the seam)

The Gateway calls one method; two implementations satisfy it.

```js
/**
 * @typedef {Object} AgentContext
 * @property {string} kelaboId
 * @property {Utterance} trigger        // the finalized utterance that may warrant help
 * @property {Utterance[]} window       // rolling recent transcript
 * @property {string[]} capabilities    // e.g. ["web","mcp:jira","code"]
 * @property {McpConfig} mcp            // resolved host-personal MCP config (org scope reserved, §5)
 * @property {ModelConfig} model        // provider + model ids
 */

/**
 * @typedef {Object} AgentRunner
 * @property {(ctx: AgentContext) => AsyncIterable<Contribution>} run
 */
```

| Impl | Where | Notes |
|------|-------|-------|
| `ServerAgentRunner` | **in the Gateway ECS task** (worker thread/child process) | main+sub agents, web + server MCP; streams Contributions to the local SSE hub; no time cap |
| `OpencodeAgentRunner` | Gateway relay | no server LLM; the Rig's opencode is the agent; this "runner" is just the caption tunnel relay so callers are uniform |

Dispatch rule per kelabo: **Rig bound → developer mode (`OpencodeAgentRunner`
relay); else `ServerAgentRunner`.** They can coexist across kelabos; per-kelabo
it's one or the other.

---

## 3. Trigger (server-agent mode only)

Developer mode does its triggering **inside opencode** (persona judgment), by
design. Server-agent mode needs its own gate to control cost/noise.

**Hybrid gate (ARCHITECTURE §3):**
1. **Cheap classifier** on each finalized utterance (rolling window) → intent:
   `INFO_GAP | CODE_QUESTION | NONE`. Implemented as a small/cheap model call or a
   tuned prompt.
2. **Debounce/cooldown:** no re-fire on the same topic within N seconds; cap
   Contributions/minute per kelabo.
3. Positive gate → build `AgentContext` → `ServerAgentRunner.run`.

The `kelabo-bot` persona *also* enforces silence-first, so the gate is a cost
pre-filter, not the sole decision-maker. Both are tunable; decisions are logged
(observability) so trigger quality can be iterated — it is the product's core
(ARCHITECTURE §14 caveat 7 covers the flip side: what a badly gated agent can be
tricked into posting).

Config knobs (per kelabo, host-settable later): `sensitivity`,
`maxContributionsPerMinute`, `cooldownSeconds`.

---

## 4. ServerAgentRunner (in-ECS worker) design

- **Where:** a **worker thread / child process** inside the Gateway task, isolated
  from the socket/SSE event loop. The Gateway hands it captions; it streams
  Contributions straight to the local SSE hub (direct call, no cross-service hop).
- **Why in-ECS not Lambda:** no 15-minute cap (long sub-agent searches survive);
  can hold an **in-flight search** and a **warm per-kelabo context**; streaming
  partials to the board is a local function call.
- **Context:** one worker context per active server-mode kelabo; holds the rolling
  transcript window in memory, rehydrated from DynamoDB on task restart. Main agent
  context = recent utterances + prior Contributions.
- **Sub-agent fan-out:** parallel workers — `webSearch(query)` (currently
  disabled — §7), `webFetch(url)`, `mcpQuery(server, request)` — each with a
  budget/timeout but
  **not** bounded by a platform limit. Results handed back to the main agent for
  synthesis.
- **Model calls:** via the provider abstraction (§6). Cheap model for the gate,
  strong model for synthesis.
- **Output:** 0..n `Contribution`s; only `[LLM_CON]` text is fanned to the
  board; internal reasoning/minutes are stored, not posted.
- **Concurrency/ceiling:** cap concurrent agent runs per task; queue beyond the cap;
  size the Fargate task for agent CPU. Known trade: agent CPU shares the task with
  connection handling (ARCHITECTURE §15.6a).

> **Scale-out split (future):** move the worker into a **dedicated agent ECS service** sharded
> by the same **kelabo affinity** as the Gateway (each task serves its assigned
> kelabos: captions in, Contributions out); the Gateway then only fans out. The
> `AgentRunner` interface makes this a deployment change, not a rewrite.

---

## 4a. Cross-kelabo context push: history and journeys

The main agent's system prompt can carry two kinds of prior-kelabo memory,
both loaded in `runner.js`'s `ensureContext()` when a kelabo's worker context
is built:

- **`historyEnabled`** (host opt-in): the minutes of the host's recent
  kelabos, reduced by `gateway/src/agent/history.js` and rendered as an
  `EARLIER KELABOS:` section — the same loader that serves dev mode's
  `kelabo_history` tool (docs 16 §2.B).
- **Journey context** ([docs 20 §12.1](../20-journey.md)): if the kelabo is
  linked to a journey, `gateway/src/agent/journeyContext.js` (sibling of
  `history.js`) is **always attempted — no opt-in flag**, because linking a
  kelabo into a journey is already the deliberate, visible act
  `historyEnabled` exists to gate for an automatic record. Per linked journey
  (`JOURNEY_LIMIT = 3` in the prompt) it builds a budgeted digest: title,
  latest description (clipped 1,500 chars), health/progress, up to 5 active
  board messages (300 chars each), up to 3 active documents (800 chars each),
  and up to 5 *other* linked kelabos reduced to their minutes
  (summary/decisions/actionItems). `renderJourneyContext()` in `persona.js`
  renders it as a `JOURNEY CONTEXT:` section after `EARLIER KELABOS:`.

**Journey context supersedes `historyEnabled` rather than joining it.**
`historyStillApplies(meta, journeys)` (`journeyContext.js`) is `false` the
moment the *reduced* journey context is non-empty, so a linked kelabo drops
the broader host record — but a dangling or momentarily-unreachable journey
link falls back to `historyEnabled`, keeping the pipeline's "best-effort,
never total silence" posture.

Both sections are framed as reference material — a record other people wrote,
not instructions and not the current state of anything — the same untrusted
boundary journey content gets everywhere it enters a prompt (docs 20 §6.3),
and both carry an explicit "never dispatch a sub-agent to look up something
already answered here" rule. Like `historyEnabled`, journey context is
disclosed to the room: a "Part of: N journeys" chip (docs 20 §12.1).

In **dev mode** the same journey is reachable by pull instead: the
`kelabo_journey_*` MCP tools (docs 16 §2.B; docs 20 §12.2, §12.3) — including
`kelabo_journey_context`, which serves this exact digest on demand, and
`kelabo_journey_join`, which attaches a developer's agent to a journey
directly, with no kelabo at all, for work between meetings.

---

## 5. MCP configuration (host-personal)

**Rule:** MCP servers are a **common, host-personal setting** — not per-kelabo.
A kelabo runs with the *host's* configured servers; the host can opt out per
kelabo at creation (`mcpEnabled: false` on the kelabo meta). Org-wide MCP and
group ACLs are not built.

```
effectiveMcp(kelabo) = kelabo.mcpEnabled === false ? ∅ : hostMcp(kelabo.hostIdentity)
```

- **Storage:** `MCP#host#<identity>` items in DynamoDB (see
  [08-database.md](../08-database.md)); managed via `GET/PUT/DELETE /me/mcp`
  (Settings page).
- **Shape (per server):** `{ name, transport: "http", url, headers?,
  secretRef?, authType, oauth?, enabled }` at `SK=SERVER#<name>`.
- **`authType: "bearer"`** — a token the host pasted. Written by the REST API as
  a `SECRET#<name>` row in the same partition, beside the `SERVER#<name>` it
  belongs to and under the same customer-managed key; the server item stores
  only `secretRef` (`<identity>/<name>`), never the token. It used to be one
  Secrets Manager secret per user per server (docs 08 §6).
- **`authType: "oauth"`** — the MCP authorization spec (OAuth 2.1 + RFC 9728 /
  8414 / 7591 / 8707). The host clicks **Connect** and signs in at the provider;
  no token is ever pasted. See §7a.
- **Server-mode MCP:** the `ServerAgentRunner` connects to configured MCP
  servers (streamable HTTP; `initialize` handshake + `Mcp-Session-Id`
  propagation). Credentials resolved server-side.
- **Dev-mode MCP:** comes from the developer's `rig-profile.json` / host
  `opencode.json` (imported at Rig setup); host-local absolute-path servers are
  dropped for the container. The host cloud config does **not** apply to dev
  mode — the developer's own opencode MCP config governs there.

`McpConfig` typedef in [10-data-contracts.md](../10-data-contracts.md).

---

## 6. Model provider abstraction

```js
/**
 * @typedef {Object} ModelConfig
 * @property {"anthropic"|"openai"|"deepseek"|"local"|string} provider
 * @property {string} model         // strong model for synthesis
 * @property {string} smallModel    // cheap model for the gate
 */
/**
 * @typedef {Object} LlmProvider
 * @property {(req) => AsyncIterable<string>} stream   // streaming completion
 * @property {(req) => Promise<string>} complete
 */
```

- Provider and model come from the deployment's environment (`LLM_CONFIG` in
  `contracts/src/credentials.js`); the key is the `llm` credential slot
  (`make credential-set env=<env> slot=llm`). Each deployment supplies its own.
- **Current setting:** `deepseek` / `deepseek-v4-flash` for **both** `model` and
  `smallModel` — flash is cheap enough to run the gate on every closed turn and
  the orchestrator on every trigger. The main/sub split is by role, not by which
  model is configured, so raising `model` to a stronger one is config-only
  (see [14-agent-orchestration.md](./14-agent-orchestration.md) §8).
- Dev mode: the developer chooses the provider/model in their opencode session
  (handed off via `PUT /auth/:id`); the server abstraction is not involved.

---

## 7. Web search & fetch sub-agents

- **`web_search` is ENABLED, gated per deployment by the Brave key.** The
  switch is `WEB_SEARCH_ENABLED` in `gateway/src/agent/subagents.js` (kept as
  a kill switch); the capability is only granted when the `llm` credential row
  carries a `braveApiKey` (`runner.js`), so a keyless deployment behaves exactly
  as the disabled era did: no capability, no tool offered, the line describing
  it dropped from the sub-agent prompt.
  - History: it was disabled project-wide while dev had no `braveApiKey` — sub-
    agents were left with `web_fetch` alone, guessed URLs, collected 403/404s,
    and returned `status:"empty"`, each failed guess costing a full LLM
    iteration. With a key, one search replaces that whole loop.
- `webFetch(url)` fetches a page/API endpoint as text (HTML stripped, byte +
  time budgets). Still enabled; it is what answers real-time data questions.
- Dev mode: opencode's built-in `websearch`/`webfetch` (allowed in the persona
  permissions) — unaffected by the switch above.

---

## 7a. MCP OAuth (`authType: "oauth"`)

Connecting a server takes a **Connect** button, not a pasted token. Kelabo
implements the MCP authorization spec as an OAuth 2.1 *client*.

- **Discovery** (`contracts/src/mcpAuth.js`, shared by rest-api and gateway):
  unauthenticated `initialize` → `401` + `WWW-Authenticate` → RFC 9728
  protected-resource metadata → RFC 8414 authorization-server metadata.
  Many deployed servers (including Atlassian's) still use the older 2025-03-26
  flow with **no** protected-resource document, so discovery falls back to RFC
  8414 at the MCP server's own origin. The path taken is reported as
  `via: "prm" | "origin"`.
- **Registration:** RFC 7591 dynamic client registration, so no human has to
  pre-create an OAuth app. One registration per authorization server, shared by
  every user of the deployment, at `PK=MCP#client, SK=AS#<issuer>`. Servers with
  no `registration_endpoint` fall back to a pasted bearer token.
- **Authorization:** authorization-code + PKCE S256, with the RFC 8707
  `resource` parameter on both the authorize and token requests. `state` and the
  PKCE verifier are stashed in a signed 10-minute cookie (the same stateless
  pattern as social login in `oidc.js`), not a DB row.
- **Redirect URI** is one fixed URL for every user and server —
  `<portal>/api/me/mcp/oauth/callback` — because it is what gets registered and
  authorization servers match it exactly. The server name and identity travel in
  the state cookie.
- **Tokens** live at `SK=TOKEN#<name>` in the mcp table, which is encrypted with
  a **customer-managed KMS key**. They are never returned by any API route.
- **Refresh is owned by the gateway**, because the gateway is the only component
  that sees a 401 mid-call. It holds `dynamodb:PutItem` on the mcp table (not
  full write — it must not be able to delete user config). Refreshes are
  serialised per server: OAuth 2.1 rotates refresh tokens, so two concurrent
  refreshes would invalidate each other.
- **Runtime path:** `loadEffectiveMcp` refreshes proactively when a token is
  within 2 min of expiry and drops servers whose grant is dead. On a live 401 the
  transport reauthorizes once and retries. Because the refresher closures cannot
  be structured-cloned into the agent `worker_thread`, the worker requests a
  refresh from the main thread over `postMessage` (`mcp_reauth` /
  `mcp_reauth_result`).

In the target design ([14-agent-orchestration.md](./14-agent-orchestration.md))
these tools belong to the **sub-agent**, not the main agent — the main agent
reaches them only by dispatching a brief.

---

## 8. Minutes generation

- Trigger: host `POST /kelabos/:id/minutes` (any time) or kelabo end.
- Mechanism: run the main agent over the stored transcript with `:KELABO-END`
  semantics → a structured summary (topics, decisions, action items, open questions,
  findings). **Not** posted to the board (omits `[LLM_CON]`); stored as a
  `minutes` record and shown in the record detail.
- Works in both modes: dev mode sends a `request{kind:"summary", requestId}`
  frame down the tunnel, answered by the agent's `kelabo_minutes` (docs 16 §2.A);
  server mode uses `ServerAgentRunner`.

---

## 9. Interfaces summary

| Peer | Direction | Contract |
|------|-----------|----------|
| Gateway | in (captions) / out (Contributions to SSE hub) | in-process `AgentRunner.run(AgentContext)` |
| DynamoDB | in (rolling window, host MCP config, prior board, history + journey digests — §4a) | [08-database.md](../08-database.md) |
| Credentials table | in (the `llm` slot: API key + optional `braveApiKey`) | `CRED#llm`, docs 08 §6c |
| Web search API | out | `webSearch()` (currently disabled — §7) |
| Web pages/APIs | out | `webFetch()` |
| MCP servers | out | resolved `effectiveMcp` (host scope) |
| opencode (dev mode) | n/a here | handled by the agent bridge (docs 16) |

---

## 10. Open decisions

- Web search provider — Brave was the initial choice, swappable behind the
  `webSearch` interface. Currently **disabled** (`WEB_SEARCH_ENABLED = false`);
  no key was ever provisioned. Alternatives if it is revived: Tavily/Exa
  (agent-oriented, return page content), Serper/SerpAPI (Google SERPs), Google
  Custom Search JSON API.
- Cheap-gate model vs. rules-only first cut — start with a small model; measure.
- Worker isolation mechanism (Node `worker_threads` vs child process) — pick for
  clean cancellation of in-flight searches.
- If scale ever forces the dedicated agent ECS service — the seam is ready.
