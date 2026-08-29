# Agent behaviour — what the assistant actually does

Docs [05](./components/05-agent-mcp.md) and [14](./components/14-agent-orchestration.md)
specify the agent's **design**. This doc describes its **behaviour**: the exact
path a spoken question takes from a caption to a board card, the exact path a
kelabo takes to its minutes, and — the reason this doc exists separately — a
line-by-line account of **which of those rules are enforced by code and which
are only sentences in a prompt**.

That distinction is not pedantry. Every recurring complaint about the assistant
("it searched for a minute and then said nothing", "it answered in Chinese")
turns out to be a rule that reads as a guarantee in docs 05/14 and is in fact a
request made politely to a model. §4 catalogues those, with the file and line
where each ends.

Scope: **server-agent mode** (the worker thread in the Gateway ECS task) unless
a section says otherwise. Dev mode — the developer's own coding agent over the
bridge — is a different brain with a different persona, and is covered in §5 and
in [16](./components/16-agent-bridge.md).

---

## 1. The life of a question

```
 browser mic ──► STT ──► POST /caption ──► caption.js ──► messageBuffer.js
                                                              │ closed message
                                                              ▼
                                            ┌────────────────────────────────┐
  §1.1  TRIGGER GATE   (smallModel)         │ 4 cheap rejections, then 1 call │
                                            └───────────────┬────────────────┘
                                       NONE ◄───────────────┤ verdict + query
                                                            ▼
                                            ┌────────────────────────────────┐
  §1.2  QUEUE          (no model)           │ working card posted immediately │
                                            └───────────────┬────────────────┘
                                                            ▼
                                            ┌────────────────────────────────┐
  §1.3  ORCHESTRATOR   (smallModel, ×1)     │ exactly ONE call. dispatch or   │
                                            │ NO_POST. Never answers itself.  │
                                            └───────────────┬────────────────┘
                                              0..3 briefs   ▼
                                            ┌────────────────────────────────┐
  §1.4  WORKERS        (model, ×0..3)       │ up to 16 tool iterations each,  │
                                            │ in parallel, then JSON result   │
                                            └───────────────┬────────────────┘
                                                            ▼
  §1.5  BOARD                                 done / skipped card, per worker
```

Four different models' worth of decisions, three of them independent gates. A
question dies quietly at any of them.

### 1.1 The gate — deciding a question was asked

`gateway/src/agent/gate.js`. Runs on **every closed message**, which is why most
of it is arranged to avoid the model call.

An `@kelabo …` typed into the room **skips this entire section**
(`worker.js:184`, logged `gate_bypassed`). A person has already made the
decision the gate exists to make, and letting a classifier, a cooldown or a rate
cap discard it would be discarding a request made in so many words.

Otherwise `TriggerGate.decide` (`gate.js:73`) applies, in order:

| # | Check | Verdict logged | Cost |
|---|---|---|---|
| 1 | Fired for this kelabo within `cooldownSeconds` (default 45) | `cooldown_active` | free |
| 2 | Caption is on the closed backchannel list (`gate.js:12` — "yeah", "mm hmm", "got it", …) | `backchannel` | free |
| 3 | A classification for this kelabo is already in flight | `classifier_busy` | free |
| 4 | `maxContributionsPerMinute` (default 3) already reached | `rate_cap_reached` | free |
| 5 | **One `smallModel` call**: whole transcript, `temperature: 0`, `response_format: json_object`, 1024 tokens | — | one call |
| 6 | `confidence` below the `sensitivity` threshold (low 0.8 / **medium 0.5** / high 0.2) | `below_threshold(…)` | — |
| 7 | Cooldown re-checked against the clock at *settle* time, not at start | `cooldown_active_on_settle` | — |

Checks 3 and 7 exist because captions arrive faster than a classification
returns: checking the cooldown, awaiting the model and only then recording the
fire is a check-then-act race, and two captions half a second apart both used to
pass a 45-second cooldown.

Every counter is **per kelabo** (`gate.js`'s `kelabos` Map). It used to be per
`TriggerGate` — one instance serving every kelabo in the task — so one room's
question silenced every other room for 45 seconds.

The classifier call is retried once on a transient provider failure
(`withLlmRetry`, `llmRetry.js`) — a 429 here used to become verdict NONE with
reason `classifier_error`, silently eating a real spoken question. Timeouts
and non-429 4xx are deliberately not retried.

The gate returns a `query`: a short standalone lookup title with references
resolved and obvious mistranscriptions corrected. That string becomes the
working card's title, so the room reads it as "this is what it thinks you
asked" — a useful, free diagnostic when the answer comes back about the wrong
thing. It also returns a `language` (the requester's, as an English language
name), which is the fallback for briefs the orchestrator dispatches without
setting one — see §4.2.

### 1.2 The queue — what the room sees before anything has happened

`worker.js:206` (`enqueueRun`) posts a `working` card **the instant the gate
says yes**, before the orchestrator's first call. The card carries the gate's
`query` as its title and one of two progress lines: "Picking up what was just
said…", or "Queued behind another lookup…" when the run cannot start yet.

Concurrency: strictly **one turn per kelabo** (`runningKelabos`,
`worker.js:236`), and by default **unlimited across kelabos** — runs are
I/O-bound LLM calls, and one room's research must never queue another room's.
A `MainAgent` owns one persistent thread and appends to it as a turn
progresses, so two turns on one kelabo interleave their writes and produce a
malformed thread — see §3.3. Jobs for a busy kelabo are skipped over in the
queue rather than blocking its head (`pumpQueue`, `worker.js:238`).
`maxConcurrentRuns` (default 0 = unlimited, `hasCapacity` in `schedule.js`) is
an opt-in global valve for deployments on a low-quota provider key; with it
unset, "Queued behind another lookup…" only ever means *this kelabo's own*
previous question.

Consequence worth stating plainly: **a second question asked while the first is
still being researched waits for the whole first turn.** That wait is now
bounded: workers carry a wall-clock deadline (`turnDeadlineSeconds`, default
180s, §1.4) and every LLM call a timeout (`LLM_TIMEOUT_MS`, 120s), so a wedged
provider can no longer hold a kelabo's slot indefinitely. A job that has
queued longer than `JOB_TTL_MS` (120s) is expired with a skipped card
("waited too long behind other work") rather than run late against a
conversation that has moved on, and every start logs its `queueWaitMs`
(`agent_run_started`) so "is the valve too small" is a measurement.

### 1.3 The orchestrator — deciding what to look up

`mainAgent.js`, `MainAgent.runTurn` (`mainAgent.js:249`). One long-lived
instance per kelabo, on `smallModel`.

Before the call: `repairThread()` (§3.3), then transcript turns are appended
append-only, then `TRIGGER: <query>` is pushed. The thread is a stable prefix
that only grows at the tail, which is what makes provider prompt caching work.

**Exactly one model call per turn**, `maxTokens: 1024`, whose only tool is
`dispatch_subagent`. Two outcomes:

- **No dispatch** → the reply is recorded as plain text (`NO_POST: reason`) and
  the card becomes `skipped` with that reason. Deliberately plain text and no
  tool calls: a recorded `tool_use` with nothing answering it kills the thread.
- **1..3 dispatches** → the assistant turn is recorded verbatim
  (`mainAgent.js:329`), the turn card is cleared, and one `working` card is
  opened per task.

The orchestrator never answers the room, never calls a research tool, and never
writes `[LLM_CON]`. Anything beyond `maxDispatchPerTurn` (default 3) is dropped
and answered with a stub `tool_result` (§3.3).

### 1.4 The workers — doing the lookup

`subAgent.js`. One fresh `SubAgent` per brief on the strong `model`, all in
parallel, each destroyed after producing its result. A worker sees **only its
brief** — never the transcript, never another worker's context. Every worker
carries the turn's wall-clock deadline (`deadlineAt`): past it the loop stops
and force-concludes from what was gathered, logged as `subagent_deadline` —
a late partial answer instead of a spinner that ends in nothing.

Its loop, up to `MAX_TOOL_ITERATIONS = 16` (`subAgent.js`), whichever of the
iteration cap or the deadline comes first:

1. Call the model with the brief and whatever tools the deployment granted.
2. No tool calls in the reply → concluded; break.
3. Otherwise push a progress line per call ("Fetching bom.gov.au", "Asking jira
   · search"), run them all in parallel, truncate each result to 8000 chars,
   append, repeat.

Tools and their budgets (`subagents.js`):

| Tool | Granted when | Budget | Failure |
|---|---|---|---|
| `web_fetch` | always (plain fetch, no key) | 15s, 64 KB, 8000 chars | `{error}` returned to the model |
| `web_search` | `WEB_SEARCH_ENABLED` **and** a `braveApiKey` on the `llm` credential | 15s, 5 results | `{error}` — a failed search is a tool failure, no longer `[]` masquerading as "nothing found" |
| `mcp_query` | any server in the host's effective MCP config | 20s per RPC | `{error}`; a 401 reauthorizes once and retries |

A loop LLM call that fails transiently is retried once; one that fails
permanently **breaks to `forceConclude` instead of throwing**, so the research
already gathered still reaches the conclusion rather than being discarded as
an error result carrying none of it (`subagent_llm_failed`).

Then `forceConclude`: if the loop ran out of iterations, or the final turn was
not parseable JSON, one extra no-tools call in JSON mode demands the result now
from what was already gathered. This exists to stop mid-research narration
("now let me check X") being posted as if it were the answer.

`normalizeResult` (`subAgent.js:334`) is the last gate. A missing or unparseable
result becomes `status: "empty"`, `gaps: "no_conclusive_result"`. An `ok` result
whose `answer` is empty is **downgraded to `empty`** — a successful-looking
result with nothing in it is not posted.

### 1.5 The board — one card, four states

A card is created when the **gate** fires, not when the answer arrives, and it
is the same card throughout. Nothing disappears without saying why.

| Moment | `status` | What the room sees |
|---|---|---|
| gate fires | `working` | the gate's query, "Picking up what was just said…" / "Queued behind another lookup…" |
| orchestrator deciding | `working` | "Deciding what to look up…" |
| dispatch | — | turn card cleared, replaced by one card per task |
| worker running | `working` | its current step, plus the trail so far |
| worker writing the answer | `working` | the `answer` field streamed as it generates (`partialAnswer`, `subAgent.js:108`) |
| concluded with an answer | `done` | answer, title, `to`, sources — **persisted** |
| `empty`/`error`, or `NO_POST` | `skipped` | the card **stays**, muted, carrying a reason |

`working` and `skipped` are streamed but never persisted (`sseHub.js` treats
them as ephemeral). `skipped` exists because deleting the card is
indistinguishable from a bug: it removes the only evidence the assistant heard
the room at all.

---

## 2. The life of the minutes

Trigger: `POST /kelabos/:id/minutes`, any time, or kelabo end. `minutes.js`
branches on whether a dev-mode runtime is attached:

- **dev mode** → `tunnel.requestDevSummary` — a `requestId`-correlated frame
  answered by the local agent's `kelabo_minutes` tool.
- **server mode** → `agentDispatcher.summarize` → the worker →
  `MainAgent.summarize` (`mainAgent.js:604`), bounded by
  `SUMMARIZE_TIMEOUT_MS = 8 minutes` (`runner.js:27`), which resolves `null` and
  logs `summarize_timeout` rather than hanging the request.

The server-mode prompt (`summarySystemPrompt`, `persona.js:220`) gets:

1. the participant list, taken from the transcript's speaker labels;
2. the **full** transcript, untrimmed;
3. `researchBrief()` (`mainAgent.js`) — the `taskLog`, one line per dispatched
   task with its objective, status, answer and sources, rendered as
   `RESEARCH THE ASSISTANT PERFORMED DURING THIS KELABO`. This is where
   `findings` and their provenance come from; without it the minutes could only
   describe what people said, and every answer the assistant put on the board
   would be lost.

`maxTokens: 8192` — minutes are the one long-form output, and the single most
expensive call in a kelabo. `completeRaw` is used rather than `complete`
specifically so `finish_reason` survives: truncation is logged as
`minutes_truncated`, because a record cut short just looks a bit thin.

Parsing is `parseMinutesJson` (`serverAgentRunner.js:23`), which tries an exact
parse of `{`…last `}`, then `repairTruncatedJson` on the full tail, then on the
greedy slice. Unparseable returns `null` and the record honestly shows no
minutes — the earlier behaviour, storing the raw reply as the summary, produced
a record claiming `hasMinutes: true` over a wall of escaped JSON.

The contract is a **document, not an index**: `title`, a 2–5 sentence
`summary`, `topics[]` each with 3–6 sentences of `detail`, `decisions[]` with
`rationale`, `actionItems[]` with `owner`/`due`, `openQuestions[]`,
`findings[]` with `sources`. `parseMinutesJson` also normalises the legacy
string-array shape so archived records and dev-mode summaries still render.

The `taskLog` is **not persisted** — it lives with the worker context. Minutes
regenerated after an ECS task restart lose their `findings` provenance.

---

## 3. What is actually enforced

The single most useful table in this document. "Prompt only" means the rule
exists as English in a system prompt and nothing downstream checks it.

### 3.1 Enforced in code

| Rule | Where |
|---|---|
| Gate cooldown, rate cap, backchannel skip, busy skip, confidence threshold | `gate.js:73`–`167` |
| An `@kelabo` mention bypasses the gate entirely | `worker.js:184` |
| One orchestration turn per kelabo | `worker.js:236`, `pumpQueue` |
| At most `maxDispatchPerTurn` (3) workers per turn; the rest get stub results | `mainAgent.js` (`dropped`) |
| At most `MAX_TOOL_ITERATIONS` (16) model round trips per worker | `subAgent.js:4` |
| Per-tool budgets: 15s search, 15s + 64 KB fetch, 20s MCP RPC | `subagents.js` |
| Tool results truncated to 8000 chars before re-entering the prompt | `subAgent.js` |
| A brief with no `task_id` or no `objective` never reaches a worker | `mainAgent.js:110`, `:367` |
| `ok`/`partial` with an empty `answer` is downgraded to `empty` | `subAgent.js:334` |
| Only `ok`/`partial` with a non-empty answer reaches the board | `mainAgent.js:438` |
| Every recorded `tool_use` gets a `tool_result`, three ways over | §3.3 |
| Every LLM call has a timeout: 120s default, 45s force-conclude, 7 min minutes | `llm.js` (`LLM_TIMEOUT_MS`, `callSignal`), `subAgent.js`, `mainAgent.js` |
| A worker stops researching at the turn deadline and force-concludes | `subAgent.js` (`deadlineAt`), `turnDeadlineSeconds` |
| Transient LLM failures (429/5xx/network) retried once; timeouts and other 4xx never | `llmRetry.js`, used by gate/orchestrator/worker/minutes |
| A brief with no `language` inherits the gate's detected language | `mainAgent.js` (`main_dispatch_language_defaulted`) |
| A queued job older than 120s is expired with a skipped card, never run late | `worker.js` (`JOB_TTL_MS`) |
| A speaker rename rewrites the orchestrator's recorded thread too | `mainAgent.js` (`renameSpeaker`), `worker.js` `onRename` |
| Minutes wait at most 8 minutes | `runner.js:27` |
| Unparseable minutes are `null`, never a raw-text record | `serverAgentRunner.js:23` |
| Dev-mode minutes carry the host's language on the request frame | `tunnel.js` `requestDevSummary`, `connector/src/binding.js` |
| Dev-mode cards left open 15 minutes are landed as `skipped` | `connector/src/cards.js` |

### 3.2 Prompt only — stated, never checked

| Rule | Stated at | What actually happens |
|---|---|---|
| `constraints.max_tool_calls` | `persona.js:189` | `subAgent.js` never reads `brief.constraints`. Only the 16-iteration cap and the turn deadline apply. |
| `constraints.deadline_ms` | `persona.js:189` | Per-brief value never read — but a real wall-clock deadline now exists per worker (`turnDeadlineSeconds`, §1.4), so the prompt sentence is redundant rather than false. |
| `language` is required on every dispatch | `mainAgent.js:34` (JSON schema) | A schema hint to the provider. `missingBriefFields` checks only `task_id` and `objective` — but an omitted `language` now inherits the gate's (§4.2) instead of falling through to the brief-mirroring fallback. |
| "answer in ${language}" | `persona.js:174` | Enforced when the orchestrator supplied one **or the gate detected one**. Both empty (an `@kelabo` typed mention) → "mirror the brief's language". |
| "on `partial`/`empty` you may re-dispatch once with a sharper brief" | `persona.js:146` | **Impossible within a turn.** `runTurn` calls the orchestrator once and returns after nesting the results. A refine needs a fresh gate trigger, which is behind a 45s cooldown. |
| "prefer the fewest, best-chosen calls (aim for 2–4)" | `persona.js:189` | Advisory. |
| `constraints.answer_from_context: true` | `persona.js:112`, `:181` | Advisory; the worker may still search. |
| "never invent data or sources" | `persona.js:208` | Advisory. Sources are deduped and carried through, never verified. |
| `kind: "web" \| "mcp" \| "code"` | `mainAgent.js` schema | A routing *hint*. Tool availability is decided by deployment capabilities, not by `kind`. |

### 3.3 The one invariant defended three times

Every provider rejects an assistant turn that calls a tool without the next
message answering every `tool_call_id` — OpenAI-compatible ones with a bare 400.
In a **persistent** thread that is not transient: the same malformed prefix is
resent on every later trigger, so one bad turn ends the assistant for the rest
of the kelabo. It happened in dev on 2026-07-28, every trigger from 23:05.

1. **Answer everything recorded.** `runTurn` emits a `tool_result` for every
   `tool_use` in the turn it records — dispatches that ran, dispatches the cap
   dropped, and any tool the model invented (small models do call `web_search`,
   which the orchestrator does not have). A turn that dispatches nothing records
   plain text and no tool calls.
2. **Repair before use.** `MainAgent.repairThread()` runs at the top of every
   turn and fills any gap with a placeholder, so a thread already broken by a
   run abandoned mid-stream recovers instead of failing forever.
3. **Guarantee the wire format.** `answerDanglingToolCalls` (`llm.js:189`)
   inserts a placeholder `tool` message for any unanswered id, whatever the
   caller did.

---

## 4. Known failure modes

Each of these is a live, reproducible behaviour, not a hypothetical. The
diagnosis is recorded here because in every case the code reads correctly and
the failure only becomes visible when you ask which line enforces the rule.

### 4.1 "It searched for a long time and then posted nothing"

The user-visible ending is one of three strings, all produced by `skipReason`
(`mainAgent.js:119`):

- *"The search finished without a concrete answer, so nothing was posted."*
- *"Nothing conclusive found — …"*
- *"Research failed — …"*

Contributing causes, roughly in order of how often each is the real one.
The first two are **fixed** and kept here as history:

1. **~~No wall-clock deadline exists.~~ Fixed.** Workers now carry
   `turnDeadlineSeconds` (default 180s) and stop researching when it passes,
   force-concluding from what was gathered (`subagent_deadline`). The room
   gets a bounded wait and, usually, a partial answer instead of nothing.
2. **~~No LLM call has a timeout.~~ Fixed.** `llm.js` now applies
   `LLM_TIMEOUT_MS` (120s) to every call whose caller sets no signal; the
   force-conclude call gets 45s, the minutes 7 minutes. Transient provider
   failures are additionally retried once (`llmRetry.js`); a mid-loop failure
   that survives the retry concludes from the gathered research rather than
   discarding it.
3. **The empty ending is structural, not exceptional.** Iterations exhausted or
   a final turn that is not JSON → `forceConclude` → if that call throws or also
   fails to parse, `normalizeResult(brief, null)` yields `status: "empty"` and
   the card is `skipped`. Long research and no answer is the *designed* path
   through those two functions, not a crash.
4. **Reasoning models are the worst case for all of the above.** Their latency
   lives in `reasoning_content`, which is accumulated but deliberately never
   streamed to the board (`llm.js`, `consumeStream`) — chain-of-thought is not
   the answer. So the card genuinely has nothing to show for the longest part of
   the wait. And when `max_tokens` cuts one off mid-reasoning, `content` is
   empty and the fallback returns the *reasoning* as the answer text, which then
   fails `extractJsonObject` and takes path 3.
5. **A truncated tool-call arguments string.** The orchestrator runs at
   `maxTokens: 1024`; a reasoning model cut off mid-JSON produces an
   unparseable `arguments`, which `parseToolArgs` logs as
   `llm_tool_args_parse_failed` and falls back to `{}`. That empty brief is
   caught by `missingBriefFields` and becomes *"Research failed: the lookup
   request was incomplete and could not be run."* Diagnosable now; still not
   prevented.
6. **~~`web_search` failure is silent.~~ Fixed.** A failed or key-less search
   now returns `{error}` (like `web_fetch` always did), so the model can tell
   "the tool failed" from "nothing exists" instead of falling back to guessing
   URLs. Without a `braveApiKey` the tool is still not offered at all.
7. **The advertised recovery cannot run.** "Re-dispatch once with a sharper
   brief" (§3.2) has no code path inside a turn, so `partial`/`empty` is
   terminal until the gate fires again — and the gate is on a 45-second
   cooldown that the failed turn has just reset.

Diagnostics that already exist: `gate_decision`, `main_no_dispatch`,
`main_dispatch_brief_invalid`, `subagent_no_post`, `turn_usage`,
`web_search_failed`, `web_fetch_failed`, `llm_tool_args_parse_failed`, and the
full `kind: "subagent"` request/response debug stream surfaced in the SPA
DebugPanel. `KELABO_LLM_WIRE_LOG=1` dumps the exact provider payloads.

### 4.2 "It answered in Chinese in an English kelabo" — fixed

Three languages are in play in one kelabo and each is decided by a different
party (docs 14 §5.5): the **board answer** follows the *requester*, **research**
may be in any language, the **minutes** follow the *host*.

The board answer's chain:

```
gate verdict: query AND language (both in/naming the participants' language)
   └─► orchestrator writes the brief and MUST set `language`
          └─► brief.language empty? → inherit the gate's language
                 (main_dispatch_language_defaulted, mainAgent.js)
          └─► SubAgent constructor: language: String(brief.language ?? "")
                 └─► subAgentSystemPrompt({ language }) — hard rule, or FALLBACK
```

It used to break at the second arrow: `language` is `required` in the dispatch
tool's JSON schema, but that is a hint to the provider, and when a small model
omitted it the worker's fallback mirrored the *brief's* language — the
orchestrator's own prior, not the participant's. The gate now returns the
requester's language alongside the query, and an omitted brief `language`
inherits it, so the fallback branch is only reachable when *both* are empty —
in practice an `@kelabo` typed mention, where the query is the participant's
own words and mirroring them is correct.

There is a second, quieter path: the gate is told to write `query` in the
participants' language, and `query` is the **card title** the room reads while
waiting. A gate that drifts and an orchestrator that mirrors the gate produce a
card that is wrong in the title as well as the body.

### 4.3 "The minutes are in Chinese and the kelabo was in English"

**Server mode: this is the design, not a bug — which is the finding.**

`hostLanguage = languageName(meta?.hostLang)` (`runner.js:283`). `hostLang` is
the host's **browser speech-to-text picker** (`kelabo-stt-lang` in
localStorage, `spa/src/routes/Kelabo.jsx`), copied to the kelabo meta by
`rest-api/src/join.js` the first time the host joins — and only then, guarded by
`!meta.hostLang`, so it is never revised.

`summarySystemPrompt` then states it as a hard rule that explicitly overrides
the room (`persona.js:226`): *"This is the kelabo host's language and it does
NOT depend on which language the kelabo was conducted in — translate what was
said into ${hostLanguage} as you write."*

So the observed behaviour follows exactly:

- a host whose STT picker is set to Chinese gets Chinese minutes for **every**
  kelabo they host, in perpetuity, whatever the room spoke;
- the setting that causes it is a *transcription* control, in a different part
  of the UI, with no indication it also decides the language of the record;
- it is stamped once and never updated, so correcting the picker does not
  correct kelabos already joined.

Only when `hostLang` is absent, `multi`, `auto` or an unrecognised tag does
`languageName` return `null` and the prompt fall back to *"the DOMINANT language
of the transcript"* — which is the behaviour most people expect by default.

Two aggravating factors:

- **Truncation lands here first.** Non-English minutes cost far more output
  tokens per character against the same 8192 cap, so a kelabo that gets
  translated minutes is also the kelabo most likely to get *truncated* minutes
  (`minutes_truncated`).
- **Dev mode now follows the same rule.** The summary `request` frame carries
  an optional `language` (frames.js), resolved by the Gateway from
  `meta.hostLang` exactly as server mode does; the bridge turns it into a
  sentence in the minutes notice (`connector/src/binding.js`). Absent, the
  bridge asks for the transcript's dominant language — the same fallback.

### 4.4 Smaller ones worth knowing

- **A second question waits for the first — but boundedly now.** One turn per
  kelabo (§1.2) still holds, but the first turn is capped by the research
  deadline and per-call timeouts (§4.1), and a job that queues past
  `JOB_TTL_MS` is expired with a card saying so instead of running late.
- **Journey/history material can still be researched externally.** The
  orchestrator is told at length to answer from journey documents first
  (`persona.js:110`–`114`) and to set `answer_from_context`, but nothing
  enforces it, and the worker may search anyway. The failure is worse than an
  empty result: a project's own term matches somebody else's product and the
  room gets a confident answer about the wrong thing.
- **The `taskLog` dies with the worker context.** An ECS task restart between
  the kelabo and the minutes request costs the `findings` section its
  provenance.
- **Sources are collected, not verified.** Every URL a worker fetched or a
  search returned is pushed to `this.sources` and deduped into the result,
  whether or not it contributed to the answer.

---

## 5. Dev mode, in one page

The bridge (`connector/`, doc 16) hands a developer's own coding agent the
transcript and four decisions to make for itself. Nothing in §1 applies: there
is no gate, no orchestrator, no worker split, no `[LLM_CON]`.

| Concern | Server mode | Dev mode |
|---|---|---|
| Deciding a question was asked | `TriggerGate` + cooldown + rate cap | the persona's "silence is the default" and the agent's judgment |
| Deciding to look something up | orchestrator, one call | the agent |
| Doing the work | `SubAgent`, ≤16 iterations, budgeted tools | the agent's own tools, subagents and MCP servers |
| Reaching the board | `[LLM_CON]` marker parsed by `contracts/src/llmcon.js` | the `kelabo_post` tool — the marker is deliberately **not** on the wire, because in a shared interactive session a text marker cannot tell a board post from the agent answering the developer's own typed question |
| The working card | opened by the gate | opened by `kelabo_working`, swept to `skipped` after 15 minutes idle (`cards.js`) |
| Kelabo end | the `:KELABO-END` token | a `requestId`-correlated `request` frame — the token is not on the wire, because it used to fire on any caption merely *containing* the string |
| Answer language | per-dispatch `language`, defaulted from the gate's when omitted | *"answer in the language you were asked in"* (`connector/src/persona.js`) |
| Minutes language | `meta.hostLang` | the same `meta.hostLang`, carried as `language` on the summary request frame (§4.3) |

Shared between the two brains, so they cannot drift: `ASSISTANT_NAME`,
`ADDRESSED_NOTE` (the speech-to-text manglings of "Kelabo" — *club, klabo,
clabo, clavo, cabo, global, "kay labo"* — and the counter-rule that the same
words in ordinary use are not a trigger), `NAME_MANGLINGS` (the bare list, for
prompts phrased in the third person — the trigger gate's own hand-restated
copy had already drifted, losing "collabo" and "ka labo", which is why the
list is now a separate export) and `NOISY_TRANSCRIPT_NOTE`, all in
`@kelabo/contracts` and imported by both `gateway/src/agent/persona.js` and
`connector/src/persona.js`, and by `gate.js`. An earlier version of the bridge
persona never told the agent it had a name, so a participant saying "Kelabo,
how long do our tokens last?" — arriving as "clabo" — was read as chatter and
ignored.

---

## 6. Knobs

**All eight are published from `/admin` → Assistant** (docs 23) and apply to a
*running* worker: `ensureWorker()` re-initialises it when the model or the knobs
changed, and `POST /internal/config/reload` pushes that immediately rather than
waiting for the next caption — which matters most in a quiet room, where
`ensureWorker` is not called again until somebody speaks.

The env vars below are the **bootstrap**: they are what a deployment falls back
to until something is published, and a published value wins over every one of
them. Tuning these against a live room, and waiting for a docker build between
attempts, is what made them the first thing anyone asked to publish.

Gateway env, all in `gateway/src/config.js` under `gateway.agent`:

| Setting | Env (bootstrap) | Default |
|---|---|---|
| `sensitivity` | `KELABO_AGENT_SENSITIVITY` | `medium` (confidence ≥ 0.5) |
| `cooldownSeconds` | `KELABO_AGENT_COOLDOWN_SECONDS` | 45 |
| `maxContributionsPerMinute` | `KELABO_AGENT_MAX_CONTRIB_PER_MIN` | 3 |
| `maxConcurrentRuns` | `KELABO_AGENT_MAX_CONCURRENT_RUNS` | 0 (unlimited; positive = global cap) |
| `maxDispatchPerTurn` | `KELABO_AGENT_MAX_DISPATCH_PER_TURN` | 3 |
| `rollingWindowSize` | `KELABO_AGENT_ROLLING_WINDOW` | 60 |
| `turnTimeoutSeconds` | `KELABO_AGENT_TURN_TIMEOUT_SECONDS` | 1 (message composition, not the agent) |
| `turnDeadlineSeconds` | `KELABO_AGENT_TURN_DEADLINE_SECONDS` | 180 (research deadline per turn, enforced on workers; 0 disables) |

Not configurable — compile-time constants: `MAX_TOOL_ITERATIONS` (16),
`LLM_TIMEOUT_MS` (120s per LLM call), `CONCLUDE_BUDGET_MS` (45s),
`MINUTES_TIMEOUT_MS` (7 min), `JOB_TTL_MS` (120s queue expiry),
`SEARCH_BUDGET_MS`/`FETCH_BUDGET_MS` (15s), `MCP_BUDGET_MS` (20s),
`FETCH_MAX_BYTES` (64 KB), `SUMMARIZE_TIMEOUT_MS` (8 min), minutes `maxTokens`
(8192), orchestrator `maxTokens` (1024), worker `maxTokens` (2048).

Models come from the `llm` credential slot: `model` (strong) runs the workers,
`smallModel` (flash) runs the gate, the orchestrator **and the minutes**. The
split is by role and stays whatever is configured; pointing `model` at a
stronger model is config, not code.

Harness for the whole pipeline with no AWS and no server:
`cd gateway && node test/devAgent.mjs --provider scripted`, or
`--provider anthropic|openai` with `KELABO_LLM_API_KEY` for a live run.
