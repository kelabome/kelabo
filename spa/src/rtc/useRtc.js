import { useCallback, useEffect, useRef, useState } from 'react'
import { rtc as rtcApi } from '../api'
import { config } from '../config'
import { createSfuTransport } from './sfuTransport'
import { createMeshTransport } from './meshTransport'
import { withRetry } from './retry.js'
import { iceRefreshDelayMs, joinRetryDelayMs, hasTurnServers } from './recovery.js'
import { callLog } from './callLog.js'

const LOG = 'call'

// How long the call outlives a dropped SSE stream before tearing down. Must
// stay BELOW the Gateway's rtc.disconnectGraceSeconds (default 20s): a client
// that holds its session past the server's eviction is a ghost — its peer
// record is gone and every /rtc call answers 409. Inside the window the
// transport keeps running; EventSource reconnects on its own and the
// reconcile loop repairs whatever drifted.
const STREAM_GRACE_MS = 15_000

// The conference call, independent of which transport carries it.
//
// Both transports expose `setLocalTrack(kind, track|null)` and report remote
// tracks through one callback, so everything above this line — the roster, the
// tiles, the mute button — is identical for `sfu` and `mesh`. Audio and video
// are published through exactly the same call; the only difference between them
// is that the camera track comes and goes.
//
// Signalling arrives on the kelabo's existing SSE stream (room/useBoard.js owns
// the EventSource and forwards `rtc` events here via `onServerEvent`), so a call
// adds no new connection.

/**
 * @param {{ kelaboId: string, enabled: boolean, stream: MediaStream|null,
 *           videoStream?: MediaStream|null, muted?: boolean,
 *           streamLive?: boolean }} opts
 */
export function useRtc({ kelaboId, enabled, stream, videoStream = null, screenStream = null, muted = false, streamLive = false, sinkId = '' }) {
  const [state, setState] = useState('idle') // idle | joining | live | full | unavailable | error
  const [mode, setMode] = useState(null)
  const [peers, setPeers] = useState([])
  const [error, setError] = useState(null)
  const [meshMax, setMeshMax] = useState(0)
  // Whether this deployment allows publishing a camera (config.rtc.video,
  // delivered on /rtc/join). Nothing about the transports depends on it — it is
  // the room's cue to not offer a control that would publish an unwanted track.
  //
  // Starts TRUE and only a server that explicitly says `video: false` turns it
  // off. Defaulting to false meant "we have not joined yet" and "the call is
  // unavailable" both read as "this deployment forbids video", which disabled
  // the camera button before anyone could press it — so the browser was never
  // asked for permission and there was nothing to see but a dead control.
  const [videoAllowed, setVideoAllowed] = useState(true)
  // participantId -> MediaStream of their remote camera and microphone.
  const [remoteStreams, setRemoteStreams] = useState(new Map())
  // participantId -> MediaStream of their shared screen, kept apart from the
  // above because a screen share is its own surface in the room, not a second
  // picture of the person sharing it.
  const [remoteScreens, setRemoteScreens] = useState(new Map())
  // RTCPeerConnection state, per peer in mesh and under '*' for the SFU's single
  // connection. Without this a tile can only say "no stream yet", which reads as
  // "connecting…" forever when the truth is that ICE failed.
  const [peerStates, setPeerStates] = useState(new Map())
  // Browsers block autoplay of remote audio until the page has been interacted
  // with; when that happens the UI offers a button that calls `unblock`.
  const [needsUnblock, setNeedsUnblock] = useState(false)
  // Bumped to rebuild the whole call around a new session. The join effect
  // keys on it, so this tears the transport down and rejoins exactly as a page
  // reload would — which until now was the only way out of a dead session, and
  // nobody was ever told to try it.
  const [generation, setGeneration] = useState(0)
  // Peers whose SSE stream dropped and whose seat the Gateway is holding open
  // (`peer_away` … `peer_back`). Their tiles read "reconnecting" instead of
  // vanishing and reappearing.
  const [awayPeers, setAwayPeers] = useState(new Set())
  // Why the last screen share attempt was refused: 'full' (mesh room at
  // capacity) or 'error'. Sticky until the next attempt, so the room can both
  // stop the capture and explain itself.
  const [screenDenied, setScreenDenied] = useState(null)
  // The join gate. Follows `streamLive` up immediately, but follows it *down*
  // only after STREAM_GRACE_MS — so an SSE blip no longer tears the whole
  // call down and rejoins (the churn everyone else saw as a leave/join).
  // The initial join still strictly waits for the stream: the SSE subscription
  // MUST precede /rtc/join, because the old stream's close observed between a
  // rejoin and its subscribe would evict the seat the rejoin just took. That
  // ordering is load-bearing.
  const [callGate, setCallGate] = useState(false)

  const transportRef = useRef(null)
  const selfIdRef = useRef('')
  const peersRef = useRef(new Map())
  const audioElsRef = useRef(new Map())
  // participantId -> the one MediaStream we own for them. Held in a ref, not
  // state, so the object identity survives every re-render: the <audio> element
  // playing it and the <video> showing it both hold onto it by reference.
  const streamsRef = useRef(new Map())
  const screensRef = useRef(new Map())

  const syncPeers = useCallback(() => setPeers([...peersRef.current.values()]), [])

  // A rebuild is a teardown that must NOT tell the Gateway we left: `/rtc/leave`
  // and the `/rtc/join` that follows it are two independent requests, and the
  // leave losing that race deletes the seat the rejoin just took. Rejoining is
  // idempotent — the Gateway reuses the existing peer record — so the quiet
  // path is simply not to send it.
  const rebuildingRef = useRef(false)
  const rebuildsRef = useRef(0)
  const rebuildTimerRef = useRef(null)
  // Join-failure retry: attempt counter and pending timer. `error` means
  // "retrying in the background", never "gave up forever".
  const joinAttemptsRef = useRef(0)
  const retryTimerRef = useRef(null)
  // `rtc` SSE events that arrived during the join await, when there is no
  // transport yet. A `peer_joined` lost in that window used to leave a peer
  // who never spoke and never toggled anything invisible forever.
  const pendingEventsRef = useRef([])
  const joiningRef = useRef(false)
  const onServerEventRef = useRef(null)
  const gateTimerRef = useRef(null)
  const iceTtlRef = useRef(0)
  const announcedScreenRef = useRef(false)
  const tickCountRef = useRef(0)

  /**
   * The session is gone and cannot be revived. Build a new one.
   *
   * Backed off and capped, because the same symptom is also what a network that
   * will not carry a call at all looks like — and rebuilding in a tight loop is
   * worse than sitting still, for this participant and for everyone else, whose
   * roster churns on every attempt. Once the attempts are spent the call says
   * so instead of pretending to be live.
   */
  const onFatal = useCallback(err => {
    if (rebuildTimerRef.current) return
    if (rebuildsRef.current >= 3) {
      callLog.error(LOG, 'rebuild budget spent — call is down', err)
      setError(err)
      setState('error')
      return
    }
    const attempt = rebuildsRef.current++
    callLog.warn(LOG, `fatal from transport — rebuilding call`, { attempt: attempt + 1, err: String(err?.message ?? err) })
    rebuildTimerRef.current = setTimeout(() => {
      rebuildTimerRef.current = null
      // Set when the timer FIRES, not when it was scheduled: a participant who
      // left the kelabo during the backoff window would otherwise have their
      // real leave silently swallowed by the rebuild flag, stranding a ghost.
      rebuildingRef.current = true
      setGeneration(g => g + 1)
    }, 1000 * 2 ** attempt)
  }, [])

  // The Gateway no longer has our seat — it said so (`peer_left` addressed to
  // us, or a 409 from /rtc/media). The old behaviour was to ignore both, which
  // left this tab a ghost: its own tiles kept playing, everyone else had
  // removed it, and no code path ever reconsidered. Rejoin cleanly; sending
  // /rtc/leave for a seat that is already gone would only race the rejoin.
  const rejoinAfterEviction = useCallback(() => {
    if (rebuildTimerRef.current || retryTimerRef.current) return
    callLog.warn(LOG, 'seat gone (evicted) — rejoining')
    rebuildingRef.current = true
    setGeneration(g => g + 1)
  }, [])

  useEffect(
    () => () => {
      clearTimeout(rebuildTimerRef.current)
      clearTimeout(retryTimerRef.current)
      clearTimeout(gateTimerRef.current)
    },
    [],
  )

  // The join gate follows streamLive up at once and down only after the grace
  // window (see STREAM_GRACE_MS above).
  useEffect(() => {
    if (streamLive) {
      if (gateTimerRef.current) {
        clearTimeout(gateTimerRef.current)
        gateTimerRef.current = null
      }
      setCallGate(true)
      return undefined
    }
    if (!callGate) return undefined
    gateTimerRef.current = setTimeout(() => {
      gateTimerRef.current = null
      setCallGate(false)
    }, STREAM_GRACE_MS)
    return () => {
      if (gateTimerRef.current) {
        clearTimeout(gateTimerRef.current)
        gateTimerRef.current = null
      }
    }
  }, [streamLive, callGate])

  // The stream came back inside the window: the transport survived, but events
  // may have been missed while it was gone — reconcile now rather than in up
  // to ten seconds.
  useEffect(() => {
    if (streamLive && state === 'live') {
      transportRef.current?.reconcile?.([...peersRef.current.values()])
    }
  }, [streamLive, state])

  /**
   * A remote track arrived. It joins that participant's stream — it never
   * becomes it.
   *
   * This used to adopt `ev.streams[0]` when the browser offered one. The SFU
   * gives every pulled track its own msid, so each arriving track came with a
   * *different* stream object and replaced the participant's previous one:
   * pulling someone's camera swapped out the very MediaStream their microphone
   * was playing through, and their audio stopped. One slot per participant,
   * last track wins — which is exactly why a two-person call could have two
   * microphones or one camera and one microphone, but never both cameras and
   * both microphones.
   *
   * So the stream is ours. `streams` is ignored for composition and the track
   * is added to the participant's stream, replacing any earlier track of the
   * same media kind (a republish) rather than accumulating dead ones.
   */
  const attachRemote = useCallback(({ participantId, kind, track }) => {
    callLog.info(LOG, `remote ${kind} attached: ${participantId}`, { trackId: track.id })
    const screen = kind === 'screen'
    const store = screen ? screensRef.current : streamsRef.current
    const publish = screen ? setRemoteScreens : setRemoteStreams
    let ms = store.get(participantId)
    if (!ms) {
      ms = new MediaStream()
      store.set(participantId, ms)
    }

    for (const existing of ms.getTracks()) {
      if (existing.kind === track.kind && existing.id !== track.id) ms.removeTrack(existing)
    }
    if (!ms.getTracks().some(t => t.id === track.id)) ms.addTrack(track)

    // A track that ends leaves the stream, so a tile falls back to the avatar
    // instead of holding a frozen last frame forever.
    track.addEventListener('ended', () => {
      const current = store.get(participantId)
      if (!current) return
      if (current.getTracks().some(t => t.id === track.id)) current.removeTrack(track)
      // A screen share that ends should leave no tile behind at all, unlike a
      // camera, where the person is still in the room.
      if (screen && !current.getTracks().length) store.delete(participantId)
      publish(new Map(store))
    }, { once: true })

    // The Map is new so React re-renders; the MediaStreams inside it are not,
    // so nothing that is already playing gets re-attached.
    publish(new Map(store))
  }, [])

  // --- join / leave ---------------------------------------------------------
  useEffect(() => {
    // Wait for the SSE stream (via callGate): it is both how signalling
    // arrives and how the Gateway notices we left, so joining without it would
    // strand a ghost peer in the roster. Once live, callGate holds through
    // brief stream drops so the call itself does not churn.
    if (!enabled || !kelaboId || !callGate) return undefined

    let cancelled = false
    setState('joining')
    joiningRef.current = true
    pendingEventsRef.current = []
    callLog.info(LOG, `joining call (generation ${generation})`)

    ;(async () => {
      let info
      try {
        // Retried like every other signalling call — one 502 that happened to
        // be in flight when the network moved is the most common transient
        // failure there is, and it used to be terminal.
        info = await withRetry(() => rtcApi.join(kelaboId))
      } catch (err) {
        joiningRef.current = false
        callLog.error(LOG, 'join failed', { code: err?.code, status: err?.status, message: err?.message })
        if (cancelled) return
        if (err?.code === 'mesh_room_full') {
          setMeshMax(err.meshMax ?? 0)
          setState('full')
        } else if (err?.code === 'rtc_unavailable') {
          setState('unavailable')
        } else {
          setError(err)
          setState('error')
          // `error` retries itself on a capped backoff (and immediately on
          // window `online` / tab return — see the effect below).
          const attempt = joinAttemptsRef.current++
          retryTimerRef.current = setTimeout(() => {
            retryTimerRef.current = null
            rebuildingRef.current = true
            setGeneration(g => g + 1)
          }, joinRetryDelayMs(attempt))
        }
        return
      }
      if (cancelled) {
        joiningRef.current = false
        return
      }

      joinAttemptsRef.current = 0
      selfIdRef.current = info.self.participantId
      iceTtlRef.current = Number(info.ttlSeconds) || 0
      callLog.info(LOG, `joined — mode ${info.mode}`, {
        self: info.self.participantId,
        peers: info.peers.length,
        iceServers: info.iceServers?.length ?? 0,
        turn: hasTurnServers(info.iceServers),
        iceTtlSeconds: iceTtlRef.current,
        video: info.video !== false,
      })
      setMode(info.mode)
      setMeshMax(info.meshMax ?? 0)
      setVideoAllowed(info.video !== false)
      peersRef.current = new Map(info.peers.map(p => [p.participantId, p]))
      syncPeers()

      const common = {
        kelaboId,
        iceServers: info.iceServers,
        onRemoteTrack: attachRemote,
        onError: err => setError(err),
        onFatal,
        // `participantId` is null for the SFU, whose single PeerConnection
        // carries everyone; mesh reports per peer.
        onStateChange: (participantId, connState) => {
          // A connection that came up is a rebuild that worked, so the budget
          // refills: three tries in a row is a network that cannot carry a
          // call, but three over an hour-long kelabo is just an hour-long
          // kelabo, and the second must not spend the allowance of the first.
          if (connState === 'connected') rebuildsRef.current = 0
          setPeerStates(prev => {
            const next = new Map(prev)
            next.set(participantId ?? '*', connState)
            return next
          })
        },
      }
      const transport =
        info.mode === 'mesh'
          ? createMeshTransport({ ...common, selfId: info.self.participantId })
          : createSfuTransport(common)
      transportRef.current = transport
      joiningRef.current = false
      announcedScreenRef.current = false
      setAwayPeers(new Set())
      setState('live')

      // Whatever the room said while the join was in flight, said again now
      // that there is a transport to hear it.
      for (const p of pendingEventsRef.current.splice(0)) onServerEventRef.current?.(p)

      // Whoever was already publishing when we walked in is picked up by the
      // reconciler's first tick rather than here — one code path for "was
      // already here" and "arrived later" instead of two.
      //
      // This used to be load-bearing for a different reason: a pull could not
      // be the first operation on a new SFU session, so publishing had to win.
      // That guarantee was unenforceable — it rested on `getUserMedia`
      // resolving before the first reconcile tick, which on a reload it does
      // not, and on the participant having granted a microphone at all. The
      // session now negotiates when it is created (see `ensureSession` in
      // sfuTransport.js), so nothing here depends on the order any more.
      if (transport.mode === 'mesh') {
        for (const p of info.peers) transport.connectTo(p.participantId)
      }
    })()

    return () => {
      cancelled = true
      joiningRef.current = false
      pendingEventsRef.current = []
      transportRef.current?.close()
      transportRef.current = null
      peersRef.current = new Map()
      streamsRef.current = new Map()
      screensRef.current = new Map()
      setPeers([])
      setRemoteStreams(new Map())
      setRemoteScreens(new Map())
      setPeerStates(new Map())
      setAwayPeers(new Set())
      setState('idle')
      if (rebuildingRef.current) rebuildingRef.current = false
      else {
        callLog.info(LOG, 'left call')
        rtcApi.leave(kelaboId).catch(() => {})
      }
    }
  }, [enabled, kelaboId, callGate, generation, attachRemote, syncPeers, onFatal])

  // `error` must never be terminal: past the retry timer above, the two
  // moments worth reacting to are the network coming back and the user coming
  // back — both are exactly when a rejoin is most likely to work and most
  // likely to be noticed failing.
  useEffect(() => {
    if (state !== 'error') return undefined
    const kick = () => {
      if (retryTimerRef.current) {
        clearTimeout(retryTimerRef.current)
        retryTimerRef.current = null
      }
      rebuildingRef.current = true
      setGeneration(g => g + 1)
    }
    const onOnline = () => kick()
    const onVisible = () => {
      if (document.visibilityState === 'visible') kick()
    }
    window.addEventListener('online', onOnline)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      window.removeEventListener('online', onOnline)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [state])

  // The rebuild budget also refills with time, not only on `connected`: once
  // `error` was reached with the budget spent, a network that recovered a
  // minute later used to find a call that had given up forever.
  useEffect(() => {
    if (state !== 'live' && state !== 'error') return undefined
    const t = setInterval(() => {
      rebuildsRef.current = Math.max(0, rebuildsRef.current - 1)
    }, 60_000)
    return () => clearInterval(t)
  }, [state])

  // --- ICE credential refresh ----------------------------------------------
  // Minted at join with a TTL (default 1h) and, until now, never refreshed:
  // /rtc/ice existed with zero call sites, so every ICE restart past the hour
  // gathered with dead TURN credentials and failed on exactly the networks
  // that needed the relay. Re-minted at 80% of TTL and pushed into the live
  // transport.
  useEffect(() => {
    if (state !== 'live') return undefined
    let stopped = false
    let timer = null
    const schedule = ttlSeconds => {
      timer = setTimeout(async () => {
        let out = null
        try {
          out = await rtcApi.ice(kelaboId)
        } catch (err) {
          callLog.warn(LOG, 'ICE re-mint failed', { message: err?.message })
        }
        if (stopped) return
        if (Array.isArray(out?.iceServers) && out.iceServers.length) {
          callLog.debug(LOG, 'ICE credentials re-minted', { ttlSeconds: out.ttlSeconds })
          transportRef.current?.setIceServers?.(out.iceServers)
          schedule(Number(out.ttlSeconds) || 0)
        } else {
          // A failed re-mint retries on iceRefreshDelayMs's short floor.
          schedule(0)
        }
      }, iceRefreshDelayMs(ttlSeconds))
    }
    schedule(iceTtlRef.current)
    return () => {
      stopped = true
      clearTimeout(timer)
    }
  }, [state, kelaboId])

  // --- leave beacon ---------------------------------------------------------
  // The effect cleanup above runs on in-app navigation but never on a killed
  // tab or a hard close; those used to leave a ghost on the roster until the
  // Gateway noticed the SSE socket die. `/rtc/leave` is idempotent, so racing
  // the SSE-close eviction is safe. text/plain keeps the beacon a simple
  // request — a preflight is exactly what a dying page cannot do.
  useEffect(() => {
    if (state !== 'live' || !kelaboId) return undefined
    const onPageHide = () => {
      if (rebuildingRef.current) return
      try {
        navigator.sendBeacon?.(
          config.gatewayBase + '/rtc/leave',
          new Blob([JSON.stringify({ kelaboId })], { type: 'text/plain' }),
        )
      } catch {}
    }
    window.addEventListener('pagehide', onPageHide)
    return () => window.removeEventListener('pagehide', onPageHide)
  }, [state, kelaboId])

  // --- publish local media --------------------------------------------------
  // Runs once the transport is up and the device has been granted. The same
  // audio track the Deepgram pipeline analyses is what peers hear, so there is
  // exactly one device capture (see useMicStream).
  useEffect(() => {
    const transport = transportRef.current
    if (state !== 'live' || !transport) return
    callLog.debug(LOG, `local audio: ${stream?.getAudioTracks()[0] ? 'on' : 'off'}`)
    transport.setLocalTrack('audio', stream?.getAudioTracks()[0] ?? null)
  }, [state, stream])

  // The camera is published the first time it is switched on and then swapped
  // in and out of the same sender. `null` is not a no-op: it is how peers are
  // told the camera went off — and it is also what a deployment with video
  // disabled always sends, so that policy is enforced here rather than only in
  // a control that happens to be hidden.
  useEffect(() => {
    const transport = transportRef.current
    if (state !== 'live' || !transport) return
    const track = videoAllowed ? (videoStream?.getVideoTracks()[0] ?? null) : null
    callLog.debug(LOG, `local video: ${track ? 'on' : 'off'}`)
    transport.setLocalTrack('video', track)
  }, [state, videoStream, videoAllowed])

  // A shared screen is published like the camera — same sender reuse — with
  // one difference: in a mesh room the share must be ADMITTED first. A share
  // is one more uplink to every peer, so it occupies a capacity unit exactly
  // like a participant does, and the Gateway is the only place that count can
  // be enforced. `screen: true` on /rtc/media is that request; a 409
  // `mesh_room_full` means the room is at its limit and nothing is published.
  // The SFU needs no admission — there the report is roster truth only.
  useEffect(() => {
    const transport = transportRef.current
    if (state !== 'live' || !transport) return undefined
    const track = videoAllowed ? (screenStream?.getVideoTracks()[0] ?? null) : null

    if (!track) {
      transport.setLocalTrack('screen', null)
      if (announcedScreenRef.current) {
        announcedScreenRef.current = false
        rtcApi.media(kelaboId, { screen: false }).catch(() => {})
      }
      return undefined
    }

    let cancelled = false
    ;(async () => {
      setScreenDenied(null)
      if (mode === 'mesh') {
        try {
          await withRetry(() => rtcApi.media(kelaboId, { screen: true }))
        } catch (err) {
          if (cancelled) return
          callLog.warn(LOG, 'screen share refused', { code: err?.code })
          if (err?.code === 'peer_not_found') rejoinAfterEviction()
          setScreenDenied(err?.code === 'mesh_room_full' ? 'full' : 'error')
          return
        }
      } else {
        rtcApi.media(kelaboId, { screen: true }).catch(() => {})
      }
      if (cancelled) return
      announcedScreenRef.current = true
      transport.setLocalTrack('screen', track)
    })()
    return () => {
      cancelled = true
    }
  }, [state, screenStream, videoAllowed, mode, kelaboId, rejoinAfterEviction])

  // --- reconcile ------------------------------------------------------------
  // The roster says what everyone publishes; the transport knows what actually
  // arrived. Every so often, compare the two and fix the difference.
  //
  // Without this the whole call rests on each one-shot working first time: the
  // Gateway announces a track once, so a pull that failed on a bad second — or
  // a peer whose `peer_joined` landed while this tab was asleep — stays missing
  // for the rest of the kelabo, and nothing will ever say so. Ten seconds is
  // slow enough to be free and fast enough that nobody finishes a sentence
  // before their microphone catches up.
  //
  // Still declared after the three publish effects, but only for readability
  // now. It used to be load-bearing — the first tick pulls the peers who were
  // already in the room, and a pull could not be the first operation on a new
  // SFU session — but effect order was never a real guarantee: on a reload the
  // microphone has not been acquired yet when these run, so the publish effects
  // published nothing and the pull went first anyway. The session is negotiated
  // when it is created instead.
  useEffect(() => {
    if (state !== 'live') return undefined
    // Membership converges too, not only track delivery: every third tick the
    // authoritative roster is fetched and any drift — a peer_joined lost to a
    // throttled tab, a peer_left that never arrived — is replayed through the
    // same event handler the live stream uses, never a second code path.
    const syncRoster = async () => {
      let out = null
      try {
        out = await rtcApi.roster(kelaboId)
      } catch {
        return
      }
      if (!transportRef.current || !Array.isArray(out?.peers)) return
      const self = selfIdRef.current
      const seen = new Set()
      let selfPresent = false
      for (const p of out.peers) {
        if (!p?.participantId) continue
        if (p.participantId === self) {
          selfPresent = true
          continue
        }
        seen.add(p.participantId)
        const known = peersRef.current.has(p.participantId)
        onServerEventRef.current?.({ kind: known ? 'tracks' : 'peer_joined', peer: p })
      }
      for (const id of [...peersRef.current.keys()]) {
        if (id !== self && !seen.has(id)) {
          callLog.warn(LOG, `roster sync: ${id} gone — synthesising peer_left`)
          onServerEventRef.current?.({ kind: 'peer_left', participantId: id, reason: 'roster_sync' })
        }
      }
      // Our own seat is gone — evicted while we could not hear it. Rejoin.
      if (!selfPresent) {
        callLog.warn(LOG, 'roster sync: our own seat is missing')
        rejoinAfterEviction()
      }
    }
    const tick = () => {
      transportRef.current?.reconcile?.([...peersRef.current.values()])
      if (++tickCountRef.current % 3 === 0) syncRoster()
    }
    tick()
    const t = setInterval(tick, 10000)
    // Also on the way back from a backgrounded tab, where timers were throttled
    // and connections may have been torn down under us — and the moment the
    // network returns, which is when every pull and publish wants re-examining
    // and when the user is watching the call come back.
    const onVisible = () => { if (document.visibilityState === 'visible') tick() }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('online', tick)
    return () => {
      clearInterval(t)
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('online', tick)
    }
  }, [state, kelaboId, rejoinAfterEviction])

  // Muting stops transmission at the source: peers hear nothing, and the track
  // stays in place so unmuting needs no renegotiation.
  useEffect(() => {
    const track = stream?.getAudioTracks()[0]
    if (track) track.enabled = !muted
  }, [muted, stream])

  // ...and tell the room, because that is the half the media cannot carry.
  // `track.enabled = false` is a local decision that never reaches the wire, and
  // a camera switched off is a sender that stopped sending on a transceiver that
  // is still negotiated. To everyone else both look identical to a bad network:
  // a muted peer was indistinguishable from a quiet one, and a camera going off
  // left its last frame frozen on the tile for the rest of the kelabo.
  //
  // Sent on every change including the first, so a peer who joins muted is
  // shown muted rather than having to speak to prove otherwise.
  const cameraOn = !!(videoAllowed && videoStream?.getVideoTracks()[0])
  useEffect(() => {
    if (state !== 'live') return undefined
    // Debounced: the state is absolute, so last-write-wins is safe, and
    // mute-spam otherwise turns into a POST burst that fans a room-wide SSE
    // event per keypress. (The mesh screen admission is deliberately NOT
    // debounced — that one is a capacity request, not a report.)
    const t = setTimeout(() => {
      // A 409 is not noise: it says the Gateway has no seat for us — evicted
      // while we could not hear it — and this once-per-toggle report is a free
      // liveness probe. Swallowing it is what let a ghost tab sit
      // healthy-looking for the rest of the kelabo.
      rtcApi.media(kelaboId, { audio: !muted, video: cameraOn }).catch(err => {
        if (err?.status === 409) rejoinAfterEviction()
      })
    }, 200)
    return () => clearTimeout(t)
  }, [state, kelaboId, muted, cameraOn, rejoinAfterEviction])

  // --- signalling from the kelabo's SSE stream -----------------------------
  // A peer whose event stream dropped is `away` while the Gateway holds their
  // seat open; anything heard from or about them afterwards clears it.
  const clearAway = useCallback(id => {
    setAwayPeers(prev => {
      if (!prev.has(id)) return prev
      const next = new Set(prev)
      next.delete(id)
      return next
    })
  }, [])

  const onServerEvent = useCallback(
    payload => {
      const transport = transportRef.current
      if (!payload) return
      callLog.debug(LOG, `rtc event: ${payload.kind}`, payload.kind === 'signal' ? { type: payload.signal?.type, from: payload.from } : { participantId: payload.participantId ?? payload.peer?.participantId })
      if (!transport) {
        // Mid-join there is no transport yet, but the room is still talking.
        // Hold what it says and replay it once the transport exists — dropping
        // it here left any peer who joined in that window invisible forever.
        if (joiningRef.current && pendingEventsRef.current.length < 200) {
          pendingEventsRef.current.push(payload)
        }
        return
      }
      const self = selfIdRef.current

      // Someone's microphone or camera was switched on or off. Roster-only —
      // no media changes hands, so there is nothing to pull or drop; the tiles
      // read it straight off the peer.
      if (payload.kind === 'media') {
        const p = payload.peer
        if (!p || p.participantId === self) return
        clearAway(p.participantId)
        const known = peersRef.current.get(p.participantId)
        if (!known) return
        peersRef.current.set(p.participantId, { ...known, media: p.media })
        syncPeers()
        return
      }

      // The Gateway moved the whole room onto another transport (see
      // `demote` in gateway/src/rtc/room.js). A transport object cannot become
      // a different kind of transport, so the call is rebuilt rather than
      // patched: the rejoin re-reads the mode, re-mints ICE — which is also
      // how a withdrawn relay actually goes away — and keeps this seat,
      // because `rebuildingRef` is what stops the teardown reporting a leave.
      //
      // Guarded on the mode actually differing, so the announcement arriving
      // twice, or arriving to a tab that has already rebuilt, is not a second
      // rebuild.
      if (payload.kind === 'mode') {
        if (!payload.mode || payload.mode === transport.mode) return
        callLog.warn(LOG, `gateway moved the call to ${payload.mode} — rebuilding`, { reason: payload.reason })
        rebuildingRef.current = true
        setGeneration(g => g + 1)
        return
      }

      // A peer's stream dropped and the Gateway is holding their seat through
      // the grace window; their tile reads "reconnecting" instead of the whole
      // room churning through a leave/join.
      if (payload.kind === 'peer_away') {
        const id = payload.participantId
        if (!id || id === self) return
        setAwayPeers(prev => (prev.has(id) ? prev : new Set(prev).add(id)))
        return
      }
      if (payload.kind === 'peer_back') {
        const id = payload.participantId
        if (id && id !== self) clearAway(id)
        return
      }

      if (payload.kind === 'peer_joined' || payload.kind === 'tracks') {
        const p = payload.peer
        if (!p || p.participantId === self) return
        clearAway(p.participantId)
        // A peer who rebuilt their SFU session is publishing on a new one, and
        // every subscription we hold points at the old. Forgetting them here is
        // what lets the pulls below start over; without it the transport sees a
        // slot it has already filled and skips the track for good.
        const prev = peersRef.current.get(p.participantId)
        if (prev?.sfuSessionId && p.sfuSessionId && prev.sfuSessionId !== p.sfuSessionId) {
          transport.dropPeer?.(p.participantId)
          streamsRef.current.delete(p.participantId)
          screensRef.current.delete(p.participantId)
          setRemoteStreams(new Map(streamsRef.current))
          setRemoteScreens(new Map(screensRef.current))
        }
        peersRef.current.set(p.participantId, p)
        syncPeers()
        if (transport.mode === 'sfu') {
          for (const [kind, trackName] of Object.entries(p.tracks || {})) {
            transport.pullTrack(p.participantId, kind, trackName, p.sfuSessionId)
          }
        } else if (payload.kind === 'peer_joined') {
          transport.connectTo(p.participantId)
        }
        return
      }

      if (payload.kind === 'peer_left') {
        const id = payload.participantId
        if (!id) return
        if (id === self) {
          // Addressed to us: the Gateway removed OUR seat (a second tab's
          // leave, an eviction we slept through). Ignoring it was the ghost
          // state — our tiles kept playing while everyone else had dropped us
          // and every /rtc call answered 409. Rejoin instead.
          rejoinAfterEviction()
          return
        }
        clearAway(id)
        peersRef.current.delete(id)
        syncPeers()
        streamsRef.current.delete(id)
        screensRef.current.delete(id)
        setRemoteStreams(new Map(streamsRef.current))
        setRemoteScreens(new Map(screensRef.current))
        transport.dropPeer?.(id)
        return
      }

      if (payload.kind === 'signal' && transport.mode === 'mesh') {
        if (payload.to !== self) return
        transport.handleSignal(payload.from, payload.signal)
      }
    },
    [syncPeers, clearAway, rejoinAfterEviction],
  )
  // Read through a ref where render order would otherwise matter: the join
  // effect replays buffered events and the roster sync synthesises them.
  onServerEventRef.current = onServerEvent

  // --- remote audio playback ------------------------------------------------
  // One <audio> element per peer, created imperatively so playback survives the
  // roster re-rendering and so autoplay rejection is observable.
  useEffect(() => {
    const els = audioElsRef.current
    for (const [participantId, ms] of remoteStreams) {
      let el = els.get(participantId)
      if (!el) {
        el = new Audio()
        el.autoplay = true
        el.playsInline = true
        els.set(participantId, el)
      }
      // The chosen speaker ('' = system default). Feature-detected — Safari
      // has no setSinkId — and best-effort: a device that was unplugged since
      // it was chosen falls back to the default rather than muting the call.
      if (el.setSinkId && el.kelaboSinkId !== sinkId) {
        el.setSinkId(sinkId)
          .then(() => { el.kelaboSinkId = sinkId })
          .catch(() => {})
      }
      if (el.srcObject !== ms) el.srcObject = ms
      el.play().catch(() => {
        callLog.warn(LOG, `autoplay blocked for ${participantId} — waiting for user gesture`)
        setNeedsUnblock(true)
      })
    }
    for (const [participantId, el] of els) {
      if (remoteStreams.has(participantId)) continue
      el.srcObject = null
      els.delete(participantId)
    }
  }, [remoteStreams, sinkId])

  useEffect(() => {
    const els = audioElsRef.current
    return () => {
      for (const el of els.values()) el.srcObject = null
      els.clear()
    }
  }, [])

  const unblock = useCallback(() => {
    for (const el of audioElsRef.current.values()) el.play().catch(() => {})
    setNeedsUnblock(false)
  }, [])

  // What a tile should say about one peer. Having their media is the only
  // proof the call actually works, so it outranks the connection state — but
  // ANY of their media counts. This used to count audio tracks alone, so a
  // participant with no microphone (mic denied, watch-only) showed
  // "connecting…" for the whole kelabo with their video on screen.
  const peerStatus = useCallback(
    participantId => {
      const ms = remoteStreams.get(participantId)
      if (ms?.getTracks().length) return 'live'
      if (remoteScreens.get(participantId)?.getTracks().length) return 'live'
      // Their SSE stream dropped; the Gateway is holding the seat.
      if (awayPeers.has(participantId)) return 'reconnecting'
      const conn = peerStates.get(mode === 'mesh' ? participantId : '*')
      if (conn === 'failed' || conn === 'closed') return 'failed'
      if (conn === 'disconnected') return 'reconnecting'
      if (conn === 'connected') {
        // Mesh: this IS their connection, so connected is live even with no
        // track (nothing granted, nothing shared). SFU: '*' is our own uplink;
        // it only vouches for a peer who advertises nothing to deliver.
        if (mode === 'mesh') return 'live'
        const p = peersRef.current.get(participantId)
        if (p && !Object.keys(p.tracks || {}).length) return 'live'
      }
      return 'connecting'
    },
    [remoteStreams, remoteScreens, awayPeers, peerStates, mode],
  )

  // Whether a peer's camera has actually reached us. A roster that advertises
  // `video: "cam"` is a promise; the track arriving is the delivery, and the
  // gap between the two is exactly what the reconciler is closing.
  const peerHasVideo = useCallback(
    participantId => !!remoteStreams.get(participantId)?.getVideoTracks().length,
    [remoteStreams],
  )

  // Whether starting a screen share could be admitted right now. Mesh only:
  // units = everyone on the call (self included) plus every active share; a
  // share needs one more. Advisory — the Gateway re-checks on the actual
  // request — but it lets the control disable itself instead of failing.
  const sharing = !!screenStream?.getVideoTracks()[0]
  const canShareScreen =
    mode !== 'mesh' ||
    !(meshMax > 0) ||
    sharing ||
    peers.length + 1 + peers.filter(p => p.media?.screen).length < meshMax

  return { state, mode, peers, remoteStreams, remoteScreens, error, meshMax, videoAllowed, needsUnblock, unblock, onServerEvent, peerStatus, peerHasVideo, screenDenied, canShareScreen, selfId: selfIdRef.current }
}
