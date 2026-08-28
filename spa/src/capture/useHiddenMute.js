import { useEffect, useRef, useState } from 'react'

/**
 * Mute while this tab is in the background — opt in, and it undoes itself.
 *
 * The microphone stays open when you switch tabs, which is what people expect
 * right up until it is not: whatever you switched away to do — the call in the
 * other tab, the keyboard, the room you are now walking through — goes into the
 * kelabo, and every second of it is streamed to the transcriber and billed. Switching
 * away is also the one moment nobody is looking at the mute button.
 *
 * It is a toggle rather than a behavior because the opposite is just as
 * reasonable: plenty of people talk *while* reading something in another tab,
 * and silently cutting them off mid-sentence would be the worse surprise.
 *
 * The one rule worth stating: coming back only unmutes a mute this hook is
 * responsible for. Someone who muted themselves by hand and then tabbed away
 * comes back muted. Turning a microphone back on for a person who deliberately
 * switched it off is the mistake never to make here.
 *
 * @param {{ enabled: boolean, muted: boolean, mute: () => void, unmute: () => void }} opts
 * @returns {boolean} whether the current mute is one this hook is holding
 */
export function useHiddenMute({ enabled, muted, mute, unmute }) {
  const [held, setHeld] = useState(false)
  const heldRef = useRef(false)
  const hold = on => { heldRef.current = on; setHeld(on) }

  // The room re-renders on every word anyone says. The listener is registered
  // once, against `enabled` alone, and reads the live mute state through this
  // ref instead of being torn down and rebuilt underneath a tab switch.
  const liveRef = useRef({ muted, mute, unmute })
  liveRef.current = { muted, mute, unmute }

  // Unmuting by hand takes the mute back: from that point it is theirs, and
  // returning to the tab has nothing left to restore.
  useEffect(() => {
    if (!muted && heldRef.current) hold(false)
  }, [muted])

  useEffect(() => {
    if (!enabled) {
      // Turned off (or the kelabo ended) while this is what is holding the mic
      // shut — give it back rather than leaving a mute nobody can explain.
      if (heldRef.current) {
        hold(false)
        if (liveRef.current.muted) liveRef.current.unmute()
      }
      return undefined
    }

    const onChange = () => {
      const live = liveRef.current
      if (document.visibilityState === 'hidden') {
        if (live.muted || heldRef.current) return
        hold(true)
        live.mute()
      } else if (heldRef.current) {
        hold(false)
        if (live.muted) live.unmute()
      }
    }

    document.addEventListener('visibilitychange', onChange)
    // Switched on from a tab that is already in the background — settings
    // synced from another device, say. Act now, not at the next tab switch.
    onChange()
    return () => document.removeEventListener('visibilitychange', onChange)
  }, [enabled])

  return held
}
