import { useEffect, useMemo, useState } from 'react'
import { api } from '../api'
import { Button } from '../components/ui/Button'
import { Icon } from '../components/ui/Icon'
import { Avatar } from '../components/ui/Avatar'
import { Menu } from '../components/ui/Menu'
import { useToast } from '../components/Toaster'
import { usePresenceContext } from '../presence/PresenceContext'

/**
 * "Add people" in the room (docs 18 §6): ring colleagues into THIS live kelabo.
 *
 * Rewritten for notes #10. It used to be a bare menu of whoever happened to be
 * online, one ring per click, addresses centred in a 180px column with the
 * avatars stranded at the left edge. Three things were wrong with that and all
 * three are the same mistake — it was built as a menu when it is a picker:
 *
 *   • People get invited to a kelabo in a group, not one at a time. Selection
 *     is now multiple and one button rings all of them.
 *   • The person you want is usually not already online, so "online" cannot be
 *     the list. It searches the org directory, and presence became a property
 *     shown on a row rather than the filter deciding which rows exist at all.
 *   • It is wide, and left-aligned, because it holds email addresses.
 */

// Long enough that typing a name does not fire a request per keystroke, short
// enough that the list feels like it is following you.
const SEARCH_DEBOUNCE_MS = 180

export function AddPeople({ kelaboId, present }) {
  const toast = useToast()
  const presence = usePresenceContext()
  const [favourites, setFavourites] = useState([])
  const [query, setQuery] = useState('')
  const [results, setResults] = useState(null) // null = nothing typed yet
  const [searching, setSearching] = useState(false)
  const [picked, setPicked] = useState(() => new Set())
  const [ringing, setRinging] = useState(false)

  useEffect(() => {
    api.listContacts().then(d => setFavourites(d.favourites || [])).catch(() => {})
  }, [])

  // Searching the directory, debounced. An empty box is not an empty search —
  // it is "the people I would most likely pick", which is favourites plus
  // whoever is online.
  useEffect(() => {
    const q = query.trim()
    if (!q) { setResults(null); setSearching(false); return undefined }
    setSearching(true)
    const t = setTimeout(() => {
      api.searchPeople(q)
        // Only people who have signed in can be rung; a directory entry who
        // never has would be refused, so they are not offered (docs 18 §4.8).
        .then(d => setResults((d.suggestions || []).filter(s => s.registered !== false)))
        .catch(() => setResults([]))
        .finally(() => setSearching(false))
    }, SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(t)
  }, [query])

  const nameOf = email => favourites.find(c => c.email === email)?.displayName || email

  /**
   * The rows to show. Anyone already in the room is dropped wherever they came
   * from — offering to ring someone who is looking at you is the one result
   * that is never right.
   */
  const rows = useMemo(() => {
    const seen = new Set()
    const out = []
    const add = (email, displayName, avatarVariant) => {
      if (!email || present.has(email) || seen.has(email)) return
      seen.add(email)
      out.push({
        email,
        name: displayName || favourites.find(c => c.email === email)?.displayName || email,
        avatarVariant: avatarVariant || 0,
        online: presence.presence.has(email),
      })
    }
    if (results) {
      for (const r of results) add(r.email, r.displayName, r.avatarVariant)
    } else {
      for (const c of favourites) add(c.email, c.displayName, c.avatarVariant)
      for (const id of presence.presence.keys()) if (id.includes('@')) add(id)
    }
    // Online first: they are the ones a ring will actually reach right now.
    return out.sort((a, b) => Number(b.online) - Number(a.online))
  }, [results, favourites, presence.presence, present])

  const toggle = email => {
    setPicked(prev => {
      const next = new Set(prev)
      if (next.has(email)) next.delete(email)
      else next.add(email)
      return next
    })
  }

  const ring = async close => {
    const invitees = [...picked]
    if (!invitees.length || ringing) return
    setRinging(true)
    try {
      const r = await api.ringInto(kelaboId, invitees)
      const offline = r.offline || []
      const reached = invitees.filter(e => !offline.includes(e))
      if (reached.length) {
        toast(`Ringing ${reached.length === 1 ? nameOf(reached[0]) : `${reached.length} people`}…`)
      }
      if (offline.length) {
        toast(`${offline.length === 1 ? nameOf(offline[0]) : `${offline.length} people`} offline — not rung`)
      }
      setPicked(new Set())
      setQuery('')
      close()
    } catch (e) {
      if (e?.code === 'no_contact') toast('You can only ring colleagues or accepted contacts')
      else toast('Could not ring — try again')
    } finally {
      setRinging(false)
    }
  }

  return (
    <Menu
      ariaLabel="Add people to this kelabo"
      className="addpeople-wrap"
      renderTrigger={props => (
        <button className="room-icon-btn cbtn" title="Add people" aria-label="Add people" {...props}>
          <Icon name="user-plus" size={18} />
        </button>
      )}
    >
      {({ close }) => (
        <div className="picker">
          <div className="picker-search">
            <Icon name="search" size={14} />
            <input
              className="input"
              value={query}
              autoFocus
              placeholder="Search your organisation…"
              aria-label="Search for people to ring into this kelabo"
              onChange={e => setQuery(e.target.value)}
            />
          </div>

          <div className="menu-label">{results ? 'Search results' : 'Contacts and people online'}</div>

          <div className="picker-list">
            {searching && rows.length === 0 && <div className="menu-empty">Searching…</div>}
            {!searching && rows.length === 0 && (
              <div className="menu-empty">
                {results ? 'Nobody matches that.' : 'Nobody to ring yet — search for a colleague.'}
              </div>
            )}
            {rows.map(r => {
              const on = picked.has(r.email)
              return (
                <button
                  key={r.email}
                  type="button"
                  className={'picker-row' + (on ? ' is-on' : '')}
                  aria-pressed={on}
                  onClick={() => toggle(r.email)}
                >
                  <Avatar id={r.email} name={r.name} variant={r.avatarVariant} className="avatar-sm" />
                  <span className="picker-row-text">{r.name}</span>
                  <span
                    className={'sdot ' + (r.online ? 'sdot-live' : 'sdot-ended')}
                    title={r.online ? 'Online' : 'Offline — they will not hear a ring'}
                  ></span>
                  <span className="picker-check">{on && <Icon name="check" size={14} />}</span>
                </button>
              )
            })}
          </div>

          <div className="picker-foot">
            {/* Only ever says something once there IS something to say. A list of
                people with tick marks does not need to be told it is a list of
                people with tick marks. */}
            <span className="text-meta">{picked.size ? `${picked.size} selected` : ''}</span>
            <Button size="sm" variant="primary" disabled={!picked.size || ringing} onClick={() => ring(close)}>
              <Icon name="phone" size={14} />
              {ringing ? 'Ringing…' : picked.size > 1 ? `Ring ${picked.size}` : 'Ring'}
            </Button>
          </div>
        </div>
      )}
    </Menu>
  )
}
