import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../api'
import { Modal } from './ui/Modal'
import { Button } from './ui/Button'
import { Icon } from './ui/Icon'
import { Avatar } from './ui/Avatar'
import { Switch } from './ui/Switch'
import { useToast } from './Toaster'
import { usePresenceContext } from '../presence/PresenceContext'

// Same debounce as the room's AddPeople — this is the same picker, one step
// earlier in the flow.
const SEARCH_DEBOUNCE_MS = 180

/**
 * The confirm step of a call (docs 18 §6). Dialling from Contacts opens this
 * instead of ringing immediately: the person you clicked is pre-selected, and
 * the same picker the room's "Add people" uses lets you pull in more before
 * anyone's phone rings — people get called in a group, not one at a time.
 *
 * "Private" makes the call an unlisted kelabo: it never appears in anyone
 * else's "Live now" list, and only the people rung (or handed the link) can
 * find it. Off by default — a call is an ordinary kelabo unless said otherwise.
 */
export function CallDialog({ initial, onClose }) {
  const toast = useToast()
  const navigate = useNavigate()
  const presence = usePresenceContext()
  const [favourites, setFavourites] = useState([])
  const [query, setQuery] = useState('')
  const [results, setResults] = useState(null) // null = nothing typed yet
  const [searching, setSearching] = useState(false)
  const [picked, setPicked] = useState(() => new Set(initial ? [initial] : []))
  // Every name this dialog has ever seen for an address, so the kelabo title
  // and the toasts can name people even after the search that showed them ends.
  const [names, setNames] = useState({})
  const [priv, setPriv] = useState(false)
  const [calling, setCalling] = useState(false)

  useEffect(() => {
    api.listContacts()
      .then(d => {
        const favs = d.favourites || []
        setFavourites(favs)
        setNames(n => ({ ...Object.fromEntries(favs.map(f => [f.email, f.displayName])), ...n }))
      })
      .catch(() => {})
  }, [])

  useEffect(() => {
    const q = query.trim()
    if (!q) { setResults(null); setSearching(false); return undefined }
    setSearching(true)
    const t = setTimeout(() => {
      api.searchPeople(q)
        .then(d => {
          // Ringing reaches people who have signed in, not directory entries
          // who never have (docs 18 §4.8).
          const found = (d.suggestions || []).filter(s => s.registered !== false)
          setResults(found)
          setNames(n => ({ ...Object.fromEntries(found.filter(r => r.displayName).map(r => [r.email, r.displayName])), ...n }))
        })
        .catch(() => setResults([]))
        .finally(() => setSearching(false))
    }, SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(t)
  }, [query])

  const nameOf = email => names[email] || email

  // An empty box is not an empty search — it is "the people I would most
  // likely call": favourites, plus whoever is online right now. Same shape as
  // the room's picker.
  const rows = useMemo(() => {
    const seen = new Set()
    const out = []
    const add = (email, displayName, avatarVariant) => {
      if (!email || seen.has(email)) return
      seen.add(email)
      out.push({
        email,
        name: displayName || names[email] || email,
        avatarVariant: avatarVariant || 0,
        online: presence.presence.has(email),
      })
    }
    if (results) {
      for (const r of results) add(r.email, r.displayName, r.avatarVariant)
    } else {
      if (initial) add(initial)
      for (const c of favourites) add(c.email, c.displayName, c.avatarVariant)
      for (const id of presence.presence.keys()) if (id.includes('@')) add(id)
    }
    return out.sort((a, b) => Number(b.online) - Number(a.online))
  }, [results, favourites, presence.presence, initial, names])

  const toggle = email => {
    setPicked(prev => {
      const next = new Set(prev)
      if (next.has(email)) next.delete(email)
      else next.add(email)
      return next
    })
  }

  const start = async () => {
    const invitees = [...picked]
    if (!invitees.length || calling) return
    setCalling(true)
    const title = `Kelabo with ${invitees.map(e => (nameOf(e).split(/[\s@]/)[0]) || e).join(', ')}`.slice(0, 80)
    try {
      const r = await api.huddle(invitees, { title, private: priv })
      const name = localStorage.getItem('kelabo-name') || 'Me'
      try {
        await api.joinKelabo(r.kelaboId, name, 'audio-board')
        localStorage.setItem('kelabo-mode', 'audio-board')
      } catch {}
      const offline = r.offline || []
      if (offline.length) {
        toast(`${offline.length === 1 ? nameOf(offline[0]) : `${offline.length} people`} offline — they can still join from the link`)
      }
      navigate(`/m/${r.kelaboId}`)
    } catch (e) {
      setCalling(false)
      if (e?.code === 'no_contact') toast('You can only kelabo colleagues or accepted contacts')
      else toast('Could not start the kelabo — try again')
    }
  }

  return (
    <Modal
      open
      onDismiss={() => { if (!calling) onClose() }}
      label="Start a kelabo"
      badge={<span className="modal-icon modal-icon-accent"><Icon name="phone" /></span>}
      title="Start a kelabo"
      actions={
        <>
          <Button variant="ghost" onClick={onClose} disabled={calling}>Cancel</Button>
          <Button variant="primary" onClick={start} disabled={!picked.size || calling}>
            <Icon name="phone" size={14} />
            {calling ? 'Starting…' : picked.size > 1 ? `Kelabo ${picked.size} people` : 'Kelabo'}
          </Button>
        </>
      }
    >
      <p className="modal-body">
        Everyone selected gets a ring and joins the moment they accept.
      </p>

      <div className="call-picker">
        <div className="picker-search">
          <Icon name="search" size={14} />
          <input
            className="input"
            value={query}
            autoFocus
            placeholder="Add more people…"
            aria-label="Search for more people to add"
            onChange={e => setQuery(e.target.value)}
          />
        </div>

        <div className="menu-label">{results ? 'Search results' : 'Contacts and people online'}</div>

        <div className="picker-list">
          {searching && rows.length === 0 && <div className="menu-empty">Searching…</div>}
          {!searching && rows.length === 0 && (
            <div className="menu-empty">
              {results ? 'Nobody matches that.' : 'Nobody to kelabo yet — search for a colleague.'}
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
      </div>

      <div className="settings-row settings-row-plain">
        <div className="sr-main">
          <div className="sr-title">Private kelabo</div>
          <div className="sr-sub">
            Not shown in anyone's kelabo list — only the people you ring, or share the link with, can join.
          </div>
        </div>
        <Switch checked={priv} onChange={setPriv} ariaLabel="Private kelabo" />
      </div>
    </Modal>
  )
}
