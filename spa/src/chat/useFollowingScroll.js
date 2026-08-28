import { useEffect, useRef, useState } from 'react'
import { followAction, isAtBottom, NOT_ANCHORED } from './followScroll.js'

/**
 * Follow a growing list, unless the reader has scrolled back — and start at
 * the newest message, not the oldest one loaded.
 *
 * Lifted out of `room/SidePanel.jsx` when the journey channel (docs 20 §19)
 * became the second thing that needed it. It was a module-local there for as
 * long as there was only one message list; two copies of "how close to the
 * bottom still counts as following" is how two message lists end up
 * disagreeing about it.
 *
 * The decision is in `followScroll.js` and only the DOM is here. What this
 * hook does is read three facts off the container, ask what they mean, and
 * carry out the answer.
 *
 * `resetKey` names the conversation being shown. Change it and the next page
 * of content anchors to the bottom again: one instance of this hook outlives a
 * leg switch (`JourneyLegs` does not remount), so without it the second leg
 * you open inherits the first one's "already anchored" and opens at the top.
 * Callers with only ever one conversation — the room's own panels — pass none
 * and get the mount-time anchor, which is all they need.
 */
export function useFollowingScroll(dep, enabled = true, { resetKey = '' } = {}) {
  const ref = useRef(null)
  const anchored = useRef(NOT_ANCHORED)
  const [pinned, setPinned] = useState(false)

  const atBottom = () => {
    const el = ref.current
    // No container is not "at the bottom" of anything. It answers true because
    // every *other* caller — `jump`, `onScroll` — is asking "may I stop
    // following?", and the safe answer while unmounted is yes. The effect
    // below does not use it for that: it asks `followAction` instead, which
    // sees `mounted: false` and declines to conclude anything at all.
    if (!el) return true
    return isAtBottom(el)
  }

  useEffect(() => {
    if (!enabled) return
    const el = ref.current
    const count = Array.isArray(dep) ? dep.length : dep ? 1 : 0
    const action = followAction({
      mounted: !!el,
      count,
      resetKey,
      anchoredKey: anchored.current,
      atBottom: el ? isAtBottom(el) : false,
    })

    if (action === 'idle') return
    if (action === 'pin') {
      setPinned(true)
      return
    }
    // 'anchor' and 'follow' both end at the bottom. They are kept apart because
    // they are different claims — one is "this is where this conversation
    // starts", the other "you were already here" — and only the first may
    // override the reader's own scroll position.
    anchored.current = resetKey
    el.scrollTop = el.scrollHeight
    setPinned(false)
  }, [dep, enabled, resetKey]) // eslint-disable-line react-hooks/exhaustive-deps

  const jump = () => {
    const el = ref.current
    if (el) el.scrollTop = el.scrollHeight
    setPinned(false)
  }

  return { ref, pinned, jump, onScroll: () => { if (pinned && atBottom()) setPinned(false) } }
}
