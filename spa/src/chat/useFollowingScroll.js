import { useEffect, useRef, useState } from 'react'

/**
 * Follow a growing list, unless the reader has scrolled back.
 *
 * Lifted out of `room/SidePanel.jsx` when the journey channel (docs 20 §19)
 * became the second thing that needed it. It was a module-local there for as
 * long as there was only one message list; two copies of "how close to the
 * bottom still counts as following" is how two message lists end up
 * disagreeing about it.
 */

// Scrolling back to re-read must not be yanked away by the next thing anyone
// says — but a reader a line or two off the bottom is still following along.
const FOLLOW_THRESHOLD_PX = 140

export function useFollowingScroll(dep, enabled = true) {
  const ref = useRef(null)
  const [pinned, setPinned] = useState(false)

  const atBottom = () => {
    const el = ref.current
    if (!el) return true
    return el.scrollHeight - el.scrollTop - el.clientHeight < FOLLOW_THRESHOLD_PX
  }

  useEffect(() => {
    if (!enabled) return
    if (atBottom()) {
      const el = ref.current
      if (el) el.scrollTop = el.scrollHeight
      setPinned(false)
    } else {
      setPinned(true)
    }
  }, [dep, enabled]) // eslint-disable-line react-hooks/exhaustive-deps

  const jump = () => {
    const el = ref.current
    if (el) el.scrollTop = el.scrollHeight
    setPinned(false)
  }

  return { ref, pinned, jump, onScroll: () => { if (pinned && atBottom()) setPinned(false) } }
}
