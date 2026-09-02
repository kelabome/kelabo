// Transcript pipeline tests (docs 13). Plain node, no DOM, no network — the
// Compose and Project stages are pure by design precisely so this file can
// exist. Until now the SPA's only gate was `npm run build`, which is why every
// transcript boundary bug had to be found in a live kelabo.
import assert from 'node:assert/strict'
import { createComposer, LOCAL_SPEAKER } from '../src/transcript/composer.js'
import {
  apply,
  emptyTranscript,
  messageParts,
  messageText,
  messages,
  renameSpeaker,
} from '../src/transcript/transcriptStore.js'
import { createSpeakerLabels, MAX_LABELS } from '../src/transcript/speakerLabels.js'
import { sttClient, sttClientIds } from '../src/stt/interface.js'
import { fromWire, DELTA, SEALED, TAIL } from '../src/transcript/events.js'

let passed = 0
const ok = msg => {
  passed += 1
  console.log('ok:', msg)
}

// A composer wired to a controllable clock and a recording sink.
function harness({ speakerId = 'alice@example.com', ...opts } = {}) {
  const events = []
  let t = 1000
  const composer = createComposer({
    speakerId,
    emit: e => events.push(e),
    now: () => t,
    ...opts,
  })
  return {
    composer,
    events,
    advance: ms => {
      t += ms
    },
    at: () => t,
  }
}

// Project a list of events exactly the way a client does.
function project(events, meta = {}) {
  return events.reduce((state, e) => apply(state, e, meta), emptyTranscript())
}

// --- Read: the provider interface, for every provider ------------------------
//
// One suite over the registry, not one per provider. Adding a provider adds a
// fixture set below and inherits every assertion here; if the interface is real
// this file needs no other edit, and if a provider quietly returns seconds, or
// a speaker index, or a bare string where a list belongs, it fails here rather
// than as a transcript that looks subtly wrong in a live kelabo.

// A Results frame as Deepgram documents it.
const dg = (start, duration, transcript, extra = {}) => ({
  type: 'Results',
  start,
  duration,
  is_final: false,
  channel: { alternatives: [{ transcript }] },
  ...extra,
})

const dgWords = (words, extra = {}) => ({
  type: 'Results',
  start: 0,
  duration: Math.max(...words.map(w => w.end)),
  is_final: true,
  channel: { alternatives: [{ transcript: words.map(w => w.word).join(' '), words }] },
  ...extra,
})

// One Soniox token, and one response carrying some.
const tok = (text, start, end, extra = {}) => ({
  text,
  start_ms: start,
  end_ms: end,
  confidence: 0.97,
  is_final: false,
  ...extra,
})
const sx = (tokens, extra = {}) => ({
  tokens,
  final_audio_proc_ms: 0,
  total_audio_proc_ms: 0,
  ...extra,
})

/**
 * What each provider has to supply to be conformance-tested. Keyed by provider
 * id, and asserted to be complete against the registry — a provider added
 * without fixtures fails the suite instead of silently going untested.
 */
const FIXTURES = {
  deepgram: {
    // Anything at all, to check the shape of what comes back.
    samples: [
      dg(0, 1.5, 'a guess'),
      dg(0, 1.5, 'a settled thing', { is_final: true }),
      dg(0, 1, ''),
      { type: 'UtteranceEnd', last_word_end: 3.1 },
    ],
    // No diarization: one speaker, and it is whoever holds the microphone.
    plain: dg(0, 2, 'just me talking', { is_final: true }),
    // Two people inside ONE provider message.
    multiSpeaker: dgWords([
      { word: 'hello', start: 0.1, end: 0.5, speaker: 0 },
      { word: 'there', start: 0.5, end: 0.9, speaker: 0 },
      { word: 'hi', start: 1.0, end: 1.4, speaker: 1 },
    ]),
    // Read twice on a fresh reader, this must commit the same words both times:
    // a new socket restarts the provider's clock, and a reader holding state
    // from the old one drops the first thing said on the new one.
    replayable: dg(0, 2, 'after a reconnect', { is_final: true }),
  },

  // Soniox sends tokens, not spans: subwords and words each carrying their own
  // `is_final`, their own timestamps in ms, and their own leading spaces.
  soniox: {
    samples: [
      sx([tok('How', 0, 200, { is_final: true }), tok(' are', 200, 400)]),
      sx([tok(' you', 400, 600, { is_final: true })], { finished: false }),
      sx([]),
      { tokens: [], finished: true, final_audio_proc_ms: 600, total_audio_proc_ms: 600 },
      { tokens: [], error_code: 503, error_type: 'service_unavailable', error_message: 'nope' },
    ],
    plain: sx([tok('just', 0, 300, { is_final: true }), tok(' me', 300, 600, { is_final: true })]),
    multiSpeaker: sx([
      tok('hello', 100, 500, { is_final: true, speaker: '1' }),
      tok(' there', 500, 900, { is_final: true, speaker: '1' }),
      tok('hi', 1000, 1400, { is_final: true, speaker: '2' }),
    ]),
    replayable: sx([tok('after a reconnect', 0, 2000, { is_final: true })]),
  },
  // The offline provider (spa/src/stt/fake.js). It is in the registry, so it is
  // held to the same contract as the two real ones — which is the point of
  // testing it at all: the e2e suite drives the whole capture pipeline through
  // this reader, and a reader that quietly returned the wrong shape would make
  // that suite prove something about a pipeline the product does not have.
  fake: {
    samples: [
      { tails: [{ speaker: '0', text: 'a guess', start: 0, end: 500 }] },
      { finals: [{ speaker: '0', text: 'a settled thing', start: 0, end: 900 }], endpoint: true },
      { finals: [], tails: [] },
      { type: 'error', code: 503, message: 'nope' },
      { type: 'finished' },
      // Not an object at all — the transport is in-process, so a caller
      // mistake arrives here rather than being filtered by a socket.
      null,
    ],
    plain: { finals: [{ speaker: '0', text: 'just me talking', start: 0, end: 1200 }] },
    multiSpeaker: {
      finals: [
        { speaker: '1', text: 'hello there', start: 100, end: 900 },
        { speaker: '2', text: 'hi', start: 1000, end: 1400 },
      ],
    },
    replayable: { finals: [{ speaker: '0', text: 'after a reconnect', start: 0, end: 2000 }] },
  },
}

for (const id of sttClientIds()) {
  const client = sttClient(id)
  const fx = FIXTURES[id]
  assert.ok(fx, `provider ${id} is registered but has no conformance fixtures`)

  // Shape. Every field, every time — a caller that has to check whether `finals`
  // exists is a caller that will forget.
  {
    const reader = client.createReader({ diarize: true, language: 'en' })
    for (const msg of fx.samples) {
      const r = reader.read(msg)
      for (const k of ['finals', 'tails', 'active', 'endpoint', 'error', 'finished']) {
        assert.ok(k in r, `${id}: read() must always return ${k}`)
      }
      assert.ok(Array.isArray(r.finals) && Array.isArray(r.tails) && Array.isArray(r.active))
      assert.equal(typeof r.endpoint, 'boolean')
      assert.equal(typeof r.finished, 'boolean')
      for (const seg of [...r.finals, ...r.tails]) {
        assert.equal(typeof seg.speaker, 'string', `${id}: speaker is an opaque string, never an index`)
        assert.equal(typeof seg.text, 'string')
        // Milliseconds, and whole ones. A provider that leaks seconds here puts
        // every message at the very start of the kelabo, which reads as an
        // ordering bug a long way from its cause.
        assert.ok(Number.isInteger(seg.start), `${id}: start must be integer ms, got ${seg.start}`)
        assert.ok(Number.isInteger(seg.end), `${id}: end must be integer ms, got ${seg.end}`)
      }
      for (const sp of r.active) assert.equal(typeof sp, 'string')
    }
    ok(`${id}: every read returns the SttRead shape, in milliseconds`)
  }

  // Text carries no speaker id when the stream is not separated into voices, so
  // the caller can file it under the local speaker without knowing the provider.
  {
    const reader = client.createReader({ diarize: false, language: 'en' })
    const r = reader.read(fx.plain)
    assert.ok(r.finals.length >= 1)
    for (const seg of r.finals) assert.equal(seg.speaker, '', `${id}: undiarized speech has no speaker id`)
    ok(`${id}: undiarized speech is attributed to the stream, not to a voice`)
  }

  // THE multi-speaker requirement: one audio stream, several people, one message.
  {
    const reader = client.createReader({ diarize: true, language: 'en' })
    const r = reader.read(fx.multiSpeaker)
    const speakers = [...new Set(r.finals.map(s => s.speaker))]
    assert.ok(speakers.length >= 2, `${id}: two voices in one message must read as two segments`)
    assert.ok(r.finals.every(s => s.text), `${id}: no empty segments`)
    // Stream order, so the composer appends each speaker's words in the order
    // they were actually said.
    const starts = r.finals.map(s => s.start)
    assert.deepEqual(starts, [...starts].sort((a, b) => a - b), `${id}: segments in stream order`)
    assert.deepEqual([...new Set(r.active)].sort(), speakers.slice().sort())
    ok(`${id}: several speakers in one message read as one segment each`)
  }

  // reset() genuinely resets: whatever per-stream bookkeeping a wire format
  // needs, none of it may survive into the next socket.
  {
    const reader = client.createReader({ diarize: false, language: 'en' })
    const first = reader.read(fx.replayable)
    reader.reset()
    const again = reader.read(fx.replayable)
    assert.deepEqual(again.finals, first.finals, `${id}: after reset the same audio reads the same way`)
    ok(`${id}: reset() drops all per-stream state`)
  }
}

// --- Read: Deepgram's wire format in particular -----------------------------
const dgReader = (opts = {}) => sttClient('deepgram').createReader({ language: 'en', ...opts })

{
  // The worked example from Deepgram's own docs: interims restate the segment in
  // progress, `is_final` settles it, and the next segment starts where that one
  // ended. A whole utterance is the concatenation of its finals.
  const frames = [
    dg(0.0, 1.1, 'yeah so'),
    dg(0.0, 2.2, 'yeah so my credit card number'),
    dg(0.0, 3.2, 'yeah so my credit card number is two two'),
    dg(0.0, 3.26, 'yeah so my credit card number is two two', { is_final: true, speech_final: false }),
    dg(3.26, 1.84, 'two two three three three three'),
    dg(3.26, 2.24, 'two two three three three three', { is_final: true, speech_final: true }),
  ]
  const reader = dgReader()
  const finals = []
  for (const f of frames) for (const seg of reader.read(f).finals) finals.push(seg.text)
  assert.deepEqual(finals, [
    'yeah so my credit card number is two two',
    'two two three three three three',
  ])
  ok('Deepgram\u2019s documented interim/final sequence reads as two settled segments')
}

{
  // THE BUG THIS REPLACED. A final is authoritative the moment it arrives, so it
  // is read as settled without any pause signal. Waiting for `speech_final`,
  // `UtteranceEnd` or a `Finalize` answer — none of which are reliable once the
  // VAD gate has removed the silence they measure — left confirmed words sitting
  // as an unconfirmed tail for the whole utterance.
  const r = dgReader().read(dg(0, 2, 'no pause signal anywhere', { is_final: true }))
  assert.equal(r.finals.length, 1)
  assert.equal(r.finals[0].text, 'no pause signal anywhere')
  assert.equal(r.tails.length, 0, 'a final leaves nothing outstanding')
  assert.equal(r.endpoint, false, 'Deepgram\u2019s pause signals are deliberately not read')
  ok('a final needs no speech_final, UtteranceEnd or Finalize to be settled')
}

{
  // Re-emission of an already finalized span (CJK models do this routinely).
  // Dropped, because it is already committed — but still that speaker talking,
  // so it holds their message open rather than letting it seal mid-utterance.
  const reader = dgReader()
  const first = reader.read(dg(0, 3.26, '今天天气很好', { is_final: true }))
  assert.equal(first.finals.length, 1)
  const again = reader.read(dg(0, 3.26, '今天天气很好', { is_final: true }))
  assert.deepEqual(again.finals, [], 'the same span must not be committed twice')
  assert.deepEqual(again.active, [''], 'but it is still speech, and still holds the message open')
  ok('a final for a span already finalized is dropped, not committed twice')
}

{
  // Empty results are Deepgram idling on audio with no speech. They are not
  // activity (they must not hold the seal clock open) but an empty *final* still
  // settles its audio, so the next real final is not read as overlapping it.
  const reader = dgReader()
  const interim = reader.read(dg(0, 1, ''))
  assert.deepEqual(interim.active, [], 'an empty result is not activity')
  assert.deepEqual(interim.finals, [])
  assert.deepEqual(interim.tails, [])
  const settled = reader.read(dg(0, 1, '', { is_final: true }))
  assert.deepEqual(settled.active, [])
  // The span it settled is gone: a later final covering only that span is a
  // re-emission, not new words.
  assert.deepEqual(reader.read(dg(0, 1, 'late', { is_final: true })).finals, [])
  ok('empty results are not activity, but an empty final still settles its span')
}

{
  // Non-Results frames (UtteranceEnd, SpeechStarted, Metadata) carry no
  // transcript. They are read, and they do nothing — deliberately.
  const r = dgReader().read({ type: 'UtteranceEnd', channel: [0, 1], last_word_end: 3.1 })
  assert.deepEqual(r.finals, [])
  assert.deepEqual(r.tails, [])
  assert.deepEqual(r.active, [])
  ok('UtteranceEnd carries no transcript and changes nothing')
}

{
  // A final that partially overlaps what is already committed contributes only
  // its new words — otherwise the overlap is transcribed twice.
  const reader = dgReader({ diarize: true })
  reader.read(dgWords([{ word: 'already', start: 0.1, end: 0.5, speaker: 0 },
                       { word: 'said', start: 0.5, end: 1.0, speaker: 0 }]))
  const r = reader.read(dgWords([
    { word: 'already', start: 0.1, end: 0.5, speaker: 0 },
    { word: 'said', start: 0.5, end: 1.0, speaker: 0 },
    { word: 'new', start: 1.2, end: 1.6, speaker: 0 },
  ]))
  assert.deepEqual(r.finals.map(s => s.text), ['new'])
  ok('a partially covered final contributes only the words it adds')
}

{
  // CJK: nova word lists mix phrase- and token-level entries, so re-joining them
  // duplicates text. Undiarized, the response transcript is authoritative — and
  // the joiner is the READER\u2019s business, chosen from the language it was built
  // with, so nothing upstream has to know which languages need it.
  const words = [
    { word: '今天', start: 0, end: 0.5 },
    { word: '今天天气', start: 0, end: 1.0 },
  ]
  const r = sttClient('deepgram').createReader({ diarize: false, language: 'zh' }).read(
    { type: 'Results', start: 0, duration: 1.0, is_final: true, channel: { alternatives: [{ transcript: '今天天气', words }] } },
  )
  assert.deepEqual(r.finals.map(s => s.text), ['今天天气'])
  ok('an undiarized final trusts the transcript, not a re-join of its word list')
}

{
  // A diarized interim stays ONE tail even though the interface allows several:
  // Deepgram re-attributes words between revisions of the same guess, so
  // splitting it would open and abandon a message per flicker. The finals it
  // later commits are attributed stably, and those are what get persisted.
  const r = dgReader({ diarize: true }).read({
    type: 'Results', start: 0, duration: 1.4, is_final: false,
    channel: { alternatives: [{ transcript: 'hello there hi', words: [
      { word: 'hello', start: 0.1, end: 0.5, speaker: 0 },
      { word: 'hi', start: 1.0, end: 1.4, speaker: 1 },
    ] }] },
  })
  assert.equal(r.tails.length, 1)
  assert.equal(r.tails[0].text, 'hello hi')
  ok('a diarized guess is one tail, because Deepgram re-attributes guesses')
}

{
  // End to end through the composer: three finals with no pause signal at all
  // become one message with all three committed — nothing left as a tail.
  const { composer, events, advance } = harness()
  const reader = dgReader()
  for (const f of [
    dg(0, 1.5, 'first part', { is_final: true }),
    dg(1.5, 1.5, 'second part', { is_final: true }),
    dg(3.0, 1.5, 'third part', { is_final: true }),
  ]) {
    for (const seg of reader.read(f).finals) {
      composer.addFragment({ text: seg.text, speakerLabel: 'Moon', tStart: seg.start, tEnd: seg.end })
    }
  }
  assert.equal(events.filter(e => e.type === DELTA).length, 3, 'each final committed on arrival')
  advance(1100)
  assert.equal(composer.sealIfIdle(), true)
  const sealed = events.find(e => e.type === SEALED)
  assert.equal(sealed.text, 'first part second part third part')
  assert.equal(sealed.reason, 'silence', 'sealed by silence, not stranded until stt_stalled')
  ok('finals commit as they arrive and seal on silence — never stranded as a tail')
}

// --- Read: Soniox's wire format in particular -------------------------------
const sxReader = (opts = {}) => sttClient('soniox').createReader(opts)

{
  // Tokens carry their own spacing, so a run is plain concatenation — and then
  // trimmed, because the composer inserts the separator itself when it appends.
  // Without the trim every word after the first arrives doubly spaced.
  const r = sxReader().read(sx([
    tok('How', 0, 200, { is_final: true }),
    tok(' are', 200, 400, { is_final: true }),
    tok(' you', 400, 600, { is_final: true }),
  ]))
  assert.equal(r.finals.length, 1)
  assert.equal(r.finals[0].text, 'How are you')
  assert.equal(r.finals[0].start, 0)
  assert.equal(r.finals[0].end, 600)
  ok('soniox tokens concatenate with no joiner and the run is trimmed')
}

{
  // The composer then joins that onto what it already has, exactly once.
  const { composer, events } = harness()
  const reader = sxReader()
  for (const msg of [
    sx([tok('How', 0, 200, { is_final: true }), tok(' are', 200, 400)]),
    sx([tok(' are', 200, 400, { is_final: true }), tok(' you', 400, 600)]),
    sx([tok(' you', 400, 600, { is_final: true })]),
  ]) {
    const r = reader.read(msg)
    for (const seg of r.finals) composer.addFragment({ text: seg.text, speakerLabel: 'Moon' })
    for (const seg of r.tails) composer.setTail({ text: seg.text, speakerLabel: 'Moon' })
  }
  composer.seal('stop')
  assert.equal(events.find(e => e.type === SEALED).text, 'How are you')
  ok('a token stream composes into one correctly spaced message')
}

{
  // ONE response, both kinds at once — the reason `finals` and `tails` are
  // separate lists rather than a discriminated kind. Deepgram never does this;
  // Soniox does it constantly.
  const r = sxReader().read(sx([
    tok('settled', 0, 300, { is_final: true }),
    tok(' guess', 300, 600),
  ]))
  assert.deepEqual(r.finals.map(s => s.text), ['settled'])
  assert.deepEqual(r.tails.map(s => s.text), ['guess'])
  ok('one response carries confirmed and unconfirmed words together')
}

{
  // And with two speakers, both halves split — the case the interface allows
  // and Deepgram deliberately declines, because Soniox's guesses are stable
  // per speaker where Deepgram's are re-attributed between revisions.
  const r = sxReader({ diarize: true }).read(sx([
    tok('I think', 0, 400, { is_final: true, speaker: '1' }),
    tok('no wait', 400, 800, { speaker: '2' }),
  ]))
  assert.deepEqual(r.finals.map(s => [s.speaker, s.text]), [['1', 'I think']])
  assert.deepEqual(r.tails.map(s => [s.speaker, s.text]), [['2', 'no wait']])
  assert.deepEqual(r.active, ['1', '2'])
  ok('two speakers can hold a confirmed and an unconfirmed run at the same time')
}

{
  // `<end>` and `<fin>` are signals, not speech. Leaving them in the text posts
  // literal "<end>" to the board and to the LLM.
  for (const marker of ['<end>', '<fin>']) {
    const r = sxReader().read(sx([
      tok('all done', 0, 400, { is_final: true }),
      tok(marker, 400, 400, { is_final: true }),
    ]))
    assert.deepEqual(r.finals.map(s => s.text), ['all done'], `${marker} must not reach the transcript`)
    assert.equal(r.endpoint, true, `${marker} reports an endpoint`)
  }
  ok('marker tokens are read as an endpoint signal, never as words')
}

{
  // Soniox reports failure in-band and then closes, so the reason is knowable
  // — unlike a socket that merely drops.
  const r = sxReader().read({
    tokens: [], error_code: 403, error_type: 'temp_api_key_session_expired', error_message: 'expired',
  })
  assert.equal(r.error.code, 403)
  assert.equal(r.error.type, 'temp_api_key_session_expired')
  assert.deepEqual(r.finals, [])
  assert.deepEqual(r.active, [], 'an error is not activity')
  ok('an error response is reported, not parsed as speech')
}

{
  const reader = sxReader()
  assert.equal(reader.read(sx([])).active.length, 0, 'a response with no tokens is idle')
  // Whitespace-only tokens are the gaps between words, not speech: counting
  // them would hold a message open through a silence.
  assert.deepEqual(reader.read(sx([tok(' ', 0, 10, { is_final: true })])).active, [])
  assert.equal(reader.read({ tokens: [], finished: true }).finished, true)
  ok('empty, whitespace-only and finished responses carry no speech')
}

// --- Compose: where messages begin and end ---------------------------------
{
  const { composer, events } = harness()
  composer.addFragment({ text: 'Alright.', speakerLabel: 'Moon', tStart: 0, tEnd: 500 })
  composer.addFragment({ text: "Let's get started.", speakerLabel: 'Moon', tStart: 500, tEnd: 1200 })
  composer.seal('silence')

  assert.equal(events.filter(e => e.type === DELTA).length, 2)
  const sealed = events.filter(e => e.type === SEALED)
  assert.equal(sealed.length, 1)
  assert.equal(sealed[0].text, "Alright. Let's get started.")
  // Both fragments and the seal share one id — that id IS the message boundary,
  // and it is what every client groups by.
  assert.equal(new Set(events.map(e => e.messageId)).size, 1)
  ok('fragments and their seal share one message id')
}

{
  const { composer, events } = harness()
  composer.addFragment({ text: 'one', speakerLabel: 'Moon' })
  composer.seal('silence')
  composer.addFragment({ text: 'two', speakerLabel: 'Moon' })
  composer.seal('silence')
  const ids = new Set(events.map(e => e.messageId))
  assert.equal(ids.size, 2, 'a seal starts a genuinely new message')
  assert.equal(messages(project(events)).length, 2)
  ok('speech after a seal opens a new message, never reopens the old one')
}

// --- Compose: seal triggers -------------------------------------------------
{
  // The VAD gate has no vote in sealing. Deepgram's Finalize answer (sent when
  // the gate shuts) is just another message: it resets the clock like any
  // other, and the seal lands a second later if nothing follows.
  const { composer, events, advance } = harness()
  composer.addFragment({ text: 'hello', speakerLabel: 'Moon' })
  advance(500)
  composer.noteActivity([LOCAL_SPEAKER]) // the Finalize answer comes back
  advance(500)
  assert.equal(composer.sealIfIdle(), false, 'still inside the second')
  advance(600)
  assert.equal(composer.sealIfIdle(), true)
  assert.equal(events.find(e => e.type === SEALED).reason, 'silence')
  ok('a gate close does not seal — 1s of Deepgram silence does')
}

{
  const { composer, events, advance } = harness({ maxOpenMs: 5000 })
  composer.addFragment({ text: 'still going', speakerLabel: 'Moon' })
  advance(6000)
  composer.addFragment({ text: 'and going', speakerLabel: 'Moon' })
  const sealed = events.filter(e => e.type === SEALED)
  assert.equal(sealed.length, 1)
  assert.equal(sealed[0].reason, 'max_open_ms')
  // The cap seals on a fragment boundary, so no fragment is ever cut in half.
  assert.equal(sealed[0].text, 'still going and going')
  ok('the time cap seals on the next fragment boundary, not mid-fragment')
}

{
  const { composer, events } = harness({ maxWords: 5 })
  composer.addFragment({ text: 'one two three', speakerLabel: 'Moon' })
  composer.addFragment({ text: 'four five six', speakerLabel: 'Moon' })
  assert.equal(events.find(e => e.type === SEALED)?.reason, 'max_words')
  ok('the word cap bounds what can ever reach the LLM in one message')
}

{
  // CJK is not space-separated, so whitespace tokens alone would never reach the
  // cap and a Chinese speaker's message would be unbounded.
  const { composer, events } = harness({ maxWords: 5 })
  composer.addFragment({ text: '今天天气', speakerLabel: 'Moon' })
  composer.addFragment({ text: '很好啊', speakerLabel: 'Moon' })
  assert.equal(events.find(e => e.type === SEALED)?.reason, 'max_words')
  ok('the word cap counts CJK characters, which have no spaces to split on')
}

// --- Compose: several speakers in one audio stream --------------------------
//
// A room mic carries more than one person, and a good diarizer separates them
// mid-conversation. Composing that into a single open message and sealing on
// every speaker change shredded both of them into one fragment per turn.

{
  const { composer, events } = harness()
  composer.addFragment({ text: 'from A', speakerLabel: 'A', key: 'A' })
  composer.addFragment({ text: 'from B', speakerLabel: 'B', key: 'B' })
  assert.equal(events.filter(e => e.type === SEALED).length, 0, 'a speaker change is not a seal')
  assert.deepEqual(composer.openKeys(), ['A', 'B'], 'both are open at once')
  ok('a second speaker opens their own message rather than closing the first')
}

{
  // The failure this replaced: A and B interleaving produced a seal per turn.
  // Now each speaker accumulates their own message, whatever order they arrive
  // in, and the transcript holds two.
  const { composer, events, advance } = harness()
  for (const [key, text] of [
    ['A', 'so I was thinking'],
    ['B', 'go on'],
    ['A', 'we should ship it'],
    ['B', 'agreed'],
  ]) {
    composer.addFragment({ text, speakerLabel: key, key })
    advance(100)
  }
  assert.equal(events.filter(e => e.type === SEALED).length, 0, 'nothing sealed while both were talking')
  advance(1100)
  assert.equal(composer.sealIfIdle(), true)

  const sealed = events.filter(e => e.type === SEALED)
  assert.equal(sealed.length, 2, 'two speakers, two messages — not four fragments')
  assert.deepEqual(
    sealed.map(e => [e.speakerLabel, e.text]).sort(),
    [['A', 'so I was thinking we should ship it'], ['B', 'go on agreed']].sort(),
  )
  // And the projection agrees, ordered by when each person started speaking.
  assert.deepEqual(messages(project(events)).map(m => m.speakerLabel), ['A', 'B'])
  ok('INTERLEAVED SPEAKERS COMPOSE INTO ONE MESSAGE EACH (the multi-speaker invariant)')
}

{
  // Each speaker's clock runs on their own. One person talking continuously
  // must not hold a silent person's message open — that is how a room mic
  // produces a single unbounded message per voice.
  const { composer, events, advance } = harness()
  composer.addFragment({ text: 'B says one thing', speakerLabel: 'B', key: 'B' })
  for (let i = 0; i < 10; i++) {
    advance(300)
    composer.addFragment({ text: 'and', speakerLabel: 'A', key: 'A' })
    composer.sealIfIdle()
  }
  const sealed = events.filter(e => e.type === SEALED)
  assert.equal(sealed.length, 1, 'B sealed on B‘s silence')
  assert.equal(sealed[0].speakerLabel, 'B')
  assert.deepEqual(composer.openKeys(), ['A'], 'A is still talking')
  ok('one speaker talking does not hold another speaker’s message open')
}

{
  // Activity is keyed too. A guess suppressed by `finalOnly`, or a span already
  // committed, still holds THAT speaker's message open and nobody else's.
  const { composer, advance } = harness()
  composer.addFragment({ text: 'a', speakerLabel: 'A', key: 'A' })
  composer.addFragment({ text: 'b', speakerLabel: 'B', key: 'B' })
  advance(800)
  composer.noteActivity(['A'])
  advance(400)
  composer.sealIfIdle()
  assert.deepEqual(composer.openKeys(), ['A'], 'A was held open, B timed out')
  ok('noteActivity holds open only the speakers who actually said something')
}

{
  // Mute, stop, kelabo end: everyone's message closes, because the stream is
  // going away and nothing more can arrive for any of them.
  const { composer, events } = harness()
  composer.addFragment({ text: 'one', speakerLabel: 'A', key: 'A' })
  composer.setTail({ text: 'two', speakerLabel: 'B', key: 'B' })
  const ids = composer.seal('mute')
  assert.equal(ids.length, 2)
  assert.deepEqual(composer.openKeys(), [])
  assert.deepEqual(
    events.filter(e => e.type === SEALED).map(e => e.text).sort(),
    ['one', 'two'],
    'an unconfirmed guess is kept, not dropped, for every speaker',
  )
  ok('sealing without a speaker closes every open message')
}

{
  // Caps are per message, so one person monologuing cannot cut somebody else off.
  const { composer, events } = harness({ maxWords: 3 })
  composer.addFragment({ text: 'one two', speakerLabel: 'A', key: 'A' })
  composer.addFragment({ text: 'short', speakerLabel: 'B', key: 'B' })
  composer.addFragment({ text: 'three four', speakerLabel: 'A', key: 'A' })
  const sealed = events.filter(e => e.type === SEALED)
  assert.equal(sealed.length, 1)
  assert.equal(sealed[0].speakerLabel, 'A')
  assert.equal(sealed[0].reason, 'max_words')
  assert.deepEqual(composer.openKeys(), ['B'], 'B was nowhere near the cap')
  ok('the word cap bounds one speaker’s message, not the whole stream')
}

// --- Compose: THE seal rule -------------------------------------------------
{
  // The reported bug: continuous talking split into small messages. Any Deepgram
  // message — interim or final — has to reset the clock, so a speaker producing
  // a steady stream is never cut.
  const { composer, events, advance } = harness()
  composer.addFragment({ text: 'I am still talking', speakerLabel: 'Moon' })
  for (let i = 0; i < 60; i++) {
    advance(800) // interims arriving faster than the 1s timeout
    composer.noteActivity([LOCAL_SPEAKER])
    composer.sealIfIdle()
  }
  assert.equal(events.filter(e => e.type === SEALED).length, 0, '48s of speech stayed one message')
  ok('any Deepgram message resets the clock, so continuous speech is never cut')
}

{
  const { composer, events, advance } = harness()
  composer.addFragment({ text: 'done now', speakerLabel: 'Moon' })
  advance(999)
  assert.equal(composer.sealIfIdle(), false, 'not yet — still inside the second')
  advance(2)
  assert.equal(composer.sealIfIdle(), true)
  assert.equal(events.find(e => e.type === SEALED).reason, 'silence')
  ok('1s with nothing from Deepgram seals the message')
}

{
  // Interims count. `finalOnly` mode used to discard them before they could
  // reset the clock, so only finals restarted it — and finals are routinely more
  // than a second apart, which sealed continuously mid-speech.
  const { composer, events, advance } = harness()
  composer.addFragment({ text: 'keep going', speakerLabel: 'Moon' })
  advance(900)
  composer.noteActivity([LOCAL_SPEAKER]) // an interim carrying text
  advance(900)
  assert.equal(composer.sealIfIdle(), false, 'the interim reset the clock')
  advance(200)
  assert.equal(composer.sealIfIdle(), true)
  assert.equal(events.filter(e => e.type === SEALED).length, 1)
  ok('an interim result resets the clock exactly like a final')
}

{
  // The rule is uniform: with silence skipping off there is no gate at all and
  // nothing about this changes.
  const { composer, events, advance } = harness()
  composer.addFragment({ text: 'vad is off', speakerLabel: 'Moon' })
  advance(1100)
  assert.equal(composer.sealIfIdle(), true)
  assert.equal(events.filter(e => e.type === SEALED).length, 1)
  ok('the rule is identical whether or not the VAD gate is running')
}

{
  const { composer } = harness()
  assert.equal(composer.sealIfIdle(), false, 'nothing open, nothing to seal')
  ok('the idle poll is a no-op when no message is open')
}

// --- The live tail: one box, not two ----------------------------------------
{
  // The reported bug: two unclosed boxes for one utterance. The guess used to be
  // rendered outside the transcript as its own bubble alongside the open
  // message. It now lives *inside* the message, so there is only ever one box.
  const { composer, events } = harness()
  composer.setTail({ text: 'I think we should', speakerLabel: 'Moon' })
  composer.setTail({ text: 'I think we should ship', speakerLabel: 'Moon' })
  const state = project(events)
  assert.equal(messages(state).length, 1, 'one message, not one per revision')
  const m = messages(state)[0]
  assert.equal(m.text, '', 'nothing is confirmed yet')
  assert.equal(m.tail, 'I think we should ship', 'the newest guess replaced the older one')
  ok('a revised guess replaces the tail in place — one box, never two')
}

{
  // Confirmation moves words from the tail into the committed text.
  const { composer, events } = harness()
  composer.setTail({ text: 'hello ther', speakerLabel: 'Moon' })
  composer.addFragment({ text: 'hello there', speakerLabel: 'Moon' })
  const m = messages(project(events))[0]
  assert.equal(m.text, 'hello there')
  assert.equal(m.tail, '', 'the guess is gone once the words are confirmed')
  ok('a finalized fragment clears the tail and commits the words')
}

{
  // Speech shows up before anything is confirmed — the box appears at once, on
  // the speaker's screen and on every listener's.
  const { composer, events } = harness()
  composer.setTail({ text: 'starting to talk', speakerLabel: 'Moon' })
  assert.equal(events.filter(e => e.type === TAIL).length, 1, 'the guess is fanned out immediately')
  assert.equal(messages(project(events))[0].state, 'open')
  ok('a message appears as soon as there is any text, confirmed or not')
}

{
  // Deepgram or the network failed mid-utterance: the last segment stays a guess
  // and nothing more arrives. Close it rather than leave it hanging.
  const { composer, events, advance } = harness({ staleTimeoutMs: 5000 })
  composer.addFragment({ text: 'we should', speakerLabel: 'Moon' })
  composer.setTail({ text: 'we should probably', speakerLabel: 'Moon' })
  advance(1500)
  assert.equal(composer.sealIfIdle(), false, 'an outstanding guess gets longer than 1s')
  advance(4000)
  assert.equal(composer.sealIfIdle(), true)
  const sealed = events.find(e => e.type === SEALED)
  assert.equal(sealed.reason, 'stt_stalled')
  assert.equal(sealed.text, 'we should probably', 'closed on what was actually heard')
  ok('an unconfirmed last segment waits longer, then closes on what was heard')
}

{
  // Stopping mid-guess keeps the words. They were heard; discarding them to
  // avoid recording something unconfirmed would lose real speech.
  const { composer, events } = harness()
  composer.setTail({ text: 'one last thing', speakerLabel: 'Moon' })
  composer.seal('stop')
  const sealed = events.find(e => e.type === SEALED)
  assert.equal(sealed.text, 'one last thing')
  assert.equal(messages(project(events))[0].state, 'sealed')
  ok('sealing with only a guess keeps the words rather than dropping them')
}

{
  // Deepgram interims often restate the whole utterance instead of only the new
  // tail — CJK models do it routinely — so a naive append shows every word twice.
  const { composer, events } = harness()
  composer.addFragment({ text: 'we should', speakerLabel: 'Moon' })
  composer.setTail({ text: 'we should probably ship', speakerLabel: 'Moon' })
  composer.seal('stop')
  assert.equal(events.find(e => e.type === SEALED).text, 'we should probably ship')
  ok('a guess that restates confirmed words replaces them instead of duplicating')
}

{
  // Empty results are Deepgram idling on audio with no speech in it. Counting
  // them as activity kept the clock alive forever and the message never closed.
  const { composer, events, advance } = harness()
  composer.addFragment({ text: 'all done', speakerLabel: 'Moon' })
  for (let i = 0; i < 10; i++) {
    advance(300)
    composer.noteActivity([]) // empty interim results streaming in
    composer.sealIfIdle()
  }
  assert.equal(events.filter(e => e.type === SEALED).length, 1, 'empty results did not hold it open')
  ok('empty Deepgram results are not activity — they never block a seal')
}

// --- Render split: only the outstanding guess is live ------------------------
{
  // The reported bug: the whole box was styled as provisional whenever any tail
  // was outstanding, so a minute of settled transcript flickered as if it were
  // about to change. Only the trailing guess may still change.
  const split = m => messageParts(m)

  // Appended tail: the settled words keep their own styling.
  assert.deepEqual(
    split({ text: 'we should', tail: 'probably ship' }),
    { settled: 'we should', live: ' probably ship' },
  )

  // Restated tail (CJK models do this constantly): the boundary is NOT
  // text.length, so it is found by walking the guess.
  assert.deepEqual(
    split({ text: 'we should', tail: 'we should probably ship' }),
    { settled: 'we should ', live: 'probably ship' },
  )
  assert.deepEqual(
    split({ text: '今天天气', tail: '今天天气很好啊' }),
    { settled: '今天天气', live: '很好啊' },
  )

  // Punctuation and case differ between the guess and the confirmed text, and
  // the split still lands on the same words.
  assert.deepEqual(
    split({ text: 'Alright,', tail: 'alright — so' }),
    { settled: 'alright — ', live: 'so' },
  )

  assert.deepEqual(split({ text: 'all done', tail: '' }), { settled: 'all done', live: '' })
  assert.deepEqual(split({ text: '', tail: 'starting' }), { settled: '', live: 'starting' })
  assert.deepEqual(split(null), { settled: '', live: '' })
  ok('a message splits into settled words plus at most one live tail')
}

{
  // The split is a presentation of `messageText`, not a second opinion about it.
  // If they could disagree, the box would gain or lose words the instant the
  // tail cleared.
  for (const m of [
    { text: 'we should', tail: 'probably ship' },
    { text: 'we should', tail: 'we should probably ship' },
    { text: '今天天气', tail: '今天天气很好啊' },
    { text: 'hello ther', tail: 'hello there' },
    { text: '', tail: 'starting to talk' },
    { text: 'sealed already', tail: '' },
  ]) {
    const { settled, live } = messageParts(m)
    assert.equal(settled + live, messageText(m))
  }
  ok('settled + live is exactly what messageText renders — never more, never less')
}

{
  // End to end: a long confirmed message with a short outstanding guess is
  // mostly settled text, whatever the tail happens to restate.
  const { composer, events } = harness()
  composer.addFragment({ text: 'This is a fairly long thing I have already said.', speakerLabel: 'Moon' })
  composer.setTail({ text: 'and now I am', speakerLabel: 'Moon' })
  const { settled, live } = messageParts(messages(project(events))[0])
  assert.equal(settled, 'This is a fairly long thing I have already said.')
  assert.equal(live, ' and now I am')
  ok('a long settled message renders live only where Deepgram has got to')
}

// --- THE property this redesign exists to guarantee -------------------------
{
  // The speaker composes; the listener receives the same events over the wire.
  // Both project with the same reducer, so both must land on an identical
  // transcript. Every reported symptom — doubled bubbles, endlessly growing
  // boxes, host and participant disagreeing — was a violation of exactly this.
  const { composer, events } = harness({ speakerId: 'guest:moon' })
  composer.addFragment({ text: 'Alright.', speakerLabel: 'Moon', tStart: 0, tEnd: 400 })
  composer.addFragment({ text: "Let's get started.", speakerLabel: 'Moon', tStart: 400, tEnd: 900 })
  composer.seal('silence')
  composer.addFragment({ text: 'Look.', speakerLabel: 'Moon', tStart: 2000, tEnd: 2400 })
  composer.seal('silence')

  // Speaker's own view.
  const local = project(events, { mine: true, at: 5 })

  // Listener's view: identical events, but round-tripped through the gateway's
  // SSE shape and back via fromWire.
  const wire = events.map(e => ({
    speaker: e.speakerLabel,
    by: e.speakerId,
    text: e.text,
    tStart: e.tStart,
    tEnd: e.tEnd,
    messageId: e.messageId,
    seq: e.seq,
    kind: e.type,
    partial: e.type !== SEALED,
  }))
  const remote = wire.reduce((s, u) => apply(s, fromWire(u), { mine: false, at: 5 }), emptyTranscript())

  const shape = state =>
    messages(state).map(m => ({ id: m.messageId, speaker: m.speakerLabel, text: m.text, state: m.state }))

  assert.deepEqual(shape(remote), shape(local))
  assert.equal(shape(local).length, 2, 'two messages, split where the speaker sealed')
  assert.equal(shape(local)[0].text, "Alright. Let's get started.")
  assert.equal(shape(local)[1].text, 'Look.')
  ok('SPEAKER AND LISTENER PROJECT AN IDENTICAL TRANSCRIPT (the core invariant)')
}

// --- Project: delivery hazards ---------------------------------------------
{
  // A delta lost in flight must not corrupt the message permanently: the sealed
  // text is the whole message and replaces whatever the deltas assembled.
  const { composer, events } = harness()
  composer.addFragment({ text: 'first', speakerLabel: 'Moon' })
  composer.addFragment({ text: 'second', speakerLabel: 'Moon' })
  composer.seal('silence')

  const lossy = events.filter((e, i) => i !== 1) // drop the second delta
  const state = lossy.reduce((s, e) => apply(s, e), emptyTranscript())
  assert.equal(messages(state)[0].text, 'first second', 'the seal healed the gap')
  ok('a dropped delta self-heals when the sealed message arrives')
}

{
  const { composer, events } = harness()
  composer.addFragment({ text: 'echo', speakerLabel: 'Moon' })
  composer.seal('silence')
  const doubled = [...events, ...events] // every event redelivered
  const state = doubled.reduce((s, e) => apply(s, e), emptyTranscript())
  assert.equal(messages(state).length, 1)
  assert.equal(messages(state)[0].text, 'echo', 'redelivery did not duplicate the words')
  ok('duplicate delivery converges (a redelivered delta is ignored)')
}

{
  // The seal races the last delta: the seal is posted while the delta is still
  // in flight, so the delta can land afterwards. It must not reopen the message
  // or append to authoritative text.
  const { composer, events } = harness()
  composer.addFragment({ text: 'done', speakerLabel: 'Moon' })
  composer.seal('silence')
  const reordered = [events[1], events[0]] // seal first, then its delta
  const state = reordered.reduce((s, e) => apply(s, e), emptyTranscript())
  assert.equal(messages(state).length, 1)
  assert.equal(messages(state)[0].state, 'sealed')
  assert.equal(messages(state)[0].text, 'done', 'the late delta was ignored')
  ok('a delta arriving after its seal never reopens or corrupts the message')
}

{
  // Overlapping speakers: messages interleave by when the speech started, not by
  // when the packets happened to arrive.
  let state = emptyTranscript()
  state = apply(state, {
    type: SEALED, messageId: 'b', speakerId: 'B', speakerLabel: 'Bob',
    text: 'second', tStart: 5000, tEnd: 6000,
  })
  state = apply(state, {
    type: SEALED, messageId: 'a', speakerId: 'A', speakerLabel: 'Ann',
    text: 'first', tStart: 1000, tEnd: 2000,
  })
  assert.deepEqual(messages(state).map(m => m.text), ['first', 'second'])
  ok('out-of-order arrival is ordered by when the speech started')
}

{
  let state = emptyTranscript()
  state = apply(state, {
    type: SEALED, messageId: 'x', speakerId: 'A', speakerLabel: 'A',
    text: 'hi', tStart: 0, tEnd: 1,
  })
  state = renameSpeaker(state, 'A', 'Ann')
  assert.equal(messages(state)[0].speakerLabel, 'Ann')
  assert.equal(messages(state)[0].text, 'hi', 'rename touches the label, never the text')
  ok('speaker rename relabels without altering message text or boundaries')
}

{
  assert.equal(fromWire({ text: 'x' }), null, 'an event with no messageId is not projectable')
  assert.equal(fromWire(null), null)
  ok('malformed wire events are rejected rather than grouped by guesswork')
}

// A typed message (notes #4) is a message. It goes through the same reducer, is
// grouped by the same messageId and lands in the same ordered list as speech —
// `source` is a label the view may draw and nothing downstream branches on.
{
  let state = emptyTranscript()
  state = apply(state, {
    type: SEALED, messageId: 't1', speakerId: 'A', speakerLabel: 'Ann',
    text: '@kelabo what is the retry policy?', tStart: 1000, tEnd: 1000, source: 'typed',
  })
  state = apply(state, {
    type: SEALED, messageId: 's1', speakerId: 'B', speakerLabel: 'Bob',
    text: 'good question', tStart: 2000, tEnd: 3000,
  })
  const list = messages(state)
  assert.deepEqual(list.map(m => m.messageId), ['t1', 's1'], 'ordered with speech, by tStart')
  assert.equal(list[0].source, 'typed')
  assert.equal(list[1].source, undefined, 'speech carries no source')
  assert.equal(list[0].state, 'sealed', 'typed text arrives whole and is sealed on arrival')
  ok('a typed message is projected exactly like speech, carrying only a source label')
}

{
  // The gateway stamps `source` on the sealed utterance it fans out, so a
  // listener marks the line as typed too — not just the person who typed it.
  const e = fromWire({ messageId: 'w1', speaker: 'Ann', text: 'hi', kind: 'sealed', source: 'typed' })
  assert.equal(e.type, SEALED)
  assert.equal(e.source, 'typed')
  ok('a typed message survives the wire as a sealed event with its source intact')
}

// --- Speaker labels: provider ids -> A/B/C ----------------------------------
{
  const labels = createSpeakerLabels()
  // Soniox counts from "1", Deepgram from 0, and neither numbering reaches the
  // transcript: what matters is the order people actually spoke in.
  assert.equal(labels.labelFor('3'), 'A', 'the first voice heard is A, whatever the provider called it')
  assert.equal(labels.labelFor('1'), 'B')
  assert.equal(labels.labelFor('3'), 'A', 'and it stays A')
  assert.equal(labels.labelFor('0'), 'C')
  assert.equal(labels.count(), 3)
  ok('speaker labels are assigned in order of first appearance, not by index')
}

{
  // Ids are opaque: numbers, strings and whatever a future provider emits all
  // work, and the numeric-looking ones are not secretly sorted.
  const labels = createSpeakerLabels()
  assert.equal(labels.labelFor(2), 'A')
  assert.equal(labels.labelFor('2'), 'A', 'a number and its string are the same voice')
  assert.equal(labels.labelFor('spk_alice'), 'B')
  ok('a speaker id is opaque — any shape a provider emits gets a stable label')
}

{
  // A label must always be something the gateway will accept as a diarization
  // label (a single capital), so beyond the alphabet it clamps rather than
  // running off the end into a caption the server would reject.
  const labels = createSpeakerLabels()
  for (let i = 0; i < MAX_LABELS + 5; i++) labels.labelFor(`v${i}`)
  for (const label of labels.known().values()) assert.match(label, /^[A-Z]$/)
  assert.equal(labels.labelFor('v0'), 'A')
  assert.equal(labels.labelFor(`v${MAX_LABELS + 4}`), 'Z')
  ok('every label is a single capital, even past the end of the alphabet')
}

{
  // On reconnect the provider renumbers, so the map is dropped: keeping it would
  // hand an existing label — and any rename the host applied to it — to whoever
  // happens to speak first on the new socket.
  const labels = createSpeakerLabels()
  labels.labelFor('1')
  labels.labelFor('2')
  labels.reset()
  assert.equal(labels.count(), 0)
  assert.equal(labels.labelFor('9'), 'A')
  ok('reset() forgets every assignment, so a new stream starts at A')
}

console.log(`\n${passed} transcript tests passed`)
