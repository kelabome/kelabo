import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '../components/ui/Button'
import { Icon } from '../components/ui/Icon'
import { Banner } from '../components/ui/Banner'
import { myAvatarVariant } from '../components/ui/Avatar'
import { Stage } from './Stage'
import { ControlBar } from './ControlBar'
import { AddPeople } from './AddPeople'
import { CaptionOverlay } from './CaptionOverlay'
import { SidePanel } from './SidePanel'
import { useFlip } from './useFlip'
import { useIdleChrome } from './useIdleChrome'
import { useRoomFavourites } from './useRoomFavourites'
import { isStageLayout, loadLayout } from './layouts'
import { roomTitle } from '../kelaboTitle'

/**
 * The kelabo room.
 *
 * Full viewport, no app chrome, everything else floating over a single canvas:
 * the tiles are the room, and the controls, captions and panels are things laid
 * on top of it that come and go. That is the whole structural idea, and it is
 * what the previous room — a header, a tab strip and two fixed half-width panes
 * — could not express, because in it the transcript was permanently as
 * important as the people.
 *
 * State that belongs here rather than in a child: which layout, what is on the
 * stage, which panel is open. All three are things a child would otherwise have
 * to ask a sibling about.
 */

const CAPTIONS_KEY = 'kelabo-room-captions'

function fmtTimer(secs) {
  const h = String(Math.floor(secs / 3600)).padStart(2, '0')
  const m = String(Math.floor((secs % 3600) / 60)).padStart(2, '0')
  const s = String(secs % 60).padStart(2, '0')
  return `${h}:${m}:${s}`
}

/**
 * Its own component purely so the second hand does not re-render the room.
 * Every tile carries a live audio analyser; re-rendering all of them once a
 * second to move a clock is the kind of thing that shows up as a warm laptop.
 */
function RoomClock({ startedAt }) {
  const [, tick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => tick(n => n + 1), 1000)
    return () => clearInterval(t)
  }, [])
  const elapsed = startedAt ? Math.max(0, Math.floor((Date.now() - startedAt) / 1000)) : 0
  return <span className="timer">{fmtTimer(elapsed)}</span>
}

function useFullscreen() {
  const [on, setOn] = useState(() => !!document.fullscreenElement)
  useEffect(() => {
    const sync = () => setOn(!!document.fullscreenElement)
    document.addEventListener('fullscreenchange', sync)
    return () => document.removeEventListener('fullscreenchange', sync)
  }, [])
  const toggle = useCallback(() => {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {})
    else document.documentElement.requestFullscreen?.().catch(() => {})
  }, [])
  return { on, toggle }
}

export function RoomShell({
  kelabo,
  kelaboId,
  me,
  isHost,
  ended,
  // { failed, onRetry } — the record's own state, separate from `ended`.
  archive,
  boardOnly,
  agentPresent,
  agentLabel,
  participantCount,
  capture,
  call,
  mic,
  cam,
  screen,
  speaker,
  board,
  stt,
  micPrefs,
  diarize,
  transcriptAccess = true,
  history,
  onToggleDebug,
  debugOn,
  onInvite,
  onLeave,
  onBack,
  onEndKelabo,
  onToggleTheme,
  onScheme,
  scheme,
  themeIcon,
}) {
  // Deployment capabilities (docs 19 §2/§3), stated by the server on the
  // kelabo META. `on !== false` throughout: an older server without the map,
  // or a kelabo still loading, renders the full room — permissive default. An
  // `off` capability leaves no trace in this component; a capability that is
  // `on` but failing keeps its UI and wears its own status.
  const caps = kelabo?.capabilities
  const sttOn = caps?.stt?.on !== false
  const assistantOn = caps?.assistant?.on !== false
  const videoOn = caps?.video?.on !== false
  const rtcOn = caps?.rtc?.on !== false

  const [layout, setLayoutState] = useState(loadLayout)
  const [focusId, setFocusId] = useState('assistant')
  const [activeSpeaker, setActiveSpeaker] = useState(null)
  const [panel, setPanel] = useState(null) // null | 'messages' | 'transcript' | 'board'
  const [captionsOn, setCaptionsOn] = useState(() => localStorage.getItem(CAPTIONS_KEY) !== '0')

  const flip = useFlip()
  const fullscreen = useFullscreen()
  const chrome = useIdleChrome()
  const favourites = useRoomFavourites(me)

  // Not persisted: every kelabo opens in the grid (see layouts.js).
  const setLayout = setLayoutState

  // --- who is in the room ---------------------------------------------------
  const tiles = useMemo(() => {
    const list = []
    // Shared screens come first. Someone puts a screen up because it is the
    // thing to look at, and a roster order that buries it behind four faces
    // argues with that.
    if (screen.on) {
      list.push({ id: 'screen:self', kind: 'screen', name: me, stream: screen.stream, isSelf: true })
    }
    for (const [participantId, ms] of call.remoteScreens) {
      const p = call.peers.find(x => x.participantId === participantId)
      list.push({
        id: 'screen:' + participantId,
        kind: 'screen',
        name: p?.displayName || participantId,
        stream: ms,
      })
    }
    if (!boardOnly) {
      list.push({
        id: 'self',
        // The tile id is the literal string 'self' — a slot in this room, not a
        // person — so the generated avatar needs the real identity or everyone
        // would see their own face as the same pattern.
        seedId: kelabo?.me || me,
        seedVariant: myAvatarVariant(),
        kind: 'person',
        name: me,
        stream: mic.stream,
        videoStream: cam.stream,
        isSelf: true,
        muted: capture.muted,
        cameraOn: cam.on,
        status: 'live',
        // Seeing yourself is not proof anyone else can. Say so on the tile
        // rather than letting a working self-view imply a working call.
        note: cam.on && call.state !== 'live' ? 'not sent' : null,
      })
    }
    for (const p of call.peers) {
      list.push({
        id: p.participantId,
        // `participantId` IS the identity (gateway/src/rtc/routes.js), so a
        // person's avatar is the same one the rail and the contact list draw.
        seedId: p.participantId,
        seedVariant: p.avatarVariant || 0,
        kind: 'person',
        name: p.displayName || p.participantId,
        stream: call.remoteStreams.get(p.participantId) ?? null,
        // Straight from the roster: their microphone and camera are the two
        // things about them that no amount of looking at their media can
        // settle. `undefined` (a peer who has not reported yet) leaves both
        // controls at their old track-derived behaviour rather than guessing.
        muted: p.media?.audio === false,
        cameraOn: p.media?.video ?? null,
        status: call.peerStatus(p.participantId),
      })
    }
    // The assistant is last for the same reason a bot is last in a member list:
    // it is in the room, but the people came first. No assistant on this
    // deployment means no tile at all — not an idle tile "listening" for an
    // LLM that was never configured.
    if (assistantOn) list.push({ id: 'assistant', kind: 'assistant' })
    return list
  }, [assistantOn, boardOnly, me, mic.stream, cam.stream, cam.on, screen.on, screen.stream, call.state, capture.muted, call.peers, call.remoteStreams, call.remoteScreens, call.peerStatus])

  // Where the stage falls back when the requested tile is gone. With no
  // assistant tile the first real tile takes its place.
  const fallbackId = assistantOn ? 'assistant' : (tiles[0]?.id ?? null)

  // Someone ELSE's screen going up takes the stage, the way it does in every
  // other kelabo tool: their share is almost always the reason it was started.
  // It happens once per share — the layout is still yours to change afterwards,
  // and switching away does not fight you.
  //
  // Your own share deliberately does not. You picked the window; you are looking
  // at the real one, not at a thumbnail of it, and rearranging the room around a
  // copy of what is already on your screen takes away the faces you were talking
  // to at the exact moment you started presenting. Every id is still recorded so
  // that stopping and re-sharing does not later count as "fresh" for the room.
  const seenScreens = useRef('')
  useEffect(() => {
    const screens = tiles.filter(t => t.kind === 'screen')
    const previous = seenScreens.current ? seenScreens.current.split('|') : []
    const fresh = screens.find(t => !t.isSelf && !previous.includes(t.id))
    seenScreens.current = screens.map(t => t.id).join('|')
    if (!fresh) return
    flip.capture()
    setFocusId(fresh.id)
    setLayout('focus')
  }, [tiles, flip, setLayout])

  const onSpeakingChange = useCallback((id, speaking) => {
    // Only ever moves forward: when someone stops talking the stage stays on
    // them rather than snapping back to whoever happens to be first.
    if (speaking) setActiveSpeaker(id)
  }, [])

  const stageId = useMemo(() => {
    if (!isStageLayout(layout)) return null
    if (layout === 'spotlight') {
      // A share outranks the active speaker: people talk *about* the thing on
      // screen, so following the voice would take away what they are discussing.
      const shared = tiles.find(t => t.kind === 'screen')
      if (shared) return shared.id
      const people = tiles.filter(t => t.kind === 'person')
      const active = people.find(t => t.id === activeSpeaker)
      return active?.id ?? people[0]?.id ?? fallbackId
    }
    return tiles.some(t => t.id === focusId) ? focusId : fallbackId
  }, [layout, tiles, activeSpeaker, focusId, fallbackId])

  // --- interactions that move tiles ----------------------------------------
  const openTile = flip.withFlip(id => {
    if (layout === 'focus' && id === stageId) {
      setLayout('grid')
      return
    }
    setFocusId(id)
    setLayout('focus')
  })

  const collapseStage = flip.withFlip(() => setLayout('grid'))

  const changeLayout = flip.withFlip(next => {
    if (next === 'focus' && !tiles.some(t => t.id === focusId)) setFocusId(fallbackId)
    setLayout(next)
  })

  const togglePanel = flip.withFlip(tab => {
    setPanel(prev => (prev === tab ? null : tab))
  })

  const closePanel = flip.withFlip(() => setPanel(null))

  const toggleCaptions = useCallback(() => {
    setCaptionsOn(v => {
      localStorage.setItem(CAPTIONS_KEY, v ? '0' : '1')
      return !v
    })
  }, [])

  // --- keyboard -------------------------------------------------------------
  const handlers = useRef({})
  handlers.current = { openTile, collapseStage, changeLayout, togglePanel, toggleCaptions, capture, cam, screen, panel, layout, boardOnly, assistantOn }

  useEffect(() => {
    const onKey = e => {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const el = e.target
      const tag = el?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el?.isContentEditable) return
      const h = handlers.current
      switch (e.key.toLowerCase()) {
        case 'm':
          if (h.boardOnly) return
          e.preventDefault()
          h.capture.muted ? h.capture.unmute() : h.capture.mute()
          return
        case 'v':
          if (h.boardOnly) return
          e.preventDefault()
          h.cam.toggle()
          return
        case 's':
          if (h.boardOnly) return
          e.preventDefault()
          h.screen.toggle()
          return
        case 'c':
          e.preventDefault()
          h.toggleCaptions()
          return
        case 't':
          e.preventDefault()
          // Toggle whichever conversation tab is open; open on Messages — the
          // tab every participant has — when neither is.
          h.togglePanel(h.panel === 'transcript' ? 'transcript' : 'messages')
          return
        case 'b':
          if (!h.assistantOn) return
          e.preventDefault()
          h.togglePanel('board')
          return
        case 'escape':
          if (h.panel) { e.preventDefault(); h.togglePanel(h.panel); return }
          if (isStageLayout(h.layout)) { e.preventDefault(); h.collapseStage() }
          return
        default:
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // --- alerts ---------------------------------------------------------------
  const alerts = []
  if (boardOnly) {
    alerts.push({ kind: 'warn', key: 'watch', text: 'Watch-only — you joined without a microphone. Captions, transcript and the board all still work.' })
  }
  if (mic.state === 'mic_denied' || capture.state === 'mic_denied') {
    alerts.push({ kind: 'danger', key: 'mic', text: 'Microphone access denied — others cannot hear you and nothing is transcribed. Allow mic access and reload to speak.' })
  }
  if (cam.state === 'denied') {
    alerts.push({ kind: 'warn', key: 'cam', text: 'Camera access blocked by your browser — everything else is unaffected. Allow it for this site from the address bar, then turn the camera on again.' })
  }
  if (screen.state === 'unavailable') {
    alerts.push({ kind: 'warn', key: 'shr', text: 'This browser cannot share a screen. Everything else on the call is unaffected.' })
  }
  if (screen.state === 'denied') {
    alerts.push({ kind: 'warn', key: 'shrd', text: 'Screen sharing was blocked. Check your browser and, on macOS, System Settings → Privacy & Security → Screen Recording.' })
  }
  if (cam.state === 'insecure') {
    alerts.push({ kind: 'warn', key: 'camctx', text: 'The camera needs a secure page — open this app over https or on localhost. Audio, captions and the board are unaffected.' })
  }
  if (capture.state === 'insecure_context') {
    alerts.push({ kind: 'danger', key: 'ctx', text: 'Microphone needs a secure context — open this app over https or localhost.' })
  }
  if (capture.state === 'stt_unavailable') {
    alerts.push({ kind: 'warn', key: 'stt', text: 'Transcription is unavailable right now — the call and the board still work.' })
  }
  if (call.state === 'full') {
    alerts.push({ kind: 'danger', key: 'full', text: `This is a secure peer-to-peer kelabo and it is full (${call.meshMax} — participants and shared screens count together). Peer-to-peer kelabos are capped because every participant sends media to every other one — the call is not switched to a relay to make room. You can still follow the captions and the board.` })
  }
  if (call.screenDenied === 'full') {
    alerts.push({ kind: 'warn', key: 'shrfull', text: `Screen sharing was refused — this peer-to-peer kelabo is at its limit of ${call.meshMax} (participants and shared screens count together). Try again when someone leaves or stops sharing.` })
  }
  if (call.screenDenied === 'error') {
    alerts.push({ kind: 'warn', key: 'shrerr', text: 'Screen sharing could not be announced to the room — the share was stopped. Try again in a moment.' })
  }
  if (call.state === 'unavailable') {
    alerts.push({ kind: 'warn', key: 'rtc', text: 'Conference audio is not configured on this deployment — captions and the board still work.' })
  }
  if (call.state === 'error') {
    alerts.push({ kind: 'warn', key: 'rtcerr', text: 'Could not join the call. Captions and the board are unaffected.' })
  }

  const idle = chrome.idle && !panel
  const title = roomTitle(kelabo?.title)

  return (
    <div className={'room' + (idle ? ' is-idle' : '')} data-layout={layout} data-panel={panel || undefined}>
      <div className="room-canvas" aria-hidden="true"></div>

      <div
        className="room-top room-top-left"
        onMouseEnter={() => chrome.hold(true)}
        onMouseLeave={() => chrome.hold(false)}
      >
        {/* A button, not a Link. Back out of a room and you leave a kelabo —
            other people notice, your microphone stops and the transcript loses
            you — which is not something a stray click on a 30px arrow should be
            able to do silently. `onBack` asks first; "Leave" on the right is
            still the one-click exit for people who meant it. */}
        <button className="room-back" onClick={onBack} title="Leave the kelabo and go home">
          <Icon name="arrow-left" size={15} />
        </button>
        <div className="room-id">
          {/* Only a real title. An untitled kelabo shows its state and nothing
              else, rather than a line announcing that nobody named it. */}
          {title && <span className="room-title" title={title}>{title}</span>}
          <span className="room-sub">
            {ended
              ? <span className="chip chip-ended">ended</span>
              : <span className="chip chip-live"><span className="dot"></span>Live</span>}
            <RoomClock startedAt={kelabo?.startedAt} />
            {/* Who is in the kelabo now, from the `roster` SSE event — not the
                call roster (which cannot see board-only participants) and not
                the tile count (which counts a shared screen as a person). Null
                until the stream delivers the first one; no number beats a
                wrong one. */}
            {typeof participantCount === 'number' && (
              <span
                className="chip"
                title={ended ? `${participantCount} took part` : `${participantCount} in the kelabo now`}
              >
                <Icon name="users" size={12} />{participantCount}
              </span>
            )}
            {call.mode === 'mesh' && (
              <span
                className="chip chip-accent"
                title="Secure kelabo: call audio flows directly between participants and no server can decrypt it."
              >
                P2P secure
              </span>
            )}
            {/* Stated in the room, not buried in the host's settings. The
                assistant can quote a kelabo some people here did not attend,
                and the only honest place to say so is where they are.
                Mutually exclusive with the journey chip below, not just
                visually — the Gateway suppresses historyEnabled's own push
                the moment any journey is linked (docs 20 §12.1), so showing
                both here would claim a source that is not actually active. */}
            {kelabo?.historyEnabled && !(kelabo?.journeys?.length > 0) && (
              <span
                className="chip chip-dev"
                title="The host let the assistant read the minutes of their own past kelabos, so it can answer questions that reach back to them."
              >
                <Icon name="book-open" size={12} />past kelabos
              </span>
            )}
            {/* Same reasoning as the chip above, for a different source: a
                journey's description, pinned notes and other linked kelabos
                reach the assistant with no opt-in of its own — linking this
                kelabo into a journey was already the deliberate act. Named
                generically ("journey"/"N journeys"), not by title, so a long
                title cannot blow out this strip — the tooltip carries them.
                Takes over from the chip above rather than joining it. */}
            {Array.isArray(kelabo?.journeys) && kelabo.journeys.length > 0 && (
              <span
                className="chip chip-dev"
                title={`Part of ${kelabo.journeys.length === 1 ? 'a journey' : kelabo.journeys.length + ' journeys'}: ${kelabo.journeys.map(j => j.title || 'Untitled journey').join(', ')}. The assistant may draw on that journey's description, pinned notes and other linked kelabos when it answers.`}
              >
                <Icon name="link" size={12} />{kelabo.journeys.length === 1 ? 'journey' : `${kelabo.journeys.length} journeys`}
              </span>
            )}
            {agentPresent && (
              <span
                className="chip chip-dev"
                title={`A participant's own coding agent is in this kelabo${agentLabel ? ` (${agentLabel})` : ''}. It answers from their local repository.`}
              >
                {agentLabel ? `agent · ${agentLabel}` : 'agent'}
              </span>
            )}
          </span>
        </div>
      </div>

      <div
        className="room-top room-top-right"
        onMouseEnter={() => chrome.hold(true)}
        onMouseLeave={() => chrome.hold(false)}
      >
        {!ended && (
          <AddPeople
            kelaboId={kelaboId}
            present={new Set(tiles.filter(t => t.kind === 'person').map(t => t.id))}
          />
        )}
        <Button
          variant="ghost"
          size="sm"
          iconOnly
          className="room-icon-btn"
          title={fullscreen.on ? 'Exit full screen' : 'Full screen'}
          aria-label={fullscreen.on ? 'Exit full screen' : 'Full screen'}
          onClick={fullscreen.toggle}
        >
          <Icon name={fullscreen.on ? 'minimize' : 'maximize'} />
        </Button>
        {isHost && !ended && (
          <Button variant="danger" size="sm" onClick={onEndKelabo} title="End the kelabo for everyone">
            End kelabo
          </Button>
        )}
        <Button variant="outline" size="sm" className="room-leave" onClick={onLeave} title="Leave — the kelabo carries on">
          <Icon name="logout" size={15} />Leave
        </Button>
      </div>

      {(alerts.length > 0 || call.needsUnblock || archive?.failed) && (
        <div className="room-alerts">
          {/* The kelabo ended but no record exists. Shown rather than toasted
              because it does not go away by itself and the host is the only
              person who can ask for it again — a toast for this is how a
              deployment loses every record and nobody notices. */}
          {archive?.failed && (
            <Banner kind="warn">
              The kelabo ended, but its record could not be saved.{' '}
              <Button size="sm" onClick={archive.onRetry}>Save the record</Button>
            </Banner>
          )}
          {call.needsUnblock && (
            <Banner kind="warn">
              Your browser blocked audio playback until you interact with the page.{' '}
              <Button size="sm" onClick={call.unblock}>Enable audio</Button>
            </Banner>
          )}
          {alerts.map(a => <Banner key={a.key} kind={a.kind}>{a.text}</Banner>)}
        </div>
      )}

      <main className="room-main">
        <Stage
          flipRef={flip.ref}
          layout={layout}
          tiles={tiles}
          stageId={stageId}
          contributions={board.contributions}
          onOpen={openTile}
          onCollapse={collapseStage}
          onSpeakingChange={onSpeakingChange}
          favourites={favourites}
        />

        {panel && (
          <SidePanel
            tab={panel}
            onTab={setPanel}
            onClose={closePanel}
            capture={capture}
            diarize={diarize}
            boardOnly={boardOnly}
            kelaboId={kelaboId}
            translation={kelabo?.translation}
            contributions={board.contributions}
            boardStatus={board.status}
            onPostNote={board.postNote}
            focusSignal={board.focusSignal}
            ended={ended}
            onHold={chrome.hold}
            // The Transcript tab needs both the policy (may this participant
            // see speech) and the capability (does this deployment transcribe
            // at all) — either alone leaves a tab that can never fill.
            transcriptAccess={transcriptAccess && sttOn}
            assistantOn={assistantOn}
            history={history}
          />
        )}
      </main>

      <CaptionOverlay messages={capture.messages} visible={captionsOn && sttOn} />

      <ControlBar
        ended={ended}
        boardOnly={boardOnly}
        capture={capture}
        cam={cam}
        screen={screen}
        speaker={speaker}
        // Only the deployment's policy — deliberately NOT whether the call is
        // live. Turning a camera on is a local act; publishing it is a separate
        // one that `useRtc` gates on its own. Requiring a live call here meant
        // that on any deployment without working conference audio you could not
        // even see yourself.
        camAvailable={call.videoAllowed}
        camPublishing={call.state === 'live'}
        // Mesh capacity gate: null when a share could be admitted, otherwise
        // the reason the button is disabled.
        shareNote={call.canShareScreen ? null : `This peer-to-peer kelabo is at its limit of ${call.meshMax} — participants and shared screens count together.`}
        stt={stt}
        micPrefs={micPrefs}
        captionsOn={captionsOn}
        onToggleCaptions={toggleCaptions}
        panel={panel}
        onPanel={togglePanel}
        boardCount={board.contributions.length}
        layout={layout}
        onLayout={changeLayout}
        onToggleDebug={onToggleDebug}
        debugOn={debugOn}
        onInvite={onInvite}
        onToggleTheme={onToggleTheme}
        onScheme={onScheme}
        scheme={scheme}
        themeIcon={themeIcon}
        onHold={chrome.hold}
        sttOn={sttOn}
        assistantOn={assistantOn}
        videoOn={videoOn}
        rtcOn={rtcOn}
        conn={{
          boardStatus: board.status,
          captureState: capture.state,
          sttLabel: capture.provider?.label,
          // `speaking` is the VAD gate: true exactly while frames are leaving
          // for the provider (and always, when silence skipping is off). Guarded
          // on `live` so a reconnecting socket cannot claim to be sending.
          sttLive: capture.state === 'live' && capture.speaking,
          callState: call.state,
          // Muting gates the outgoing conference track, so connected-and-unmuted
          // IS publishing. Nothing about speech: WebRTC keeps sending through
          // your pauses.
          callLive: call.state === 'live' && !capture.muted,
          callMode: call.mode,
          // No STT on this deployment → no transcription light at all, same as
          // watch-only: it is simply not part of this kelabo.
          transcribing: !boardOnly && sttOn,
          callOn: rtcOn,
        }}
      />
    </div>
  )
}
