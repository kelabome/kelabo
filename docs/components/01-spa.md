# Component: SPA (browser app)

**Runtime:** static assets on S3 served via CloudFront. **Stack:** Vite + React +
Tailwind, pure JS/JSX. **Trust:** untrusted client; holds no long-lived
secrets (the STT provider key never reaches it; only short-lived temp tokens and an
httpOnly session cookie set by the REST API).

---

## 1. Responsibilities

1. Authenticate the user **passwordlessly** — email OTP **or** social login
   (Google/Apple) — and keep the session alive via **silent refresh** (no re-auth
   every open).
2. Let registered users create/list kelabos and open records.
3. Let anyone join a kelabo from an invite link with a display name.
4. In a kelabo: capture microphone audio and stream it **directly to the STT
   provider** (Deepgram or Soniox — [06-stt.md](./06-stt.md)), render the
   diarized transcript, and render the shared board.
5. Post finalized utterances (captions) to the Gateway; **backfill prior board
   messages** via REST, then subscribe to the board SSE stream and render new
   Contributions.
6. Host controls: end kelabo, generate minutes, MCP override, copy invite link.
7. Raise OS notifications (Service Worker) for new board messages when unfocused.

**Explicitly NOT the SPA's job:** holding the STT provider key, deciding when the agent
speaks, running MCP, persisting transcripts (server does these). **No
opencode-in-browser surface** — there is no collaboration tab.

---

## 2. Outbound interfaces (who the SPA talks to)

| Target | Transport | Purpose | Auth |
|--------|-----------|---------|------|
| REST API | HTTPS (fetch, `credentials:include`) | auth (OTP+social), refresh, kelabos, join, **board backfill**, records, STT token | session/participant cookie |
| STT provider (Deepgram or Soniox) | WSS (direct) | stream mic audio, receive diarized transcript | short-lived credential (`SttSession` from REST API) |
| Gateway | HTTPS POST `/caption` | send finalized utterances | participant cookie |
| Gateway | SSE `GET /caption/replies?kelaboId=` (EventSource, `withCredentials`) | receive live board Contributions | participant cookie |
| Cloudflare Realtime SFU / peers | WebRTC (media) | conference audio/video | signalled over the existing SSE stream + `POST /rtc/*` (participant cookie) |

The SPA **never** opens a WebSocket to the Gateway. Audio = WSS to the STT provider only;
board = REST backfill + SSE tail. No opencode collaboration tab. Contract details in
[10-data-contracts.md](../10-data-contracts.md).

---

## 3. Screen / route map

```
/                    Gate → Home (if session) or Login
/login               OTP request + verify
/new                 Create kelabo (registered) → lobby
/join/:kelaboId     Guest/participant join (name-only if not logged in)
/m/:kelaboId/lobby  Waiting room — invite link + participant arrivals
/m/:kelaboId        Kelabo room (tiles + assistant)  ← core screen
/schedule            Schedule a kelabo + invite by email (registered)
/scheduled/:id       One scheduled kelabo: link, replies, "Start now" (registered)
/invite/:kelaboId   Accept or decline an invitation  ← works without an account
/kelabos             Past kelabos — records list (registered)
/kelabos/:id         Record + minutes (registered)
/journeys            Journeys list — mine / accessible / public (registered)
/journeys/:id        One journey: tabs, timeline, board, documents (registered)
/contacts            Contacts (registered)
/settings            Personal settings (registered)
/admin               Deployment administration (administrators; guarded in-component)
/pair                Agent device pairing
/records, /records/:id      → redirect to /kelabos, the record
/meetings, /meetings/:id    → redirect to /kelabos, the record  (old term)
*                    → /
```

Server-handled navigations (not React Router): `/logout` (clears cookie, 302→`/`).
OTP request/verify are XHR, no navigation.

### Navigation state machine
```
Gate(/) --GET /me--> identity? --no--> Login(/login) --OTP ok--> Home(/)
                                --yes-> Home(/)
Home --/new--> Create --POST--> Lobby(/m/:id/lobby) --enter--> Kelabo(/m/:id)
invite link --> Join(/join/:id) --joined--> Kelabo(/m/:id)
Kelabo --leave--> Home or Login
```

---

## 4. Roles → UI gating

| Role | Obtained by | Sees |
|------|-------------|------|
| Guest | invite link + name | join, capture, board |
| Registered | OTP login (allowed domain) | + create kelabo, records, settings |
| Host | created the kelabo | + end, minutes, MCP override, manage participants |
| Developer | running a bound Rig/agent bridge | contributions from local opencode appear on board |
| Administrator | on the `ADMIN#` roster, or root | `/admin`: publish operational config, rotate supplier keys |
| Root | the deploy-time `rootAdminEmail` | all of the above, plus the only one who may grant or revoke administrators |

**`/admin` is registered for every signed-in user and guarded inside the
component**, deliberately: a route that exists only for some users 404s for
everyone else, which reads as a broken link rather than as a refusal. The menu
entry is gated on `GET /admin/whoami` and is cosmetic — it fails to `false` on
error, and every route re-checks server-side.

Roles are additive; host controls are hidden from non-hosts, records/settings from
guests.

---

## 5. Screens (wireframes + states)

### 5.1 Login (`/login`) — passwordless (OTP or social)
```
┌──────────────────────────────┐        after "Send code":
│           kelabo             │        ┌──────────────────────────────┐
│  Sign in                     │        │ Enter 6-digit code            │
│  [  Continue with Google  ]  │        │ [2][4][9][ ][ ][ ]            │
│  [  Continue with Apple   ]  │   →    │ [ Verify ]   Resend (28s)     │
│  ── or with email ──         │        └──────────────────────────────┘
│  [ you@company.com        ]  │
│        [ Send code ]         │
│  Only @company.com allowed.  │
└──────────────────────────────┘
```
- **Social:** button → `GET /auth/oidc/:provider/start` (full-page redirect) →
  provider → `/callback` → back to `/`. The callback enforces the **domain
  allow-list** (a disallowed domain shows "This deployment only allows @company.com").
- **OTP:** email → code. States `idle → sending → code_sent → verifying →
  success|error`. Errors: wrong/expired code, domain not allowed, rate-limited. OTP
  inputs support paste-to-fill; resend countdown.
- **The allowed domain is named, and optional to type.** This is a **build-time**
  value and the enforcement is not, which is a real seam: the server-side check in
  `otp.js`/`oidc.js` reads the *published* domain (docs 23), so a deployment that
  publishes a new one and does not run `make frontend` will admit the new domain
  while this page still names the old. `config.allowedEmailDomain`
  reaches the bundle as `VITE_ALLOWED_EMAIL_DOMAIN` (from `deploy-frontend.sh`), so
  the copy above renders the real domain instead of `company.com`, and `rico`
  submits as `rico@mycompany.com`. The field stays a real `type="email"` input
  rather than a suffix-locked one, because a locked suffix loses email autofill and
  turns a *pasted* full address into `rico@x.com@x.com`. What gets submitted is
  decided by `spa/src/emailDomain.js` — pure, so `spa/test/emailDomain.mjs` pins
  that trap and the wrong-domain refusal under plain node. Empty config = open
  registration, and every string falls back to the generic wording.
- **The deployment names itself.** `config.organizationName` → `VITE_ORG_NAME` →
  "Use your **Acme Corp** email to receive a sign-in code", and `document.title`
  becomes `Acme Corp · kelabo` (set once in `main.jsx`, not per route — it is a
  build-time constant). Cosmetic only: it is never consulted about who may sign
  in. Unset leaves "Use your corp email…" and the plain `kelabo` tab title.
- **No password field anywhere.**

**Silent refresh (no re-login every open):** on app load, if `/me` returns 401 the
SPA calls `POST /auth/refresh` once; success → continue, failure → Login. A
background timer refreshes before the ~1h session expires. Users re-authenticate
only ~monthly (refresh-token expiry) or after logout.

### 5.2 Home (`/`, registered)
```
┌───────────────────────────────────────────────┐
│ kelabo                    alice.chen ▾  [☾]     │
│ [ + New kelabo ]                               │
│ Your kelabos                                   │
│  ● Design sync   active · 3    [Open]           │
│  ○ Standup       ended 2h ago  [Record]         │
│ Recent records                    [See all →]   │
└───────────────────────────────────────────────┘
```
"New kelabo" → `/new` (title + host defaults, e.g. translation toggle/target)
→ POST → navigate `/m/:id/lobby`. Active list polls every 8s. States:
loading(skeleton)/empty/loaded/error.

### 5.2a Create (`/new`) & Lobby (`/m/:kelaboId/lobby`)
```
┌──────────────────────────────┐   ┌──────────────────────────────┐
│ Create a kelabo             │   │ Design sync   waiting…        │
│  Title [ Design sync      ]  │ → │ Invite link                   │
│  [x] Translate transcript    │   │ [example.com/join/m_8f3k2x][⧉]│
│      into [ major lang ▾ ]   │   │ Participants (1)              │
│      [ Create kelabo ]      │   │  AC Alice (you) host · lobby  │
└──────────────────────────────┘   │  B  Bob joined  (animates in) │
                                   │ [Cancel] [Enter kelabo room→]│
                                   └──────────────────────────────┘
```
- **Create** collects the title and host-level defaults (reserved: translation
  on/off + target language, default = kelabo major language). The host's personal
  MCP servers (from Settings) apply automatically.
- **Lobby** is the pre-kelabo waiting room: shows the copyable invite link, the
  live participant-arrival list (each arrival animates in + toast, polled or SSE),
  and "Enter kelabo room" (host can enter any time; late joiners use the link).
  "Cancel kelabo" ends it before anyone joined.
- States: created/link-copied/waiting/entering. Arrival count in the title chip.

### 5.3 Join (`/join/:kelaboId`)
```
┌──────────────────────────────┐
│ Join "Design sync"           │
│   Your name [ Sam           ]  │  ← localStorage prefilled
│   (•) Share mic + watch board  │  audio-board
│   ( ) Watch board only         │  board-only
│        [ Join kelabo ]      │
└──────────────────────────────┘
```
States: loading/invalid("link invalid or ended")/ready/joining/error.
On join → mint participant cookie (XHR) → navigate `/m/:id`. Name saved to
`localStorage`. Join modes: `audio-board` (mic + board) or `board-only` (watch).

**Device check** (`components/DeviceCheck.jsx`, shared by Join and the Lobby):
camera preview, live microphone level meter, device pickers, and the two
choices that matter — join muted, join with camera on. Toggling is not a
preview of a decision, it *is* the decision: every change writes to
`joinPrefs.js` immediately, because the Lobby pulls participants into the room
the moment the host starts and an "apply on join" button would be skipped for
most of them. It also does the one thing a settings screen cannot — proves the
hardware works. A mic muted in the OS, a camera held by another app, a headset
lost with Bluetooth: all look fine in a checkbox and are obvious against a level
meter that does not move.

Requests are **serialized**, microphone first: asking for both at once puts two
permission prompts on screen together, which browsers queue or reject. Each is
time-boxed (20s) purely so a `getUserMedia` that never settles cannot wedge the
other behind it — a hung microphone must not also cost you the camera — and a
timeout says "could not open" rather than "blocked", which sends people to a
different settings page.

The Lobby carries the same component: the host never passes through Join, so it
is their only look at their own camera before everyone else has one.
*(No "open collaboration view" mode — the opencode surface is not built.)*

**Where the defaults live** (`joinPrefs.js`): whether you *usually* join muted
or with video is a preference and lives in Settings, synced across devices with
everything else. Which microphone is plugged into this particular machine is not
a preference, it is a fact about the machine — device ids stay device-local and
are never synced, because a device id from a laptop selects nothing on a phone.
The room reads all four **once, on entry**; from then on its own controls own
them, and re-reading would fight the person using those controls.

### 5.3b Scheduling (`/schedule`, `/scheduled/:id`, `/invite/:id`)

A kelabo can be scheduled for later and its link shared straight away. The link
is the point: it is minted before the kelabo exists as a live thing and is the
*same* link once the host starts, because a scheduled kelabo is the same
kelabo in an earlier state (docs 08), not a placeholder swapped for a real one.

- **`/schedule`** — title, time, duration, note, and an invitee picker
  (`EmailPicker`) that suggests the people registered at your own email domain
  as you type — read from the users table's `tenant-index`, not a private
  contact list, which would start empty for everybody. Suggestions never
  restrict: any valid address is accepted, so inviting someone outside the
  company or a colleague who has not signed in yet works the same. `When` is a
  themed `DateTimePicker` rather than the native controls, which each browser
  draws in its own palette — a white calendar on a dark page. Committing an address is deliberately generous — Enter,
  Tab, comma, space or blur — because the commonest way to lose an invitee is to
  type the address, press Schedule, and have the half-finished input discarded.
  **Signed-in only**: scheduling sends mail in the tenant's name.
- **`/scheduled/:id`** — the host's view: the link to copy, who has replied, and
  **Start now**, enabled whatever the clock says. A scheduled time is an
  intention, not a lock; a host staring at a disabled button because it is 13:58
  is worse than one starting two minutes early.
- **`/invite/:id`** — sits *outside* the signed-in shell, beside `/join` and the
  lobby, because an invitation that demands a sign-up before it will say what
  the kelabo is has failed at its only job. A signed-in visitor is never asked
  their name; a guest is asked once and a signed cookie remembers them, so
  changing their mind updates their answer instead of adding a second person.
  Declining is never a lock — the link keeps working and the answer can be
  changed, because people say no and then find they can come.

The rail carries a **Scheduled** group above *Live now*, showing what is still
ahead with a short "Tmrw 14:00" stamp; today and tomorrow are named because
"Wed" is ambiguous when today is Wednesday.

### 5.4 Kelabo room (`/m/:kelaboId`) — core

A full-viewport surface with no app chrome: the tiles *are* the room, and
controls, captions and panels float over them and come and go. The two fixed
half-width panes it replaced made the transcript permanently as important as the
people, which is the wrong trade during a kelabo.

```
┌─────────────────────────────────────────────────────────────────────┐
│ ←│Design sync                          ⛶  [End kelabo] [⇥ Leave]   │  ← floats, hides on idle
│  │● Live 00:42:13 👥4 P2P secure                                     │
│                                                                     │
│    ┌─────────┐   ┌─────────┐   ┌─────────┐                          │
│    │  (AB)   │   │  (BC)   │   │  (CD)   │                          │
│    │ ●●● bob │   │ ●●● sam │   │ ●●● ann │                          │
│    └─────────┘   └─────────┘   └─────────┘                          │
│         ┌─────────┐   ┌─────────┐                                   │
│         │  (DE)   │   │   ✦  4  │  ← the assistant, as a participant │
│         │ ●●● eve │   │ ●●● Assistant · searching…                  │
│  ┌───────────────────────────┐ └─────────┘                          │
│  │ bob  we should raise the… │            ← floating captions        │
│  │ sam  what's the retry lim │                                       │
│  └───────────────────────────┘                                       │
│      ( 🎤^ 📹^ │ CC ▤ 💬4 │ ▦^ │ 🐞 ⋯ )   ← one control row        │
└─────────────────────────────────────────────────────────────────────┘
```

**Layouts** (`room/layouts.js`, persisted in `localStorage`): `grid` (equal
tiles, best-fit packing), `focus` (one card large + a rail; what a card click
opens) and `spotlight` (same frame, stage follows the active speaker). Every
layout renders **one flat list of tiles into one container** — stage vs rail is
CSS grid placement, never a nested wrapper — so a switch is a FLIP animation
(`room/useFlip.js`) of the same DOM nodes rather than a cut. A nested rail would
remount every card and there would be nothing to animate.

- **Tiles** (`ParticipantCard`): camera video when there is any, avatar when
  there is not, speaking ring and name-plate level meter driven by a CSS custom
  property written at frame rate, mute/status badges top-right. Level never goes
  through React state; only the boolean "is speaking" does. The meter is a
  property readout rather than a keyframe animation on purpose: keyframes stop
  on any machine reporting `prefers-reduced-motion`, which on Windows is every
  machine set to "Adjust for best performance", so a live status indicator was
  dead on a whole platform while looking perfect on macOS. It is also why
  `useSpeaking` (a hook in `ParticipantCard.jsx`) resumes its `AudioContext` on the first user gesture — a
  suspended context reads pure silence and reports nobody as speaking, with no
  error to say why. The video sits over
  the avatar rather than replacing it, so a camera switching off reveals the
  face behind it instead of remounting the box; over live video the name plate
  gets a scrim, because the "surface" it sits on is now whatever is in front of
  someone's camera. Self-view is mirrored, remote video is not.
- **Camera** (`rtc/useCameraStream.js`): opt-in, off by default, and owned
  separately from the microphone — the mic is held for the whole kelabo because
  the transcript depends on it, while the camera is *stopped* on every toggle so
  the device light actually goes out. Turning it off is not a message to peers:
  the transport clears the track, their receiving track fires `mute`, and their
  tile falls back to the avatar (docs 15 §8). Camera choice is in the chevron
  next to the button; `v` toggles it. Hidden when `config.rtc.video` is off.
- **The assistant is a participant** (`AssistantTile`), not a panel: same card,
  same grid. Its state *is* its video — a breathing halo while thinking, a
  scanning sweep while searching, one pulse when a contribution lands, and the
  live step ("Fetching bom.gov.au") as its phase line. When it is not working
  the tile shows **the answer itself**, set to be read: title plus the body as
  running text, markdown flattened (structure cannot survive tile size; the
  sentence is what people want). Type is sized in `cqi` against the tile's own
  width with px floors and ceilings, so one component is legible in a 240px grid
  tile and scales up when the tile takes the stage — no breakpoints, no second
  component. An answer nobody can read without opening the side panel is an
  answer most of the room never reads. Clicking it opens `AssistantStage`, the
  equivalent of someone sharing their screen: every contribution in a list on
  the left, the selected one rendered full size on the right, filterable by
  kind. It takes no part in Spotlight's speaker-follow — an agent that speaks in
  bursts would yank the stage off a human mid-sentence.
- **Captions** (`CaptionOverlay`): the last ~3 utterances, bottom-left, over the
  tiles, expiring ~9 s after their last revision. Settled words plain, the
  unconfirmed tail dimmed (`messageParts` in `transcript/transcriptStore.js`).
- **Side panel** (`SidePanel`, ~22% width, on request): `Transcript` — the whole
  conversation as chat bubbles, speaker-rename chips when diarization is on —
  and `Board` — every `LLM_CON` contribution as a collapsed card, click to
  expand the `markdown`, plus a compose box for a manual note.
  `ContributionCard` is built for the narrowest column it appears in (~300px)
  and is the same card on the wide record page, because a card that survives
  300px is not improved by being given 900. Two rows, never one: a kind icon
  plus a two-line title, then a meta row of time, `→ target` (only when it is
  not "all", which it almost always is), a source count and an origin glyph.
  The kind is an icon and a border colour rather than a word — the word was the
  longest thing in the head and the least useful. A **working** card is a
  spinner, its title, the live `progress` line ("Fetching bom.gov.au") and the
  last three `steps` — no chip repeating that it is working. A **skipped** card
  is the same card gone muted, carrying the one-line `reason` the agent had for
  posting nothing; it is never deleted, because a card that vanishes reads as a
  bug and hides the difference between "decided not to" and "crashed".
- **Controls** (`ControlBar`) are one Slack-style row, grouped by what they act
  on: mic (+ chevron → mute when tab is hidden, language, label speakers, skip
  silence, final only), what you can read (captions / transcript / board), how the room is
  arranged (layout + chevron), then debug and ⋯ (copy link, minutes, theme). Mic
  and camera each pair their button with the chevron that configures it.
  Settings set once a kelabo live behind the chevron of the thing they
  configure, not in the row used every minute.
- **Exits float top-right** — `End kelabo` (host, designed confirm modal, never
  native `confirm()`), `Leave`, full screen — alongside the identity cluster
  top-left. Both fade out after ~2.8 s of stillness and return on any pointer or
  key activity; a hold keeps them up while a menu or panel is open
  (`useIdleChrome`). Alerts (mic denied, insecure context, mesh full) never hide.
- Keyboard: `m` mute, `v` camera, `c` captions, `t` transcript, `b` board, `Esc`
  back to grid / close panel.
- **Dev-mode chip** if any participant has a bound Rig; contributions from a dev's
  opencode carry a "from local repo" chip. (Still no opencode tab — only the chip.)
- **Journey chip** (`RoomShell.jsx`) in the identity strip when the kelabo is
  linked to any journey — generically labelled ("journey" / "N journeys", titles
  in the tooltip), rendered from `kelabo.journeys` and mutually exclusive with
  the `historyEnabled` chip beside it, because a live journey link supersedes
  the host-history context (docs 20 §12.1). Same disclosure reasoning as
  `historyEnabled`: context nobody can see is context nobody can object to.

`routes/Kelabo.jsx` owns the four live connections — microphone, STT
capture, conference transport and the kelabo's single SSE stream (`room/useBoard.js`,
extracted from the old `BoardPanel` so that no layout decision can drop a
stream) — and nothing about how the room looks. `room/RoomShell.jsx` owns the
entire presentation and none of the connections.

**The headcount chip (`👥`) is live, not cumulative.** It comes from the `roster`
SSE event (docs 03 §5.1) — distinct identities holding a stream on this kelabo
right now. It is deliberately not the kelabo's `participants` list, which is
append-only and so only ever climbs (two people who both left still read "2"),
and not the tile count, which counts a shared screen as a person and cannot see
a board-only participant. Until the first `roster` arrives there is no chip:
no number beats a wrong one. An **ended** kelabo shows the cumulative count
instead, which is the honest number for a record of who took part.

**One tab per kelabo** (`room/tabClaim.js` + `room/useSingleTab.js`). A second
tab of the same kelabo, in the same browser, is refused with a page offering
"Open here instead" (`room/TabTaken.jsx`). Not cosmetic: a second tab takes a
second `getUserMedia` on a device the room holds exactly once — echo, and every
sentence transcribed twice under one identity — and the conference seat is keyed
by identity, so the Gateway treats the new tab as a *rejoin* and the first tab's
call silently dies. Nothing server-side can catch it, because the SSE hub
deliberately tolerates two streams per identity so EventSource reconnects
survive. The gate is a `BroadcastChannel` probe with a 400ms window, so a
crashed tab leaves no stale lock; the room component is **not mounted** while
blocked, which is also what makes the takeover clean — the losing tab's cleanups
release the mic and leave the call before the winning tab opens anything. The
protocol is a pure reducer so the races (simultaneous opens, a holder that never
answers) are testable: `spa/test/tabClaim.mjs`. Scope is one browser profile —
a phone and a laptop are a legitimate pair of tabs.

**Multilingual (not built):** participants may speak different languages in the same
kelabo — **no per-participant language setting**: the STT provider's language
detection identifies each speaker's language automatically. Translation is a **host
control**: the host enables it in a Translation drawer and picks the target
language (default = the kelabo's auto-detected **major language**, shown as a
`🌐 major: EN` chip in the room's identity cluster). When on, the Transcript
side panel shows a read-only `translated → <LANG>` chip and every finalized transcript line renders
bilingually — original text with the translation beneath it in accent color
tagged with the target-language label. Interim lines are never translated
(finals only). Pipeline: the STT provider stamps the detected `lang` on each
`Utterance`; translation would run server-side and be delivered as an
optional `tr` field on captions/records — the SPA only renders it, never calls
a translation API itself.

States: `connecting`, `live`, `mic_denied` (banner, can still watch),
`insecure_context` (banner: must use https/localhost — prototype lesson),
`reconnecting` (SSE dropped → toast + auto-retry), `ended` (overlay + record link).

Mobile: the rail narrows and the side panel takes the whole room rather than a
fifth of it — 22% of a 390px screen is not a panel; SW notifications still fire.

### 5.5 MCP override drawer (host)
```
┌── MCP configuration ──────────────┐
│ Your MCP servers (from Settings)  │
│  • jira   https://…   [enabled]   │
│  • wiki   https://…   [enabled]   │
│ Your overrides (this kelabo)     │
│  • jira   [edit]                  │
│  [ + Add MCP server ]             │
│        [Cancel] [Save]            │
└───────────────────────────────────┘
```
MCP servers are a **host-personal** setting (managed in Settings, applied to
kelabos they host); the drawer overrides them per kelabo. Org-wide MCP + group
ACLs are not built (see [05-agent-mcp.md](./05-agent-mcp.md)).

### 5.6 Records list (`/kelabos`) & 5.7 detail (`/kelabos/:id`)
```
Records                          Record: Design sync 2026-07-25 42min
● Design sync 4 people 🗎min      [Transcript][Board][Minutes]
● Standup     6 people           [Alice]00:01 raise retry limit
                                 [Bob]  00:04 what's the retry…
                                                 [Download .json]
```
Only kelabos the user participated in/hosted. 🗎 = minutes exist. Detail tabs:
Transcript / Board / Minutes. Guests get 403 + redirect. States:
loading/empty/loaded/error.

Minutes are a write-up, not an index: Summary (narrative), Discussion (a titled
paragraph per topic, with who drove it), Decisions (+ rationale), Action items
(+ owner/due), Open questions, and "Looked up during the kelabo" (what the
assistant researched, with its sources). Records written before the richer
document stored plain strings; each section renders either shape.

### 5.8 Settings (`/settings`)
Sections: Profile, Notifications (enable OS notifications → SW permission), MCP
(personal defaults), Appearance (theme), Danger (sign out everywhere).

### 5.9 Journeys (`/journeys`, `/journeys/:id`) — docs 20 §13

The persistent container that links related kelabos ([20-journey.md](../20-journey.md));
this section is the SPA surface only, the design is there.

- **Nav:** a `Journeys` sidebar entry beside Kelabos, and a **New journey**
  sidebar *action* beside New kelabo/Schedule/Join (`AppShell.jsx`) — a
  `<button>`, not a route, opening `NewJourneyModal`
  (`components/NewJourneyModal.jsx`) from wherever the user already is.
- **`/journeys`** (`routes/Journeys.jsx`): bucketed list `{mine, accessible,
  public}` — reusing the Records bucketed-sections pattern. Each row: avatar,
  title, status chip, health dot, progress badge, kelabo count, last activity.
- **`/journeys/:id`** (`routes/JourneyDetail.jsx`): header (avatar, title,
  status, health/progress, lead) + `Tabs`: **Overview** · **Timeline** ·
  **Kelabos** (linked list + New kelabo/Schedule shortcuts via `?journeyId=`) ·
  **Reports** · **Board** ("Show archived (N)" reveal) · **Documents** ("Show
  removed (N)" reveal) · **Accessors** (appended only when the journey is
  private; lead-managed). Details per tab: docs 20 §13.
- **Creation-time linking:** `NewKelabo.jsx` / `Schedule.jsx` gain
  `JourneyPicker` (`components/JourneyPicker.jsx`), a chip-list + modal picker
  over `api.listJourneys()`, capped at 10 (`journeyIds`,
  `contracts/src/schemas.js`). Picking any journey **hides the
  `historyEnabled` toggle and resets it to `false`** — a journey link
  supersedes host-history context (docs 20 §12.1), so offering both would be
  offering a dead switch.
- **"Part of: …" breadcrumb:** `RecordDetail.jsx` and `ScheduledKelabo.jsx`
  render journey chips (linking to `/journeys/:id`) from the `journeys:
  [{id,title,visibility}]` field on the kelabo GET; the live room shows the
  generic chip via `RoomShell.jsx` (§5.4).
- **Display vocabulary — labels only, stored enums unchanged:** the SPA renders
  `ownerIdentity`/`myRole:"owner"` as **"Lead"**, and `health`'s stored
  `green|yellow|red` as **"Full Steam"** / **"Shoal Waters"** / **"Anchored"**
  (`Journeys.jsx` `HEALTH_LABEL`, `JourneyDetail.jsx` `HEALTH_OPTIONS`). The
  wire, the database and anything fed to an LLM keep the raw enum words
  (docs 20 §13).
- Health chips reuse the fixed `--success`/`--warn`/`--danger` tokens — no new
  palette, no new CSS system.

*(Global search (`SearchDialog.jsx`) still has two tabs — contacts and kelabos;
a journeys tab is not built.)*

---

### 5.10 Administration (`/admin`) — docs 23

Six tabs, mirrored into `?tab=` with `replace: true` so a section is linkable and
survives a reload: **Assistant**, **Services**, **Suppliers**, **Limits**,
**Access**, **History**.

**Every field shows three things, not one.** What is published, what this
deployment falls back to, and therefore what is in effect. Showing only the
effective value would make the page unusable for the thing it exists for: an
operator seeing `sfu` cannot tell whether they published it or whether it is the
config file's default showing through, so clearing a field they believed they
had set would change nothing while looking as though it should. An empty box
means *not published*, never *set to empty*.

**One publish for the whole document, and a note is required.** The config is
versioned atomically, so a form per group would mint a version per field and
lose the single note that explains the change. Two administrators publishing at
once: the second gets `version_conflict`, reloads, and republishes on top —
never a blind retry.

**It reports latency honestly.** "Live now" when the Gateway acknowledged the
reload; "the gateway will pick this up within a minute" when it did not. Saying
"live" when it is not is how an operator ends up debugging the wrong thing.

**Suppliers is not config and has no publish bar.** Each slot saves itself,
immediately, with no version and no note — a key is not a decision anyone needs
the history of. Boxes are password fields that always start empty, because
**there is no route that returns a credential**: nothing exists to prefill with,
and a masked placeholder over a value that was never fetched would imply
otherwise. Empty means "leave this one alone" and the server merges, so rotating
one engine's key cannot wipe the other's.

A failed load renders an error with a retry, not a skeleton. That distinction
was learned the hard way: `.catch(() => setState(null))` left the tab
indistinguishable from still-loading, and a 500 span forever with the actual
error only in CloudWatch.

---

## 6. Capture behavior (interface to the STT provider)

The capture pipeline lives in `src/capture/` (`useCapture.js`, `vad.js`):
`getUserMedia` → `AudioContext` @ device rate → PCM16 → **WSS directly to the
STT provider** — connection params come from the minted `SttSession`, never
hard-coded. The transport is provider-specific (`spa/src/stt/<id>.js`), the
wire reader pure and provider-specific (`spa/src/transcript/stt/<id>.js`); the
pipeline itself names no provider ([06-stt.md](./06-stt.md)).
- Interim results render live (italic) unless "Final only" is on.
- **Only finalized** utterances are POSTed to the Gateway `/caption` endpoint.
- A short-lived STT credential (`SttSession = {provider, url, token,
  expiresInSeconds, params}`) is fetched from the REST API before opening the
  socket.
- Mute closes the provider socket (no billing) but keeps the mic track alive.
- "Mute when tab is hidden" (off by default) mutes on tab switch and unmutes on
  return, never undoing a mute the participant set themselves.
- A local VAD gate streams only speech ("Skip silence", toggled in the mic
  chevron menu in the control bar, on by default); silence is held with
  `KeepAlive`. The mic control in the control bar reflects `listening` / `idle`.
- Full capture-side details in [06-stt.md](./06-stt.md).

---

## 7. Board behavior (interface to Gateway + REST)

- On kelabo entry: **1)** `GET /kelabos/:id/board` (REST) to **backfill** prior
  Contributions so late-comers see earlier AI messages; **2)** then open
  `EventSource(gatewayBase + '/caption/replies?kelaboId=' + id)` with
  `withCredentials` for the live tail. Track the last-seen `at` to de-dupe across
  the backfill→stream handoff.
- Each SSE message is a `Contribution`; `room/useBoard.js` owns the stream and
  every view reads its result — the assistant tile, the focus stage and the
  Board side panel (`LLM_CON` items collapsed to their `title` + `to` chip by
  default, expandable). If the tab is unfocused, raise an SW notification.
- Auto-reconnect the EventSource with backoff on drop; on reconnect, re-backfill
  with `?since=<lastAt>` to fill the gap (Gateway SSE has no replay).
- Manual note (optional): POST to `/caption` with `human:true` so the agent and
  other clients see it.
- Card status drives who shows what: `working`/`skipped` are ephemeral (the
  gateway never persists them, so they do not survive a reload or reach the
  archive), only `done` cards count toward the assistant tile's badge or raise a
  notification, and a `done` card carrying neither title nor markdown is a
  *clear* marker that removes the card by id.
- **LLM debug drawer** (`board/DebugPanel.jsx`) renders the same SSE `debug`
  entries as a call tree on a timeline: turn → (gate, orchestrator, sub-agents)
  → calls → tool calls, every row carrying its `+offset` from the start of the
  turn and its own duration, bodies one click away. The two live readouts (VAD
  gate, transcript ledger) fold shut so they never push the turns off screen.

---

## 8. Notifications (Service Worker)

- First kelabo entry, if board unfocused → prompt once
  (`Notification.requestPermission`).
- New Contribution while unfocused → OS notification (the `title`, falling back to
  first ~80 chars); click focuses tab + scrolls board.
- Settings surfaces the honest limit: works only while a browser tab is open;
  browser-closed tray needs a desktop app (not built).

---

## 9. Client-held state & synced settings

User settings are **synced to the backend** via `src/settings.js` (per-user,
last-write-wins by `updatedAt`). Synced keys: `kelabo-name`, `kelabo-theme`,
`kelabo-scheme`, `kelabo-notif`, `kelabo-final-only`, `kelabo-stt-lang`,
`kelabo-vad`, `kelabo-mute-hidden`, `kelabo-join-muted`, `kelabo-join-camera`,
`kelabo-avatar`.

Deliberately **device-local** (never synced): debug toggles and join device
ids — a device id from one machine selects nothing on another.

Identity/participant/session/refresh auth is in **httpOnly cookies** set by the
REST API — never in JS-readable storage. The SPA can't read them; it relies on
`/me` + silent `/auth/refresh` to know login state.

---

## 10. Global UI elements

Top bar (logo→Home, identity menu, theme — the menu carries an **Administration**
entry when `GET /admin/whoami` says so, cosmetic only and failing to hidden on
error), Toaster (transient status), Confirm
dialog (destructive), Skeletons (all lists/details), app-wide insecure-context
banner when `!window.isSecureContext`.

---

## 11. Accessibility & responsiveness

Keyboard reachable; OTP paste-to-fill; board respects `prefers-reduced-motion`;
color never the only speaker signal (the name is always on the tile and on every
caption); the room's tile, halo and caption animations all collapse under
`prefers-reduced-motion`, and so does the layout-switch FLIP. Breakpoints:
`<768px` stacked/tabbed for pages, `<900px` for the room (narrower rail,
full-width side panel).

---

## 12. Build/deploy notes

- Vite build → `dist/` → S3; CloudFront with SPA fallback (rewrite unknown paths to
  `/index.html`) via a CloudFront Function.
- Env config injected at build via `VITE_*` (API base, Gateway base, feature flags
  like `VITE_CAPTION_ENABLED`), values sourced from the one CDK config file so
  nothing is hard-coded.
- Service Worker registered at root scope for notifications.
