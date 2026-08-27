import { useEffect } from 'react'

/**
 * Type-anywhere: on pages that are really one input (sign-in email, the
 * pairing code, a kelabo title, the contacts search), starting to type or
 * pasting anywhere on the page lands in that input — nobody should have to
 * click a box first when there is only one place the text could mean to go.
 *
 * Deliberately inert whenever the keystroke could mean something else:
 * another editable element has focus, a modifier is held (shortcuts), or an
 * overlay is open (its own inputs get their own focus).
 */

export const isEditable = el =>
  !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)

export const overlayOpen = () =>
  !!document.querySelector('.modal-veil.open, .drawer.open, .menu, .epick-list, .dtp-panel')

export function useTypeAnywhere(ref, enabled = true) {
  useEffect(() => {
    if (!enabled) return undefined

    const target = () => {
      const el = ref.current
      return el && !el.disabled ? el : null
    }

    // Printable key: just move focus during keydown — the browser's own
    // default action then types the character into the newly focused input.
    const onKeyDown = e => {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      // `key` is absent on synthetic keydowns — password managers and some IMEs
      // dispatch them — and reading `.length` off undefined threw out of a
      // document-level listener, which takes the whole page with it. Seen on
      // the sign-in page, which is exactly where a password manager fires.
      if (typeof e.key !== 'string' || e.key.length !== 1) return
      if (isEditable(document.activeElement) || overlayOpen()) return
      target()?.focus()
    }

    // Paste has to be re-aimed by hand: refocusing mid-event does not redirect
    // where the clipboard lands. Written through the native value setter so
    // React's controlled input sees an ordinary `input` event.
    const onPaste = e => {
      if (isEditable(e.target) || overlayOpen()) return
      const el = target()
      const text = e.clipboardData?.getData('text')?.trim()
      if (!el || !text) return
      e.preventDefault()
      el.focus()
      const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, text)
      el.dispatchEvent(new Event('input', { bubbles: true }))
    }

    document.addEventListener('keydown', onKeyDown)
    document.addEventListener('paste', onPaste)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('paste', onPaste)
    }
  }, [ref, enabled])
}
