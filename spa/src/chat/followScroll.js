/**
 * Where a message list should be looking, as a decision rather than an effect.
 *
 * Pure for the reason `rtc/reconcile.js` and `rtc/retry.js` are pure: the
 * thing that goes wrong here is invisible in a live room. A list parked at the
 * top of its history looks exactly like a list that has not loaded yet, and
 * both look exactly like a reader who scrolled back on purpose — which is what
 * the hook actually concluded, and why it put a "Jump to latest" chip on
 * screen for someone who had never scrolled. No React, no DOM, so
 * `spa/test/followScroll.mjs` can run it under plain node.
 */

// Scrolling back to re-read must not be yanked away by the next thing anyone
// says — but a reader a line or two off the bottom is still following along.
export const FOLLOW_THRESHOLD_PX = 140

/**
 * Nothing has been anchored yet on this hook instance.
 *
 * A sentinel rather than `''` or `null`, because those are legitimate reset
 * keys: a list with no conversation id (the room's own panels pass none) must
 * still anchor on its first page, and it would not if "no key" already counted
 * as the key it had anchored to.
 */
export const NOT_ANCHORED = Symbol('not-anchored')

/** Geometry only, so the threshold is exercised rather than trusted. */
export function isAtBottom({ scrollHeight = 0, scrollTop = 0, clientHeight = 0 } = {}, threshold = FOLLOW_THRESHOLD_PX) {
  return scrollHeight - scrollTop - clientHeight < threshold
}

/**
 * What this pass should do:
 *
 *   'idle'   — nothing to look at yet; decide nothing, remember nothing.
 *   'anchor' — the first content of a conversation. Go to the newest message,
 *              whatever the geometry says.
 *   'follow' — the reader is at the bottom and something arrived. Stay there.
 *   'pin'    — the reader is reading back. Leave them alone and offer the chip.
 *
 * `anchor` is the branch that did not exist, and its absence is the whole bug.
 * A leg opens with up to 200 messages committed at once into a freshly mounted
 * container, so `scrollTop` is 0 and the distance to the bottom is a whole
 * history — `atBottom` is false on the very first paint, and the old code read
 * that as "the reader has scrolled back". It had never been wrong before
 * because the room's lists grow from empty inside a container that is already
 * mounted: at one message the content is shorter than the viewport, `atBottom`
 * is trivially true, and the follow branch holds from then on. A conversation
 * with history is the opposite shape and needs to be told where to start.
 *
 * `idle` is what keeps `anchor` correct across a switch. While the outgoing
 * leg is torn down there is no container and no content, and a pass that
 * concluded anything there would consume the anchor before the new leg's
 * messages arrived.
 */
export function followAction({ mounted = false, count = 0, resetKey = '', anchoredKey = NOT_ANCHORED, atBottom = false } = {}) {
  if (!mounted || count <= 0) return 'idle'
  if (anchoredKey !== resetKey) return 'anchor'
  return atBottom ? 'follow' : 'pin'
}
