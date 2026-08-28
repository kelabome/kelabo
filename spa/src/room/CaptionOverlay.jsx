import { useEffect, useRef, useState } from 'react'
import { messageParts } from '../transcript/transcriptStore'

/**
 * Live captions, floating over the room.
 *
 * The transcript used to own half the screen, which is the wrong trade: during
 * a kelabo you need the last sentence, not the last hour, and the last hour is
 * one click away in the side panel. So this shows the tail of the conversation
 * — a couple of lines, bottom-left, over the tiles — and gets out of the way
 * when nobody has said anything for a moment.
 *
 * Each line keeps the transcript's own split between settled words and the
 * unconfirmed tail the provider may still revise; only the tail is dimmed, so a
 * caption never looks provisional after it has stopped changing.
 */

const MAX_LINES = 3
// How long a finished line stays up after its last revision.
const HOLD_MS = 9000

export function CaptionOverlay({ messages, visible }) {
  // messageId -> { ref: last seen message object, t: when it last changed }.
  // The transcript store replaces a message object whenever it changes, so
  // object identity is a reliable "was this revised" signal — and a message's
  // own `at` is when it started, which is not the same thing at all for a
  // sentence someone took ten seconds to finish.
  const stamps = useRef(new Map())
  const [, tick] = useState(0)

  useEffect(() => {
    const now = Date.now()
    const live = new Set()
    for (const m of messages) {
      live.add(m.messageId)
      const seen = stamps.current.get(m.messageId)
      if (!seen || seen.ref !== m) stamps.current.set(m.messageId, { ref: m, t: now })
    }
    for (const id of [...stamps.current.keys()]) {
      if (!live.has(id)) stamps.current.delete(id)
    }
    tick(n => n + 1)
  }, [messages])

  // Expiry is time-based, so something has to re-check it even when no new
  // words arrive — which is exactly the case where a caption needs to go away.
  useEffect(() => {
    if (!visible) return undefined
    const t = setInterval(() => tick(n => n + 1), 1000)
    return () => clearInterval(t)
  }, [visible])

  if (!visible) return null

  const now = Date.now()
  const lines = messages
    .filter(m => m.state === 'open' || now - (stamps.current.get(m.messageId)?.t ?? 0) < HOLD_MS)
    .slice(-MAX_LINES)

  if (!lines.length) return null

  return (
    <div className="captions" aria-live="polite" aria-atomic="false">
      {lines.map(m => {
        const { settled, live } = messageParts(m)
        if (!settled && !live) return null
        return (
          <p className={'caption' + (m.state === 'open' ? ' is-open' : '')} key={m.messageId}>
            <span className="caption-who">{m.speakerLabel}</span>
            <span>
              {settled}
              {live && <span className="caption-tail">{settled ? ' ' : ''}{live}</span>}
            </span>
          </p>
        )
      })}
    </div>
  )
}
