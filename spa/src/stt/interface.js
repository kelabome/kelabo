// The STT provider interface, browser half — and the registry that resolves it.
//
// `useCapture` owns the microphone, the VAD gate, the composer and the clock. A
// provider owns EVERYTHING about talking to its service: how many connections,
// when they open, when a billable stream starts and stops, the control frames,
// and the wire format. Nothing outside `spa/src/stt/` and
// `spa/src/transcript/stt/` names a provider or holds a socket.
//
// WHY THIS IS STREAM-SHAPED AND NOT SOCKET-SHAPED. It began as
// `open()/canSend()/keepalive()/close()` — one socket per kelabo, opened and
// held by the caller. That cannot express what Soniox needs. Soniox bills the
// WALL-CLOCK LIFETIME of a stream rather than the audio it receives, and the
// clock starts at the start request, not at connection setup — so a connected
// but unconfigured socket costs nothing and produces no usage record at all.
// The cheap design is therefore a pool of those, with a stream started on
// speech and ended on silence: several sockets per kelabo, most of them opened
// before anyone has said anything. A caller holding "the" socket cannot do it.
//
// So the caller hands over audio and says when speech starts and stops. What
// that means on the wire is the provider's business, and it differs completely
// between the two we have.
//
// A provider is three files and nothing else:
//
//   spa/src/stt/<id>.js             transport — this interface, implemented
//   spa/src/transcript/stt/<id>.js  reader    — pure, the whole wire format
//   rest-api/src/stt/<id>.js        mint      — the credential, server side
//
// plus one line in this registry and one in its server twin.

/**
 * One run of speech from one speaker. `start`/`end` are MILLISECONDS on the
 * provider's own audio clock — never seconds, whatever the provider sends.
 *
 * `speaker` is an OPAQUE, provider-scoped id, not an index: Deepgram counts
 * from 0, Soniox from "1", and normalising the numbering here would bake one
 * provider's convention into the interface. The empty string means "this
 * stream's own speaker" — diarization off, or a provider that does not separate
 * voices. Turning an id into an A/B/C label is `transcript/speakerLabels.js`,
 * once, for every provider.
 *
 * @typedef {{speaker: string, text: string, start: number, end: number}} SttSegment
 */

/**
 * One provider message, normalised. The only shape `useCapture` ever sees.
 *
 * `finals` and `tails` are both lists, always, because one message can carry
 * several speakers — and, on a token-stream provider, confirmed and unconfirmed
 * words for different people at the same time.
 *
 * @typedef {object} SttRead
 * @property {SttSegment[]} finals   confirmed words -> `composer.addFragment`
 * @property {SttSegment[]} tails    unconfirmed guess -> `composer.setTail`
 * @property {string[]} active       speaker ids that carried text, including
 *                                   text this message did not surface. Drives
 *                                   the seal clock; empty means silence.
 * @property {boolean} endpoint      the provider believes a speaker finished.
 * @property {{code:number, type:string, message:string}|null} error
 * @property {boolean} finished      the provider closed the stream itself.
 */

/**
 * @typedef {object} SttReader
 * @property {(msg: any) => SttRead} read
 * @property {() => void} reset
 */

/**
 * What a provider is given when a capture session starts.
 *
 * @typedef {object} SttConnectContext
 * @property {SttSession} session   the first minted credential and its params.
 * @property {number} sampleRate    what the AudioContext actually gave us —
 *   which is not what anybody asked for, and is not a constant.
 * @property {boolean} diarize
 * @property {string} language
 * @property {boolean} gated        whether the caller is only handing over
 *   audio that carries speech. A provider that bills per stream needs to know:
 *   with no gate there is no speech edge to start and stop one on.
 * @property {() => Promise<SttSession>} renew  mint another session. A provider
 *   whose credential outlives a single stream calls this on its own schedule,
 *   and never on the critical path of an utterance.
 * @property {(read: SttRead) => void} onRead
 * @property {() => void} onStreamStart  a NEW provider stream began, so its
 *   audio clock restarted at zero and its speaker numbering with it. The caller
 *   resets its clock mapping and its speaker labels. It does NOT reset the
 *   composer: an open message survives a stream boundary, and dropping it would
 *   lose whatever was said either side of one.
 * @property {(state: string) => void} onState  one of the capture states the
 *   room already renders: connecting | live | reconnecting | stt_unavailable.
 * @property {(...args: any[]) => void} log
 */

/**
 * The handle the caller keeps. Audio in, speech edges in, nothing else.
 *
 * @typedef {object} SttTransport
 * @property {(pcm: ArrayBuffer) => void} sendAudio  one frame. May be sent,
 *   buffered as pre-roll, or start a stream — the provider's call.
 * @property {(speaking: boolean) => void} setSpeaking  the VAD edge. Rising is
 *   the moment a provider may begin billing; falling begins the count towards
 *   ending the stream. Called with `true` once and never again when the caller
 *   is not gating.
 * @property {() => void} close
 * @property {() => (object|null)} stats  whatever the Debug drawer should show.
 */

/**
 * @typedef {object} SttClient
 * @property {string} id     matches the provider id the server mints under.
 * @property {string} label  what the connection light calls it.
 * @property {{diarization: 'always'|'optional'|'none', maxSpeakers: number}} capabilities
 * @property {boolean} prefersVad  the default for silence skipping. A
 *   participant's own choice always wins; this is only what to do when they
 *   have not expressed one.
 * @property {(ctx: SttConnectContext) => SttTransport} connect
 * @property {(opts: {diarize?: boolean, language?: string}) => SttReader} createReader
 *   Exposed separately from `connect` so the wire format can be exercised under
 *   plain node with no socket — which is where every parsing bug lives.
 */

/** @typedef {import('@kelabo/contracts/typedefs').SttSession} SttSession */

import { deepgramClient } from './deepgram.js'
import { sonioxClient } from './soniox.js'
import { fakeClient } from './fake.js'

/** @type {Record<string, SttClient>} */
const CLIENTS = {
  [deepgramClient.id]: deepgramClient,
  [sonioxClient.id]: sonioxClient,
  // Opens no socket and transcribes nothing; it exists so `e2e/` can drive the
  // capture pipeline in a real browser without a supplier account. It cannot be
  // reached from a config file — see ./fake.js and rest-api/src/stt/fake.js.
  [fakeClient.id]: fakeClient,
}

/**
 * Resolve the client for a provider id.
 *
 * An unknown id throws rather than falling back to a default, for the reason
 * `connector/src/runtimes.js` gives for runtimes: a default is the wrong parse
 * path and the wrong control frames, and that failure is silent everywhere —
 * the socket opens, audio streams, nothing is ever transcribed, and no error is
 * raised at any level.
 *
 * @param {string} id
 * @returns {SttClient}
 */
export function sttClient(id) {
  const client = CLIENTS[id]
  if (!client) {
    throw new Error(`unknown stt provider: ${JSON.stringify(id)} (have: ${sttClientIds().join(', ')})`)
  }
  return client
}

/** Every registered provider id. The conformance suite iterates this. */
export function sttClientIds() {
  return Object.keys(CLIENTS)
}
