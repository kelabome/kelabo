import { useCallback, useEffect, useRef, useState } from 'react'

// Single owner of the microphone for the whole kelabo.
//
// Two consumers need the same MediaStream: the transcription capture pipeline
// (spa/src/capture/useCapture.js) and the conference transport
// (spa/src/rtc/useRtc.js). Calling getUserMedia twice would hand back two
// independent captures of one device — Chrome and Safari then apply echo
// cancellation to each in isolation, which degrades both, and the browser shows
// the recording indicator twice. So the stream is acquired here, once, and
// passed down.

const RAW_CONSTRAINTS = { echoCancellation: false, noiseSuppression: false, autoGainControl: false }

/**
 * @param {{ enabled: boolean, rawAudio?: boolean, deviceId?: string }} opts
 * @returns {{ stream: MediaStream|null, state: string, error: string|null, retry: () => void }}
 *   state: idle | requesting | ready | mic_denied | insecure_context
 */
export function useMicStream({ enabled, rawAudio = false, deviceId = '' }) {
  const [stream, setStream] = useState(null)
  const [state, setState] = useState('idle')
  const [attempt, setAttempt] = useState(0)
  const streamRef = useRef(null)

  const release = useCallback(() => {
    streamRef.current?.getTracks().forEach(t => t.stop())
    streamRef.current = null
    setStream(null)
  }, [])

  const retry = useCallback(() => setAttempt(n => n + 1), [])

  useEffect(() => {
    if (!enabled) {
      release()
      setState('idle')
      return undefined
    }
    let cancelled = false

    if (!window.isSecureContext) {
      setState('insecure_context')
      return undefined
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      setState('mic_denied')
      return undefined
    }

    setState('requesting')
    // Raw mode disables echo cancellation / noise suppression / auto gain so
    // audio played through the speakers is transcribed too. It is mutually
    // exclusive with being on a Kelabo call — see the guard in Kelabo.jsx —
    // because otherwise every remote voice comes back through your own mic and
    // is transcribed a second time under your name.
    // `ideal`, not `exact`: a microphone that has been unplugged since it was
    // chosen must not stop the kelabo having any audio at all. The browser
    // falls back to the default and the transcript keeps working.
    const audio = deviceId
      ? { ...(rawAudio ? RAW_CONSTRAINTS : {}), deviceId: { ideal: deviceId } }
      : (rawAudio ? RAW_CONSTRAINTS : true)
    navigator.mediaDevices
      .getUserMedia({ audio })
      .then(s => {
        if (cancelled) {
          s.getTracks().forEach(t => t.stop())
          return
        }
        // Replacing an earlier stream (the constraints changed): stop the old
        // device capture before publishing the new one.
        streamRef.current?.getTracks().forEach(t => t.stop())
        streamRef.current = s
        setStream(s)
        setState('ready')
      })
      .catch(() => {
        if (!cancelled) setState('mic_denied')
      })

    return () => {
      cancelled = true
    }
  }, [enabled, rawAudio, deviceId, attempt, release])

  // Release the device when the hook goes away for good.
  useEffect(() => () => release(), [release])

  return {
    stream,
    state,
    error: state === 'mic_denied' || state === 'insecure_context' ? state : null,
    retry,
  }
}
