/**
 * One tab per kelabo: the decision half.
 *
 * A second tab on the same kelabo is not a harmless duplicate. It takes a
 * SECOND `getUserMedia` on a device the room is documented to hold exactly once
 * (AGENTS.md), which costs echo cancellation and posts every utterance to
 * the transcriber twice under the same identity. Worse, the conference seat is keyed by
 * identity, so the Gateway treats the new tab as a *rejoin* of the existing seat
 * (`gateway/src/rtc/room.js`) and the first tab's call goes dead with nothing on
 * screen to say why. And the SSE hub deliberately tolerates two streams for one
 * identity — that is how EventSource reconnects survive — so nothing on the
 * server ever notices.
 *
 * So the room refuses to open twice, and it has to be decided before any of
 * those connections exist. This module is the protocol; `useSingleTab.js` binds
 * it to a BroadcastChannel and real timers.
 *
 * Pure on purpose (no BroadcastChannel, no clock, no React), because every
 * interesting case here is a race — two tabs opening in the same instant, a
 * holder that crashed rather than closed, a takeover whose holder never answers
 * — and a race is exactly what cannot be tested in a browser by hand. See
 * `spa/test/tabClaim.mjs`.
 *
 * Scope is one browser profile, which is the scope of the problem: the harm is
 * a second microphone and a stolen seat on THIS machine. A phone and a laptop
 * are a legitimate pair of tabs and are none of this module's business.
 */

/**
 * How long a tab waits for an answer before deciding the kelabo is free.
 *
 * This is a same-process message round trip, so it is a generous ceiling rather
 * than a guess — but it is also the delay before the room opens, so it cannot
 * be large. A holder that does not answer inside it has crashed or been killed,
 * which is precisely the case a stored lock gets wrong and a live probe gets
 * right: there is no stale claim to expire, because a claim is only ever an
 * answer from something still running.
 */
export const PROBE_MS = 400

/** @typedef {'idle'|'checking'|'holding'|'blocked'|'taking'|'stopped'} ClaimPhase */

/**
 * @param {string} tabId  Unique per tab. Also the tie-break for a dead heat, so
 *   it must be comparable and collision-free — a random string, not a counter.
 */
export function emptyClaim(tabId) {
  return { phase: /** @type {ClaimPhase} */ ('idle'), tabId }
}

/**
 * The protocol, as a reducer.
 *
 * Returns the next state plus the effects the caller must perform: `send`
 * broadcasts a message to the other tabs, `timer` (re)arms the probe timeout.
 * Effects are returned rather than performed so the tests can run the whole
 * thing without a DOM.
 *
 * Events: `start`, `stop`, `takeover`, `timeout`, and `message` carrying one
 * from another tab.
 *
 * @returns {{ state: object, effects: Array<{send?: object, timer?: number}> }}
 */
export function applyClaim(state, event) {
  const stay = { state, effects: [] }
  const to = (phase, effects = []) => ({ state: { ...state, phase }, effects })
  const probe = kind => [{ send: { kind, tabId: state.tabId } }, { timer: PROBE_MS }]

  switch (event.type) {
    case 'start':
      // Announce and listen. Silence means nobody is here.
      return to('checking', probe('claim'))

    case 'stop':
      // Closing the room hands it back. A blocked tab watching for this reopens
      // by itself, so closing the forgotten tab is all the fix anyone needs.
      if (state.phase === 'holding' || state.phase === 'taking') {
        return to('stopped', [{ send: { kind: 'release', tabId: state.tabId } }])
      }
      return to('stopped')

    case 'takeover':
      // "Open here instead". The holder yields; if it is not really there any
      // more, the same timeout that opened the room in the first place applies.
      if (state.phase !== 'blocked') return stay
      return to('taking', probe('take'))

    case 'timeout':
      if (state.phase === 'checking' || state.phase === 'taking') return to('holding')
      return stay

    case 'message':
      return applyMessage(state, event.msg, stay, to)

    default:
      return stay
  }
}

function applyMessage(state, msg, stay, to) {
  // BroadcastChannel does not deliver to the sender, but a caller might replay
  // its own message and a self-block is unrecoverable, so never trust that.
  if (!msg || msg.tabId === state.tabId) return stay

  switch (state.phase) {
    case 'checking':
      // Someone already has it.
      if (msg.kind === 'held') return to('blocked')
      // A dead heat: both tabs opened before either could answer, so neither
      // sees a `held` and both would open the room. Resolve it on the ids —
      // the same comparison in both tabs, giving opposite answers, with no
      // further round trip to lose.
      if (msg.kind === 'claim' && msg.tabId < state.tabId) return to('blocked')
      return stay

    case 'holding':
      // Answer a newcomer so it blocks itself.
      if (msg.kind === 'claim') {
        return { state, effects: [{ send: { kind: 'held', tabId: state.tabId } }] }
      }
      // Stand down for a deliberate takeover. This tab becomes the blocked one
      // rather than closing: the person is still looking at it, and it can take
      // the kelabo back the same way.
      if (msg.kind === 'take') {
        return to('blocked', [{ send: { kind: 'yield', tabId: state.tabId } }])
      }
      return stay

    case 'blocked':
      // The holder closed — reclaim rather than making the person reload.
      if (msg.kind === 'release') {
        return { state: { ...state, phase: 'checking' }, effects: [{ send: { kind: 'claim', tabId: state.tabId } }, { timer: PROBE_MS }] }
      }
      return stay

    case 'taking':
      if (msg.kind === 'yield') return to('holding')
      return stay

    default:
      return stay
  }
}

/** The room may only mount here. Everything else shows the blocked screen. */
export function holdsRoom(state) {
  return state.phase === 'holding'
}
