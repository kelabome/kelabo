import { useCallback, useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { api } from '../api'
import { Banner } from '../components/ui/Banner'
import { Icon } from '../components/ui/Icon'
import { Avatar } from '../components/ui/Avatar'
import { SkeletonRows } from '../components/ui/Skeleton'
import { CallDialog } from '../components/CallDialog'
import { useToast } from '../components/Toaster'
import { usePresenceContext } from '../presence/PresenceContext'
import { useTypeAnywhere } from '../useTypeAnywhere'
import { useAuth } from '../auth'

/**
 * Contacts (docs 18 §4).
 *
 * The list is your favourites — same-org colleagues you have pinned. Everyone
 * else in the org is found by search, where each result shows whether you have
 * favourited them and lets you toggle it in place. Search also covers the
 * organisation directory an administrator imported (docs 18 §4.7), so a
 * colleague is findable by name before they have ever signed in; those rows
 * say so, and can be starred only when they are at your own domain — the same
 * rule favourites always had. Favouriting is private and
 * one-way: the other person is never told, so there is no "request" and no
 * "pending" here. Presence dots arrive with docs 18 §5; until then a
 * neutral dot is shown.
 */

function Star({ on, onClick, busy, label }) {
  return (
    <button
      className={'star-btn' + (on ? ' on' : '')}
      onClick={onClick}
      disabled={busy}
      aria-pressed={on}
      title={label}
      aria-label={label}
    >
      <Icon name="star" size={16} />
    </button>
  )
}

function Row({ email, name, avatarVariant, favourited, onToggle, busy, online, inKelabo, onCall, canFavourite = true, notSignedIn = false }) {
  const who = name || email
  const dotCls = online ? 'sdot-live' : 'sdot-ended'
  const dotTitle = !online ? 'Offline' : inKelabo ? 'In a kelabo' : 'Online'
  return (
    <div className="row">
      <span className={'sdot ' + dotCls} title={dotTitle}></span>
      <Avatar id={email} name={who} variant={avatarVariant} />
      <div className="row-main">
        <div className="row-title">
          {who}
          {online && inKelabo && <span className="chip">in a kelabo</span>}
          {notSignedIn && <span className="chip chip-sm" title="In your organisation's directory">not signed in yet</span>}
        </div>
        {name && name !== email && <div className="row-sub">{email}</div>}
      </div>
      {online && (
        <button
          className="call-btn"
          onClick={() => onCall(email)}
          title={`Kelabo ${who}`}
          aria-label={`Kelabo ${who}`}
        >
          <Icon name="phone" size={16} />
        </button>
      )}
      {canFavourite && (
        <Star
          on={favourited}
          busy={busy}
          onClick={() => onToggle(email, !favourited)}
          label={favourited ? `Remove ${who} from favourites` : `Add ${who} to favourites`}
        />
      )}
    </div>
  )
}

export default function Contacts() {
  const toast = useToast()
  const presence = usePresenceContext()
  const { identity } = useAuth()
  const myDomain = (identity?.email || '').split('@')[1]?.toLowerCase() || ''
  const [favourites, setFavourites] = useState(null)
  const [error, setError] = useState(false)
  const [busy, setBusy] = useState({})
  // The address the call dialog opened for, or null. The dialog owns the dial
  // itself — this page only decides who it starts with.
  const [callTo, setCallTo] = useState(null)

  // Arriving from the global search dialog carries the query along (?q=…),
  // so the page opens already showing the person that was clicked.
  const [params] = useSearchParams()
  const [q, setQ] = useState(() => params.get('q') || '')
  const [results, setResults] = useState([])
  const [searching, setSearching] = useState(false)
  const seq = useRef(0)
  const searchRef = useRef(null)

  // Typing or pasting anywhere on the page starts a search.
  useTypeAnywhere(searchRef, !callTo)

  const load = useCallback(() => {
    api.listContacts()
      .then(d => { setFavourites(d.favourites || []); setError(false) })
      .catch(() => setError(true))
  }, [])

  useEffect(() => { load() }, [load])

  // Debounced colleague search. Sequence-guarded so only the newest response
  // wins, like EmailPicker.
  useEffect(() => {
    const text = q.trim()
    if (!text) { setResults([]); setSearching(false); return undefined }
    const mine = ++seq.current
    setSearching(true)
    const t = setTimeout(() => {
      api.searchPeople(text)
        .then(r => {
          if (mine !== seq.current) return
          setResults(r?.suggestions || [])
        })
        .catch(() => { if (mine === seq.current) setResults([]) })
        .finally(() => { if (mine === seq.current) setSearching(false) })
    }, 160)
    return () => clearTimeout(t)
  }, [q])

  const favSet = new Set((favourites || []).map(f => f.email))

  const toggle = async (email, next) => {
    setBusy(b => ({ ...b, [email]: true }))
    // Optimistic: update the favourites list and any visible search result.
    const prev = favourites
    if (next) {
      const name = results.find(r => r.email === email)?.displayName || email
      setFavourites(list => [...(list || []).filter(f => f.email !== email), { email, displayName: name }]
        .sort((a, b) => (a.displayName || a.email).localeCompare(b.displayName || b.email)))
    } else {
      setFavourites(list => (list || []).filter(f => f.email !== email))
    }
    setResults(list => list.map(r => (r.email === email ? { ...r, favourited: next } : r)))
    try {
      if (next) await api.favouriteContact(email)
      else await api.unfavouriteContact(email)
    } catch {
      setFavourites(prev)
      setResults(list => list.map(r => (r.email === email ? { ...r, favourited: !next } : r)))
      toast('Could not update favourites — try again')
    } finally {
      setBusy(b => ({ ...b, [email]: false }))
    }
  }

  return (
    <main className="page">
      <h1 className="page-title">Contacts</h1>
      <p className="page-sub">Pin the colleagues you meet with most. Only you can see your favourites.</p>

      <div className="field">
        <span className="label">Find a colleague</span>
        <div className="search-box">
          <Icon name="search" size={16} />
          <input
            className="input"
            ref={searchRef}
            placeholder="Name or email"
            value={q}
            onChange={e => setQ(e.target.value)}
            autoComplete="off"
          />
        </div>
      </div>

      {q.trim() && (
        <>
          <div className="section-title">Search results</div>
          {searching && results.length === 0 && <SkeletonRows n={2} />}
          {!searching && results.length === 0 && (
            <div className="empty">Nobody matches “{q.trim()}”.</div>
          )}
          {results.map(r => (
            <Row
              key={r.email}
              email={r.email}
              name={r.displayName}
              avatarVariant={r.avatarVariant}
              favourited={r.favourited ?? favSet.has(r.email)}
              onToggle={toggle}
              busy={!!busy[r.email]}
              online={presence.isOnline(r.email)}
              inKelabo={presence.inKelabo(r.email)}
              onCall={setCallTo}
              canFavourite={!myDomain || r.email.split('@')[1] === myDomain}
              notSignedIn={r.registered === false}
            />
          ))}
        </>
      )}

      <div className="section-title">Favourites</div>
      {error && <Banner kind="warn">Couldn't load your contacts — retrying on next visit.</Banner>}
      {favourites === null && !error && <SkeletonRows n={3} />}
      {favourites !== null && favourites.length === 0 && !error && (
        <div className="empty">No favourites yet — search above and tap the star to pin someone.</div>
      )}
      {(favourites || []).map(f => (
        <Row
          key={f.email}
          email={f.email}
          name={f.displayName}
          avatarVariant={f.avatarVariant}
          favourited={true}
          onToggle={toggle}
          busy={!!busy[f.email]}
          online={presence.isOnline(f.email)}
          inKelabo={presence.inKelabo(f.email)}
          onCall={setCallTo}
        />
      ))}

      {callTo && <CallDialog initial={callTo} onClose={() => setCallTo(null)} />}
    </main>
  )
}
