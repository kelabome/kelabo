// Imports inside spa/src/transcript/ carry the .js extension (unlike the rest of
// the SPA, which relies on Vite's resolution) because these modules are also
// loaded by plain node in spa/test/transcript.mjs, and node ESM requires it.

// The fake provider's wire format — which is `SttRead` itself, near enough.
//
// Every other reader in here exists because a supplier invented a shape and
// somebody has to translate it. This one exists because the READER IS PART OF
// THE CONTRACT: a provider without one would be a provider whose transport
// bypassed the stage the others go through, and the e2e suite would then be
// exercising a shorter pipeline than production. So the fake transport emits
// messages in a deliberately plain shape and this turns them into reads, with
// the same normalisation the real readers do: milliseconds, string speaker ids,
// `active` derived rather than trusted.
//
// Pure: no socket, no clock, no React.

const empty = () => ({ finals: [], tails: [], active: [], endpoint: false, error: null, finished: false })

/** Milliseconds, integer, never negative — whatever the message claimed. */
const ms = v => Math.max(0, Math.round(Number(v) || 0))

function normalise(segments, diarize) {
  return (segments || [])
    .filter(s => s && typeof s.text === 'string' && s.text !== '')
    .map(s => ({
      // The empty string means "this stream's own speaker", which is what a
      // provider with diarization off reports. Turning an id into an A/B/C
      // label is `transcript/speakerLabels.js`'s job, once, for every provider.
      speaker: diarize ? String(s.speaker ?? '0') : '',
      text: s.text,
      start: ms(s.start),
      end: ms(s.end ?? s.start),
    }))
}

function speakersOf(segments) {
  const seen = []
  for (const s of segments) if (!seen.includes(s.speaker)) seen.push(s.speaker)
  return seen
}

/**
 * @param {{diarize?: boolean}} [opts]
 * @returns {{read: (msg: any) => object, reset: () => void}}
 */
export function createFakeReader({ diarize = false } = {}) {
  return {
    read(msg) {
      if (!msg || typeof msg !== 'object') return empty()
      if (msg.type === 'error') {
        return { ...empty(), error: { code: msg.code ?? 0, type: 'fake', message: msg.message ?? 'fake error' } }
      }
      if (msg.type === 'finished') return { ...empty(), finished: true }

      const finals = normalise(msg.finals, diarize)
      const tails = normalise(msg.tails, diarize)
      return {
        finals,
        tails,
        // Derived from what actually carried text, never taken from the
        // message: `active` drives the seal clock, and a provider that
        // over-reports it holds a message open forever.
        active: speakersOf([...finals, ...tails]),
        endpoint: msg.endpoint === true,
        error: null,
        finished: false,
      }
    },
    reset() {},
  }
}
