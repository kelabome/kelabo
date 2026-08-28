// Where a message list looks when it opens (spa/src/chat/followScroll.js).
//
// The bug these exist for: opening a leg with history left the viewport at
// `scrollTop = 0` — the oldest message of the loaded window — and put a "Jump
// to latest" chip on screen, because the hook read "a long way from the
// bottom" as "the reader has scrolled back". Nobody had scrolled. Every
// assertion below is one of the three things that were indistinguishable to
// the old code: not loaded yet, opened at the top, and deliberately reading
// back.
import assert from 'node:assert/strict'
import { followAction, isAtBottom, FOLLOW_THRESHOLD_PX, NOT_ANCHORED } from '../src/chat/followScroll.js'

let passed = 0
function test(name, fn) {
  try {
    fn()
    passed++
    console.log(`ok - ${name}`)
  } catch (e) {
    console.error(`FAIL - ${name}`)
    console.error(e)
    process.exitCode = 1
  }
}

// A leg that opens with a screenful and a half of history: the exact shape the
// old code could not read. 200 messages arrive in one commit into a container
// that has just mounted, so the distance to the bottom is the whole history.
const OPENED_WITH_HISTORY = { scrollHeight: 8000, scrollTop: 0, clientHeight: 600 }

test('a conversation with history opens at its newest message, not its oldest', () => {
  const action = followAction({
    mounted: true,
    count: 200,
    resetKey: 'leg-a',
    anchoredKey: NOT_ANCHORED,
    atBottom: isAtBottom(OPENED_WITH_HISTORY),
  })
  // The geometry says "nowhere near the bottom" and it is right; what was
  // wrong was concluding from that that the reader put it there.
  assert.equal(isAtBottom(OPENED_WITH_HISTORY), false)
  assert.equal(action, 'anchor')
})

test('and having anchored once, it does not do it again to a reader scrolling back', () => {
  const action = followAction({
    mounted: true,
    count: 200,
    resetKey: 'leg-a',
    anchoredKey: 'leg-a',
    atBottom: false,
  })
  assert.equal(action, 'pin', 'this is the one case where the chip is honest')
})

test('switching legs anchors again — one hook instance serves every leg', () => {
  // JourneyLegs does not remount on a leg switch, so "already anchored" is
  // per conversation and not per mount. Without the key the second leg you
  // open inherits the first one's anchor and starts at the top.
  assert.equal(
    followAction({ mounted: true, count: 200, resetKey: 'leg-b', anchoredKey: 'leg-a', atBottom: false }),
    'anchor'
  )
})

test('the key is the leg on screen, not the leg selected — the whole switch, in order', () => {
  // The first fix passed every test above and still opened the second leg at
  // the top, because `followAction` is only ever as right as the key it is
  // handed. Clicking a leg re-renders immediately; the channel is emptied by
  // an effect afterwards. So there is one commit where the selection is the
  // new leg and every message on screen belongs to the old one — and keyed by
  // the selection, that commit is indistinguishable from the new leg's page
  // having arrived.
  //
  // Played out as the four commits React actually produces. `contentLeg` is
  // what the channel carries; `selectedLeg` is what the rail says.
  let anchored = 'leg-a'
  const run = ({ contentLeg, selectedLeg, mounted, count, atBottom }) => {
    const action = followAction({ mounted, count, resetKey: contentLeg, anchoredKey: anchored, atBottom })
    if (action === 'anchor' || action === 'follow') anchored = contentLeg
    return action
  }

  // 1. Reading leg-a, scrolled up into its history.
  assert.equal(run({ contentLeg: 'leg-a', selectedLeg: 'leg-a', mounted: true, count: 200, atBottom: false }), 'pin')

  // 2. Click leg-b. Re-render: selection is leg-b, content is still leg-a's.
  //    Keyed by the selection this returned 'anchor' and burned leg-b's turn.
  assert.equal(
    run({ contentLeg: 'leg-a', selectedLeg: 'leg-b', mounted: true, count: 200, atBottom: false }),
    'pin',
    'the outgoing leg must not consume the incoming one\'s anchor'
  )

  // 3. The effect empties the channel; the list is swapped for the placeholder.
  assert.equal(run({ contentLeg: '', selectedLeg: 'leg-b', mounted: false, count: 0, atBottom: false }), 'idle')

  // 4. leg-b's page lands: a full history into a freshly mounted container.
  assert.equal(
    run({ contentLeg: 'leg-b', selectedLeg: 'leg-b', mounted: true, count: 200, atBottom: false }),
    'anchor',
    'and this is the commit that must land on the newest message'
  )
  assert.equal(anchored, 'leg-b')
})

test('the teardown between two legs decides nothing, so it cannot spend the anchor', () => {
  // Selecting a leg empties the channel and swaps the list for a placeholder,
  // so a pass runs with no container and no messages. If that pass concluded
  // anything, the anchor would be consumed before the new leg's page arrived
  // and the new leg would open at the top — the original bug, one step later.
  assert.equal(followAction({ mounted: false, count: 0, resetKey: 'leg-b', anchoredKey: NOT_ANCHORED }), 'idle')
  assert.equal(followAction({ mounted: false, count: 200, resetKey: 'leg-b', anchoredKey: NOT_ANCHORED }), 'idle')
  assert.equal(followAction({ mounted: true, count: 0, resetKey: 'leg-b', anchoredKey: NOT_ANCHORED }), 'idle')
})

test('loading earlier history does not yank the reader to the bottom', () => {
  // "Load earlier" prepends a page while the reader sits at the top. Same
  // conversation, already anchored, not at the bottom — the one thing this
  // must never do is treat a bigger list as a reason to scroll.
  assert.equal(
    followAction({ mounted: true, count: 400, resetKey: 'leg-a', anchoredKey: 'leg-a', atBottom: false }),
    'pin'
  )
})

test('a reader at the bottom keeps following what arrives', () => {
  assert.equal(
    followAction({ mounted: true, count: 201, resetKey: 'leg-a', anchoredKey: 'leg-a', atBottom: true }),
    'follow'
  )
})

test('a list with no conversation id still anchors on its first content', () => {
  // The room's own panels pass no key. `''` is a real key, which is why the
  // unanchored state is a sentinel and not an empty string — otherwise these
  // lists would count as already anchored before they had rendered anything.
  assert.notEqual(NOT_ANCHORED, '')
  assert.equal(followAction({ mounted: true, count: 12, atBottom: false }), 'anchor')
  assert.equal(followAction({ mounted: true, count: 12, resetKey: '', anchoredKey: '', atBottom: false }), 'pin')
})

test('the threshold is a band, not a pixel', () => {
  const h = { scrollHeight: 1000, clientHeight: 300 }
  assert.equal(isAtBottom({ ...h, scrollTop: 700 }), true, 'exactly at the bottom')
  assert.equal(isAtBottom({ ...h, scrollTop: 700 - (FOLLOW_THRESHOLD_PX - 1) }), true, 'a line or two up is still following')
  assert.equal(isAtBottom({ ...h, scrollTop: 700 - FOLLOW_THRESHOLD_PX }), false, 'and past it is reading back')
  // A list shorter than its viewport is trivially at the bottom — which is why
  // the room's panels never showed this bug and a short leg does not either.
  assert.equal(isAtBottom({ scrollHeight: 120, scrollTop: 0, clientHeight: 600 }), true)
})

test('an unmounted container is never a reason to scroll', () => {
  for (const key of [NOT_ANCHORED, 'leg-a'])
    assert.equal(followAction({ mounted: false, count: 200, resetKey: 'leg-a', anchoredKey: key, atBottom: true }), 'idle')
})

console.log(`\nspa/followScroll: ${passed} passed${process.exitCode ? ' (with failures)' : ''}`)
