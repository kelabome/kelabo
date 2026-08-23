# 15 — Conference audio (Cloudflare Realtime)

**Component:** the live call. **Runtime:** browser WebRTC + Cloudflare Realtime,
signalled by the Gateway ECS task. Read [03-gateway.md](./03-gateway.md) and
[06-deepgram.md](./06-deepgram.md) first — this doc sits between them.

Kelabo hosts the kelabo's audio. Before this, participants were assumed to be in
one room or on somebody else's call, and Kelabo only listened; now the call is
ours, and the transcript comes from the same microphone that feeds it.

**Camera video is built** and rides exactly the seams this doc always described
— a second track through the same `setLocalTrack` on both transports, a second
entry in the open `Peer.tracks` map, and no wire-format change. Screen share is
the one still open; see [§8](#8-video-and-screen-share).

---

## 1. Two transports, one interface

A kelabo's transport is chosen by the host at creation, stored on the kelabo
META as `rtcMode`, and **fixed for the life of the kelabo**. Changing it midway
would revoke the guarantee participants joined under.

The one exception is a **demotion**, `sfu` → `mesh`, and only ever in that
direction: see [§1.1](#11-demotion-sfu--mesh-mid-call).

| | `sfu` (default) | `mesh` ("secure kelabo") |
|---|---|---|
| Media path | browser → Cloudflare Realtime SFU → browsers | browser ↔ browser, direct |
| Who can decrypt media | Cloudflare (an SFU terminates DTLS-SRTP) | **only the participants** |
| Uplink per participant | 1 stream | N−1 streams |
| Practical size | large | `rtc.meshMaxParticipants` (default 6) |
| Cloudflare's role | media relay + STUN/TURN | STUN/TURN only |
| Kelabo's role | signalling relay | signalling relay |

In **neither** mode does audio touch Kelabo's own infrastructure. The Gateway
relays SDP and ICE and never sees a media packet.

**The mesh cap is a refusal, not a downgrade.** A joiner beyond
`meshMaxParticipants` gets `409 mesh_room_full` and stays on the board and
transcript. Spilling the room over to the SFU would silently break the
peer-to-peer promise, so it is not done. Rejoining a seat you already hold does
not count against the cap.

**TURN does not weaken mesh.** When direct connectivity fails, Cloudflare TURN
relays the DTLS-SRTP packets — it cannot decrypt them, so a relayed mesh call is
still end-to-end confidential between participants.

### 1.1 Demotion: `sfu` → `mesh`, mid-call

`rtcRoom.demote(kelaboId, { reason })` moves a live call off the SFU. It is the
only thing that changes `rtcMode` after creation, and it is one-way.

That does not contradict the rule above, because the rule is about *drift*: a
participant must never be moved onto a transport with a **weaker** promise than
the one they joined under. Mesh is the stronger promise — nobody but the
participants can decrypt the media — so arriving at it is not a revocation.
Promotion, `mesh` → `sfu`, is exactly the revocation the rule forbids and has no
implementation.

It is offered because the alternative to demoting is usually not "keep the SFU",
it is "no call": the SFU is unreachable, or the operator has stopped paying to
route this room. What it does:

1. **Refuses if the room does not fit.** Mesh is not a cheaper SFU — every
   participant sends their uplink to every other one. If `meshUnits` (people
   plus live screen shares) exceeds `meshMaxParticipants`, `demote` answers
   `{ ok: false, code: 'mesh_too_small' }` and changes nothing. Ending a call
   cleanly beats handing back a room nobody can hear.
2. Sets the in-process room's mode, then writes `rtcMode: 'mesh'` to META —
   without the write, the next task restart reads `sfu` back and undoes it.
3. Clears every peer's `sfuSessionId` and `tracks`. The sessions are abandoned;
   a roster that still names them makes every peer pull tracks that no longer
   exist.
4. Fans `rtc { kind: 'mode', mode: 'mesh', reason }`.
5. Retracts the abandoned Cloudflare tracks, detached and best-effort. Not
   awaited: the room has already been told, and the SFU expires idle sessions
   by itself.

Clients rebuild rather than adapt (`useRtc`, on `kind: 'mode'`): a transport
object cannot become a different kind of transport, so the call is torn down and
rejoined. The rejoin re-reads the mode and **re-mints ICE**, which is how a
withdrawn relay actually stops being used. The seat is kept across the rebuild,
so the room sees no leave/join churn and the mesh cap is not re-tested against a
room that has just been measured.

**`mesh` is a media guarantee only.** Deepgram transcription, the shared board,
the agent and persistence behave identically in both modes. A secure kelabo is
not an off-the-record kelabo.

---

## 2. The invariant: one microphone, two consumers

Each participant transcribes **only their own microphone**. The conference
carries playback audio; it is never a transcription source.

That preserves three things at once: exact speaker attribution (no diarization
needed for remote peers, because every caption is posted by the person who said
it), the per-participant Deepgram billing model, and the property that Kelabo
never handles audio.

It also imposes a rule. `spa/src/rtc/useMicStream.js` is the **single owner** of
`getUserMedia`; `useCapture` and `useRtc` both consume its `MediaStream`.
Acquiring the device twice gives two independent captures, which browsers then
apply echo cancellation to in isolation — degrading both — and shows the
recording indicator twice.

For the same reason the room no longer offers a **Raw mic** mode. Raw mode
disabled echo cancellation so speaker output got transcribed too; on a Kelabo
call that means every remote voice returns through your microphone and is posted
as a caption attributed to *you*. It was therefore locked off for the entire
duration of every call — a control whose only reachable state was "unavailable",
which is worse than no control at all. `useMicStream` still accepts
`rawAudio` for a caller that is genuinely not on a call; nothing passes it.

---

## 3. Signalling rides the existing SSE stream

No new connection. Down-signalling is a new `rtc` event on the kelabo's
`/caption/replies` stream; up-signalling is `POST /rtc/*` on the Gateway, authed
by the same participant cookie as `/caption`.

`spa/src/board/BoardPanel.jsx` owns the kelabo's single `EventSource` and hands
`rtc` events to `useRtc` through an `onRtc` callback, the same pattern already
used for `rename`, `utterance` and `debug`.

An SSE subscriber is `{ res, participantId }` rather than a bare response
(`gateway/src/sseHub.js`). That buys two things: mesh signalling can be delivered
to exactly one peer, and **a closed stream is how the Gateway learns someone
left** — `/rtc/leave` only fires on a clean exit, never on a shut laptop.

### `rtc` event payloads

| `kind` | Sent to | Payload |
|---|---|---|
| `peer_joined` | room | `{ peer }` |
| `tracks` | room | `{ peer }` — peer's published tracks changed |
| `media` | room | `{ peer }` — peer's mic, camera or screen share was switched on or off |
| `peer_away` | room | `{ participantId }` — peer's last SSE stream closed; seat held for the grace window |
| `peer_back` | room | `{ participantId }` — the peer resubscribed inside the window |
| `peer_left` | room | `{ participantId, reason }` (`left` \| `disconnected`) |
| `signal` | **one peer** | `{ from, to, signal }` — mesh offer/answer/ICE/bye |

A peer is `{ participantId, displayName, isGuest, sfuSessionId?, tracks, media, joinedAt }`,
where `tracks` maps media kind → published track name (`{ audio: "mic" }` for an
audio-only participant) and `media` is `{ audio, video, screen }`.

The stream also carries a named `ping` event every 25s (as well as the SSE
comment that keeps proxies from idling the socket). The comment is invisible to
the EventSource API; the named event is what lets `useBoard`'s watchdog tell a
quiet room from a half-open socket — a minute of total silence closes and
resubscribes the stream, which no `onerror` would ever report.

---

## 4. Gateway HTTP surface

All participant-cookie authed and CORS'd like `/caption`. `kelaboId` in the body
is only ever *checked against* the cookie, never trusted as the source.

| Method | Path | Purpose |
|---|---|---|
| POST | `/rtc/join` | → `{ mode, self, peers[], iceServers, ttlSeconds, meshMax, video }`. Enforces the mesh cap (in units — see §8). Refuses with `503 rtc_mode_unavailable` if the META cannot be read and the room is not cached: guessing would silently downgrade a mesh kelabo to the SFU. |
| POST | `/rtc/leave` | Drops the peer, fans out `peer_left` *first*, then best-effort closes its SFU tracks. Also sent as a `pagehide` beacon so a killed tab does not ghost the roster. |
| POST | `/rtc/ice` | Re-mint TURN credentials mid-call (they expire). The client calls it at 80% of `ttlSeconds` and applies the result with `setConfiguration` (`recovery.js` decides when). |
| POST | `/rtc/media` | Report own mic/camera/screen on-off state; fans `media` to the room. `screen: true` in a mesh room is an **admission request** — a full room answers `409 mesh_room_full` and the client must not publish. A `409 peer_not_found` from any media report tells an evicted tab it is a ghost; the client rejoins. |
| POST | `/rtc/roster` | Authoritative membership snapshot. Fetched by every third reconcile tick so membership converges even when an SSE event was missed; a client absent from its own snapshot rejoins. |
| POST | `/rtc/signal` | Mesh only. Relays to exactly one peer. |
| POST | `/rtc/sfu/session` | Creates the caller's Cloudflare session and binds it to their peer record. |
| POST | `/rtc/sfu/tracks` | Publish (`local`) or pull (`remote`). |
| PUT | `/rtc/sfu/renegotiate` | Answer an SFU-initiated offer. |
| PUT | `/rtc/sfu/tracks/close` | Stop receiving tracks. |

### Ownership rules — the security core of the SFU proxy

Cloudflare's docs warn that leaked session/track ids let an attacker disrupt
service unless the backend authenticates request origins. So:

1. **The caller's `sessionId` is resolved from their own peer record**, never read
   from the request body. A client cannot express "operate on someone else's
   session" — the schemas have no such field, and the route would ignore it.
2. **A `location:"remote"` pull must resolve to a peer of the same kelabo**,
   else `403`. This is what stops a session id from any other kelabo being
   subscribed to.

   The pull names the **publisher**, and the Gateway resolves their current
   session from the roster. A client can only know the session id it was last
   told about, and that goes stale the moment the publisher rebuilds theirs —
   two participants reloading a few seconds apart is enough, and it surfaced as
   a `403` in the console on an otherwise clean reconnect. Resolving it here
   also removes the client's ability to name a raw session at all, which is the
   same principle as rule 1 applied to the other end of the pull. A body-supplied
   `sessionId` is still accepted and still checked against the roster, so a
   browser on an older bundle keeps working across a deploy.
3. `location:"local"` tracks are recorded on the caller's peer and announced, so
   peers learn what to pull.

All four Cloudflare credentials live in one Secrets Manager entry read only by
the Gateway task role. The browser sees SDP and short-lived ICE credentials,
never an app id or secret.

---

## 5. State

A peer's `tracks` are cleared when `bindSfuSession` binds a *different* session
id. They were published on the old one and exist nowhere now; the roster only
ever added before, so a participant who rebuilt their session kept advertising
tracks nobody could pull, and every other participant asked for them once per
reconcile tick for the rest of the kelabo.

Presence is **in-process and unpersisted**, like `sseSubscribers`:

```js
c.state.rtcRooms  // kelaboId -> { mode, peers: Map<participantId, Peer> }
```

A task restart rebuilds it as clients reconnect. The durable half is `rtcMode` on
the kelabo META, written once by the REST API at creation. This is another
reason `desiredCount` stays 1 (see ARCHITECTURE §15.5); any future kelabo-affinity
routing has to cover RTC connections along with SSE and captions.

---

## 6. SFU flow

One `RTCPeerConnection` and one Cloudflare session per participant, publishing
and pulling on the same connection. The SFU alternates who offers, so every
operation is serialized through a queue in `spa/src/rtc/sfuTransport.js` — two
overlapping negotiations on one PeerConnection collide in `have-local-offer`.

```
publish:  addTransceiver → createOffer → POST /rtc/sfu/tracks {local}
          → setRemoteDescription(answer)

pull:     POST /rtc/sfu/tracks {remote}  → response is an OFFER
          → setRemoteDescription → createAnswer → PUT /rtc/sfu/renegotiate
```

An arriving track is matched back to its publisher by the `mid` the SFU assigned
to the pull.

**The mid must be recorded before the SFU's offer is applied.** Applying it is
what fires `track`, so a mid stored afterwards means every arriving track finds
no subscription to belong to and is dropped on the floor. What that looks like
is the worst version of this bug: the pull succeeds, the renegotiation
completes, the SFU behaves perfectly and logs a clean exchange — and because
nothing sets `live`, the reconciler closes the subscription and pulls it again
ten seconds later, forever, mid climbing, both tiles on "connecting", no error
in either console. It cost three rounds of debugging the signalling before
anyone suspected the bookkeeping.

`track` events that arrive before their mid is recorded are now held in
`orphaned` and claimed when it is, so the ordering is no longer load-bearing —
the invariant above is documented because it is still the fast path, not because
correctness depends on it.

### The session negotiates when it is created

Two rules the API does not state in its status codes, both learned from a call
where nobody could hear or see anybody while every self-view worked perfectly:

1. **A session cannot subscribe to anything until its own PeerConnection is
   up.** `tracks/new` answers `410 session_error: "Session appears to be
   disconnected. Please check if the PeerConnection is connected."` — and the
   session never recovers; every later call on it answers the same.

   The first fix for this was to make a publish the first operation on every
   session, ordering the SPA's effects so the reconciler's first tick ran
   second. **That guarantee was unenforceable**, and a later kelabo proved it:
   effect order says nothing about when `getUserMedia` resolves. Reloading into
   a kelabo already in progress, the publish effects run with no microphone yet
   and publish nothing, the reconcile tick fires against a roster that is
   already full of tracks, and the first call on the newborn session is a pull.
   The session was dead four seconds after it was created, both participants
   spent the kelabo retrying against it, and the only thing that still worked
   was the transcript. A participant who declines the microphone had the same
   failure with no race needed.

   So the session now brings its own connection up: `ensureSession` offers at
   `/sessions/new`, which Cloudflare answers in the same round trip, and waits
   for `connected` before releasing the queue. Ordering stops being load-bearing
   — nothing has to happen first, because the session is connected from birth.
   The recvonly transceiver in that offer exists only to give it a media
   section; an SDP with no m-line is not a valid offer.

   **A session that dies anyway is replaced, not retried.** `cfCode` is
   forwarded from Cloudflare to the SPA (both a live session and a dead one
   answer `502` otherwise), `isFatal` in `spa/src/rtc/retry.js` names the one
   code that means "gone", and `useRtc` rebuilds the call around a new session —
   backed off, capped at three attempts, and surfaced as an error rather than a
   permanently silent room once they are spent. The rebuild deliberately skips
   `/rtc/leave`: it and the rejoin are independent requests, and the leave
   losing that race deletes the seat the rejoin just took.

2. **A 200 is not a success.** A rejected track is reported inside the body,
   per track: `200 { tracks: [{ mid: "", errorCode: "not_found_track_error",
   errorDescription: "Track not found on remote peer. Make sure the publisher
   peer is connected and sending packets for this track" }] }`. Pulling a peer
   who joined a second ago hits this routinely. Both the transport and
   `/rtc/sfu/tracks` now read `errorCode`: the transport treats it as a failed
   pull for the reconciler to retry and never records the empty mid, and the
   Gateway does not put a refused track on the roster — announcing it had every
   other participant spend the kelabo subscribing to something that was never
   published.

   The empty mid was its own quiet disaster. Stored as if it were real, it made
   the reconciler ask the SFU to close a track named by an empty string, which
   is `406 invalid_params: "tracks[0]: Missing mid in track"`, once per peer per
   tick, for the length of the kelabo.

**A failed publish is retried, not just a failed pull.** The reconciler compares
what the transport was *asked* to send against what it actually has a sender
for. Nothing else would ever notice: a publish that failed is invisible to the
person it happened to, because their own camera preview is local and keeps
working — it is everyone else who gets a tile with a name in it and nothing
else.

**`desired` is the truth, even mid-flight.** A camera toggled off — or a device
switched — while its *first* publish was still in flight used to be lost: the
new value landed in `desired`, hit the in-progress guard, and nothing ever
re-read it, so the sender kept the track captured at call time (sometimes an
ended one) until the next manual toggle. The publish now re-reads `desired` on
completion and swaps the sender, and the reconciler repairs any sender whose
`track` disagrees with `desired` on every tick.

### Mid-call connection failure: restart, then rebuild

`connectionState`/`iceConnectionState` reaching `failed` after the session is up
— a network change, a VPN toggle, a mobile OS killing the connection in
background — runs a recovery ladder (`recoverConnection`): fresh TURN
credentials (best-effort re-mint), a real ICE restart (`createOffer({
iceRestart: true })` through the serialized queue, posted to
`/rtc/sfu/renegotiate`, the SFU's answer applied), and, if `connected` is not
reached within 10s or the SFU refuses the restart offer, escalation to the
fatal whole-session rebuild. The previous code called `pc.restartIce()` here
and nothing else — which only *flags* that the next offer should restart ICE,
and with no code path making that offer the call stayed dead until a manual
reload.

### SDP gathering waits for the relay when one is expected

The SFU API has no trickle channel, so an offer carries every candidate it will
ever have. When the configured ICE servers include TURN (`hasTurnServers` in
`recovery.js`), the gather wait stretches past the 3s soft cap — up to a hard
8s — until at least one relay candidate is in. Cutting it off at 3s shipped
host/srflx-only offers on exactly the networks where TURN allocation is slow
because it is needed.

---

## 7. Mesh flow

One `RTCPeerConnection` per remote participant
(`spa/src/rtc/meshTransport.js`). Both sides call `connectTo` for each other;
simultaneous offers (glare) are resolved by the standard **perfect-negotiation**
pattern — the peer with the lexicographically greater `participantId` is
*polite* and rolls back its own offer when it collides with an incoming one. ICE
candidates arriving before their description are buffered.

`setLocalTrack(kind, track)` adds to every current and future peer connection,
and `negotiationneeded` is what actually dials. A participant without a
microphone adds nothing and waits to be dialled.

---

## 8. Video and screen share

**Camera video is live.** It reuses every seam without widening one:

- **One call publishes both kinds.** `setLocalTrack(kind, track|null)` is the
  only publishing entry point on both transports. Audio is set once and left;
  video is set and cleared as the camera is toggled.
- **A toggle never renegotiates.** The first camera-on negotiates a transceiver;
  every toggle after that is `sender.replaceTrack(...)` on it. Adding and
  removing the transceiver instead would mean, in mesh, a full offer/answer with
  every participant on every click, and in SFU a roster change that makes every
  peer re-pull.
- **"Camera off" needed a message after all.** Clearing the track stops the RTP
  flow, and the plan was to let the receiving side's `mute` event carry it —
  no camera-state field anywhere, so nothing could disagree with the picture.
  Through an SFU that does not work: the relay keeps the subscription open and
  simply forwards nothing, which the receiver cannot tell from a network that
  went quiet. `mute` does not fire, and the tile held the last decoded frame —
  a switched-off camera stayed a frozen photograph of its owner for the rest of
  the kelabo.

  So `Peer.media` (`{ audio, video, screen }`) carries the switch states, reported on
    `POST /rtc/media` and fanned as the `media` event. `useVideoLive` still reads
  the track, because it is the faster signal when it does fire, but the owner's
  report is what settles it — only they can distinguish "switched off" from "a
  bad second of network". Both default to `true`, which reproduces exactly the
  old track-only behaviour for a peer who never reports.

  **Muting needed it for a stronger reason: there is no media signal at all.**
  `track.enabled = false` is a local decision the browser never puts on the
  wire, so a muted participant was indistinguishable from a quiet one and the
  mic badge could only ever be drawn on your own tile.
- **Two captures, not one.** `useMicStream` holds the microphone for the whole
  kelabo because the transcript depends on it; `useCameraStream` acquires and
  **stops** the camera on each toggle, so the device light actually goes out.
  Folding them together would mean either never releasing the camera or dropping
  the mic on every video toggle.
- **`config.rtc.video`** defaults to `true` and still reaches the SPA on the
  `/rtc/join` response. A deployment that sets it `false` hides the control *and*
  makes `useRtc` publish `null` regardless — the policy is enforced at the
  transport, not only in the UI.

  Deploying that flag is the one trap here. On ECS the gateway does not read
  `config/` at all — `loadGatewayConfig()` takes the `fromEnv()` branch whenever
  `KELABO_TABLE_KELABOS` is set — so the value arrives as `KELABO_RTC_VIDEO` in
  the **task definition**, written by `infra/lib/gateway-ecs-stack.js`. Rebuilding
  the image and running `make restart` re-pulls `:latest` against the *same*
  task-definition revision and the old value survives. Use `make gateway` or
  `make deploy`. To check what a running task actually believes:

  ```
  aws ecs describe-task-definition --task-definition "$(aws ecs describe-services \
    --cluster kelabo-<env> --services kelabo-<env>-gateway \
    --query 'services[0].taskDefinition' --output text)" \
    --query "taskDefinition.containerDefinitions[0].environment[?name=='KELABO_RTC_VIDEO']"
  ```
- **Tiles are size-agnostic.** A `<video>` fills the same box the avatar sits in,
  at grid, rail or stage size, so video changed no layout code.
- **The speaker is selectable too** (`useSpeakerDevice` + `setSinkId` on the
  per-peer `Audio` elements). It was the one device the room decided silently —
  a laptop docked to a conference speaker played the call through its own lid.
  `''` means system default; the device id is a fact about the machine and is
  never synced (joinPrefs.js). Safari has no `setSinkId`, so the picker hides
  itself there.

**Screen share is built**, and it needed the one protocol addition this doc
predicted. The SFU could always tell a shared screen from a camera — it names
tracks (`cam` / `screen`) and the roster carries the name — but **mesh could
not**: there a screen arrives as `ev.track.kind === 'video'`, identical to a
camera, and the receiver has no way to decide which m-line deserves its own
tile. So `rtcSignalBodySchema`'s offer and answer variants gained an optional
`kinds` map of `mid -> "audio" | "video" | "screen"`, built from the sender's
own transceivers straight after `setLocalDescription` (before then, `mid` is
null) and applied by the receiver *before* `setRemoteDescription` — because
applying the description is what fires the `track` events the map exists to
explain. The Gateway relays it without reading it; it had to be added to the
schema only because zod strips unknown keys, so an unlisted field would never
have reached the peer.

Doing it for the SFU alone would have given the two transports visibly different
behaviour, which is exactly what §1's "one interface" exists to prevent.

Above the transports a share is one more `setLocalTrack('screen', track)`, and
on the receiving side it lands in its own per-participant stream rather than
joining the sharer's camera — a screen is a surface in the room, not a second
picture of the person. `useScreenShare` treats the browser's own "Stop sharing"
bar as authoritative: `ended` on the track is the source of truth and the app
follows it, never the reverse. Video only for now — `getDisplayMedia` can
capture system audio, but mixing tab audio into a call whose echo cancellation
is tuned against the speakers is a feedback loop, and worth doing deliberately
rather than as a side effect.

**The mesh cap counts units, and screen shares are units.**
`meshMaxParticipants` (default 5) caps a mesh room at *participants plus active
screen shares*: each participant is one unit and each share is one more,
because a share is one more video uplink to every peer — precisely the cost the
cap exists to bound. Enforcement lives in the pure `gateway/src/rtc/capacity.js`
and is applied at both admission points: `/rtc/join` for a seat, and the
`screen: true` transition on `/rtc/media` for a share (in mesh mode the Gateway
never sees the media or the SDP, so that report is the only possible gate — the
client asks *before* publishing and stops the capture on a `409
mesh_room_full`). Stopping a share, leaving, or being evicted frees the unit at
once; a rejoin onto a seat that already holds a share keeps both units and is
never refused. SFU rooms are not capped. The SPA disables the share button when
its local count says the room is full (advisory — the Gateway re-checks), and
the value remains config: raise it for a deployment whose uplinks can carry
more, or set it `<= 0` to uncap.

---

## 9. Config and secrets

```json
"rtc": { "provider": "cloudflare", "defaultMode": "sfu",
         "meshMaxParticipants": 5, "iceTtlSeconds": 3600,
         "disconnectGraceSeconds": 20, "video": true },
"secrets": { "cloudflareRealtime": "kelabo/<env>/cloudflare-realtime" }
```

`disconnectGraceSeconds` is how long a participant whose last SSE stream closed
keeps their seat (§10). The client holds its transport through a stream drop
for slightly *less* (15s, `STREAM_GRACE_MS` in `useRtc.js`) — the two windows
move together, and the client must always give up first, or it becomes a ghost
holding a session the server has already evicted.

`config/loadConfig.mjs` derives `rtcApiBase` (`https://rtc.live.cloudflare.com/v1`)
and defaults the whole `rtc` block, so a `kelabo.json` predating conference audio
still loads. Secret payload:

```json
{ "sfuAppId": "…", "sfuAppSecret": "…", "turnKeyId": "…", "turnKeyApiToken": "…" }
```

Set it with `make rtc-secrets env=dev CF_SFU_APP_ID=… CF_SFU_APP_SECRET=… CF_TURN_KEY_ID=… CF_TURN_KEY_TOKEN=…`,
then `make restart env=dev`. It is deliberately **not** part of `make secrets`:
without it the Gateway answers `/rtc/*` with `rtc_unavailable` and kelabos still
run with transcript and board, so an existing deployment does not break. Without
the TURN half, STUN alone is used and only relay-requiring peers fail to connect.

---

## 10. Failure behaviour

| Situation | Result |
|---|---|
| No Cloudflare secret | `rtc_unavailable`; board + transcript unaffected |
| META unreadable at join | `503 rtc_mode_unavailable`, retried by the client — never a guessed (downgraded) mode |
| `/rtc/join` fails transiently | Retried in-flight (`withRetry`); a still-failed join lands in `error`, which retries itself on a capped backoff and immediately on `online` / tab return. `error` always means "retrying", never "gave up" |
| Pull of a peer who is not sending yet | Reported inside a 200 as `not_found_track_error`; retried by the reconciler |
| Publish rejected or the session refuses it | Sender torn down, track stays in `desired`, reconciler republishes |
| Mesh room full (participants + shares) | `409 mesh_room_full`; joiner keeps board + transcript, a refused share stops its capture |
| Mic denied | Not on the call, banner shown; board + transcript unaffected. The peer's tile still reads `live` once connected — status counts any media, or the connection itself for a peer publishing nothing |
| Autoplay blocked | "Enable audio" button in the Call pane |
| SSE stream drops briefly | Nobody notices: the server holds the seat for `disconnectGraceSeconds` (fanning `peer_away`/`peer_back`), the client holds its transport for `STREAM_GRACE_MS` and reconciles on recovery |
| SSE stream stays gone | Past the windows: server evicts (`peer_left`, `disconnected`), client tears down and rejoins when the stream returns |
| Half-open SSE socket | `useBoard`'s watchdog notices a minute without events (the named `ping` makes silence observable) and resubscribes |
| Evicted while unaware (second tab left, slept through it) | Self-addressed `peer_left`, a `409` from `/rtc/media`, or absence from the roster snapshot each trigger a clean rejoin — a ghost tab heals in seconds instead of never |
| Mesh peer connection fails | ICE restart, then capped rebuilds (`recovery.js`); the budget refills on `connected` and with time. Every peer failing at once escalates to a whole-call rebuild via `onFatal` |
| SFU connection fails mid-call | Recovery ladder (§6): fresh TURN, real ICE restart via `/rtc/sfu/renegotiate`, then the fatal session rebuild if not `connected` within 10s |
| Call older than the TURN TTL | Credentials re-minted at 80% of TTL via `/rtc/ice` and applied with `setConfiguration`, so ICE restarts keep their relay |
| Tab killed / hard close | `pagehide` beacon posts `/rtc/leave`; the SSE close (and its grace window) remains the backstop |
| Cloudflare session dies (`session_error`) | Not retried — the call is rebuilt around a new session, backed off, three attempts, then `error` (which retries, see above) |
| Kelabo ends | `rtcRoom.closeKelabo` runs *before* `sseHub.ended`, so ending does not emit a per-peer `peer_left` storm |

---

## 11. Tests

`gateway/test/rtc.mjs` (in `npm test`), offline with a recording stub in place of
the Cloudflare client. It covers session binding, publish announcement, the
cross-kelabo pull rejection, that renegotiate/close ignore a body-supplied
session id, single-recipient mesh signalling, the mesh cap refusal (including
that the room stays `mesh`, and that screen shares occupy units at both
admission points), rejoining a full room (with a share held), the roster
snapshot, that `peer_left` is fanned before the Cloudflare cleanup, the
META-read failure refusing rather than guessing the mode, disconnect cleanup,
the disconnect grace window (`peer_away`, cancel-on-resubscribe, expiry), track
retraction when a peer rebinds to a new session, and auth.

`spa/test/rtc.mjs` covers the decisions that are pure enough to run in plain
node and costly enough to get wrong in a live kelabo: `missingPulls` (what the
reconciler re-pulls), `isRetryable` / `isFatal` (whether a failure is worth
another go, worth rebuilding the session for, or neither), and `recovery.js`
(per-peer rebuild budget, the whole-call escalation, ICE-credential refresh
timing, join-retry backoff). Everything else in the transports needs a real
`RTCPeerConnection`.
