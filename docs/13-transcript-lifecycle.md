# 13 — Transcript: concepts, stages, invariants

Single source of truth for how spoken audio becomes a transcript, a board and an
LLM prompt. Code uses these terms; reviews check these invariants.

The document is split the way the code is: **concepts** (the nouns — what exists,
and what crosses a boundary) and **stages** (the verbs — one module each, in
order). If a change does not fit one concept and one stage, the design is wrong,
not the change.

---

## 1. Concepts

| Concept | 中文 | Definition |
|---|---|---|
| **Tail** | 未确定尾段 | Unconfirmed STT output (Deepgram's `is_final: false`, Soniox's provisional tokens) — the provider's current guess at the words being spoken. Lives *inside* its message, is replaced wholesale on each revision, and is relayed to the room for liveness. A message has **at most one**, always at its end, and it is the only part rendered as live text. Never persisted and never shown to the LLM. |
| **Fragment** | 转录片段 | Finalized STT output (Deepgram's `is_final: true`, Soniox's final tokens). Immutable words, but only part of an utterance. Client-internal: a fragment never crosses a boundary on its own, only folded into a delta. |
| **Message** | 消息 | What a speaker produces between two seals: **committed text plus a live tail**. `{ messageId, speakerId, speakerLabel, text, tail, state: 'open' \| 'sealed', … }`. **The** unit of display, persistence and LLM submission — and one box on screen, never two. |
| **`messageId`** | 消息标识 | Minted by the speaker when a message opens. Carried by every delta and by the seal. The **sole** grouping key on every client. |
| **MessageDelta** | 增量 | An append to an open message: `{ messageId, seq, text, tStart, tEnd }`. Relayed live to the room; never persisted, never buffered, never shown to the LLM. |
| **MessageSealed** | 已封存消息 | The authoritative, immutable message. Replaces whatever its deltas built. Persisted, fanned out, and the only thing the agent ever sees. |
| **Transcript** | 会话记录 | Ordered messages. The only thing the view renders. |
| **UTT record** | 持久化转录 | A sealed message in DynamoDB (`UTT#…`). The kelabo's transcript is its ordered UTT records. |
| **Gate decision** | 门禁判定 | Per sealed message, the small model classifies it (`INFO_GAP` / `CODE_QUESTION` / `NONE`). Only non-`NONE` starts an agent run. |
| **Contribution** | Board 卡片 | Agent output on the board: a `working` placeholder, updated with progress, replaced in place by the `done` card — or cleared if the agent stays silent. |
| **Speaker rename** | 说话者修订 | A *label-only* revision across UTT rows, `META.speakerNames`, the agent window and every client. Never alters text or boundaries. |
| **Minutes** | 会议总结 | Structured summary generated from the complete UTT transcript. |

---

## 2. Stages

One module per stage, one job each.

| # | Stage | Module | Job |
|---|---|---|---|
| 1 | **Capture** | `spa/src/capture/useCapture.js` + `capture/vad.js` + `stt/<provider>.js` + `transcript/stt/<provider>.js` | mic → VAD gate → STT provider (Deepgram or Soniox — see `docs/components/06-stt.md`) → **interims and fragments**. Owns no message logic. Reading the wire (`readResult`) is pure and tested per provider; the hook only maps the normalised result onto the composer and converts the provider's audio clock to wall time. |
| 2 | **Compose** | `spa/src/transcript/composer.js` | STT output + seal triggers → **tails, deltas and seals**. Pure JS, injected clock. |
| 3 | **Publish** | `spa/src/transcript/publisher.js` | events → `POST /caption`. The only module that knows the wire format. |
| 4 | **Distribute** | `gateway/src/caption.js` | tail/delta → relay to the room and forget. Sealed → persist, fan out, dispatch to the agent. |
| 5 | **Project** | `spa/src/transcript/transcriptStore.js` | events → **Transcript**. Pure `apply(state, event) → state`. |
| 6 | **Render** | `spa/src/capture/CapturePanel.jsx` | draw the transcript: settled text, then the live tail. No grouping logic, and no opinion about where the tail begins — that is `messageParts`. |

```
STT provider          capturing browser                        gateway / agent
────────────         ──────────────────                       ────────────────
interim ──────▶ COMPOSE ── MessageTail ───┬─▶ publish ──▶ relayed live (throttled)
                      │                   └─▶ PROJECT (my own screen)
is_final ─────▶ FRAGMENT (settled — committed on arrival, never buffered)
                      │
                      ▼
                COMPOSE ── MessageDelta ──┬─▶ publish ──▶ relayed live to the room
                      │  (tail cleared)   └─▶ PROJECT (my own screen)
                      │
                      │ seal: 1s with no TEXT from the provider (5s if the last
                      │       segment is still an unconfirmed tail)
                      │       · word/time cap · speaker change · mute · stop · end
                      │       ✗ NOT the VAD gate — it is a cost gate only
                      │       ✗ NOT another participant speaking
                      ▼
                MessageSealed ────────────┬─▶ publish ──▶ persist ─▶ UTT record
                                          │              fan out  ─▶ every client PROJECTs
                                          │              dispatch ─▶ gate → agent → board
                                          └─▶ PROJECT (my own screen)

kelabo end: UTT records ──▶ archive (S3) ──▶ MINUTES
```

### The seal rule

> A message exists as soon as there is **any** text, confirmed or not — it is
> rendered and relayed at once. Every STT result carrying text resets a 1 s
> timer. **1 s with no text arriving seals the message.** If its last segment is
> still an unconfirmed tail, it waits `staleTimeoutMs` (5 s) instead: the provider
> normally confirms within a beat, so silence there means it or the network
> failed us, and the message is closed on what was heard rather than left
> hanging. Caps: open longer than `maxOpenMs` (60 s), or more than `maxWords`
> (250) words, seals on the next finalization.

**Empty results are not text.** A provider emits them continuously while receiving
audio containing no speech. Counting them as activity kept the clock alive
forever and a message never closed at all.

**One box, not two.** The tail lives inside its message; there is no separate
preview element. A second piece of UI state for in-progress speech is what
rendered two unclosed boxes for a single utterance.

**One box, two type styles.** An open message is mostly settled: a large
immutable body plus *at most one* trailing guess. Only that guess is drawn as
live (dimmed, italic). Styling the whole box while any tail was outstanding made
a minute of already-final transcript flicker as if it were about to change, and
hid the one thing the live style is for — where the transcription has actually got to.
The split is `messageParts`, next to `mergeTail` and tested with it, because a
tail may *restate* the confirmed words rather than follow them: the boundary is
not `text.length`, and `settled + live` must equal `messageText` exactly or the
box gains or loses words the instant the tail clears.

**Tails are throttled** (`TAIL_MIN_INTERVAL_MS`) before relay: a provider revises
several times a second, the room cannot perceive the difference, and a delta or
seal always flushes the newest one first, so nothing is lost.

**A tail may restate the whole utterance** rather than only the new words — CJK
models do this routinely — so `mergeTail` replaces rather than appends when the
guess already contains the confirmed text. The view and the seal both use it, so
what is displayed and what is recorded cannot disagree.

Also sealed by: speaker change (diarization), mute, stop, kelabo end. A remote
participant speaking is deliberately **not** a trigger (I6).

**The VAD gate gets no vote.** It is a cost gate — it decides which audio is
worth paying the STT provider to transcribe — and nothing else. Earlier versions let it
decide message boundaries too, which coupled the transcript to *how a room
sounds*: where background noise sits near speech level the gate latches open,
reports voice forever, and a message never sealed until the speaker muted.
Silence is now inferred from the only thing that tracks speech end to end —
whether words are still coming back.

That also makes the rule uniform. With silence skipping off there is no gate at
all and the rule is unchanged; there is no special case to get wrong.

The gate still tells the provider speech has ended when it shuts (the Deepgram
provider sends a `Finalize` frame; Soniox stops the billable stream), because with
the trailing silence cut the provider's own endpointer may never fire and the last words
would be stranded. The answer is just another message: it resets the clock like
any other, and the seal lands a second later if nothing follows. Nothing
*depends* on that answer, though — see below.

### A final is settled on arrival

Each provider's wire format lives in its own pure reader under
`spa/src/transcript/stt/` (docs 06); the principle here holds for all of them.
The Deepgram provider's streaming format is two kinds of Results frame:
`is_final: false` is its guess for the segment in progress, restated in full
about once a second; `is_final: true` means that segment is finalized and will
never be revised, and the next segment starts where it ended. An utterance is
the concatenation of its finals. (Soniox sends a token stream with per-token
`is_final` instead; its reader normalises to the same shape.)

`speech_final`, `UtteranceEnd` and `Finalize` mark where Deepgram thinks the
*speaker* paused. **We use none of them**, and the reason is structural: the VAD
gate removes silence before it is ever sent, so `endpointing` sees almost none,
and `utterance_end_ms` measures gaps between word timings — on Deepgram's audio
clock our words are contiguous even when the speaker stopped for a minute.
`Finalize` is no substitute either; Deepgram documents that its `from_finalize`
answer is *not guaranteed* when little audio is buffered.

Capture used to buffer finals until one of those signals arrived, to turn several
into one delta. The signals routinely never came, so confirmed words stayed an
unconfirmed tail for the whole utterance: nothing was persisted or shown to the
LLM, and the message eventually closed as `stt_stalled` instead of `silence`. A
final is authoritative when it arrives, so it is committed when it arrives —
one delta each, which is at most one a second anyway. Message boundaries stay
where they belong, in the composer (I5, I5a).

**Caps.** Both bound the same failure from two directions — one unbounded
message, so the agent hears nothing for the rest of the kelabo and then receives
everything at once. 250 words a minute is already very fast speech. CJK has no
spaces to split on, so `countWords` counts CJK characters (roughly morphemes)
alongside whitespace tokens; otherwise a Chinese speaker's message would never
reach the cap.

**Room noise and the gate.** Independent of sealing, but it cost real money: the
floor tracker used to be frozen while the gate was open, so a room louder than
the floor was unrecoverable — room tone sat above `floor + closeDb`, every pause
frame counted as speech, and the gate stayed open all kelabo with *zero* audio
skipped, so VAD saved nothing and Deepgram billed the lot. Frames within
`floorTrackDb` of the floor now pull it up (`floorRiseRate`), while speech, far
above it, still cannot. Simulated across rooms from −70 to −30 dBFS, the gate now
cycles normally down to about −35 dBFS.

---

## 3. Invariants

- **I1** — Unconfirmed text (a tail) is rendered and relayed for liveness, but is **never persisted and never shown to the LLM**. Only sealed message text is.
- **I1a** — A message has **at most one** tail, at its end, and only that tail is rendered as live text. `messageParts` splits it; `settled + live` is exactly `messageText`.
- **I2** — A message is persisted exactly once, and only after it is sealed. Tails and deltas are relayed and forgotten.
- **I3** — The LLM (gate, agent, minutes) only ever sees sealed messages. The room needs text immediately and the agent needs whole thoughts; tails and deltas serve the first without compromising the second.
- **I4** — **One reducer.** A speaker's own view is produced by the same `apply()`, from the same events, that every listener receives. *This is the load-bearing invariant.* Grouping implemented twice — once for local speech, once for remote — is what let a speaker and a listener disagree about where messages began and ended.
- **I5** — Message boundaries belong to the **speaker**. `messageId` is the sole grouping key; nothing re-derives boundaries from speaker identity, adjacency or timing.
- **I5a** — Sealing depends on **the STT provider's output alone**. The VAD gate is a cost gate and never decides a message boundary, so the transcript cannot be broken by how a room sounds.
- **I5b** — An `is_final` result is committed to the composer **on arrival**. Nothing between the socket and the composer buffers text, and no stage waits for `speech_final`, `UtteranceEnd` or a `Finalize` answer — all three are unreliable once the gate has removed the silence they measure.
- **I6** — A participant's message is sealed by their **own** silence, never by anyone else's speech. On a Kelabo call somebody is talking almost continuously, so sealing on remote speech shredded messages mid-sentence.
- **I7** — The sealed message is authoritative: on arrival it **replaces** whatever its deltas built, so a dropped or duplicated delta self-heals.
- **I8** — A delta arriving after its seal is ignored. It never reopens or appends to a sealed message (the seal routinely races the last delta).
- **I9** — "Is this mine?" is decided by the **participant identity** (`GET /kelabos/:id` → `me`), never the signed-in email. Guests have no email, so the email test silently failed for exactly the people who are not the host.
- **I10** — A sealed message is immutable. Rename touches the label, never the text or the boundaries.
- **I11** — A sealed message appears at most once as a UTT record (consecutive identical turns from one speaker are dropped: late STT re-emissions, two devices in one room).
- **I12** — LLM prompts contain the full kelabo transcript, append-only (prefix-cache friendly; system prompts static).

---

## 4. Why this shape

Every transcript bug in this system's history has been one of two kinds:

1. **Two implementations of one concept.** Local speech built a line per fragment
   and merged them in the renderer; remote speech built a line per message and
   mutated it in place. Same idea, two code paths, guaranteed divergence — and
   nothing in the design made them agree. I4 removes the possibility.
2. **Boundaries re-derived downstream.** Grouping remote speech by speaker and
   adjacency merged an entire kelabo into one growing bubble. I5 makes the
   speaker's decision the only one.

Both classes were invisible until a live kelabo, because the SPA had no tests.
Stages 2 and 5 are pure functions specifically so `spa/test/transcript.mjs` can
exercise them under plain node — including the I4 equivalence property directly:
the same event sequence, projected as a speaker and as a listener, must give an
identical transcript.

**Observability:** the Debug drawer's *Transcript ledger* lists every message by
`messageId`, with origin, state, seal reason and delta count. Two participants
comparing that panel see the same ids or they do not — divergence is visible
rather than inferred.

---

## 5. Where each stage lives

| Stage | Code |
|---|---|
| Capture | `spa/src/transcript/stt/<provider>.js` (`readResult`: wire format, pure — one reader per provider, e.g. `stt/deepgram.js` with its span cursor and diarization split), `spa/src/stt/<provider>.js` (transport: connections, billable stream edges; resolved by `spa/src/stt/interface.js`), `spa/src/capture/useCapture.js` (audio clock, composer binding), `capture/vad.js` (gate; `stats()` feeds the Debug readout used to tune `hangoverMs`) |
| Compose | `spa/src/transcript/composer.js` (`setTail`, `addFragment`, `seal`, `noteActivity`/`sealIfIdle`, `countWords`, caps) |
| Publish | `spa/src/transcript/publisher.js` (`kind: 'delta' \| 'sealed'`) |
| Distribute | `gateway/src/caption.js` (delta relay, duplicate suppression, persistence, agent dispatch) |
| Project | `spa/src/transcript/transcriptStore.js` (`apply`, `messages`, `messageText`/`mergeTail`, `messageParts`, `renameSpeaker`) |
| Render | `spa/src/capture/CapturePanel.jsx` |
| Wire types | `contracts/src/schemas.js` (`captionPostSchema`) |
| Agent transcript / gate / run | `gateway/src/agent/worker.js`, `gate.js`, `mainAgent.js`, `subAgent.js` |
| Rename propagation | `gateway/src/caption.js` (`handleCaptionRename`), `transcriptStore.renameSpeaker` |
| Archive / minutes | `gateway/src/archive.js`, `minutes.js` |
| Tests | `spa/test/transcript.mjs` (read + compose + project), `gateway/test/smoke.mjs` (distribute) |
