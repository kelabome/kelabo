import { useEffect, useRef } from 'react'
import { Button } from '../components/ui/Button'
import { Icon } from '../components/ui/Icon'

/**
 * The chat composer: a textarea that grows, sends on Enter and breaks on
 * Shift+Enter.
 *
 * The room's original was a single-line `<input>`, which is defensible for an
 * aside in a meeting and wrong for a channel somebody is going to write
 * paragraphs in — there was no way to type a second line at all. A textarea
 * is the whole difference, and it is why this is a component rather than the
 * two lines of JSX it replaces: autogrow, the Enter/Shift+Enter split, and
 * "do not submit while an IME is composing" are each one line and each
 * individually easy to forget.
 *
 * Uncontrolled, like the input it replaces: a controlled value re-renders the
 * whole message list on every keystroke.
 */

// Roughly eight lines. Past that the list it sits under has no room left, and
// a message that long wants to be a document — the journey has a tab for those.
const MAX_HEIGHT_PX = 200

export function Composer({ onSend, placeholder, ariaLabel, disabled = false, autoFocus = false }) {
  const ref = useRef(null)
  // A ref, not state: this must be read inside the keydown handler without
  // making the handler depend on a render.
  const composing = useRef(false)

  const resize = () => {
    const el = ref.current
    if (!el) return
    // Reset first — without this the height only ever ratchets upward, and
    // deleting a paragraph leaves the box the size it was.
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT_PX)}px`
  }

  useEffect(resize, [])

  const submit = () => {
    const el = ref.current
    const text = el?.value ?? ''
    if (!text.trim() || disabled) return
    el.value = ''
    resize()
    onSend(text.trim())
  }

  const onKeyDown = e => {
    if (e.key !== 'Enter' || e.shiftKey) return
    // Japanese, Chinese and Korean input methods use Enter to accept a
    // candidate. Submitting on that sends a half-written word and clears the
    // rest — `isComposing` is the only reliable signal, and `keyCode === 229`
    // is the fallback for the browsers that do not set it.
    if (composing.current || e.nativeEvent?.isComposing || e.nativeEvent?.keyCode === 229) return
    e.preventDefault()
    submit()
  }

  return (
    <form
      className="compose compose-chat"
      onSubmit={e => {
        e.preventDefault()
        submit()
      }}
    >
      <textarea
        className="input compose-input"
        ref={ref}
        rows={1}
        autoFocus={autoFocus}
        disabled={disabled}
        placeholder={placeholder}
        aria-label={ariaLabel || placeholder}
        onInput={resize}
        onKeyDown={onKeyDown}
        onCompositionStart={() => { composing.current = true }}
        onCompositionEnd={() => { composing.current = false }}
      />
      <Button type="submit" size="sm" iconOnly disabled={disabled} title="Send" aria-label="Send">
        <Icon name="send" size={15} />
      </Button>
    </form>
  )
}
