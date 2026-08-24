import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { api, getCaptionHistory } from '../api'
import { useAuth, displayName } from '../auth'
import { useToast } from '../components/Toaster'
import { useConfirm } from '../components/ConfirmDialog'
import { Drawer } from '../components/ui/Drawer'
import { Button } from '../components/ui/Button'
import { Icon } from '../components/ui/Icon'
import { Modal } from '../components/ui/Modal'
import { currentScheme, setScheme, themeIcon, toggleTheme } from '../theme'
import { useCapture } from '../capture/useCapture'
import { useHiddenMute } from '../capture/useHiddenMute'
import { sttClient } from '../stt/interface'
import { useMicStream } from '../rtc/useMicStream'
import { useCameraStream } from '../rtc/useCameraStream'
import { useScreenShare } from '../rtc/useScreenShare'
import { useSpeakerDevice } from '../rtc/useSpeakerDevice'
import { useRtc } from '../rtc/useRtc'
import { useBoard } from '../room/useBoard'
import { useSingleTab } from '../room/useSingleTab'
import { TabTaken } from '../room/TabTaken'
import { RoomShell } from '../room/RoomShell'
import { InviteDialog } from '../room/InviteDialog'
import { DebugPanel } from '../board/DebugPanel'
import { CallLogPanel } from '../board/CallLogPanel'
import { pushSettings } from '../settings'
import { joinPrefs } from '../joinPrefs'
import { useLeaveGuard } from '../useLeaveGuard'
import { playEventSound, rosterDiff, shouldChimeUtterance } from '../sounds'

/**
 * The kelabo route: everything the room needs, and nothing about how it looks.
 *
 * This file owns the four live connections — microphone, Deepgram capture,
 * conference transport and the kelabo's single SSE stream — plus the kelabo
 * record itself. `RoomShell` owns the entire presentation. The split matters
 * more than it looks: the room can now rearrange itself as much as it likes
 * without any risk of dropping a stream, because no layout decision reaches
 * anything on this page.
 */

/**
 * The one-tab gate, and the reason it is a separate component.
 *
 * `KelaboRoom` opens the microphone, the Deepgram capture, the conference
 * transport and the SSE stream — each from a hook, on mount. So a second tab
 * cannot merely be told it is a duplicate: it must not mount the room at all,
 * or it has already taken a second `getUserMedia` and stolen the conference
 * seat (see `tabClaim.js`). Not mounting is also what makes "Open here instead"
 * work: unmounting runs every one of those cleanups in the tab that gives the
 * kelabo up, before the tab taking it opens anything.
 */
export default function Kelabo() {
  const { id } = useParams()
  const tab = useSingleTab(id)

  // `checking` lasts one message round trip inside this browser. Rendering
  // nothing beats a spinner that would flash on every open.
  if (tab.phase === 'checking') return null
  if (!tab.held) {
    return <TabTaken kelaboId={id} onTakeOver={tab.takeOver} busy={tab.phase === 'taking'} />
  }
  return <KelaboRoom />
}

function KelaboRoom() {
  const { id } = useParams()
  const toast = useToast()
  const confirm = useConfirm()
  const navigate = useNavigate()
  const { identity, loading: authLoading } = useAuth()

  const [kelabo, setKelabo] = useState(null)
  const [loadError, setLoadError] = useState(false)
  const [ended, setEnded] = useState(false)
  // The kelabo ended but the Gateway never wrote the record. Distinct from
  // `ended` because only the host sees it, and only they can retry it.
  const [archiveFailed, setArchiveFailed] = useState(false)
  const [icon, setIcon] = useState(themeIcon())
  const [scheme, setSchemeState] = useState(currentScheme())
  const [finalOnly, setFinalOnly] = useState(localStorage.getItem('kelabo-final-only') === '1')
  const [sttLang, setSttLang] = useState(localStorage.getItem('kelabo-stt-lang') || 'en')
  // Speaker diarization always starts off for each kelabo — opt in per kelabo.
  const [diarize, setDiarize] = useState(false)
  // Silence skipping. The participant's own choice always wins; with none
  // stored, the provider decides (see the effect below), because the gate is
  // worth opposite things on different ones.
  const [vad, setVad] = useState(localStorage.getItem('kelabo-vad') !== '0')
  // Auto-mute on tab switch is off unless asked for — see useHiddenMute for
  // why this is a preference and not simply the behavior.
  const [muteHidden, setMuteHidden] = useState(localStorage.getItem('kelabo-mute-hidden') === '1')
  // Two different facts, and conflating them is what used to wipe the flag on
  // reload. `debugEnabled` is "this person is diagnosing something" — it lives
  // in localStorage and survives reloads until they say otherwise.
  // `debugOpen` is merely whether the drawer is on screen right now.
  const [debugEnabled, setDebugEnabled] = useState(localStorage.getItem('kelabo-debug') === '1')
  const [debugOpen, setDebugOpen] = useState(debugEnabled)
  const [debugEntries, setDebugEntries] = useState([])
  const [debugFullscreen, setDebugFullscreen] = useState(false)
  const debugEnabledRef = useRef(debugEnabled)
  const startAttemptedRef = useRef(false)

  // Read once, on the way in. These are decisions made before the kelabo (the
  // device check, or the saved default) and the room's own controls own them
  // from here — re-reading would fight the person using those controls.
  const [entry] = useState(joinPrefs)

  const mode = localStorage.getItem('kelabo-mode') || 'audio-board'
  const boardOnly = mode === 'board-only'
  // Deployment capabilities from the kelabo META (docs 19 §3). Permissive
  // until the META arrives or when a server predates the map: `on !== false`.
  // An `off` capability is never attempted — no STT session minted, no
  // /rtc/join — which is what keeps "not configured" from ever being an error.
  const sttOn = kelabo?.capabilities?.stt?.on !== false
  const assistantOn = kelabo?.capabilities?.assistant?.on !== false
  const rtcOn = kelabo?.capabilities?.rtc?.on !== false
  const sttProvider = kelabo?.capabilities?.stt?.provider

  // Take the provider's preferred default for silence skipping, once, and only
  // for somebody who has never expressed one. The gate saves real money on a
  // provider that bills the audio it receives; on one that bills the open
  // stream it saves nothing and removes the pauses its diarizer uses to tell
  // speakers apart. The provider is the only thing that knows which it is.
  const vadDefaulted = useRef(false)
  useEffect(() => {
    if (vadDefaulted.current || !sttProvider) return
    vadDefaulted.current = true
    if (localStorage.getItem('kelabo-vad') !== null) return
    try {
      setVad(sttClient(sttProvider).prefersVad)
    } catch {
      // A provider this build does not carry: leave the toggle where it is.
    }
  }, [sttProvider])
  // Same precedence as everywhere else: the user's chosen name beats the
  // server identity, which is only ever the email local-part.
  const me = localStorage.getItem('kelabo-name') || displayName(identity)

  const [streamStatus, setStreamStatus] = useState('connecting')
  // May this participant see the spoken transcript? The server says so on every
  // history response; until it does, assume yes — on self-hosted deployments
  // that is always the answer, and a guest on a withholding deployment merely
  // sees the Transcript tab disappear after the first fetch. The server never
  // sent them speech either way; this only controls what the panel offers.
  const [transcriptAccess, setTranscriptAccess] = useState(true)
  // Backward paging through persisted messages. The cursor tracks the OLDEST
  // row seen so far: reconnect backfills re-fetch the newest page, whose
  // cursor must never drag the pager forward again.
  const historyCursor = useRef({ nextBefore: '', hasMore: false })
  const [historyPager, setHistoryPager] = useState({ hasMore: false, loading: false })
  // Live agent presence from the SSE `agent` event (docs 16). `null` until one
  // arrives, at which point it supersedes whatever the META said at page load.
  const [agent, setAgent] = useState(null)
  // Live headcount from the SSE `roster` event: distinct identities holding a
  // stream on this kelabo right now. `null` until the first one arrives.
  const [roster, setRoster] = useState(null)
  // `gateStats()` is a getter, not state — sampled while the drawer is open so
  // the VAD readout stays live without re-rendering the room every frame.
  const [gateStats, setGateStats] = useState(null)

  const handleEnded = useCallback(() => setEnded(true), [])
  const onDebugEvent = useCallback(entry => {
    if (!debugEnabledRef.current) return
    setDebugEntries(prev => [...prev.slice(-99), entry])
  }, [])

  const micEnabled = !boardOnly && !ended && !!kelabo
  const onCall = !boardOnly && !ended
  // One getUserMedia for the whole kelabo, shared by the Deepgram pipeline and
  // the conference transport (see spa/src/rtc/useMicStream.js). Echo
  // cancellation is never turned off here: without it every remote voice coming
  // out of the speakers is picked up again by this mic and transcribed a second
  // time under this participant's name.
  const mic = useMicStream({ enabled: micEnabled, deviceId: entry.micDevice })
  // The camera is opt-in and independent of the mic: it starts off, and turning
  // it off releases the device rather than sending black frames.
  const cam = useCameraStream({ enabled: onCall && !!kelabo, initialOn: entry.camera })
  // Sharing is off until asked for, and the browser's own "Stop sharing" bar
  // is authoritative — see useScreenShare.
  const screen = useScreenShare({ enabled: onCall && !!kelabo })
  // Which output the call plays through ('' = system default). The one device
  // the room used to decide silently.
  const speaker = useSpeakerDevice()

  const capture = useCapture({
    kelaboId: id,
    enabled: micEnabled && sttOn,
    finalOnly,
    startedAt: kelabo?.startedAt,
    language: sttLang,
    diarize,
    displayName: me,
    // The participant identity from the server, NOT the signed-in email: a guest
    // has no email, so comparing against `identity.email` left it empty and every
    // guest saw their own utterances echoed back as though a second person had
    // said them. Hosts are always signed in, which is why this only showed up
    // for non-host participants.
    myIdentity: kelabo?.me || identity?.email || '',
    stream: mic.stream,
    micError: mic.error,
    vad,
    startMuted: entry.muted,
  })

  // Muting because the tab went to the background mutes the call as well as the
  // transcript — `capture.muted` is what useRtc gates the outgoing track on —
  // which is the whole point: nobody hears the other thing you are doing.
  const hiddenMuteHeld = useHiddenMute({
    enabled: muteHidden && micEnabled,
    muted: capture.muted,
    mute: capture.mute,
    unmute: capture.unmute,
  })

  const call = useRtc({
    kelaboId: id,
    enabled: onCall && !!kelabo && rtcOn,
    stream: mic.stream,
    videoStream: cam.stream,
    screenStream: screen.stream,
    muted: capture.muted,
    streamLive: streamStatus === 'live',
    sinkId: speaker.deviceId,
  })

  // A share the Gateway refused — a mesh room at its participants-plus-shares
  // cap — must release the browser capture too, or the browser's own
  // "sharing" bar keeps promising something nobody receives.
  useEffect(() => {
    if (call.screenDenied) screen.stop()
  }, [call.screenDenied, screen.stop])

  // Fold one history response in: seed the transcript, adopt the entitlement
  // flag, and advance the backward cursor — but only to something OLDER than
  // what we already hold, so a reconnect's newest-page refetch cannot reset
  // the pager a reader has been walking backwards.
  const adoptHistory = h => {
    if (typeof h?.transcriptAccess === 'boolean') setTranscriptAccess(h.transcriptAccess)
    capture.seedHistory?.(h?.utterances)
    const cur = historyCursor.current
    if (h?.nextBefore && (!cur.nextBefore || h.nextBefore < cur.nextBefore)) {
      historyCursor.current = { nextBefore: h.nextBefore, hasMore: !!h.hasMore }
      setHistoryPager(p => ({ ...p, hasMore: !!h.hasMore }))
    }
  }

  const loadEarlierMessages = useCallback(async () => {
    const cur = historyCursor.current
    if (!cur.hasMore || !cur.nextBefore) return
    setHistoryPager(p => ({ ...p, loading: true }))
    try {
      adoptHistory(await getCaptionHistory(id, { before: cur.nextBefore }))
    } catch {
      // Leave hasMore as it was — the button stays and the next click retries.
    } finally {
      setHistoryPager(p => ({ ...p, loading: false }))
    }
  }, [id]) // eslint-disable-line react-hooks/exhaustive-deps

  // The kelabo's one EventSource. Everything the server pushes rides it —
  // contributions, transcript echo, LLM debug, conference signalling — so it is
  // mounted here, once, above every view that reads from it.
  //
  // The identity the stream knows this participant by. Roster and utterance
  // events carry it, and the sound hooks compare against it so your own
  // arrivals and messages never chime back at you.
  const myIdentityRef = useRef('')
  myIdentityRef.current = kelabo?.me || identity?.email || ''
  // That snapshot is "who was already here", not a wave of joins — and after a
  // resubscribe the same holds again, which is also what swallows your own
  // reconnect flapping inside the server's grace window.
  const rosterIdsRef = useRef(null)

  const onRosterEvent = useCallback(r => {
    setRoster(r)
    const next = Array.isArray(r?.participants) ? r.participants : []
    const prev = rosterIdsRef.current
    rosterIdsRef.current = next
    if (!prev) return
    const { joined, left } = rosterDiff(prev, next, myIdentityRef.current)
    if (joined.length) playEventSound('join')
    if (left.length) playEventSound('leave')
  }, [])

  const onUtteranceEvent = useCallback(utt => {
    // Sealed remote messages only — live partial fragments stream constantly
    // while someone talks, and your own echo comes back down the same event.
    if (shouldChimeUtterance(utt, myIdentityRef.current)) playEventSound('message')
    capture.addRemoteUtterance(utt)
  }, [capture.addRemoteUtterance])

  const board = useBoard({
    kelaboId: id,
    ended,
    onEnded: handleEnded,
    onRename: capture.renameSpeaker,
    onUtterance: onUtteranceEvent,
    onHistory: h => adoptHistory(h),
    onDebug: onDebugEvent,
    onRtc: call.onServerEvent,
    onAgent: setAgent,
    onRoster: onRosterEvent,
    onStreamStatus: setStreamStatus,
    authorName: me,
  })

  useEffect(() => {
    api.getKelabo(id)
      .then(m => {
        setKelabo(m)
        if (m.status === 'ended') setEnded(true)
      })
      .catch(() => setLoadError(true))
  }, [id])

  // Only while the drawer is open: sampling a getter every second for a panel
  // nobody is looking at is pure waste.
  useEffect(() => {
    if (!debugOpen) return undefined
    const sample = () => setGateStats(capture.gateStats())
    sample()
    const t = setInterval(sample, 1000)
    return () => clearInterval(t)
  }, [debugOpen]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const load = () => {
      api.getKelabo(id)
        .then(m => {
          setKelabo(prev => ({ ...prev, ...m }))
          if (m.status === 'ended') setEnded(true)
        })
        .catch(() => {})
    }
    const t = setInterval(load, 10000)
    return () => clearInterval(t)
  }, [id])

  useEffect(() => {
    if (ended && capture.state !== 'ended' && capture.state !== 'idle') capture.stop()
  }, [ended]) // eslint-disable-line react-hooks/exhaustive-deps

  const onFinalOnlyChange = v => {
    setFinalOnly(v)
    localStorage.setItem('kelabo-final-only', v ? '1' : '0')
    pushSettings()
  }

  const onSttLangChange = v => {
    setSttLang(v)
    localStorage.setItem('kelabo-stt-lang', v)
    pushSettings()
  }

  const onMuteHiddenChange = v => {
    setMuteHidden(v)
    localStorage.setItem('kelabo-mute-hidden', v ? '1' : '0')
    pushSettings()
  }

  const onVadChange = v => {
    setVad(v)
    localStorage.setItem('kelabo-vad', v ? '1' : '0')
    pushSettings()
  }

  // Opening and closing the drawer. NOT the same thing as turning debugging on
  // and off, though it used to be: closing the panel wrote `kelabo-debug: 0`,
  // which stopped capture, removed the toolbar button that was the only way
  // back in, and did not survive the reload the person was usually in the
  // middle of diagnosing. Somebody who reloads to reproduce a bug lands on an
  // open panel, closes it because it is in the way, and has silently switched
  // off the instrument they came for.
  const toggleDebug = () => {
    const open = !debugOpen
    setDebugOpen(open)
    // Don't leave the panel full-screen for the next time it opens.
    if (!open) setDebugFullscreen(false)
  }

  // Turning the instrument off, deliberately. The flag is what survives a
  // reload, so this is the only thing that may write it.
  const disableDebug = () => {
    setDebugOpen(false)
    setDebugEnabled(false)
    debugEnabledRef.current = false
    setDebugFullscreen(false)
    setDebugEntries([])
    localStorage.setItem('kelabo-debug', '0')
  }

  const hostIdentity = kelabo?.hostIdentity
  const isHost = !!(identity && hostIdentity && identity.email === hostIdentity)

  useEffect(() => {
    if (authLoading || !kelabo || kelabo.hostJoinedAt || startAttemptedRef.current) return
    startAttemptedRef.current = true
    if (isHost) {
      api.startKelabo(id)
        .then(r => setKelabo(prev => (prev ? { ...prev, hostJoinedAt: r.hostJoinedAt } : prev)))
        .catch(() => {})
    } else {
      navigate(`/m/${id}/lobby`, { replace: true })
    }
  }, [authLoading, kelabo, isHost, id]) // eslint-disable-line react-hooks/exhaustive-deps

  // `agent` is the live SSE state; the kelabo META is the value at page load.
  // Live wins, because it is the one that changes while someone is watching —
  // and an agent dropping mid-kelabo used to be entirely invisible (docs 16).
  const agentPresent = agent ? agent.attached : !!kelabo?.isDeveloperPresent
  const agentLabel = agent?.label || agent?.runtime || kelabo?.agentLabel || kelabo?.agentRuntime || ''
  // The kelabo META's `participants` is an append-only join ledger — nobody is
  // ever removed from it — so it answers "who has ever been here". That is the
  // right number for a kelabo that is over, and the wrong one for a live room,
  // where it only ever climbs and two people who both left still read "2".
  // While the kelabo is live the answer comes from the `roster` SSE event, and
  // until the first one arrives there is nothing honest to show: `null` hides
  // the chip rather than guessing.
  const everJoinedCount = kelabo?.participantCount ?? (kelabo?.participants || []).length
  const participantCount = ended ? everJoinedCount : (roster ? roster.count : null)

  // Nothing is minted until this opens — a code the room never showed anybody
  // would still be a live code, and still count against the room's hourly cap.
  const [inviteOpen, setInviteOpen] = useState(false)

  const leave = () => {
    navigate(identity ? '/' : '/login')
  }

  /**
   * Going back out of a live kelabo, with a question first.
   *
   * `Leave` in the top-right is unambiguous and stays one click. This is for
   * every other way out — the back arrow, and the browser's own Back — where
   * the intent is "return to the previous page" and quitting the kelabo is a
   * side effect the person did not necessarily ask for. Once it has ended there
   * is nothing left to quit, so it just navigates.
   */
  const confirmLeave = useCallback(async () => {
    if (ended) return true
    return confirm({
      title: 'Leave this kelabo?',
      body: isHost
        ? 'The kelabo carries on without you and everyone else stays in it. To finish it for everyone, use End kelabo instead.'
        : 'The kelabo carries on without you. You can come back from the same link.',
      confirmLabel: 'Leave',
      cancelLabel: 'Stay',
      icon: 'logout',
      danger: false,
    })
  }, [confirm, ended, isHost])

  const back = async () => {
    if (await confirmLeave()) leave()
  }

  // The browser's own Back gets the same question the arrow does (notes #2).
  // The reload/close prompt stands down while the call is in `error`: with the
  // call already down there is nothing a reload loses, and it used to tax the
  // exact action that recovers.
  useLeaveGuard({ enabled: !ended, unloadEnabled: !ended && call.state !== 'error', confirm: confirmLeave, onLeave: leave })

  const endKelabo = async () => {
    const ok = await confirm({
      title: 'End kelabo?',
      body: `The kelabo ends for all ${participantCount || ''} participants. ${
        assistantOn
          ? 'The agent will generate minutes and the record will be archived.'
          : 'The record will be archived.'
      }`,
      confirmLabel: 'End kelabo',
    })
    if (!ok) return
    try {
      const res = await api.endKelabo(id)
      // The kelabo always ends; the record does not always get written. Say
      // which happened rather than promising an archive that is not there —
      // the host is the only person who can ask for it again.
      if (res?.archived === false) setArchiveFailed(true)
      // Promise minutes only where an agent exists to write them (docs 19 §2).
      else toast(assistantOn ? 'Kelabo ended — minutes generating…' : 'Kelabo ended — record archived')
      setEnded(true)
    } catch {
      toast('Could not end the kelabo')
    }
  }

  const retryArchive = async () => {
    try {
      const res = await api.endKelabo(id)
      if (res?.archived === false) {
        toast('Still could not save the record')
        return
      }
      setArchiveFailed(false)
      toast('Record saved')
    } catch {
      toast('Still could not save the record')
    }
  }

  return (
    <>
      <RoomShell
        kelabo={loadError ? { title: 'Kelabo' } : kelabo}
        kelaboId={id}
        me={me}
        isHost={isHost}
        ended={ended}
        archive={{ failed: archiveFailed, onRetry: retryArchive }}
        boardOnly={boardOnly}
        agentPresent={agentPresent}
        agentLabel={agentLabel}
        participantCount={participantCount}
        capture={capture}
        call={call}
        mic={mic}
        cam={cam}
        screen={screen}
        speaker={speaker}
        board={board}
        diarize={diarize}
        transcriptAccess={transcriptAccess}
        history={{ hasMore: historyPager.hasMore, loading: historyPager.loading, onLoadEarlier: loadEarlierMessages }}
        stt={{
          lang: sttLang,
          onLang: onSttLangChange,
          diarize,
          onDiarize: setDiarize,
          vad,
          onVad: onVadChange,
          finalOnly,
          onFinalOnly: onFinalOnlyChange,
        }}
        micPrefs={{
          muteHidden,
          onMuteHidden: onMuteHiddenChange,
          held: hiddenMuteHeld,
        }}
        onToggleDebug={toggleDebug}
        debugOn={debugEnabled}
        onInvite={() => setInviteOpen(true)}
        onLeave={leave}
        onBack={back}
        onEndKelabo={endKelabo}
        onToggleTheme={() => { toggleTheme(); setIcon(themeIcon()); pushSettings() }}
        onScheme={id => { setSchemeState(setScheme(id)); pushSettings() }}
        scheme={scheme}
        themeIcon={icon}
      />

      <InviteDialog kelaboId={id} open={inviteOpen} onClose={() => setInviteOpen(false)} />

      {ended && (
        <Modal
          open
          label="Kelabo ended"
          badge={<span className="modal-icon modal-icon-neutral"><Icon name="check" /></span>}
          title="Kelabo ended"
          actions={
            <>
              {identity && (
                <Button as={Link} variant="primary" to={`/kelabos/${id}`}>Open kelabo</Button>
              )}
              <Button as={Link} variant="ghost" to={identity ? '/' : '/login'}>{identity ? 'Back home' : 'Back to sign in'}</Button>
            </>
          }
        >
          <p className="modal-body">
            This kelabo has ended
            {board.contributions.length
              ? ` with ${board.contributions.length} board contribution${board.contributions.length === 1 ? '' : 's'}`
              : ''}.
            {identity
              ? assistantOn
                ? ' The record and minutes will be archived shortly.'
                : ' The record will be archived shortly.'
              : ''}
          </p>
        </Modal>
      )}

      <Drawer
        open={debugOpen}
        onClose={toggleDebug}
        title="LLM debug"
        titleChip={<span className="chip chip-accent">{debugEntries.length}</span>}
        fullscreen={debugFullscreen}
        onToggleFullscreen={setDebugFullscreen}
        // The one drawer worth resizing: it is read side by side with the room
        // rather than instead of it, so fullscreen is the wrong tool half the
        // time — you want it wide enough for a JSON payload while still
        // watching who is talking.
        resizable
        widthKey="kelabo-debug-width"
      >
        {/* Mounted only while debug is on. `Drawer` renders its children
            whether or not it is open, and the Transcript ledger draws a row per
            message straight off the live transcript — so leaving it mounted
            behind a closed drawer meant rebuilding forty rows every time anyone
            said a word, for a panel nobody was looking at. */}
        {debugEnabled && (
          <>
            <DebugPanel
              entries={debugEntries}
              onClear={() => setDebugEntries([])}
              onDisable={disableDebug}
              gateStatsPoll={capture.gateStats}
              gateLevel={capture.gateLevel}
              captureDiag={capture.captureDiag}
              onThreshold={capture.setGateThreshold}
              // The drawer renders its children whether or not it is open, so
              // the live meters need telling — a rAF loop behind a closed panel
              // is a rAF loop nobody is looking at.
              active={debugOpen}
              gateStats={gateStats}
              messages={capture.messages}
            />
            <CallLogPanel />
          </>
        )}
      </Drawer>
    </>
  )
}
