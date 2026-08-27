# Component: Speech-to-text — the STT provider boundary

Live speech-to-text with real-time speaker diarization, behind a **provider
boundary**: two providers are built in — **Deepgram** and **Soniox** — and a
deployment picks one with a single config value (`stt.provider`). Key property,
whichever provider: **audio goes browser → provider directly**; it never
touches Kelabo infra (cost + serverless + privacy). Kelabo only mints a
short-lived credential and receives finalized transcripts.

---

## 1. Split of responsibilities

| Piece | Where | Responsibility |
|-------|-------|----------------|
| Mint core | REST API Lambda `POST /kelabos/:id/stt-token` (`rest-api/src/stt/index.js`) | everything provider-neutral: kelabo lookup, participant check, reading the `stt` credential, mapping every failure to `stt_unavailable`. Names no provider |
| Mint provider | `rest-api/src/stt/<id>.js` | turn the long-lived API key into a credential a browser may hold, and say what that browser should send |
| Capture pipeline | SPA (`spa/src/capture/useCapture.js`) | owns the mic, the VAD gate, the composer and the clock. Names no provider |
| Transport provider | `spa/src/stt/<id>.js` | everything about talking to its service: how many connections, when a billable stream starts and stops, control frames |
| Wire reader | `spa/src/transcript/stt/<id>.js` | pure — the whole wire format, normalised to one `SttRead` shape; testable under plain node |
| STT provider | external | STT + diarization |

The server **never** proxies audio and **never** holds a browser-visible
long-lived key.

## 2. The boundary itself

A provider is **three files and two registry lines**, nothing else
(`spa/src/stt/interface.js`):

```
rest-api/src/stt/<id>.js         mint      — the credential, server side
spa/src/stt/<id>.js              transport — the SttClient interface, implemented
spa/src/transcript/stt/<id>.js   reader    — pure, the whole wire format
```

plus one line in each registry: `PROVIDERS` in
`rest-api/src/stt/interface.js` and `CLIENTS` in `spa/src/stt/interface.js`.
**An unknown id throws in both registries rather than defaulting** — a default
on the server would mint a credential for a service the browser is not talking
to; a default in the browser is the wrong parse path and the wrong control
frames, and that failure is silent everywhere (the socket opens, audio streams,
nothing is transcribed, no error is raised at any level).

The browser interface is **stream-shaped, not socket-shaped**: the caller hands
over audio (`sendAudio`) and speech edges (`setSpeaking`), and what that means
on the wire is the provider's business. It began as
`open()/canSend()/keepalive()/close()` — one socket, held by the caller — and
that could not express what Soniox needs (§4.2). A mint provider is likewise
handed everything (`{key, settings, opts, fetchImpl}`) and reaches for nothing:
no DynamoDB, no Secrets Manager, no `process.env` — which is what makes each
one testable offline and keeps adding one from touching the others.

The kelabo GET reports `capabilities.stt = { on, provider }`
(`rest-api/src/kelabos.js`), so the client knows which provider — and which
defaults, like whether silence-skipping is worth it (`prefersVad`) — before it
ever mints.

## 3. Credential minting (server)

`POST /kelabos/:id/stt-token` (participant cookie required, kelabo active):

- The long-lived keys live in **one credentials-table row per environment**,
  the `stt` slot (`PK = CRED#stt`, docs 08 §6c), holding **one key per
  provider** — `{ "deepgram": "…", "soniox": "…" }` — so switching provider
  (or rolling back) is a config change, never a scramble to re-enter a
  credential. The lookup is by exact provider id (`sttKeyFrom` in
  `contracts/src/credentials.js`): there is no `|| apiKey || key || value`
  fallback chain, because that made a key stored under a misspelling
  indistinguishable from a correct one.
- The core mints via the configured provider and returns an `SttSession`:
  ```json
  { "provider": "deepgram",
    "url": "wss://…",
    "token": "<short-lived>",
    "expiresInSeconds": 60,
    "params": { "…provider-shaped…": "…" } }
  ```
  `provider` is stamped by the core from the registry key, so a provider
  cannot claim to be a different one than was asked for.
- Per-provider mint:
  - **Deepgram** (`rest-api/src/stt/deepgram.js`): a temporary token via
    `POST https://api.deepgram.com/v1/auth/grant`, TTL 60s — one grant per
    socket; the browser fetches a fresh one per (re)connect. **The API key
    must have the Member role, not owner/admin** — `/v1/auth/grant` rejects
    owner/admin-scoped keys, and the symptom is `stt_unavailable` later, not
    a deploy-time error.
  - **Soniox** (`rest-api/src/stt/soniox.js`): a temporary API key via
    `POST https://api.soniox.com/v1/auth/temporary-api-key`, TTL 600s,
    deliberately `single_use: false` (one connection = one stream, and the
    gated client opens a stream per utterance), `max_session_duration_seconds`
    from config, and `client_reference_id = kelaboId` for per-kelabo cost
    attribution. The transport renews between utterances via the injected
    `renew()`, never on the critical path of an utterance.
- Per-provider tuning (model, TTLs, Soniox endpointing) lives in
  `config.stt.providers.<id>` and is opaque to the core — a provider is handed
  its own block and only its own.

> The env path mirrors config exactly: `KELABO_STT_PROVIDER`,
> `KELABO_STT_LANGUAGE`, `KELABO_STT_PROVIDERS`
> (`infra/lib/lambda-stack.js`). No secret name travels with them — the key is
> the `stt` credential slot, reached through `KELABO_TABLE_CREDENTIALS`.

## 4. Capture client (browser)

`useCapture` (`spa/src/capture/useCapture.js`) captures the mic
(`getUserMedia` → `AudioContext` → Int16 PCM frames), runs the VAD gate (§5),
fetches the `SttSession`, resolves the transport with
`sttClient(session.provider)` and from then on branches on nothing
provider-shaped: audio frames go in, normalised `SttRead`s come out, sealed
messages leave for the Gateway (doc 13).

### 4.1 Deepgram transport (`spa/src/stt/deepgram.js`)

**One socket for the whole capture session.** Deepgram bills the **audio it
receives**, so an open socket with nothing flowing is free — the simple shape
is also the cheap one. Configuration rides the URL; auth is the WebSocket
subprotocol pair `['bearer', token]` (how a browser sends a bearer credential
on a handshake it cannot put headers on). During gated silence the client
sends `KeepAlive` every ~4s (Deepgram idle-closes at 10s); on gate close it
sends `Finalize` to flush the buffer; mute closes the socket entirely.
Reconnects (up to 3) fetch a fresh token first.

### 4.2 Soniox transport (`spa/src/stt/soniox.js`)

**Soniox bills the wall-clock lifetime of a stream**, not the audio it
receives — and the clock starts at the start request, not at connection setup.
A socket held open for a whole kelabo would bill the whole kelabo per
participant, speech or silence. So, in gated mode, the client keeps a **pool
of 2 pre-opened, unbilled connections**: speech onset takes the oldest, sends
the start request (billing starts), flushes pre-roll, and refills the pool
immediately; ~3s of silence ends the stream (billing stops) and retires the
socket to drain its trailing finals. The connection handshake is paid during
silence, off the critical path. When the caller is not gating — or when
diarization is on, because **Soniox numbers speakers per stream** and
per-utterance streams would make "1" a different person every time — it runs
one **continuous** stream instead. Every decision that costs money is in
`spa/src/stt/sonioxPolicy.js`, pure and tested (`spa/test/soniox.mjs`).

## 5. VAD gate (`spa/src/capture/vad.js`)

With one mic per participant each client is silent for most of a kelabo. The
capture pipeline runs an energy gate with an adaptive noise floor and hands
the transport only speech (plus pre-roll):

| Knob | Default | Why |
|---|---|---|
| `prerollMs` | 400 | frames before the gate opened are ring-buffered and sent first, so the triggering word isn't clipped |
| `hangoverMs` | 900 | must exceed the provider's endpointing window or it never sees a pause |
| `openDb` / `closeDb` | +10 / +6 over floor | hysteresis, so a soft syllable doesn't chatter the gate |
| `minSpeechDb` | −55 | absolute floor: a very quiet room must not open the gate on fan noise |

False triggers cost preroll+hangover (~1.3s) of billed audio/stream time,
which is the deliberate bias — clipping a word is worse than paying for a blip.

**What the gate is worth differs by provider**, which is why `prefersVad` is
part of the client interface: on Deepgram (billed per audio) it is a direct
saving; on Soniox (billed per stream lifetime) it is *the* cost control,
because it is what creates the speech edges streams start and stop on. A
participant's own choice (**Skip silence**, mic chevron menu, `kelabo-vad`)
always wins; `prefersVad` only decides the default.

**Timestamps:** provider word times count *streamed* audio on the provider's
own clock, so skipped silence would pull every later utterance earlier.
`useCapture` records `{audio, wall}` per burst and maps provider milliseconds
back to wall clock before stamping `tStart`/`tEnd`. `onStreamStart` tells it a
new stream began, so the clock mapping and speaker labels reset — the open
composer message deliberately survives a stream boundary.

## 6. Reader and utterance production

Each provider's reader (`spa/src/transcript/stt/<id>.js`) is pure and
normalises every wire message to one `SttRead` shape:
`{finals, tails, active, endpoint, error, finished}` — confirmed segments feed
`composer.addFragment`, unconfirmed ones `composer.setTail`, and `active`
drives the seal clock. Segment times are **milliseconds, always**, whatever
the provider sends. From there the transcript lifecycle (doc 13) owns
everything: the composer seals messages, only sealed messages are POSTed to
the Gateway `/caption`, fanned out, persisted and offered to the agent.

## 7. Diarization

- `speaker` on a segment is an **opaque, provider-scoped id**, not an index —
  Deepgram counts from 0, Soniox from "1"; mapping ids to the `A/B/C` labels
  the room shows happens once, for every provider, in
  `spa/src/transcript/speakerLabels.js`. The empty string means "this stream's
  own speaker."
- Capabilities differ and the client declares them: Deepgram's diarization is
  `optional` (a separate, costed model — asked for, not assumed); Soniox's is
  `always` (bundled, no extra cost).
- Streaming diarization is **provisional** everywhere: early labels can shift
  as the model accumulates voice context. Only finals are trusted.
- Per-user capture (one mic per person) doesn't need diarization — `speaker`
  is the participant identity, stamped by the Gateway. Room capture (one mic,
  many voices) is where the labels matter; labels are kelabo-local, not
  identities.

## 8. Failure handling

| Failure | Behavior |
|---------|----------|
| mint fails (any reason) | the core maps it to `stt_unavailable`; SPA shows it and retries with backoff |
| provider socket closes | reconnect with a fresh credential (Deepgram: up to 3; Soniox: pool refill); show `reconnecting` |
| mic denied | `mic_denied` banner; user can still watch the board |
| insecure context | app-wide banner (must use https/localhost) |
| wrong Deepgram key scope | `stt_unavailable` with a `deepgram grant 4xx` line in the REST API log — see the self-hosting guide §C2 |

## 9. Cost controls

- The **VAD gate** (§5) is the primary control on both providers, for
  different reasons: audio-billed (Deepgram) vs stream-billed (Soniox).
- **Mute** closes the Deepgram socket / ends the Soniox stream entirely.
- **Mute when tab is hidden** (`kelabo-mute-hidden`, opt-in) does the same on
  every tab switch and unmutes on return — but only ever undoes its own mute
  (`spa/src/capture/useHiddenMute.js`).
- Only finalized utterances leave the browser — no server audio cost at all.
- Credentials are short-lived and usage is attributable per participant/kelabo
  (Soniox: `client_reference_id`; Deepgram: one grant per socket).

## 10. Interfaces summary

| Peer | Direction | Transport | Contract |
|------|-----------|-----------|----------|
| REST API | in | HTTPS `POST /kelabos/:id/stt-token` | `SttSession` (§3) |
| STT provider | out | WSS direct | provider wire format, confined to `spa/src/transcript/stt/<id>.js` |
| Gateway | out | HTTPS `POST /caption` (finals only) | `Utterance` (doc 10) |

## 11. Adding a provider

Three files (§2), one line in each registry, a `config.stt.providers.<id>`
block, a field for it in `CREDENTIAL_FIELDS.stt`
(`contracts/src/credentials.js` — the field list is closed, so an undeclared
name is refused), and its key written into the `stt` credential slot.
The conformance suite iterates the registry (`sttClientIds()`), so a new
provider is exercised by the existing tests; nothing downstream of the
`SttRead` / `Utterance` contracts changes. A self-hoster could swap in local
Whisper/`diart` behind the same seam.
