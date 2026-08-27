import { useCallback, useEffect, useRef, useState } from 'react'
import { api, boardStreamUrl, getCaptionHistory, postCaption } from '../api'
import { useToast } from '../components/Toaster'
import { notifyBoard } from '../notify'

/**
 * The kelabo's single EventSource, and the board state it feeds.
 *
 * This used to live inside `BoardPanel`, which meant the one stream the whole
 * kelabo depends on — contributions, transcript echo, LLM debug and conference
 * signalling — was owned by a component whose job was to draw a list. The room
 * now has several views onto the same contributions (the assistant tile, the
 * focus stage, the side panel), and none of them may own the connection: a
 * layout switch must never re-subscribe. So the stream is a hook, mounted once
 * by the room, and every view reads its result.
 *
 * Everything else is unchanged from the panel version, deliberately — the
 * reconnect/backfill/dedupe rules were paid for in live kelabos.
 */

export function conKey(c) {
  return c.id || `${c.at}|${c.title || ''}|${c.author || ''}`
}

export function useBoard({
  kelaboId,
  ended,
  onEnded,
  onRename,
  onUtterance,
  onHistory,
  onDebug,
  onRtc,
  onNotice,
  onAgent,
  onRoster,
  onStreamStatus,
  authorName,
}) {
  const toast = useToast()
  const [contributions, setContributions] = useState([])
  const [status, setStatus] = useState('connecting')
  // Bumped when the service worker asks us to surface the board (notification
  // click). The side panel watches it and scrolls itself to the bottom.
  const [focusSignal, setFocusSignal] = useState(0)

  const onRenameRef = useRef(onRename)
  onRenameRef.current = onRename
  const onUtteranceRef = useRef(onUtterance)
  onUtteranceRef.current = onUtterance
  const onHistoryRef = useRef(onHistory)
  onHistoryRef.current = onHistory
  const onDebugRef = useRef(onDebug)
  onDebugRef.current = onDebug
  const onRtcRef = useRef(onRtc)
  onRtcRef.current = onRtc
  const onNoticeRef = useRef(onNotice)
  onNoticeRef.current = onNotice
  const onAgentRef = useRef(onAgent)
  onAgentRef.current = onAgent
  const onRosterRef = useRef(onRoster)
  onRosterRef.current = onRoster
  const onStreamStatusRef = useRef(onStreamStatus)
  onStreamStatusRef.current = onStreamStatus
  const onEndedRef = useRef(onEnded)
  onEndedRef.current = onEnded

  const seenRef = useRef(new Set())
  const lastAtRef = useRef(0)
  // Once the kelabo ends, the server closes the SSE stream on purpose. That is
  // a normal shutdown, NOT a lost connection — never toast or reconnect after it.
  const endedRef = useRef(false)
  const esRef = useRef(null)

  const push = useCallback(list => {
    const items = (list || []).filter(Boolean)
    if (items.length === 0) return
    setContributions(prev => {
      let next = prev
      for (const c of items) {
        const id = c.id
        const isClear = c.status === 'done' && !c.title && !c.markdown
        const idx = id ? next.findIndex(x => x.id === id) : -1
        // A card that stops working stops carrying its live status: merging
        // would otherwise leave "Fetching bom.gov.au" pinned under a finished
        // answer forever.
        const live = c.status === 'working'
        const incoming = live ? c : { ...c, progress: undefined, steps: undefined }

        if (idx >= 0) {
          // Update-in-place by id (in-progress -> progress -> final/skipped, or clear).
          if (isClear) {
            next = next.filter((_, i) => i !== idx)
          } else {
            const merged = next.slice()
            merged[idx] = { ...next[idx], ...incoming }
            next = merged
          }
          continue
        }
        if (isClear) continue // nothing to remove

        const key = conKey(c)
        if (seenRef.current.has(key) && c.status !== 'working') continue
        seenRef.current.add(key)
        next = [...next, incoming]
        if (typeof c.at === 'number' && c.at > lastAtRef.current) lastAtRef.current = c.at
        // Only a real contribution is worth a notification — not a placeholder,
        // and not the agent explaining that it has nothing to add.
        if (c.tag !== 'note' && c.status !== 'working' && c.status !== 'skipped') {
          const title = c.title || String(c.markdown || '').slice(0, 80)
          notifyBoard(`Board: ${title}`, String(c.markdown || '').slice(0, 80))
        }
      }
      return next.slice().sort((a, b) => (a.at || 0) - (b.at || 0))
    })
  }, [])

  useEffect(() => {
    let cancelled = false
    let es = null
    let dropped = false
    // When ANY event last arrived, pings included. A half-open connection —
    // network change without a RST, suspend/resume, NAT rebinding — leaves the
    // EventSource "open" while receiving nothing, indefinitely: no signalling,
    // no roster, no reconnect, because onerror never fires. The server pings
    // every 25s precisely so this side can notice the silence.
    let lastEventAt = Date.now()
    const mark = () => { lastEventAt = Date.now() }

    const backfill = async since => {
      // Board and message history side by side — neither waits on the other,
      // and one failing must not cost the other its backfill.
      await Promise.all([
        api.getBoard(kelaboId, since ? { since } : { limit: 50 })
          .then(data => {
            const list = Array.isArray(data) ? data : (data?.contributions || [])
            if (!cancelled) push(list)
          })
          .catch(() => {}),
        // Messages persisted while this client was away (or before it arrived).
        // The seeding side dedupes by messageId, so refetching the same rows
        // after every reconnect is safe — this is the gap repair.
        getCaptionHistory(kelaboId)
          .then(history => {
            if (!cancelled && history) onHistoryRef.current?.(history)
          })
          .catch(() => {}),
      ])
    }

    // Close the stream for good — used when the kelabo ends. The browser's
    // EventSource auto-reconnects on its own, so we must explicitly close it and
    // flag `endedRef` so onerror (which may still fire during teardown) stays quiet.
    const closeForGood = () => {
      endedRef.current = true
      setStatus('ended')
      if (es) { es.close(); es = null }
      esRef.current = null
    }

    const subscribe = () => {
      if (cancelled || endedRef.current) return
      mark()
      es = new EventSource(boardStreamUrl(kelaboId), { withCredentials: true })
      esRef.current = es
      es.addEventListener('contribution', e => {
        mark()
        try { push([JSON.parse(e.data)]) } catch {}
      })
      es.addEventListener('rename', e => {
        mark()
        try {
          const { from, to } = JSON.parse(e.data)
          onRenameRef.current?.(from, to)
        } catch {}
      })
      es.addEventListener('utterance', e => {
        mark()
        try { onUtteranceRef.current?.(JSON.parse(e.data)) } catch {}
      })
      es.addEventListener('debug', e => {
        mark()
        try { onDebugRef.current?.(JSON.parse(e.data)) } catch {}
      })
      // Conference-audio signalling: roster changes plus, in mesh mode,
      // offer/answer/ICE addressed to this participant (docs 15).
      es.addEventListener('rtc', e => {
        mark()
        try { onRtcRef.current?.(JSON.parse(e.data)) } catch {}
      })
      // Something the room needs told about itself — today, that a metered
      // service stopped and when it comes back. Deliberately not a board card:
      // it is true for a few minutes and belongs to nobody's record.
      es.addEventListener('notice', e => {
        mark()
        try { onNoticeRef.current?.(JSON.parse(e.data)) } catch {}
      })
      // A developer's local coding agent attached or detached (docs 16). This
      // used to be silent, so a dropped bridge handed the kelabo back to the
      // server agent with nothing on screen to say so.
      es.addEventListener('agent', e => {
        mark()
        try { onAgentRef.current?.(JSON.parse(e.data)) } catch {}
      })
      // Who is attached to the kelabo right now — sent on subscribe and again
      // whenever it changes. Not the same as the call roster: a board-only
      // participant is here, holding this stream, and never joins the call.
      es.addEventListener('roster', e => {
        mark()
        try { onRosterRef.current?.(JSON.parse(e.data)) } catch {}
      })
      // The server's liveness pulse. Carries nothing; its arrival IS the data.
      es.addEventListener('ping', mark)
      es.addEventListener('ended', () => {
        // Kelabo ended: normal server-side stream close. Stop cleanly, no toast.
        closeForGood()
        onEndedRef.current?.()
      })
      es.onopen = () => {
        mark()
        if (dropped && lastAtRef.current) backfill(lastAtRef.current)
        dropped = false
        setStatus('live')
      }
      es.onerror = () => {
        // Don't churn if the kelabo is over (server closed the stream on purpose)
        // or the component is tearing down.
        if (cancelled || endedRef.current) return
        if (!dropped) toast('Board connection lost — reconnecting')
        dropped = true
        setStatus('reconnecting')
      }
    }

    // The watchdog for the half-open case onerror can never see: if nothing —
    // not even the 25s ping — has arrived for a minute, the socket is dead no
    // matter what readyState claims. Close it and resubscribe; onopen backfills
    // and the call's reconcile loop repairs the rest.
    const STALL_MS = 60_000
    const watchdog = setInterval(() => {
      if (cancelled || endedRef.current || !es) return
      if (Date.now() - lastEventAt < STALL_MS) return
      es.close()
      if (!dropped) toast('Board connection stalled — reconnecting')
      dropped = true
      setStatus('reconnecting')
      subscribe()
    }, 15_000)

    // If we mounted into an already-ended kelabo, don't open a live stream at all.
    if (ended) {
      endedRef.current = true
      backfill()
    } else {
      backfill().then(subscribe)
    }

    const onSwMessage = e => {
      if (e.data?.type === 'focus-board') setFocusSignal(n => n + 1)
    }
    navigator.serviceWorker?.addEventListener?.('message', onSwMessage)

    return () => {
      cancelled = true
      clearInterval(watchdog)
      es?.close()
      navigator.serviceWorker?.removeEventListener?.('message', onSwMessage)
    }
  }, [kelaboId]) // eslint-disable-line react-hooks/exhaustive-deps

  // When the kelabo is ended locally (host pressed "End kelabo"), proactively
  // close the live stream so the browser's EventSource doesn't keep retrying
  // against a stream the server is about to close — no "connection lost" churn
  // while the user decides where to go next.
  useEffect(() => {
    if (!ended) return
    endedRef.current = true
    setStatus('ended')
    if (esRef.current) { esRef.current.close(); esRef.current = null }
  }, [ended])

  // The call depends on this stream — it is how signalling arrives and how the
  // server notices a participant left — so its state is reported upward and the
  // call only joins once the stream is live.
  useEffect(() => {
    onStreamStatusRef.current?.(status)
  }, [status])

  const postNote = useCallback(async text => {
    const body = String(text || '').trim()
    if (!body) return
    try {
      await postCaption({ kelaboId, text: body, isFinal: true, human: true, tStart: 0, tEnd: 0 })
      return
    } catch {
      toast('Note failed to send — saved locally only')
    }
    push([{
      id: 'local-' + Date.now(),
      tag: 'note',
      kind: 'note',
      title: body.slice(0, 60),
      to: 'all',
      markdown: body,
      author: authorName || 'you',
      origin: 'server',
      at: Date.now(),
    }])
  }, [kelaboId, authorName, push, toast])

  return { contributions, status, postNote, focusSignal }
}
