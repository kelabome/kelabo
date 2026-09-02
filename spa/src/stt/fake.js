// The fake provider's transport: an `SttTransport` that opens no socket.
//
// See rest-api/src/stt/fake.js for why this exists and why a deployment cannot
// select it by accident. In short: the capture pipeline — mic, VAD gate,
// resampler, composer, publisher, Transcript tab — is only reachable in a
// browser when the deployment HAS a transcription provider, and standing up a
// real one for a test run costs a supplier account, a network and a
// non-deterministic answer.
//
// It behaves like a provider rather than like a stub: audio arrives, speech
// edges arrive, and reads come back on the caller's `onRead`, asynchronously,
// after the edge — which is what makes the composer's clock and the seal path
// real. What it does NOT do is invent words from the audio. It has two sources:
//
//   1. a queue a test pushes with `window.__kelaboFakeStt.say(...)`, which is
//      what makes an assertion about exact text possible at all; and
//   2. failing that, a canned phrase per speech burst, so a run with a fake
//      audio device and no script still produces visible transcript.
//
// The `window` hook is the part to be uneasy about, so: it is installed ONLY by
// this module, this module is only loaded when `stt.provider` resolves to
// "fake", and that cannot come from a config file (config/loadConfig.mjs's
// STT_PROVIDERS refuses it). On any real deployment this file is dead code that
// the bundler still ships — the same as any unselected provider.

import { createFakeReader } from '../transcript/stt/fake.js'

const CANNED = [
  'This is the fake transcription provider speaking.',
  'It produces the same words every time, on purpose.',
  'Nothing here reached a supplier.',
]

/**
 * The queue every fake transport on the page shares, plus the hook that fills
 * it. Shared rather than per-transport because a test says "say this in this
 * kelabo" without knowing how many transports the room has built.
 */
function installHook() {
  if (typeof window === 'undefined') return { pending: [], listeners: new Set() }
  if (window.__kelaboFakeStt) return window.__kelaboFakeStt
  const hook = {
    pending: [],
    listeners: new Set(),
    /**
     * Queue a line for the next speech burst — or deliver it immediately if a
     * transport is already listening, which is the case whenever the mic is
     * open.
     */
    say(text, { speaker = '0', immediate = true } = {}) {
      const line = { text: String(text), speaker: String(speaker) }
      if (immediate && hook.listeners.size) {
        for (const deliver of hook.listeners) deliver(line)
        return
      }
      hook.pending.push(line)
    },
  }
  window.__kelaboFakeStt = hook
  return hook
}

/** @type {import('./interface.js').SttClient} */
export const fakeClient = {
  id: 'fake',
  label: 'Fake',
  capabilities: { diarization: 'optional', maxSpeakers: 4 },
  // No gate: this provider bills nothing, and running ungated means the
  // pipeline under test is the one where audio flows continuously — the harder
  // of the two, and the one a `--use-file-for-fake-audio-capture` run produces.
  prefersVad: false,

  connect({ diarize, onRead, onState, onStreamStart, log }) {
    const hook = installHook()
    const reader = createFakeReader({ diarize })
    let closed = false
    let clockMs = 0
    let cannedIndex = 0
    let framesSinceEdge = 0

    // A provider is not live the instant it is asked for; going through
    // connecting -> live is what the connection light renders, and a transport
    // that jumped straight to live would hide a whole state from the suite.
    onState('connecting')
    const liveTimer = setTimeout(() => {
      if (closed) return
      onState('live')
      onStreamStart()
      // Anything queued before the mic opened, now that there is a stream for
      // it to belong to.
      for (const line of hook.pending.splice(0)) emit(line, true)
    }, 30)

    function emit(line, final) {
      if (closed) return
      const start = clockMs
      const end = clockMs + Math.max(400, line.text.length * 40)
      clockMs = end
      const segment = { speaker: line.speaker, text: line.text, start, end }
      onRead(reader.read(final ? { finals: [segment], endpoint: true } : { tails: [segment] }))
    }

    const deliver = line => emit(line, true)
    hook.listeners.add(deliver)

    return {
      sendAudio() {
        // Counted, not transcribed. The count is what lets a canned burst be
        // tied to actual audio having arrived, so a broken resampler or a dead
        // AudioContext still fails this provider rather than passing silently.
        framesSinceEdge++
      },

      setSpeaking(speaking) {
        if (closed) return
        if (speaking) {
          framesSinceEdge = 0
          return
        }
        // Falling edge: a burst just ended. Say whatever was queued for it, or
        // the next canned line if the test scripted nothing.
        if (!framesSinceEdge) return
        const queued = hook.pending.shift()
        emit(queued ?? { text: CANNED[cannedIndex++ % CANNED.length], speaker: '0' }, true)
      },

      close() {
        closed = true
        clearTimeout(liveTimer)
        hook.listeners.delete(deliver)
        log?.('fake stt closed')
      },

      stats() {
        return { provider: 'fake', clockMs, queued: hook.pending.length }
      },
    }
  },

  createReader(opts) {
    return createFakeReader(opts)
  },
}
