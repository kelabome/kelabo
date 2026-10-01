import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../api'
import { Icon } from './ui/Icon'

/**
 * Who to invite: a list of chips plus one input that suggests people by name.
 *
 * Suggestions are everyone at your own email domain who has signed in, plus
 * the organisation directory an administrator imported for it (docs 18 §4.7),
 * ranked by how well they match what has been typed so far — a first name, a
 * surname, initials, a misspelling or the start of the address (docs 18 §4.8).
 * Everyone in a domain can see everyone else in it.
 *
 * It is a suggestion and never a restriction: the input takes any valid
 * address, so inviting somebody outside the company, or a colleague who has not
 * signed in yet, works exactly the same.
 *
 * Committing an address is deliberately generous — Enter, Tab, comma, space, or
 * simply moving on — because the most common way to lose an invitee is to type
 * the address, click "Schedule", and have the half-finished input thrown away.
 */

const SEPARATORS = [',', ' ', ';']
const VALID = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export function EmailPicker({ value, onChange, disabled, hostDomain }) {
  const [text, setText] = useState('')
  const [suggestions, setSuggestions] = useState([])
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const [error, setError] = useState('')
  const [lookupFailed, setLookupFailed] = useState(false)
  const boxRef = useRef(null)
  const seq = useRef(0)

  const add = useCallback(candidate => {
    const email = String(candidate || '').trim().toLowerCase().replace(/[,;]+$/, '')
    if (!email) return true
    if (!VALID.test(email)) {
      setError(`"${email}" is not an email address`)
      return false
    }
    setError('')
    // Silently ignoring a duplicate is right: it is not a mistake worth a
    // message, and the address is already in the list where they can see it.
    if (!value.includes(email)) onChange([...value, email])
    return true
  }, [value, onChange])

  const commit = useCallback(() => {
    if (!text.trim()) return true
    const ok = add(text)
    if (ok) { setText(''); setOpen(false) }
    return ok
  }, [text, add])

  // Suggestions are fetched per keystroke but only the newest response is
  // allowed to win — otherwise a slow reply for "ma" lands after "matth" and
  // the list flicks back to the wrong thing.
  useEffect(() => {
    const q = text.trim().toLowerCase()
    if (disabled || q.length < 1 || q.includes(',')) { setSuggestions([]); return undefined }
    const mine = ++seq.current
    let cancelled = false
    const t = setTimeout(() => {
      api.searchPeople(q)
        .then(r => {
          if (cancelled || mine !== seq.current) return
          const fresh = (r?.suggestions || []).filter(s => !value.includes(s.email))
          setLookupFailed(false)
          setSuggestions(fresh)
          setActive(0)
          setOpen(fresh.length > 0)
        })
        .catch(() => {
          if (cancelled || mine !== seq.current) return
          // Typing still works — this only means we cannot help.
          setLookupFailed(true)
          setSuggestions([])
          setOpen(false)
        })
    }, 140)
    return () => { cancelled = true; clearTimeout(t) }
  }, [text, disabled, value])

  useEffect(() => {
    const onDown = e => { if (!boxRef.current?.contains(e.target)) setOpen(false) }
    document.addEventListener('pointerdown', onDown)
    return () => document.removeEventListener('pointerdown', onDown)
  }, [])

  const onKeyDown = e => {
    if (open && suggestions.length) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setActive(i => (i + 1) % suggestions.length); return }
      if (e.key === 'ArrowUp') { e.preventDefault(); setActive(i => (i - 1 + suggestions.length) % suggestions.length); return }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        add(suggestions[active].email)
        setText('')
        setOpen(false)
        return
      }
    }
    if (e.key === 'Enter' || e.key === 'Tab' || SEPARATORS.includes(e.key)) {
      if (e.key !== 'Tab' || text.trim()) e.preventDefault()
      commit()
      return
    }
    // Backspace on an empty input takes back the last chip, which is what every
    // other chip input does and therefore what fingers expect.
    if (e.key === 'Backspace' && !text && value.length) onChange(value.slice(0, -1))
  }

  return (
    <div className="epick" ref={boxRef}>
      <div className={'epick-box' + (disabled ? ' is-disabled' : '')} onClick={() => boxRef.current?.querySelector('input')?.focus()}>
        {value.map(email => (
          <span className="epick-chip" key={email}>
            {email}
            <button
              type="button"
              onClick={() => onChange(value.filter(e => e !== email))}
              aria-label={`Remove ${email}`}
              disabled={disabled}
            >
              <Icon name="x" size={12} />
            </button>
          </span>
        ))}
        <input
          className="epick-input"
          value={text}
          disabled={disabled}
          placeholder={value.length ? 'Add another…' : `name@${hostDomain || 'company.com'}`}
          onChange={e => { setText(e.target.value); setError('') }}
          onKeyDown={onKeyDown}
          // Losing focus commits too: an address left in the box when the form
          // is submitted is an invitation the host thought they had sent.
          onBlur={() => commit()}
          // Chrome ignores autocomplete="off" on anything it decides is a
          // contact field and shows its own saved-address list on top of ours —
          // two dropdowns, and the useful one underneath. A name it does not
          // recognise plus the newer "off" spelling is what actually suppresses
          // it; the password-manager opt-outs are here for the same reason.
          autoComplete="new-password"
          name="invitee-search"
          type="text"
          inputMode="email"
          spellCheck="false"
          autoCorrect="off"
          autoCapitalize="off"
          data-1p-ignore
          data-lpignore="true"
          aria-autocomplete="list"
          aria-expanded={open}
        />
      </div>

      {open && suggestions.length > 0 && (
        <ul className="epick-list" role="listbox">
          {suggestions.map((s, i) => (
            <li key={s.email}>
              <button
                type="button"
                className={'epick-option' + (i === active ? ' is-active' : '')}
                onMouseEnter={() => setActive(i)}
                onClick={() => { add(s.email); setText(''); setOpen(false) }}
              >
                {/* Name first: it is what was typed, and the address under it
                    is what gets invited. */}
                <span className="epick-option-main">
                  <span className="epick-option-email">{s.displayName || s.email}</span>
                  {s.displayName && <span className="epick-option-name">{s.email}</span>}
                </span>
                {s.registered === false && (
                  <span className="epick-option-tag" title="In your organisation's directory; has not signed in yet">
                    directory
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}

      {error && <p className="epick-error">{error}</p>}
      {!error && lookupFailed && (
        <p className="epick-note">
          Cannot reach the people list right now — type the full address and it will still be invited.
        </p>
      )}
    </div>
  )
}
