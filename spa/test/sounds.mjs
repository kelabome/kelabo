import assert from 'node:assert/strict'
import { rosterDiff, shouldChimeUtterance, soundPlan } from '../src/sounds.js'

/**
 * The pure halves of the room chimes: who the roster says arrived or left,
 * and what the active scheme makes that event sound like. The WebAudio half
 * needs a browser and is only exercised live — the same split as
 * transcript/ and rtc/reconcile.js.
 */

let passed = 0
const tests = []
const test = (name, fn) => tests.push([name, fn])

// --- rosterDiff --------------------------------------------------------------

test('a new identity is a join, a missing one a leave', () => {
  const { joined, left } = rosterDiff(['a', 'b'], ['b', 'c'], 'me')
  assert.deepEqual(joined, ['c'])
  assert.deepEqual(left, ['a'])
})

test('your own arrival and departure never chime', () => {
  const { joined, left } = rosterDiff(['a'], ['me'], 'me')
  assert.deepEqual(joined, [])
  assert.deepEqual(left, ['a'])
  assert.equal(left.includes('me'), false)
})

test('an unchanged roster is silent', () => {
  const { joined, left } = rosterDiff(['a', 'b'], ['a', 'b'], 'me')
  assert.deepEqual(joined, [])
  assert.deepEqual(left, [])
})

test('duplicated identities in a snapshot count once', () => {
  // Two tabs from one person hold two streams but one roster entry.
  const { joined } = rosterDiff([], ['a', 'a'], 'me')
  assert.deepEqual(joined, ['a'])
})

// --- shouldChimeUtterance ----------------------------------------------------

test('a sealed remote message chimes', () => {
  assert.equal(shouldChimeUtterance({ by: 'a', partial: false, kind: 'sealed' }, 'me'), true)
})

test('live fragments never chime — they stream while someone is still talking', () => {
  assert.equal(shouldChimeUtterance({ by: 'a', partial: true, kind: 'delta' }, 'me'), false)
  assert.equal(shouldChimeUtterance({ by: 'a', partial: true, kind: 'tail' }, 'me'), false)
})

test('your own sealed echo never chimes', () => {
  assert.equal(shouldChimeUtterance({ by: 'me', partial: false, kind: 'sealed' }, 'me'), false)
})

test('no attributable sender stays silent rather than guessing', () => {
  assert.equal(shouldChimeUtterance({ partial: false, kind: 'sealed' }, 'me'), false)
  assert.equal(shouldChimeUtterance(null, 'me'), false)
})

// --- soundPlan ---------------------------------------------------------------

test('every scheme produces a plan for every event kind', () => {
  for (const scheme of ['clay', 'slate', 'sage', 'plum', 'mono', 'matrix']) {
    for (const kind of ['join', 'leave', 'message']) {
      const plan = soundPlan(scheme, kind)
      assert.ok(plan.length > 0, `${scheme}/${kind} is silent`)
      for (const n of plan) {
        assert.ok(n.freq > 0 && n.dur > 0 && n.at >= 0)
        // Loud enough to hear over a call, quiet enough to stay a nudge.
        assert.ok(n.gain >= 0.05 && n.gain <= 0.2, `${scheme}/${kind} gain ${n.gain} out of range`)
      }
    }
  }
})

test('joins rise and leaves fall by the same interval', () => {
  const join = soundPlan('clay', 'join').map(n => n.freq)
  const leave = soundPlan('clay', 'leave').map(n => n.freq)
  assert.ok(join[1] > join[0])
  assert.ok(leave[1] < leave[0])
  assert.equal(join[0], leave[1])
  assert.equal(join[1], leave[0])
})

test('the scheme picks the timbre: matrix is the square-wave blip', () => {
  assert.equal(soundPlan('matrix', 'message')[0].type, 'square')
  assert.equal(soundPlan('clay', 'message')[0].type, 'triangle')
  assert.notEqual(
    soundPlan('matrix', 'message')[0].freq,
    soundPlan('clay', 'message')[0].freq
  )
})

test('an unknown scheme falls back rather than falling silent', () => {
  assert.deepEqual(soundPlan('future-scheme', 'join'), soundPlan('clay', 'join'))
})

test('an unknown kind is silence, not an error', () => {
  assert.deepEqual(soundPlan('clay', 'explosion'), [])
})

// --- runner ------------------------------------------------------------------

for (const [name, fn] of tests) {
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
console.log(`\n${passed}/${tests.length} sounds tests passed`)
