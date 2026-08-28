# 16 — Agent bridge (local coding agents)

> Read [`03-gateway.md`](./03-gateway.md) first for the caption channel and the
> SSE board hub. This document replaces the opencode-specific half of
> [`04-connector-rig.md`](./04-connector-rig.md), which is now *one adapter* rather
> than *the* developer mode.

Developer mode lets a developer's **own, already-running, interactive coding
agent** take the place of Kelabo's server agent for one kelabo. The developer
starts opencode or Claude Code themselves, in a folder they chose, with their own
model, their own MCP servers and their own permission prompts. Kelabo supplies
exactly two things: a **token** and a **channel**.

```
                    WSS /rig  (Kelabo Agent Protocol)
  Gateway ◀──────────────────────────────────────────▶ kelabo-mcp
                                                          │  one process,
                                                          │  spawned over stdio
                                                          │  by the runtime
                                     ┌────────────────────┴────────────────────┐
                                     │                                         │
                              MCP tools (B)                          transcript injection (C)
                        kelabo_join · kelabo_post                   Claude Code: channel notification
                        kelabo_working · kelabo_info             opencode:    POST /session/:id/prompt_async
                        kelabo_board · kelabo_minutes
                        kelabo_history · kelabo_leave
                        kelabo_journey_* ×11 (§2.B)
                                     └────────────────────┬────────────────────┘
                                                          ▼
                                            the developer's interactive session
                                              (their model, their MCP, their
                                               permission prompts, their repo)
```

---

## 1. Why this exists in this shape

Three constraints, in the order they bind.

**The session is human-owned and interactive.** The developer wants to see each
tool call and approve or deny it in their own TUI. So Kelabo never spawns the
agent, never configures a model, never installs an MCP server and never
auto-approves anything. Headless is not an option; "attach to the session I
already have open" is the whole requirement.

**Injecting a turn is runtime-specific; posting is not.** opencode exposes
`POST /session/:id/prompt_async`, which pushes a message into a live session.
Claude Code exposes *channels*: an MCP server that declares the
`claude/channel` capability may push `notifications/claude/channel` into the
running session. These are different mechanisms with the same effect, so they
are the *only* thing the adapter layer abstracts. Everything the agent itself
touches — the tools, the transcript envelope, the persona — is identical.

**Turns block on humans.** A permission prompt stalls the agent while the
kelabo keeps talking. The prior implementation fired one prompt per caption
with no backpressure, which is unusable interactively. The bridge therefore owns
a transcript queue, and "push versus pull" reduces to who drains it.

**Turns also block on work.** The queue paces delivery; it cannot shorten a
turn. A subagent launched in the foreground holds the session for its entire
duration, and `session.idle` — the only readiness signal opencode gives — does
not fire until it returns. A five-minute codebase search is therefore five
minutes of total deafness, during which the kelabo is still talking. This is
why the persona pushes heavy work to `Task(background: true)` (§4.1) and why the
board is told work has started (§2.D): one keeps the agent listening, the other
stops the wait reading as indifference.

---

## 2. Three contracts

Only the third varies per runtime.

| | Contract | Between | Stability |
|---|---|---|---|
| **A** | Kelabo Agent Protocol (KAP) | Gateway ↔ bridge | versioned wire protocol |
| **B** | Kelabo Agent Tools | bridge ↔ agent | **the standard**; identical everywhere |
| **C** | Runtime adapter | bridge ↔ runtime | per-runtime, ~100 lines each |

### 2.A Kelabo Agent Protocol — WSS `/rig`

Runtime-agnostic. No opencode nouns anywhere; a `sessionRef` is an opaque
string the Gateway stores and never interprets.

**Up (bridge → Gateway)**

| Frame | Payload |
|---|---|
| `register` | `{token, agent:{runtime, version, label}}` |
| `heartbeat` | — |
| `attach` | `{kelaboId, runtime, sessionRef, workspace}` |
| `contribution` | `{kelaboId, to, title, markdown, kind?, sources?, card?, status?, progress?, steps?, reason?, ref?}` |
| `summary` | `{requestId, kelaboId, minutes}` |
| `archive` | `{requestId, archive}` |
| `rename` | `{kelaboId, title}` |
| `board_request` | `{requestId, kelaboId}` |
| `history_request` | `{requestId, kelaboId}` |
| `journey_attach` | `{requestId, journeyId}` — direct attachment, no kelabo (docs 20 §12.3) |
| `journey_detach` | `{journeyId?}` |
| `journey_info_request` | `{requestId, kelaboId?, journeyId?}` |
| `journey_context_request` | `{requestId, kelaboId?, journeyId?}` |
| `journey_kelabos_request` | `{requestId, kelaboId?, journeyId?}` |
| `journey_documents_request` | `{requestId, kelaboId?, journeyId?, docId?}` |
| `journey_reports_request` | `{requestId, kelaboId?, journeyId?, reportId?}` |
| `journey_timeline_request` | `{requestId, kelaboId?, journeyId?, entryType?, before?, limit?}` |
| `journey_board_request` | `{requestId, kelaboId?, journeyId?}` |
| `journey_report_submit` | `{requestId, kelaboId?, journeyId?, question, answer}` |
| `journey_post` | `{requestId, kelaboId?, journeyId?, content, msgId?}` |
| `detach` | `{kelaboId?}` |

`kelaboId` on the journey requests is optional (docs 20 §12.3): present, the
journey resolves against that kelabo's links; absent, against the journeys
this connection attached to with `journey_attach`.

**Down (Gateway → bridge)**

| Frame | Payload |
|---|---|
| `registered` | `{agentId, kelaboId}` |
| `rejected` | `{reason}` |
| `briefing` | `{kelaboId, status, title, host, scheduledAt?, durationMinutes?, note?, invitees[], participants[], journeys[]}` |
| `transcript` | `{kelaboId, messageId, seq, speaker, text, at, final, human}` |
| `kelabo` | `{kelaboId, event:"started"\|"ended"\|"renamed", title?}` |
| `request` | `{kind:"summary"\|"archive", requestId, kelaboId}` |
| `board` | `{requestId, kelaboId, contributions[]}` |
| `history` | `{requestId, kelaboId, enabled, entries[]}` |
| `journey_info` | `{requestId, kelaboId, resolved, journeys[], journeyId?, title?, visibility?, status?, description, health?, progress?, counts?}` |
| `journey_timeline` | `{requestId, kelaboId, resolved, journeys[], entries[], nextBefore?}` |
| `journey_board` | `{requestId, kelaboId, resolved, journeys[], messages[]}` |
| `journey_report_submitted` | `{requestId, kelaboId, resolved, journeys[], reportId?}` |
| `journey_posted` | `{requestId, kelaboId, resolved, journeys[], msgId?, version?}` |
| `journey_briefing` | `{requestId, resolved:"ok"\|"journey_not_found"\|"not_journey_member", journeyId?, title, visibility?, status?, description, health?, progress?, aiCanPost, counts?, kelabos[]}` |
| `journey_context` | `{requestId, kelaboId, resolved, journeys[], journeyId?, title, status?, description, health?, progress?, aiCanPost, board[], documents[], kelabos[], reports[]}` |
| `journey_kelabos` | `{requestId, kelaboId, resolved, journeys[], entries[]}` — each entry the minutes reduction, never a transcript |
| `journey_documents` | `{requestId, kelaboId, resolved(+document_not_found), journeys[], documents[]}` — content only on a single `docId` read |
| `journey_reports` | `{requestId, kelaboId, resolved(+report_not_found), journeys[], reports[]}` — answer only on a single `reportId` read |
| `ping` | — |

Two things left the protocol deliberately:

- **`[LLM_CON]` is gone from the wire**, and from the bridge entirely — there is
  no marker parsing left anywhere in `connector/`. A contribution is structured,
  because in a *shared interactive session* the developer's own typed questions
  produce assistant turns too, and a text marker cannot tell those apart from a
  deliberate board post. A tool call can.
- **`:KELABO-END` is gone from the wire.** Summary and archive are
  `requestId`-correlated `request` frames. The old in-band token meant any
  caption merely *containing* the string triggered the minutes prompt, and the
  summary was recovered by stealing the next board post.

### 2.B Kelabo Agent Tools — the standard

This is the surface to keep stable. Every runtime sees exactly this.

| Tool | Behaviour |
|---|---|
| `kelabo_join({kelaboId?})` | Bind this session to a kelabo. With no argument, returns the developer's joinable kelabos — **active and scheduled**, as **host or invitee** — for the agent to choose from. On success returns the briefing, so the tool result *is* the context load. |
| `kelabo_post({to, title, markdown, kind?, sources?, card?})` | Post to the kelabo's shared board. With `card`, the post *becomes* that in-progress card instead of appearing under it. |
| `kelabo_working({title, progress?, to?, card?})` | Put a card on the board saying this is being looked into, before there is an answer. Returns the card reference to hand back to `kelabo_post`. See §2.D. |
| `kelabo_info()` | Current binding: title, status, time to start or elapsed, participants, RSVP. |
| `kelabo_board()` | Read the board. Lets a session see what it already posted — load-bearing across the prep → live boundary, where the two are usually different sessions. |
| `kelabo_history()` | The minutes of the host's past kelabos — summaries, decisions, action items — behind the same host opt-in (`historyEnabled`) that feeds the in-ECS agent's memory (`gateway/src/agent/history.js`, one loader for both modes). `enabled:false` is a real answer: the host never opted in, which is different from opted in with nothing recorded. |
| `kelabo_minutes({minutes})` | Submit the minutes as one JSON object, when Kelabo asks. Stored as the kelabo record; never posted to the board. |
| `kelabo_leave()` | Detach. |
| `kelabo_journey_join({journeyId?})` | Bind this session to a **journey directly** — no kelabo, no transcript (docs 20 §12.3). With no argument, lists joinable journeys (`GET /agent/journeys`: owned, accessor, public-at-tenant; active only). On success returns the journey briefing — the offline mode's context load. Independent of `kelabo_join`: either or both may be active. |
| `kelabo_journey_leave({journeyId?})` | Detach from one or every directly-joined journey. |
| `kelabo_journey_info({journeyId?})` | The journey in scope: title, visibility, status, description, health/progress, counts. |
| `kelabo_journey_context({journeyId?})` | The one-call bundle — the same digest the in-ECS agent is pushed per turn (docs 20 §12.1), pulled on demand: description, status, pinned board, document excerpts, linked kelabos as minutes, recent reports. |
| `kelabo_journey_kelabos({journeyId?})` | Every linked kelabo reduced to its stored minutes — never a transcript, never another kelabo's board. |
| `kelabo_journey_documents({journeyId?, docId?})` | The document list (no content), or one document's full text by `docId`. |
| `kelabo_journey_reports({journeyId?, reportId?})` | Ready reports — questions only in the list, the full Q&A by `reportId`. |
| `kelabo_journey_timeline({journeyId?, entryType?, before?, limit?})` | The journey's timeline, newest first (docs 20 §9.2, over the tunnel). |
| `kelabo_journey_board({journeyId?})` | The journey's pinned board messages — distinct from this kelabo's own board. |
| `kelabo_journey_report_submit({journeyId?, question, answer})` | Store the agent's **own synthesis** as a journey report, directly — no server-side LLM round-trip. |
| `kelabo_journey_post({journeyId?, content, msgId?})` | Write or edit a pinned journey board message, gated by the journey owner's `aiCanPost` flag (docs 20 §7) — **off by default**, and off is a clear refusal, not a silent no-op. The write that carries "X has been added and tested" to the journey's next kelabo. |
| `kelabo_journey_document_add({journeyId?, title, content})` | Add a pasted-text document — the same `DOC#` item a person's paste produces, written as the attached identity so the removal rule (`addedBy` or the lead) lands on them. **Not file upload**: there is none anywhere in the product (docs 20 §8) and this does not introduce one. What is new is only that the text came off a developer's disk. Added once, never edited. |
| `kelabo_journey_legs({journeyId?})` | The journey's legs — named threads — with message counts. |
| `kelabo_leg_messages({legId, journeyId?, limit?})` | One leg's recent messages, wrapped in `<kelabo-leg untrusted="true">`: a conversation between people, some of whom nobody vouched for. |
| `kelabo_leg_post({legId, text, journeyId?})` | Say something in a leg. **Not** gated by `aiCanPost` — that flag guards the curated *board*, while a leg is the conversation and an attached agent is a participant in it. Mentions resolve server-side exactly as for a person, so `@bob` from an agent raises Bob's badge. |
| `kelabo_leg_create({title, journeyId?})` | Start a leg. Any member may, over HTTP or the tunnel; the narrowing on legs is on *messages*, not on the container. Ungated for `kelabo_leg_post`'s reason — an empty leg asserts nothing. |
| `kelabo_leg_edit({legId, msgId, text, journeyId?})` | Correct a message **this agent posted**. There is no permission check in the handler and that is the design: `onLegPost` writes `author: conn.identity`, `editJourneyMessage` is author-only, and this passes the same identity — so the reachable set is exactly what this connection wrote. A second check would be that rule copied somewhere it could drift, and the rule matters: a lead may remove somebody's message but must never put words in their mouth. It also means the assistant's own leg replies (authored `kelabo`) are uneditable by anyone. |

The `kelabo_journey_*` read/write tools (docs 20 §12.2, §12.3) share two
rules:

- **An omitted `journeyId` resolves against what the session is attached
  to** (`resolveJourneyRequest`, `gateway/src/tunnel.js`): the attached
  kelabo's links when there is a kelabo, this session's direct journey
  attachments otherwise — the one candidate if there is exactly one, an
  explicit refusal enumerating them if there are several, the same
  "enumerate rather than guess" idiom `kelabo_join`'s omitted `kelaboId`
  uses. An explicit `journeyId` is trusted only if it is one of the kelabo's
  links or one of this connection's direct attachments, never as a bare
  lookup key — otherwise an attached agent could read or write any journey
  in the deployment by guessing an id.
- **The two writes are request/response, not fire-and-forget.** Unlike
  `kelabo_post`, a bad `journeyId` or an `aiCanPost` refusal is a real
  outcome the calling model needs back. Every journey frame carries a
  `resolved` field: `ok`, `no_journey`, `ambiguous`, `journey_not_found` —
  plus `ai_posting_disabled`, `message_not_found` and `already_archived` on
  `journey_posted` alone, and `document_not_found`/`report_not_found` on the
  two single-item reads.

The agent can create or edit a journey board message; it can **never archive
or unarchive one** — that stays a human action via the SPA/REST, so there is
deliberately no `kelabo_journey_archive` tool.

There is deliberately **no `kelabo_transcript`**. Transcript is pushed, never
polled. A pull path would be a second implementation of one concept, which is
the mistake [`13-transcript-lifecycle.md`](../13-transcript-lifecycle.md) exists
to prevent.

### 2.D The card lifecycle — one channel, not two

A dev agent's answer can be minutes away: a background subagent searching a
repository is the normal case, not the slow one. For that whole time the board
showed nothing, and *nothing* is exactly what the board shows when the agent
decided to stay quiet. The room cannot tell "working on it" from "ignored you",
and the honest reading of silence is the second one.

The in-ECS agent already solved this. It puts a card up the moment its gate
fires and keeps updating that same card — `working` → `progress` → the answer —
all on one contribution `id`, streamed on the existing SSE `contribution` event
and merged in place by the SPA (docs 14 §5.3a). Dev mode **joins that channel**
rather than getting one of its own:

```
kelabo_working({title})        -> contribution{card:"c1a2b3", status:"working"}  -> board card appears
kelabo_working({card, progress}) -> contribution{card:"c1a2b3", status:"working"}  -> status line updates
kelabo_post({card, markdown})  -> contribution{card:"c1a2b3", status:"done"}     -> the card becomes the answer
```

Three things make this safe rather than merely convenient:

- **The reference is not an id.** The agent gets an opaque `card` string; the
  Gateway maps it to a real contribution id, per connection and per kelabo
  (`gateway/src/tunnel.js`, `cardId()`). An id taken off the wire would let any
  paired agent overwrite any card on a board it is attached to — including one
  of the in-ECS agent's.
- **Working and skipped cards are never persisted.** That rule already lives in
  `sseHub.publish` and applies unchanged here, so a placeholder cannot end up in
  the archive.
- **A card is always landed.** An agent that opens one and never comes back
  leaves a spinner on every participant's screen, and nothing at the developer's
  terminal shows it. So the bridge closes them: on `kelabo_leave` and on kelabo
  end, and by TTL sweep for one simply abandoned. The bookkeeping is pure and
  tested (`connector/src/cards.js`), because a live kelabo is the only other
  place it would be found.

An empty `done` card is rejected at the Gateway: it is already the "remove this
card" marker the SSE hub understands, so accepting one would delete the card
instead of finishing it.

### 2.C Runtime adapter

```js
/** @typedef {{
 *   runtime: string,
 *   attach(ref): Promise<{sessionRef: string, workspace: string}>,
 *   inject(envelope: string, opts: {silent: boolean}): Promise<void>,
 *   ready(): boolean,
 *   detach(): Promise<void>
 * }} RuntimeAdapter */
```

`inject` is the whole abstraction. `ready()` reports whether the runtime can
accept a batch now; `silent` asks for context that must not cause a reply.

---

## 3. The transcript envelope

One pure module composes what every runtime shows the agent, so the agent's view
does not depend on which runtime it is:

```
<kelabo-transcript kelabo="7f3a…" untrusted="true">
[10:04:12] Alice: what's our retry policy on the gateway?
[10:04:19] Bob: exponential, I think
</kelabo-transcript>
```

`untrusted="true"` is not decoration. It is the gate — see §6.

On Claude Code this becomes the notification `content`, with
`meta: {kelabo_id, speakers, silent}` — Claude Code wraps it again as
`<channel source="kelabo" kelabo_id="…" speakers="…">`. Channel `meta` keys must
be identifiers: **letters, digits and underscores only — hyphenated keys are
silently dropped**. On opencode the bridge writes the wrapper itself and the meta
is ignored.

---

## 4. Runtimes

### 4.1 opencode

| Concern | Mechanism |
|---|---|
| Inject | `POST /session/:id/prompt_async` → `204`, fire-and-forget |
| Silent inject | the same call with `noReply: true` — used for the briefing, so loading context does not burn a turn |
| Ready | the `session.idle` event on `GET /event` |
| Register | the `/kstart` plugin hook `command.execute.before` supplies `input.sessionID` **and the server base URL** |
| Persona | the developer's own agent, optionally the `kelabo-bot` template |

**opencode must be started as `opencode --port <n>`** — which is what
`kelabo opencode` does, on a free port, along with setting
`OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS` (docs 17 §5). `--port` defaults to
`0`, which means the TUI serves *nothing* over HTTP — not that it picks a random
port. A plain `opencode` binds no socket, and the `serverUrl` a plugin reads then
falls back to a `http://localhost:4096` that nothing answers.

This is the one failure in the bridge that is invisible from the kelabo. Every
tool (`kelabo_join`, `kelabo_post`, `kelabo_board`) travels the tunnel and works
regardless; only *injection* needs the HTTP server. So a developer with no
`--port` sees an agent that joins, posts, and reads the board, and simply never
reacts to anything said — indistinguishable from an agent choosing to stay quiet,
which is its normal state. Hence `probe()`: the handover does a real request
before reporting success, and `/kstart` names the remedy. Never make injection
failures silent again on the assumption that a swallowed error is harmless.

The plugin must report the URL at all because the bridge is a separate process
and cannot discover either it or the session id.

**The `/kstart` result is a toast, not a text part.** The obvious way to tell the
developer what happened is to push a `{type:"text"}` part onto the hook's
`output.parts` for the command template to relay. That does not work: the hook
argument is typed `Part[]`, and a `Part` requires `id`, `sessionID` and
`messageID`. A bare `{type,text}` literal is rejected and opencode abandons the
command **silently** — no message, no turn, no error anywhere. The handover
underneath had already succeeded, so `/kstart` looked inert while it was in fact
working, which is a worse failure than an exception. The plugin therefore
`POST`s `/tui/show-toast` directly, and the command template drives the model
through `kelabo_join` instead of through a relayed string.

opencode has no notification queue, so the bridge's `TranscriptQueue` is drained
on `session.idle`. Exactly one batch is in flight at a time; transcript that
arrives while the developer is answering a permission prompt accumulates and is
delivered as one batch.

**Background subagents, and the flag that fails silently.** `session.idle` is
per session, and a `task` subagent runs *inside* the parent's turn unless it is
backgrounded — so the parent stays busy for the child's whole life and the queue
never drains. `background: true` fixes that: the parent goes idle in seconds, the
result arrives later as a separate `<task state="completed">` user message, and
transcript keeps flowing throughout. Measured, not assumed.

The parameter only exists when opencode is started with
`OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true`. It is undocumented and off by
default, and when off the parameter is **absent from the tool's schema**, so the
model's `background: true` is dropped on the way to the call — no error, correct
answer, and the only symptom is an agent that goes deaf for minutes. The Rig
sets the flag (docs 04 §1.1). A developer running their own opencode cannot have
it set for them, so the handover checks: `backgroundSubagents()` in the adapter
reads the task tool's schema over the opencode API, and `/kstart` reports a
`warning` toast when it is missing. **Do not let this one go quiet again** — it
is the same class of failure as a missing `--port`, and for the same reason:
every tool still works, so nothing else reveals it.

### 4.2 Claude Code

Claude Code channels are the intended mechanism, and the bridge *is* the channel
server. There is no second process and nothing to hand over: the channel targets
whichever session spawned the MCP server, which is why there is a `/kstart` on
opencode and none here.

Everything below was verified against **Claude Code 2.1.220** — by reading the
gate out of the shipped binary and then running it — rather than from the
research-preview documentation. Nothing on this path fails loudly, so "the docs
say" is not good enough: see the invisible-failure list at the end.

| Concern | Mechanism |
|---|---|
| Inject | `notifications/claude/channel` with `{content, meta}` |
| Capability | `capabilities.experimental['claude/channel'] = {}` — presence of the key *is* the registration handshake |
| Post back | ordinary MCP tools, `capabilities.tools = {}` |
| Persona | the `Server` constructor's `instructions` — **truncated to 2048 chars**, see below |
| Ready | always — the runtime batches notifications that arrive mid-turn and delivers them together on the next turn |
| Config | one key: `mcpServers.kelabo` in `~/.claude.json` (docs 17 §3) |

`meta` keys become attributes on the `<channel>` tag and **must be identifiers —
letters, digits and underscores.** Anything else is dropped silently, which is
why they are `kelabo_id` and `speakers`, never `kelabo-id`. `metaFor()` in the
adapter filters at the source so a future key that breaks the rule fails a unit
test instead of going missing in a live kelabo.

Launch, during the research preview:

```bash
kelabo claude          # composes the line below, on a session that is wired
claude --dangerously-load-development-channels server:kelabo
```

`server:<name>` is resolved against the *configured MCP servers*, and a name
matching none of them is skipped — so the channel name and the MCP server name
are the same string by necessity, not by convention.

#### The persona does not fit

Claude Code caps an MCP server's `instructions` at **2048 characters**, at
connection time. It says so once:

```
MCP server "kelabo": Server instructions truncated from 5820 to 2048 chars
```

…at `DEBUG`, and then behaves normally. The persona is 5820 characters, so
nearly two thirds of it was being discarded — including every line of the
prompt-injection gate, which is the only thing standing between a link-joined
guest's typed note and an agent with read access to a private repository. From a
kelabo this is invisible: the agent joins, posts, and reads the board exactly as
it should, right up until someone tries it.

So `persona.js` splits by *what can survive being lost*, not by topic:

- **`PERSONA_CORE`** — identity, silence-is-the-default, the injection gate, and
  the fact that `kelabo_post` is the only route to the room. Held under 2048 and
  asserted so in `test/persona.mjs`. This is what Claude Code gets as
  `instructions`. A security control that arrives only in a tool result is one an
  attacker can hope has been compacted away, so it belongs in the system prompt.
- **`PERSONA`** — the full operating brief, returned by `kelabo_join`, which is
  already "the context load" (§2.B), is not truncated, and is the first moment
  any of it can matter since transcript only flows after a join.

opencode takes the whole thing in `instructions` and loses nothing, so this split
costs it nothing either.

#### Three ways to hear nothing, none of which report anything

This is the Claude Code counterpart of opencode's missing `--port`, and it fails
for the identical reason: **every tool travels the tunnel and keeps working.**
The agent joins, posts and reads the board perfectly and simply never reacts to
anything said — which is indistinguishable from an assistant choosing to stay
quiet, its normal state.

| Precondition | If missing | Detectable? |
|---|---|---|
| `--channels`/`--dangerously-load-development-channels` names this server | notification dropped, no error at either end | **yes, indirectly** — see below |
| First-party auth | gate skips: "channels are not available on third-party providers" | yes, from the environment |
| Org policy `channelsEnabled` | gate skips on claude.ai Team/Enterprise | no |

`kelabo claude` supplies the flag so it cannot be forgotten, but a developer who
starts Claude Code themselves still can. The flag cannot be probed over a socket
the way `--port` can, so the adapter reads **its own parent process's command
line** (`/proc/<ppid>/cmdline`,
or `ps`). Claude Code spawns a stdio MCP server directly, so the parent *is* the
`claude` the developer launched — verified: the bridge logs
`{"event":"channel_state","armed":true}` under a real session. When it can see
the flag is missing, `kelabo_join` returns the remedy in its result, because the
developer at that terminal is the only person who can fix it and the agent's own
output is the only thing they are certainly reading.

It returns **null**, and warns about nothing, when the command line cannot be
read. An unknown is not a fault, and warning on one trains people to ignore the
warning — the same reasoning as `backgroundSubagents()` on the opencode side.

The provider gate is the six environment variables Claude Code's own check reads
(`CLAUDE_CODE_USE_BEDROCK`, `…_VERTEX`, `…_FOUNDRY`, `…_ANTHROPIC_AWS`,
`…_ANTHROPIC_GOOGLE_CLOUD`, `…_MANTLE`); any of them set means channels are off
whatever else is right. It outranks the flag in the caveat text, because with
both wrong, adding the flag changes nothing and naming it first sends the
developer to fix something that was not the problem.

Remaining preview constraints: custom channels are not on Anthropic's allowlist,
so the development flag is required — Team and Enterprise admins can
self-allowlist via `allowedChannelPlugins`, and the official list needs an
Anthropic partner contact. The flag does not appear in `claude --help`, and the
protocol may change.

**`claude/channel/permission` is deliberately not declared.** That capability
relays tool-approval prompts out through the channel so they can be answered
remotely. The far end of this channel is a kelabo room that may contain
link-joined guests, and anyone who can reply through a channel can approve tool
use in the developer's session. Kelabo declines the capability rather than
gate it.

---

## 5. Kelabo prep — attaching before the kelabo starts

A scheduled kelabo is the **same `KELABO#<id>` partition, the same id**, with
`status: "scheduled"`; `start-scheduled` mutates the META in place. So a board
post written before the kelabo exists on the same board afterwards, with no
migration and no second identity.

`kelabo_join` accepts a scheduled kelabo. What the binding does is decided by
the kelabo's status, never by the client:

| Status | Binding registered in | Transcript | Down-frames |
|---|---|---|---|
| `scheduled` | `state.prepByKelabo` | none | `briefing` only |
| `active` | `state.tunnelByKelabo` | yes | `briefing`, then `transcript` |

`caption.js` consults only `tunnelByKelabo`, so **a prep binding can never
receive transcript**. That is a structural guarantee rather than a convention.

The lifecycle is deliberately manual:

1. Before the kelabo, the developer opens a session and calls `kelabo_join` on
   the scheduled kelabo. The briefing arrives: title, time, host, the host's
   `note`, the invitee roster and their RSVPs.
2. The agent investigates against the local repo and calls `kelabo_post`. Those
   posts persist as ordinary `CONTRIB#` items.
3. The kelabo starts. **Nothing happens automatically.** If the developer wants
   the agent in the kelabo, they call `kelabo_join` again — from the same
   session or a new one. If they do not, the prep findings are already on the
   board and no transcript ever reaches the agent.

There is **no prep card type and no `phase` field**. A prep contribution is an
ordinary contribution from the same Kelabo assistant, with an earlier `at`. The
board sorts ascending by `at`, so prep findings are simply already at the top
when the first participant walks in.

One display consequence: a contribution's timestamp renders as time-of-day only,
which reads as "just now" for a card written yesterday. The board renders the
date when a card's day differs from the kelabo's.

---

## 6. Security model

**Kelabo makes no permission guarantee about a dev agent, and cannot.** The
agent is the developer's own; it may have `bash` allowed and write-capable MCP
servers configured. The previous model — a Kelabo-authored persona with
`bash: deny` and `edit: deny` in its frontmatter — does not survive the
developer owning their own configuration.

The compensating control is the one the developer asked for: **every permission
prompt appears in their own TUI, and they answer it.** That is why the bridge
never auto-approves, never sets a permission mode, and declines Claude Code's
permission relay.

**Captions are untrusted input.** Any participant, including a name-only guest,
can speak or post a note that becomes text in front of an agent with read access
to a private repo. The mitigations:

- Every injected batch is wrapped in `<kelabo-transcript untrusted="true">`, and
  the persona instructs the agent to treat the contents as *data about a
  conversation*, never as instructions addressed to it.
- The bridge is the sender gate. It forwards transcript for exactly one kelabo —
  the one the developer explicitly chose with `kelabo_join` — and nothing else.
- The board post is a deliberate tool call, so nothing reaches the kelabo that
  the agent did not decide to send.

**Prep widens the window.** An invitee, possibly a link guest, can influence an
agent before anyone is in the room watching. The briefing therefore carries only
the host-authored `title` and `note` plus the invitee roster — and invitee
display names are guest-controlled, so they travel inside the untrusted envelope
like any other participant text.

**Token.** The bridge authenticates with an agent token obtained through a
device-code pairing flow (`kelabo login` prints a code, the developer approves it
in the portal). It is scoped to one identity and tenant, revocable from Settings,
and independent of the browser session and refresh chain.

---

## 7. Process and files

One process, `kelabo-mcp`, spawned by the runtime over stdio. It holds the MCP
server, the WSS tunnel, the token, the transcript queue and the binding, plus a
small loopback listener so the opencode `/kstart` plugin can hand over its
session id. Its lifetime is the agent session's lifetime, which matches how the
feature is used: one agent, in one folder, for one kelabo.

```
connector/
  src/
    index.js            startBridge() — wiring. No CLI
    cli.js              the bin: setup/login/status/uninstall/reset/run
    runtimes.js         the runtime registry: config file, MCP entry shape, launch line
    launch.js           `kelabo opencode` / `kelabo claude` — composes the flags (docs 17 §5)
    mcpServer.js        contract B  (@modelcontextprotocol/sdk, stdio)
    persona.js          PERSONA_CORE (≤2048 chars) + the full PERSONA (§4.2)
    tunnel.js           contract A  (WSS /rig client)
    envelope.js         transcript composition          — pure, node-testable
    transcriptQueue.js  coalescing + backpressure       — pure, node-testable
    install.js          the three opencode config keys  — pure, node-testable
    installer.js        the fs half of setup/uninstall
    version.js          the version announced in `register`
    binding.js          the kelabo binding state machine
    cards.js            board-card bookkeeping (§2.D)   — pure, node-testable
    control.js          loopback listener for /kstart
    login.js            device-code pairing CLI
    plugin/
      opencode.js       the /kstart plugin — npm AND the Rig load this one file
    adapters/
      index.js          picks contract C from KELABO_RUNTIME; unknown throws
      opencode.js       contract C
      claudeCode.js     contract C
  commands/             /kstart and /kend, markdown with front matter
  build/pack.mjs        emits the publishable package
```

`envelope.js`, `transcriptQueue.js` and `install.js` are pure — no MCP, no fetch,
no fs, injected clock — for the same reason `transcript/composer.js` is
([`13-transcript-lifecycle.md`](../13-transcript-lifecycle.md)): they are the
parts where a mistake is otherwise only findable in a live kelabo, or in
somebody's already-damaged opencode config. Keep new batching, envelope or
config-editing logic in them rather than in an adapter or the CLI.

How this reaches a developer who has not cloned the repo — the npm package, the
three config keys, `setup`/`uninstall` — is
[`17-agent-distribution.md`](./17-agent-distribution.md).

---

### 7.1 One bridge per opencode, and how `/kstart` finds the right one

Every opencode instance spawns its own bridge over stdio, so a laptop with three
sessions open has three — all wanting the same loopback port, and only one
getting it. Two things follow, both of which were wrong and both of which failed
*silently*:

- **A busy port is not survivable by giving up.** The loser used to abandon its
  listener and carry on, which looks fine — every MCP tool still works, because
  those go over the tunnel. Only transcript needs the handover, so the symptom
  is a bridge that joins, posts, reads the board, and never hears a word.
  It now takes an ephemeral port instead.
- **A single shared lock file cannot address N bridges.** Last writer wins, so
  `/kstart` reached *another session's* bridge, which bound it happily, while
  the bridge serving this session's tools still had no session — and
  `kelabo_join` reported "run /kstart first" to someone who just had.

The rendezvous is therefore keyed by process: the MCP server is spawned directly
by the opencode process that loads the plugin, so the plugin's own `process.pid`
is the bridge's `process.ppid`. The bridge writes
`~/.kelabo/bridge-<ppid>.json`; the plugin reads `bridge-<own pid>.json`. Exact,
not heuristic. The shared `bridge.json` is still written as a fallback for a
runtime that spawns MCP servers through a wrapper, and a bridge only deletes a
lock it actually wrote — deleting unconditionally is how one bridge shutting
down used to blind every other bridge on the machine.

`test/control.mjs` covers this with real sockets and two live bridges, because
none of it is reproducible with one.

---

## 8. Interfaces summary

| Interface | Direction | Transport |
|---|---|---|
| KAP | Gateway ↔ bridge | WSS `/rig`, zod discriminated unions both ways |
| Agent tools | bridge ↔ agent | MCP over stdio |
| Transcript injection | bridge → runtime | channel notification (Claude Code) / `prompt_async` (opencode) |
| `/kstart` handover | opencode plugin → bridge | loopback HTTP, POST-only, rendezvous by parent pid |
| Pairing | `kelabo login` → REST | `POST /agent/device/{code,token}` |
| Kelabo discovery | bridge → REST | `GET /agent/kelabos`, agent-token auth |
