import { useEffect, useMemo, useRef, useState } from 'react'
import { presenceStreamUrl } from '../api'
import { apply, emptyPresence, isOnline, isInKelabo } from './presenceStore.js'

/**
 * The one contact-presence stream (docs 18 §5), mounted once by AppShell.
 *
 * Like the board's EventSource (useBoard), this owns a single connection whose
 * lifetime must not be tied to any component that draws a list — a layout switch
 * or a route change must never re-subscribe. It is opened while signed in and
 * closed on sign-out.
 *
 * The browser's native EventSource reconnects on its own; the server sends a
 * fresh `snapshot` on every (re)connect, and the pure reducer treats a snapshot
 * as a full replace — so a reconnect re-syncs with no client bookkeeping. There
 * is no REST backfill because there is no durable presence to fetch.
 *
 * `identity` gates the connection: a signed-in user opens it, a guest (no
 * identity) does not.
 */
const RING_KINDS = new Set(['ring_incoming', 'ring_answer', 'ring_cancelled'])

// A stream that has gone quiet for this long is treated as dead and reopened.
// The server pings every 25s, so a minute is two missed pings — long enough
// not to churn a slow connection, short enough that a half-open socket is not
// how somebody spends their afternoon.
const STALL_MS = 60_000
const STALL_CHECK_MS = 15_000

export function usePresence(identity, onRing, onJourneyMessage) {
  const [presence, setPresence] = useState(() => emptyPresence())
  const esRef = useRef(null)
  // Keep the latest callbacks without re-opening the stream when they change.
  const onRingRef = useRef(onRing)
  onRingRef.current = onRing
  const onJourneyRef = useRef(onJourneyMessage)
  onJourneyRef.current = onJourneyMessage

  useEffect(() => {
    if (!identity) {
      setPresence(emptyPresence())
      return undefined
    }
    let cancelled = false
    let es = null
    let lastAt = Date.now()

    const open = () => {
      es = new EventSource(presenceStreamUrl(), { withCredentials: true })
      esRef.current = es
      lastAt = Date.now()

      es.addEventListener('presence', e => {
        if (cancelled) return
        lastAt = Date.now()
        let evt
        try { evt = JSON.parse(e.data) } catch { return }
        // Ring events (docs 18 §6) ride the same stream — routed to the ring
        // handler, not the presence reducer, which stays about who-is-online only.
        if (RING_KINDS.has(evt.kind)) { onRingRef.current?.(evt); return }
        // Journey leg messages ride it too (docs 20 §19.9), for the same
        // reason: this stream is already open on every page, and a badge is
        // needed precisely for the journey you are NOT currently subscribed to.
        if (evt.kind === 'journey_message') { onJourneyRef.current?.(evt); return }
        setPresence(prev => apply(prev, evt))
      })

      // The server's keepalive. It used to be an SSE comment, which keeps the
      // TCP connection warm but is invisible to EventSource — so a quiet
      // stream and a half-open socket looked identical from here, and the
      // watchdog below could not exist.
      es.addEventListener('ping', () => { lastAt = Date.now() })
      es.addEventListener('open', () => { lastAt = Date.now() })
    }

    open()

    // `onerror` never fires for a half-open socket — the connection is still
    // there as far as the browser is concerned, it just never delivers
    // anything again. The same watchdog the board stream carries, and it
    // matters more here now that a badge nobody sees is the failure mode.
    const watchdog = setInterval(() => {
      if (cancelled || Date.now() - lastAt < STALL_MS) return
      try { es?.close() } catch {}
      open()
    }, STALL_CHECK_MS)

    // On a dropped connection the browser reconnects and the server re-sends a
    // snapshot, which replaces the set — so nothing to do there but wait.
    return () => {
      cancelled = true
      clearInterval(watchdog)
      try { es?.close() } catch {}
      esRef.current = null
    }
  }, [identity])

  return useMemo(() => ({
    presence,
    isOnline: id => isOnline(presence, id),
    inKelabo: id => isInKelabo(presence, id),
  }), [presence])
}
