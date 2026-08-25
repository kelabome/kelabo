# 19 — Optional capabilities & graceful degradation

Every external provider Kelabo uses can be absent: no STT key, an expired
Cloudflare token, no LLM configured, a tier that opted a room out of the
assistant. None of that is an error. It is a *smaller kelabo*, and the product
must shrink to fit it rather than jam.

This doc names the pattern so new code lands inside it instead of rediscovering
it one incident at a time.

## 1. The floor and the ladder

Capabilities are ordered. Each rung depends only on the rungs below it, and the
bottom rung is the product's floor — the thing that must work when everything
optional is gone:

| Rung | Capability | Needs | When it is absent |
|------|-----------|-------|-------------------|
| 0 | join + presence + typed messages | gateway only | (never — this is the floor) |
| 1 | P2P call (mesh) | rung 0 | messages-only room |
| 2 | SFU conference, TURN | Cloudflare creds | fall back to mesh (capped) |
| 3 | live transcription | an STT provider key (`kelabo/<env>/stt`, docs 06) | typed messages only |
| 4 | assistant / board | LLM key or dev agent | no board tab, no @kelabo |
| 5 | minutes, records, history | archive + rung 3 | no record after the kelabo |

**The rule that keeps the ladder honest: no capability may own state that a
lower rung needs.** A rung can *consume* what is below it; it must never be a
gatekeeper for it.

The incident that named this rule: `muted` — the flag that gates the outgoing
*call* track (rung 1) — lived in the STT hook (rung 3) and was only cleared
inside the STT socket's `onopen` (Deepgram, then hard-wired). "Unmute" therefore
*meant* "successfully connect to Deepgram", and on any deployment where STT was absent or broken
the mic could never be unmuted while the UI complained about transcription.
Two visible bugs, one inverted dependency.

## 2. Absence is a status with a reason, not an exception

A capability is in one of three states, and every state is renderable:

- **on** — configured, healthy.
- **off** — not configured, or policy says no (`reason: not_configured |
  policy | quota`). Known *before* anything is attempted; the UI simply does
  not offer the affordance (no Transcript tab, no board, no captions toggle).
- **degraded** — was on, is currently failing (`reason: token_expired |
  unreachable | reconnecting`). Announced as a chip or toast on the capability
  itself ("Transcription unavailable — board still works"), while every other
  rung continues untouched.

**The rendering rule follows from the state, mechanically:**

| State | What the UI shows |
|-------|-------------------|
| on | the capability's UI, working |
| off | **nothing.** No tab, no button, no greyed-out control, no empty panel, no "coming soon". A capability that is not meant to run leaves no trace it could have existed — a disabled control is a promise the deployment cannot keep, and an error about a service nobody configured is a bug report about nothing. |
| degraded | the capability's UI stays where it is, wearing a **status indicator** — a chip, a toast, a reconnecting badge — on the capability itself. It was offered, so it must not vanish (a tab that disappears mid-kelabo reads as data loss); it must say what is wrong and what still works. |

The distinction is *knowledge*: `off` is known before anything is attempted, so
there is nothing to report and nothing to render; `degraded` is a broken
promise, so it must be visible where the promise was made — and nowhere else.
The frozen-mic incident violated both halves at once: a guest room (STT `off`)
surfaced *degraded*-style complaints about a service that was never meant to
run, from a retry loop that should never have started.

The existing conformers, which new code should imitate:

- Gateway without Cloudflare creds answers `/rtc/*` with `rtc_unavailable` and
  the kelabo runs as transcript + board (Makefile notes, docs 15).
- `transcriptAccess` on `/caption/history`: the server states the policy, the
  SPA withholds the Transcript tab entirely — not a disabled tab (docs 09 §10).
- A guest kelabo has no assistant, so it has no Board tab and no `@kelabo`
  placeholder hint — `off` rendered as absence.
- The STT socket exhausting reconnects demotes itself to `stt_unavailable`
  with a toast — captions stop, the room does not. `degraded` rendered as a
  status on the thing that broke.

## 3. The server computes it, the client renders it

The client must never *infer* a capability from a sibling component's failure —
that is how a Deepgram error became a frozen mic. The decision has three
inputs, and all three live server-side:

1. **Deployment config** — is the secret present, is the feature compiled in
   (`rtcMode`, `mcpEnabled`, …).
2. **Policy** — what this tier/room/participant is allowed
   (`guestTranscriptAccess`, guest rooms with no assistant, quotas).
3. **Runtime health** — the token mint failed, the provider is down.

The kelabo META response carries this as `capabilities`, a map of
`{ name: { on, … } }` computed by the REST API (`rest-api/src/kelabos.js`) —
`stt` carries `{ on, provider }` (which STT provider will transcribe, so the
client can pick its defaults before minting anything), `rtc` carries `mode`:
`stt`, `assistant` and `rtc` from provider-secret **existence** (DescribeSecret
only — the API can state that the LLM key exists without being able to read
it; `rest-api/src/secrets.js secretExists`), `video` from deployment config.
Anything short of a definitive "the secret does not exist" answers `on` — a
probe hiccup must never switch a working feature off. New capabilities join
this map rather than inventing parallel booleans; `transcriptAccess` (a
per-participant *policy*, not a deployment capability) stays on
`/caption/history` beside the data it governs.

## 4. Public repo = mechanism, private repo = policy

The public repo builds the ladder, the statuses and the fallbacks, with
**permissive defaults** (self-hosting a full deployment needs no tuning). The
private repo changes *configuration only*: flip a default
(`guestTranscriptAccess: false`), set quotas (`guestRooms.*`), mark a tier's
rooms as `assistant: off`. If a hosted-tier behaviour needs a UI fork or a new
code path rather than a config value, the mechanism is missing here — add it
here first, then configure it there. (Precedent: the Messages/Transcript tab
split, built here, consumed there as one config default.)

## 5. Checklist for touching a provider integration

- Does anything a lower rung needs live in your module? Move it down.
- On failure, do you demote *yourself* with a reason, and nothing else?
- Is "not configured" handled before the first network attempt, not as a
  retry loop that eventually gives up?
- Does the UI affordance come from a server-stated status rather than from
  observing your errors?
- When you are `off`, does every trace of your UI disappear — and when you are
  `degraded`, does your UI stay put with a status indicator on it?
- Can the private repo get its behaviour from your config knob alone?
