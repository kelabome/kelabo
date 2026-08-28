import { createContext, useCallback, useContext, useMemo, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../auth'
import { api } from '../api'
import { usePresence } from './usePresence.js'
import { useRing } from './useRing.js'
import { RingModal } from './RingModal'

/**
 * App-wide contact presence + ring (docs 18 §5, §6), provided ABOVE the router so
 * both the signed-in shell (Contacts, the rail) and the kelabo room — which
 * lives outside the shell — read from the same single stream. One EventSource
 * per tab, no matter how many views consume it. Ring events ride that same
 * stream and surface as a modal here, on any page.
 *
 * A guest (no identity) gets an inert value: every lookup is false, no stream.
 */
const PresenceContext = createContext({
  presence: new Map(),
  isOnline: () => false,
  inKelabo: () => false,
  onJourneyMessage: () => () => {},
})

export function PresenceProvider({ children }) {
  const { identity } = useAuth()
  const navigate = useNavigate()
  const ring = useRing()

  // Journey thread messages (docs 20 §19.9) reach several unrelated places at
  // once — the rail's badge, the journey page's tab badge, the open thread —
  // and none of them owns the stream. A subscription set rather than a piece
  // of state: putting the last event in state would re-render every consumer
  // on every message, including the ones that only wanted to know a count
  // changed.
  const journeySubs = useRef(new Set())
  const onJourneyMessage = useCallback(fn => {
    journeySubs.current.add(fn)
    return () => journeySubs.current.delete(fn)
  }, [])
  const fanOut = useCallback(evt => {
    // A throwing subscriber must not stop the others from being told.
    for (const fn of [...journeySubs.current]) {
      try { fn(evt) } catch {}
    }
  }, [])

  const presence = usePresence(identity, ring.handleRingEvent, fanOut)
  const value = useMemo(() => ({ ...presence, onJourneyMessage }), [presence, onJourneyMessage])

  const accept = async () => {
    const r = ring.incoming
    ring.clearRing()
    if (!r) return
    try { await api.answerRing(r.kelaboId, 'accepted') } catch {}
    // Join gets the participant cookie every in-room call needs, then straight
    // into the room — a huddle skips the lobby by design.
    const name = localStorage.getItem('kelabo-name') || (identity ? identity.split('@')[0] : 'Guest')
    try {
      await api.joinKelabo(r.kelaboId, name, 'audio-board')
      localStorage.setItem('kelabo-mode', 'audio-board')
    } catch {}
    navigate(`/m/${r.kelaboId}`)
  }

  const decline = async () => {
    const r = ring.incoming
    ring.clearRing()
    if (!r) return
    try { await api.answerRing(r.kelaboId, 'declined') } catch {}
  }

  return (
    <PresenceContext.Provider value={value}>
      {children}
      {ring.incoming && <RingModal ring={ring.incoming} onAccept={accept} onDecline={decline} />}
    </PresenceContext.Provider>
  )
}

export function usePresenceContext() {
  return useContext(PresenceContext)
}
