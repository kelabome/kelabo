import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../api'
import { useToast } from '../components/Toaster'
import { createSpeechGate, VAD_DEFAULTS } from './vad'
import { createSileroVad } from './silero'
import { createResampler, createChunker, FRAME_SAMPLES as MODEL_FRAME_SAMPLES } from './resample'
import { createComposer, LOCAL_SPEAKER } from '../transcript/composer'
import { createSpeakerLabels } from '../transcript/speakerLabels'
import { sttClient } from '../stt/interface'
import { createPublisher } from '../transcript/publisher'
import { fromWire, messageSealed, newMessageId } from '../transcript/events'
import { apply, emptyTranscript, messages, renameSpeaker as renameInTranscript } from '../transcript/transcriptStore'

// The Capture stage (docs 13), plus the React binding for the stages after it.
//
// This hook owns the microphone pipeline and the STT socket, and turns their
// output into *fragments*. It owns no message logic: composing fragments into
// messages is `transcript/composer.js`, and projecting messages for display is
// `transcript/transcriptStore.js`.
//
// It also names no speech-to-text provider. Which one is running is the
// server's decision, arriving as `session.provider`; everything after that goes
// through `SttClient` (spa/src/stt/interface.js) — open a socket, gate audio on
// it, three control frames, and results read into the normalised `SttRead`.
// Nothing below branches on who the provider is.
//
// The binding below is the whole point of that split:
//
//     composer.emit(event)  ->  publisher.publish(event)   (to everyone else)
//                           ->  apply(transcript, event)   (to my own screen)
//
// My own view is built by the same reducer, from the same events, that every
// listener receives. A speaker and a listener cannot group speech differently
// because there is only one implementation of grouping. Previously there were
// two — a line per fragment here, a line per message for remote speech — and
// they disagreed.

// ScriptProcessor buffer size: ~85ms of audio at 48kHz.
const FRAME_SAMPLES = 4096
// A gap this long means the next frame begins a new burst, for the purpose of
// mapping the provider's audio clock back onto the wall clock.
const BURST_GAP_MS = 250
// The seal trigger: this much time with nothing at all from the provider closes
// a speaker's open message. It is the ONLY silence trigger — the VAD gate
// decides which audio is worth transcribing and nothing else (docs 13).
const SILENCE_TIMEOUT_MS = 1000
// How often that is evaluated. Well under the timeout, so the seal still lands
// within a beat of the speaker actually stopping.
const IDLE_POLL_MS = 200

function floatTo16BitPCM(input) {
  const out = new Int16Array(input.length)
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i]))
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff
  }
  return out.buffer
}

// `stream` is the shared microphone owned by useMicStream — this hook never
// calls getUserMedia itself, so the conference transport and STT capture share
// exactly one device capture. `micError` carries that hook's failure
// ('mic_denied' | 'insecure_context') so the Capture pane still reports it.
export function useCapture({ kelaboId, enabled, finalOnly, startedAt, language = 'en', diarize = false, displayName = '', myIdentity = '', stream = null, micError = null, vad = true, startMuted = false, onPostError = null }) {
  const toast = useToast()
  const clientId = useMemo(() => (crypto.randomUUID ? crypto.randomUUID() : String(Math.random())), [])
  const [state, setState] = useState('idle')
  // Which provider the server minted this kelabo's session under, once one has
  // been minted. Display only — the connection light needs something to call
  // itself. Nothing in the pipeline branches on it.
  const [provider, setProvider] = useState(null)
  // Somebody who chose to join muted is muted from the first frame, not a
  // second later: `start(skipSocket)` builds the analysis graph without opening
  // the STT socket, so nothing is streamed or billed until they unmute. Muting
  // after the fact would have transcribed the moment they walked in.
  const [muted, setMuted] = useState(startMuted)
  // The projected transcript — every message, mine and everyone else's, built by
  // one reducer. A message carries its own live tail, so there is no separate
  // preview state: a second piece of UI state for in-progress speech is what
  // rendered two boxes for one utterance.
  const [transcript, setTranscript] = useState(emptyTranscript)
  // Gate open — i.e. the mic is currently carrying speech and audio is billing.
  // Always true when VAD is off, where every frame is streamed.
  const [speaking, setSpeaking] = useState(false)

  const languageRef = useRef(language)
  languageRef.current = language
  const diarizeRef = useRef(diarize)
  diarizeRef.current = diarize
  const streamPropRef = useRef(stream)
  streamPropRef.current = stream
  const displayNameRef = useRef(displayName)
  displayNameRef.current = displayName
  const myIdentityRef = useRef(myIdentity)
  myIdentityRef.current = myIdentity
  const vadRef = useRef(vad)
  vadRef.current = vad
  const finalOnlyRef = useRef(finalOnly)
  finalOnlyRef.current = finalOnly
  // Read by `sendTyped`, which must stay stable across renders and so cannot
  // close over the prop.
  const startedAtRef = useRef(startedAt)
  startedAtRef.current = startedAt

  // A provider speaker id -> the message it belongs to, and what to call it.
  //
  // The empty id means "this stream's own speaker": diarization off, or a
  // provider that does not separate voices. That is me, so it is filed under one
  // key and carries my display name. Every other id is a distinct voice in my
  // microphone and gets an A/B/C label from the shared labeller — which assigns
  // in order of first appearance, so the arithmetic that used to live here (and
  // would have to be repeated per provider) is gone.
  const labelsRef = useRef(null)
  if (!labelsRef.current) labelsRef.current = createSpeakerLabels()
  const keyFor = sp => (sp ? `spk:${sp}` : LOCAL_SPEAKER)
  const labelFor = sp => (sp ? labelsRef.current.labelFor(sp) : (displayNameRef.current || 'You'))

  const streamRef = useRef(null)
  const ctxRef = useRef(null)
  const transportRef = useRef(null)
  const stoppedRef = useRef(false)
  const captureStartRef = useRef(0)
  // VAD gate plus the bookkeeping that converts the provider's audio clock back
  // to wall clock. Those timestamps count only the audio it received, so every
  // second of skipped silence shifts word times earlier; `bursts` records, for
  // each contiguous run of streamed audio, where its start sat on both clocks.
  const gateRef = useRef(null)
  // The speech detector, and the two pure stages that feed it the 16kHz frames
  // it insists on. All three outlive individual gates: the model takes seconds
  // to fetch the first time and must not be reloaded because a stream
  // reconnected.
  const sileroRef = useRef(null)
  const resamplerRef = useRef(null)
  const chunkerRef = useRef(null)
  // A pinned threshold survives the gate being rebuilt and the page being
  // reloaded. Far less needed than when this was a decibel level — a
  // probability means the same thing in every room — so it is now a
  // diagnostic rather than a workaround.
  //
  // A DIFFERENT key from the decibel one it replaces. The old values were
  // negative dBFS, and reading -40 back as a probability would clamp to 0 and
  // hold the gate open for the whole kelabo, billing all of it.
  const thresholdRef = useRef(
    (() => {
      const v = Number(localStorage.getItem('kelabo-vad-p'))
      return Number.isFinite(v) && v > 0 && v <= 1 ? v : null
    })(),
  )
  const sentSamplesRef = useRef(0)
  const burstsRef = useRef([])
  const lastAudioAtRef = useRef(0)
  const speakingRef = useRef(false)

  const setSpeakingOnce = on => {
    if (speakingRef.current === on) return
    speakingRef.current = on
    setSpeaking(on)
  }

  // Both clocks are in milliseconds. Providers disagree about the unit on the
  // wire — Deepgram sends seconds, Soniox milliseconds — and each reader
  // converts, so nothing downstream of `SttRead` has to know which.
  const wallAt = ms => {
    const list = burstsRef.current
    let burst = list[0]
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i].audio <= ms + 1) { burst = list[i]; break }
    }
    if (!burst) return captureStartRef.current + ms
    return burst.wall + (ms - burst.audio)
  }
  // Provider audio-clock ms -> ms since the kelabo started, which is what the
  // transcript orders messages by.
  const stampFor = ms => Math.round(wallAt(ms) - (startedAt || captureStartRef.current))

  // Verbose STT logging, enabled together with the Debug drawer.
  const dbg = (...args) => {
    if (localStorage.getItem('kelabo-debug') === '1') console.log('[stt]', new Date().toISOString().slice(11, 23), ...args)
  }
  const audioStatsRef = useRef({ frames: 0, pipelines: 0, lastLog: 0 })

  // --- Compose + Publish + Project, bound together --------------------------
  // Held in a ref so the publisher, which is built once, always calls the
  // current handler rather than the one captured on first render.
  const onPostErrorRef = useRef(onPostError)
  onPostErrorRef.current = onPostError

  const publisherRef = useRef(null)
  if (!publisherRef.current) {
    publisherRef.current = createPublisher({
      kelaboId,
      clientId,
      displayName: () => displayNameRef.current,
      diarized: () => diarizeRef.current,
      // A rejected caption is dropped on purpose, but never silently: the
      // gateway returns the schema issues that rejected it, and without printing
      // them a payload bug is indistinguishable from a flaky network.
      onError: (payload, err) => {
        dbg(`caption ${payload.kind} FAILED ${err?.status ?? ''} ${err?.code ?? ''}`, err?.detail ?? err?.message ?? '')
        // **A typed message that did not send must say so.** Speech can lose a
        // line — the next one heals it — but a person who typed something
        // watched it appear in their own panel and has no other way to learn
        // that nobody else got it. It looked exactly like "messaging is
        // broken", from both sides of the screen, with the only evidence in a
        // debug drawer nobody had open.
        if (payload.source === 'typed') onPostErrorRef.current?.(err)
      },
    })
  }

  const composerRef = useRef(null)
  if (!composerRef.current) {
    composerRef.current = createComposer({
      // Whatever identity the server will stamp on my captions, so my own echo
      // is recognisable. A guest has no email, which is why this is the
      // participant identity and not the signed-in address.
      speakerId: myIdentity,
      silenceTimeoutMs: SILENCE_TIMEOUT_MS,
      emit: event => {
        dbg(event.type, { messageId: event.messageId, text: event.text, reason: event.reason })
        // Everyone else...
        publisherRef.current.publish(event)
        // ...and me, through the identical reducer. This line is the invariant.
        setTranscript(prev => apply(prev, event, { mine: true }))
      },
    })
  }
  // The composer is created once but reads a changing identity.
  composerRef.current.speakerId = myIdentity


  // Fetch the detector as soon as the hook mounts, not when the first person
  // speaks. It is ~13MB of WebAssembly and model weights, and every second it
  // is not ready is a second of audio streamed ungated — correct, but billed.
  useEffect(() => {
    if (!sileroRef.current) sileroRef.current = createSileroVad()
    let live = true
    sileroRef.current.load().then(() => {
      if (!live) return
      const st = sileroRef.current.status()
      dbg(st.state === 'ready' ? 'vad model ready' : `vad model ${st.state}: ${st.error}`)
    })
    return () => {
      live = false
    }
  }, [])

  // The seal clock is polled, not armed. As a one-shot timer it had to be
  // re-armed from every place a provider result was handled, and the one place
  // that forgot (interim results in `finalOnly` mode) sealed messages while the
  // speaker was still talking. Polling asks the composer a question it can
  // always answer correctly instead of relying on every call site — and it now
  // has to walk every open speaker, which is worse still to re-arm by hand.
  useEffect(() => {
    const t = setInterval(() => {
      composerRef.current.sealIfIdle()
    }, IDLE_POLL_MS)
    return () => clearInterval(t)
  }, [])

  // One normalised result from the provider, mapped onto the composer and
  // converted from the provider's audio clock to wall time. Reading the wire
  // happened in the provider's own reader (pure, tested, one file per
  // provider); nothing here knows which one produced this.
  //
  // Both lists are walked unconditionally: one message can carry several
  // speakers at once, and a provider that never does simply returns one.
  const applyRead = useCallback(r => {
    if (!r) return
    // Reported for the log; recovery is the provider's business, since what is
    // recoverable differs entirely between them.
    if (r.error) dbg('provider error', r.error.code, r.error.type, r.error.message)

    // Only text counts as activity, and only for the speakers who produced it.
    // Providers emit empty results continuously while receiving audio with no
    // speech in it, and treating those as activity kept the seal clock alive
    // forever — a message then never closed at all. Keying it by speaker matters
    // just as much: one person talking must not hold everyone else's message
    // open, or a room mic produces one unbounded message per voice.
    composerRef.current.noteActivity(r.active.map(keyFor))

    // Confirmed words first: `addFragment` clears the speaker's tail, and the
    // tails below are the guess that replaces it.
    for (const seg of r.finals) {
      dbg('final', seg.speaker || '-', seg.text)
      composerRef.current.addFragment({
        text: seg.text,
        speakerLabel: labelFor(seg.speaker),
        key: keyFor(seg.speaker),
        tStart: stampFor(seg.start || 0),
        tEnd: stampFor(seg.end || 0),
      })
    }

    // Never persisted, never given to the LLM: liveness only.
    if (finalOnlyRef.current) return
    for (const seg of r.tails) {
      composerRef.current.setTail({
        text: seg.text,
        speakerLabel: labelFor(seg.speaker),
        key: keyFor(seg.speaker),
        tStart: stampFor(seg.start || 0),
        tEnd: stampFor(seg.end || 0),
      })
    }
  }, [startedAt]) // eslint-disable-line react-hooks/exhaustive-deps

  // Tearing down transcription. The provider decides what that means on the
  // wire — one socket closed, or a pool of them — so this is one call.
  const closeTransport = useCallback(() => {
    const t = transportRef.current
    transportRef.current = null
    if (t) {
      try { t.close() } catch {}
    }
  }, [])

  // Hand frames to the provider and advance the audio clock. `opened` marks the
  // first frame of a burst: the frames handed over end at "now", so the burst
  // started that many frame-durations earlier on the wall clock.
  const sendFrames = (buffers, opened) => {
    const t = transportRef.current
    if (!t) return
    const rate = ctxRef.current?.sampleRate || 48000
    if (opened) {
      const bursts = burstsRef.current
      bursts.push({
        audio: (sentSamplesRef.current / rate) * 1000,
        wall: Date.now() - (buffers.length * FRAME_SAMPLES * 1000) / rate,
      })
      if (bursts.length > 400) bursts.splice(0, 200)
    }
    for (const buf of buffers) t.sendAudio(buf)
    sentSamplesRef.current += buffers.length * FRAME_SAMPLES
  }

  // The provider reports state; the room hears about the two that matter. A
  // transcription that quietly stops is indistinguishable from a room that has
  // gone quiet, which is why these were ever spoken aloud.
  const lastStateRef = useRef('idle')
  const reportState = useCallback(next => {
    if (lastStateRef.current !== next) {
      if (next === 'reconnecting') toast('Transcription reconnecting…')
      if (next === 'stt_unavailable') toast('Transcription unavailable — board still works')
      lastStateRef.current = next
    }
    setState(next)
  }, [toast])

  const connectSocket = useCallback(async () => {
    if (stoppedRef.current) return
    // Never two live transports: the previous one must be torn down before the
    // next is built, or both transcribe the same audio and duplicate every turn.
    closeTransport()
    setState('connecting')

    const mintSession = () =>
      api.sttToken(kelaboId, { language: languageRef.current, diarize: diarizeRef.current })

    let session
    try {
      session = await mintSession()
    } catch {
      reportState('stt_unavailable')
      return
    }
    if (stoppedRef.current) return

    // The server says which provider this session is for; an id with no client
    // registered throws rather than guessing, because every wrong guess here
    // fails silently — a socket that opens, streams audio and transcribes
    // nothing.
    let client
    try {
      client = sttClient(session.provider)
    } catch (e) {
      dbg('unusable session', e?.message)
      reportState('stt_unavailable')
      return
    }
    setProvider({ id: client.id, label: client.label })

    try {
      transportRef.current = client.connect({
        session,
        sampleRate: ctxRef.current?.sampleRate || 16000,
        diarize: diarizeRef.current,
        language: languageRef.current,
        // Whether the provider is being handed only speech. A provider that
        // bills per stream starts and stops one on this edge; without it there
        // is nothing to trigger on and it must hold a stream open instead.
        gated: vadRef.current,
        renew: mintSession,
        onRead: applyRead,
        onStreamStart: () => {
          // A new provider stream restarts its audio clock at zero and its
          // speaker numbering with it, so the clock mapping and the labeller
          // restart too — a new voice must not inherit the label, and the
          // host's rename, of whoever held it on the last stream.
          //
          // The composer is deliberately NOT reset: on a provider that opens a
          // stream per utterance this fires constantly, and resetting would
          // drop the open message every time instead of letting it seal.
          captureStartRef.current = Date.now()
          sentSamplesRef.current = 0
          burstsRef.current = [{ audio: 0, wall: captureStartRef.current }]
          labelsRef.current.reset()
          gateRef.current?.reset()
          // The model carries an LSTM state and 64 samples of context across
          // frames. Audio either side of a stream restart is not continuous, so
          // carrying them over is reasoning about a moment that never happened.
          sileroRef.current?.reset()
          resamplerRef.current?.reset()
          chunkerRef.current?.reset()
        },
        onState: reportState,
        log: dbg,
      })
    } catch (e) {
      dbg('connect failed', e?.message)
      reportState('stt_unavailable')
    }
  }, [kelaboId, applyRead, closeTransport, reportState])

  // Read by the start effect, which must see the current value without taking a
  // dependency on it.
  const mutedRef = useRef(startMuted)
  mutedRef.current = muted

  const startingRef = useRef(false)
  const start = useCallback(async (skipSocket = false) => {
    if (stoppedRef.current) return
    if (streamRef.current || startingRef.current) return // never build a second pipeline
    // The microphone belongs to useMicStream; without it there is nothing to
    // analyse yet, and the effect below re-runs once it arrives.
    const micStream = streamPropRef.current
    if (!micStream) return
    startingRef.current = true
    if (!skipSocket) setState('connecting')
    try {
      streamRef.current = micStream
      const AC = window.AudioContext || window.webkitAudioContext
      const ctx = new AC()
      ctxRef.current = ctx
      // A browser creates an AudioContext SUSPENDED unless it was constructed
      // inside a user gesture, and a suspended context never fires
      // `onaudioprocess`. Nothing is captured, nothing is transcribed, the
      // socket sits open receiving no audio, and NOTHING reports an error at
      // any level — the room simply goes quiet. Reloading the page into a
      // kelabo, which rejoins without anybody clicking anything, is precisely
      // that case.
      if (ctx.state === 'suspended') {
        try { await ctx.resume() } catch {}
      }
      const source = ctx.createMediaStreamSource(micStream)
      const processor = ctx.createScriptProcessor(FRAME_SAMPLES, 1, 1)
      audioStatsRef.current.pipelines += 1
      processor.onaudioprocess = e => {
        // NOT gated on there being a transport. The gate has to run whenever
        // the microphone does, because it feeds the model and the live meter —
        // and the moment somebody most needs to see the gate is when nothing is
        // being transcribed and they are trying to find out why. Only SENDING
        // requires a transport.
        const transport = transportRef.current
        const stats = audioStatsRef.current
        stats.frames += 1
        const samples = e.inputBuffer.getChannelData(0)
        const pcm = floatTo16BitPCM(samples)
        const now = Date.now()
        // The gate ALWAYS runs. It is the analyser — probability, threshold,
        // margin — and only its *decisions* are optional. Tearing it down when
        // silence skipping is switched off took the meter with it, so the one
        // reading that would explain "why is my quiet speech being cut"
        // vanished exactly when somebody turned the feature off to investigate.
        // It also means the skipped ratio still answers "what would this save
        // if I turned it on".
        if (!gateRef.current) {
          gateRef.current = createSpeechGate({
            sampleRate: ctx.sampleRate,
            frameSamples: FRAME_SAMPLES,
            threshold: thresholdRef.current,
          })
          // The capture rate is whatever the hardware gave us; the model takes
          // 16kHz and nothing else.
          resamplerRef.current = createResampler({ inputRate: ctx.sampleRate })
          chunkerRef.current = createChunker({ frameSamples: MODEL_FRAME_SAMPLES })
        }
        // Hand this buffer to the model as however many 32ms frames it makes.
        // Fire and forget: inference is async (0.45ms typical) and awaiting it
        // here would block the audio thread on every callback.
        for (const frame of chunkerRef.current.push(resamplerRef.current.push(samples))) {
          sileroRef.current?.push(frame)
        }
        // The peak across the frames the model has finished since the last
        // callback. Peak, not mean: over 85ms the question is "did speech start
        // anywhere in here", and an average lets a quiet lead-in cancel out the
        // syllable after it.
        //
        // Worst case this is one callback stale, because a frame pushed just
        // above may not have been inferred yet. 85ms, against 400ms of pre-roll
        // that is sent anyway — so the lag costs no words.
        const ready = sileroRef.current?.ready()
        const r = gateRef.current.push(ready ? sileroRef.current.take() : NaN, pcm)
        // From here on the gate has already measured this frame, so the meter
        // is live even with nothing to send it to.
        if (!transport) return

        // No model, no gating. Until it has loaded — and for good if it fails —
        // there is no probability to gate on, and the gate above is reading
        // every frame as silence. Streaming everything is the correct fallback:
        // the transcript stays right and only the bill suffers, where gating on
        // a number that does not exist would lose speech instead.
        if (!vadRef.current || !ready) {
          setSpeakingOnce(true)
          // Not gating: every frame goes over, and the provider is told once
          // that speech is permanently "on" so it does not sit waiting for an
          // onset that will never come.
          transport.setSpeaking(true)
          // A gap (silence skipping just turned off, or the gate was shut) is a
          // new burst.
          sendFrames([pcm], now - lastAudioAtRef.current > BURST_GAP_MS)
          lastAudioAtRef.current = now
          return
        }

        if (r.send.length) {
          setSpeakingOnce(true)
          // BEFORE the audio, always. On a provider that opens a billable
          // stream at the onset, this is what opens it — and the frames handed
          // over below include the pre-roll from just before the gate tripped,
          // which is the start of the word that opened it.
          transport.setSpeaking(true)
          sendFrames(r.send, r.opened)
          lastAudioAtRef.current = now
          return
        }
        if (r.closed) {
          setSpeakingOnce(false)
          // The gate shut. What that means is the provider's business: flush
          // what it is holding, begin counting towards ending a billed stream,
          // or nothing at all. Not a seal either way — the composer closes the
          // message on its own silence clock.
          transport.setSpeaking(false)
          dbg('gate closed', gateRef.current.stats())
        }
      }
      source.connect(processor)
      processor.connect(ctx.destination)
      if (!skipSocket) await connectSocket()
      startingRef.current = false
    } catch {
      startingRef.current = false
      setState('mic_denied')
    }
  }, [connectSocket])

  // Nothing is buffered ahead of the composer any more, so closing a message is
  // just the seal — every open speaker's, since the stream is going away.
  // (This used to flush a pending queue first — the queue is what could strand a
  // final the provider had already confirmed.)
  const sealAndFlush = useCallback(reason => {
    composerRef.current.seal(reason)
  }, [])

  const mute = useCallback(() => {
    sealAndFlush('mute')
    closeTransport()
    setMuted(true)
    setState('muted')
    setSpeakingOnce(false)
  }, [closeTransport, sealAndFlush])

  const unmute = useCallback(() => {
    // Unmuting is a CALL action: `muted` is what gates the outgoing conference
    // track (useRtc), so it flips here, immediately and unconditionally — the
    // room hears the speaker the moment they ask. Transcription is a tap on the
    // same stream, restarted *afterwards* and only where this kelabo transcribes
    // at all; its failure demotes captions ("Transcription unavailable"), never
    // the audio. Flipping `muted` only inside the STT socket's onopen — the old
    // behaviour — made "unmute" mean "successfully connect to the transcription
    // provider", which froze the mic on every deployment where it was absent,
    // unconfigured or broken.
    setMuted(false)
    if (!enabled || stoppedRef.current) {
      setState(s => (s === 'muted' ? 'idle' : s))
      return
    }
    setState('connecting')
    // Analysis pipeline may have been torn down (e.g. the shared stream was
    // re-acquired while muted).
    if (!streamRef.current || !ctxRef.current) start()
    else connectSocket()
  }, [enabled, connectSocket, start])

  const stop = useCallback(() => {
    stoppedRef.current = true
    sealAndFlush('stop')
    closeTransport()
    // The MediaStream is not ours to stop — useMicStream owns the device and
    // the conference transport is still publishing from it.
    streamRef.current = null
    ctxRef.current?.close().catch(() => {})
    ctxRef.current = null
    gateRef.current = null
    setSpeakingOnce(false)
    setState('ended')
  }, [closeTransport, sealAndFlush])

  // Retroactively relabel a speaker (driven by the server `rename` SSE event so
  // every client stays consistent). Label only — never the text or boundaries.
  const renameSpeaker = useCallback((from, to) => {
    setTranscript(prev => renameInTranscript(prev, from, to))
  }, [])

  /**
   * A message the participant typed instead of said.
   *
   * It takes the composer's own exit — publish to everyone, apply to me —
   * rather than posting a caption of its own, so a typed line is grouped,
   * ordered and rendered by exactly the code that handles speech. The composer
   * is bypassed only because there is nothing to compose: the words arrived
   * whole and are sealed the moment they are sent, which is what a `SEALED`
   * event already means.
   *
   * Works with the microphone off. Someone who joined watch-only, or muted,
   * still has something to say — and typing it is the only way they can.
   */
  const sendTyped = useCallback(text => {
    const body = String(text || '').trim()
    if (!body) return null
    const at = Date.now() - (startedAtRef.current || captureStartRef.current || Date.now())
    const stamp = Math.max(0, at)
    const event = messageSealed({
      messageId: newMessageId(),
      speakerId: myIdentityRef.current,
      // Never a diarization letter: the typist is known, and attributing typed
      // words to whichever voice is currently being labelled "B" would put them
      // in someone else's mouth.
      speakerLabel: displayNameRef.current || 'You',
      text: body,
      tStart: stamp,
      tEnd: stamp,
      reason: 'typed',
      source: 'typed',
    })
    publisherRef.current.publish(event)
    setTranscript(prev => apply(prev, event, { mine: true }))
    return event
  }, [])

  /**
   * Persisted messages fetched on (re)entry — the backfill that makes leaving
   * and re-entering a room show the conversation instead of an empty panel.
   *
   * Rows go through `fromWire` into the same reducer as live events, under the
   * same messageId the live event carried, and `apply` ignores a messageId that
   * is already sealed — so seeding after a reconnect cannot duplicate a message
   * that also arrived live. No `by`-echo filter here: my own past messages are
   * exactly what a backfill is for.
   */
  const seedHistory = useCallback(rows => {
    if (!Array.isArray(rows) || rows.length === 0) return
    setTranscript(prev => {
      let next = prev
      for (const utt of rows) {
        const event = fromWire(utt)
        if (!event) continue
        // Display only. Persisted rows carry no author identity, so fall back
        // to the display name the row was attributed to.
        const mine =
          (!!utt.by && utt.by === myIdentityRef.current) ||
          (!utt.by && !!utt.speaker && utt.speaker === displayNameRef.current)
        // `?? 0`, never "now": a row persisted before wall clocks were stored
        // must render as undated ("Earlier"), not borrow today's date from the
        // moment it happened to be re-fetched.
        next = apply(next, event, { mine, at: utt.at ?? 0 })
      }
      return next
    })
  }, [])

  // Someone else's speech, arriving over SSE. It goes through `fromWire` into
  // the SAME reducer my own speech goes through — there is no separate remote
  // path to drift from the local one.
  const addRemoteUtterance = useCallback(utt => {
    if (!utt) return
    // My own captions echo back; they are already in the transcript.
    if (utt.by && utt.by === myIdentityRef.current) return
    const event = fromWire(utt)
    if (!event) return
    setTranscript(prev => apply(prev, event, { mine: false }))
  }, [])

  // Latest finalize routine for the unmount cleanup (which closes over the
  // first render's callbacks and would otherwise drop the open message).
  const finalizeRef = useRef(null)
  finalizeRef.current = () => sealAndFlush('unmount')

  // Re-runs when the shared microphone arrives or is replaced (useMicStream
  // re-acquires the device), which is what rebuilds the analysis graph around
  // the new stream.
  useEffect(() => {
    if (!enabled || !stream) return undefined
    stoppedRef.current = false
    // `mutedRef` rather than `muted`: this effect must not re-run on unmute —
    // that path goes through `unmute()`, which reuses the graph this built.
    start(mutedRef.current)
    if (mutedRef.current) setState('muted')
    return () => {
      stoppedRef.current = true
      finalizeRef.current?.()
      closeTransport()
      // Only the analysis graph is ours; the device belongs to useMicStream.
      streamRef.current = null
      ctxRef.current?.close().catch(() => {})
      ctxRef.current = null
      startingRef.current = false
    }
  }, [enabled, stream]) // eslint-disable-line react-hooks/exhaustive-deps

  // A context that could not be resumed at build time — no gesture had happened
  // yet — is resumed on the first one that does. Without this the only recovery
  // is another reload, which lands in the same state.
  useEffect(() => {
    if (!enabled) return undefined
    const tryResume = () => {
      const ctx = ctxRef.current
      if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {})
    }
    const opts = { capture: true }
    window.addEventListener('pointerdown', tryResume, opts)
    window.addEventListener('keydown', tryResume, opts)
    document.addEventListener('visibilitychange', tryResume)
    return () => {
      window.removeEventListener('pointerdown', tryResume, opts)
      window.removeEventListener('keydown', tryResume, opts)
      document.removeEventListener('visibilitychange', tryResume)
    }
  }, [enabled])

  // Why there is (or is not) any audio to measure. Every one of these can be
  // wrong silently, which is what made "nothing is being captured" a dead end
  // rather than an answer.
  const captureDiag = useCallback(
    () => ({
      state,
      muted,
      hasStream: !!streamRef.current,
      audioContext: ctxRef.current?.state ?? 'none',
      frames: audioStatsRef.current.frames,
      pipelines: audioStatsRef.current.pipelines,
      hasTransport: !!transportRef.current,
      gating: vadRef.current,
    }),
    [state, muted],
  )

  // Surface the shared mic hook's failure through the same `state` the Capture
  // pane already renders banners for.
  useEffect(() => {
    if (micError) setState(micError)
  }, [micError])

  // Switching language or diarization mid-kelabo reconnects with a fresh
  // session carrying the new params (only while live).
  //
  // Silence skipping is in here too, and not only as a parameter: `gated` is
  // what tells a provider whether there will be a speech edge to start and stop
  // a billable stream on. Toggling it mid-kelabo changes the provider's whole
  // connection strategy, so the transport has to be rebuilt rather than
  // informed.
  const firstParamRun = useRef(true)
  useEffect(() => {
    if (firstParamRun.current) { firstParamRun.current = false; return }
    if (!enabled || stoppedRef.current || muted) return
    if (!ctxRef.current) return
    closeTransport()
    connectSocket()
  }, [language, diarize, vad]) // eslint-disable-line react-hooks/exhaustive-deps

  // `gateStats()` is a getter, not state: the ratio changes every frame and
  // nothing needs to re-render for it (the Debug drawer samples it).
  // Sampled by the meter in the Debug drawer at animation rate. Deliberately
  // separate from `gateStats`, which is a heavier snapshot polled once a second:
  // this one has to be cheap enough to read on every frame.
  /**
   * Pin the gate's speech probability threshold, or pass null to hand it back
   * to the default. Applied to the live gate immediately, so the effect is
   * visible on the meter while the mouse is still over it.
   */
  const setGateThreshold = useCallback(p => {
    const v = p == null || !Number.isFinite(p) ? null : Math.min(1, Math.max(0, Math.round(p * 100) / 100))
    thresholdRef.current = v
    gateRef.current?.setThreshold?.(v)
    try {
      if (v == null) localStorage.removeItem('kelabo-vad-p')
      else localStorage.setItem('kelabo-vad-p', String(v))
    } catch {}
    dbg(v == null ? 'vad threshold -> default' : `vad threshold pinned at p=${v}`)
  }, [])

  const gateLevel = useCallback(() => {
    const l = gateRef.current?.level?.()
    if (!l) return null
    // Whether the gate's verdict is actually being applied. The measurement is
    // the same either way; what it means for the audio is not.
    //
    // `model` rides along because a probability pinned at zero and a model that
    // has not loaded look identical on a meter, and only one of them is a
    // problem.
    return { ...l, gating: vadRef.current, model: sileroRef.current?.status?.().state ?? 'idle' }
  }, [])

  const gateStats = useCallback(() => {
    const gate = gateRef.current?.stats() || null
    const transport = transportRef.current?.stats?.() || null
    if (!gate && !transport) return null
    return {
      ...(gate || {}),
      // What the loop has settled on, and how it got there. Without this the
      // gate's behaviour changes under the operator with no way to see that it
      // did, let alone why.
      hangoverMs: gateRef.current?.hangoverMs?.() ?? null,
      attackFrames: gateRef.current?.attackFrames?.() ?? null,
      // The detector's own health. Without it a gate that never opens is
      // indistinguishable from a model that never loaded.
      model: sileroRef.current?.status?.() ?? null,
      ...(transport ? { transport } : {}),
    }
  }, [])

  const list = useMemo(() => messages(transcript), [transcript])

  return {
    state,
    // null until a session has been minted — a watch-only participant, or a
    // deployment with no STT configured, never has one.
    provider,
    muted,
    speaking,
    messages: list,
    mute,
    unmute,
    stop,
    renameSpeaker,
    addRemoteUtterance,
    seedHistory,
    sendTyped,
    gateStats,
    gateLevel,
    captureDiag,
    setGateThreshold,
  }
}
