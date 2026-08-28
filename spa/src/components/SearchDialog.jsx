import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../api'
import { Modal } from './ui/Modal'
import { Icon } from './ui/Icon'
import { Avatar } from './ui/Avatar'
import { Tabs } from './ui/Tabs'
import { timeAgo } from '../timeAgo'
import { kelaboKindIcon } from '../kelaboKind'
import { usePresenceContext } from '../presence/PresenceContext'

const SEARCH_DEBOUNCE_MS = 250

// `placeholder` per tab rather than a ternary at the input: with three tabs a
// two-way ternary becomes a chain nobody updates when a fourth arrives.
const TABS = [
  { id: 'contacts', label: 'Contacts', placeholder: 'Name or email…' },
  { id: 'kelabos', label: 'Kelabos', placeholder: 'Title, or anything from the minutes…' },
  { id: 'journeys', label: 'Journeys', placeholder: 'Title, description, or a pinned message…' },
]

/**
 * Global search, from the magnifier in the rail. One box, three tabs: people
 * (favourites and the org directory), past kelabos (titles from the record
 * list, plus full text of the minutes — the server reads those out of the
 * archives, most recent first, so "where did we decide that?" is answerable
 * without remembering which kelabo it was), and journeys (titles, then
 * descriptions and pinned board messages, docs 20 §11).
 *
 * Rows act: a contact opens the call dialog via `onCall`; a kelabo opens its
 * record; a journey opens its page. With nothing typed, each tab shows what
 * you would most likely reach for — favourites, the latest records, your
 * journeys.
 *
 * Both capped searches say so when they were capped, rather than letting
 * somebody conclude the thing they are looking for is not there.
 */
export function SearchDialog({ onClose, onCall }) {
  const navigate = useNavigate()
  const presence = usePresenceContext()
  const [tab, setTab] = useState('contacts')
  const [query, setQuery] = useState('')

  const [favourites, setFavourites] = useState([])
  const [people, setPeople] = useState(null) // null = nothing typed yet
  const [records, setRecords] = useState(null) // recent records, for the empty state
  const [hits, setHits] = useState(null) // server search results
  const [minutesCapped, setMinutesCapped] = useState(false)
  const [journeys, setJourneys] = useState(null) // recent journeys, for the empty state
  const [journeyHits, setJourneyHits] = useState(null)
  const [bodyCapped, setBodyCapped] = useState(false)
  const [searching, setSearching] = useState(false)

  useEffect(() => {
    api.listContacts().then(d => setFavourites(d.favourites || [])).catch(() => {})
    api.listRecords().then(d => setRecords(d.records || [])).catch(() => setRecords([]))
    api
      .listJourneys()
      // Three buckets on the wire, one list here — the distinction between
      // owned, shared and public is a discovery concern, and somebody typing
      // into a search box has already decided which journey they mean.
      .then(d => setJourneys([...(d.mine || []), ...(d.accessible || []), ...(d.public || [])]))
      .catch(() => setJourneys([]))
  }, [])

  // One debounce drives both tabs — the query means the same thing in each,
  // and switching tabs after typing should show results, not restart them.
  useEffect(() => {
    const q = query.trim()
    if (q.length < 2) {
      setPeople(null); setHits(null); setMinutesCapped(false)
      setJourneyHits(null); setBodyCapped(false); setSearching(false)
      return undefined
    }
    setSearching(true)
    const t = setTimeout(() => {
      // allSettled, not all: one endpoint failing must leave that tab empty,
      // never break the other two.
      Promise.allSettled([api.searchPeople(q), api.searchRecords(q), api.searchJourneys(q)])
        .then(([p, r, j]) => {
          setPeople(p.status === 'fulfilled' ? p.value?.suggestions || [] : [])
          setHits(r.status === 'fulfilled' ? r.value?.results || [] : [])
          setMinutesCapped(r.status === 'fulfilled' ? !!r.value?.minutesCapped : false)
          setJourneyHits(j.status === 'fulfilled' ? j.value?.results || [] : [])
          setBodyCapped(j.status === 'fulfilled' ? !!j.value?.bodyCapped : false)
        })
        .finally(() => setSearching(false))
    }, SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(t)
  }, [query])

  const contactRows = useMemo(() => {
    if (people) return people.map(p => ({ email: p.email, name: p.displayName || p.email, avatarVariant: p.avatarVariant }))
    return favourites.map(f => ({ email: f.email, name: f.displayName || f.email, avatarVariant: f.avatarVariant }))
  }, [people, favourites])

  const kelaboRows = useMemo(() => {
    if (hits) return hits
    return (records || []).slice(0, 8).map(r => ({ ...r, matched: null }))
  }, [hits, records])

  const journeyRows = useMemo(() => {
    if (journeyHits) return journeyHits
    return (journeys || []).slice(0, 8).map(j => ({ ...j, matched: null }))
  }, [journeyHits, journeys])

  const openRecord = id => { onClose(); navigate(`/kelabos/${id}`) }
  const openJourney = id => { onClose(); navigate(`/journeys/${id}`) }
  const openContact = email => { onClose(); navigate(`/contacts?q=${encodeURIComponent(email)}`) }

  return (
    <Modal
      open
      onDismiss={onClose}
      label="Search"
      className="modal-search"
      badge={<span className="modal-icon modal-icon-neutral"><Icon name="search" /></span>}
      title="Search"
      actions={null}
    >
      <Tabs tabs={TABS} active={tab} onChange={setTab} />

      <div className="call-picker">
        <div className="picker-search">
          <Icon name="search" size={14} />
          <input
            className="input"
            value={query}
            autoFocus
            placeholder={TABS.find(t => t.id === tab)?.placeholder}
            aria-label="Search"
            onChange={e => setQuery(e.target.value)}
          />
        </div>

        {tab === 'contacts' && (
          <>
            <div className="menu-label">{people ? 'Search results' : 'Favourites'}</div>
            <div className="picker-list">
              {searching && contactRows.length === 0 && <div className="menu-empty">Searching…</div>}
              {!searching && contactRows.length === 0 && (
                <div className="menu-empty">
                  {people ? 'Nobody matches that.' : 'No favourites yet — type to search your organisation.'}
                </div>
              )}
              {contactRows.map(c => {
                const online = presence.presence.has(c.email)
                return (
                  <div className="picker-row search-contact" key={c.email}>
                    <button type="button" className="search-contact-main" onClick={() => openContact(c.email)}>
                      <Avatar id={c.email} name={c.name} variant={c.avatarVariant} className="avatar-sm" />
                      <span className="picker-row-text">{c.name}</span>
                      <span className={'sdot ' + (online ? 'sdot-live' : 'sdot-ended')} title={online ? 'Online' : 'Offline'}></span>
                    </button>
                    {online && (
                      <button
                        type="button"
                        className="call-btn"
                        title={`Kelabo ${c.name}`}
                        aria-label={`Kelabo ${c.name}`}
                        onClick={() => onCall(c.email)}
                      >
                        <Icon name="phone" size={15} />
                      </button>
                    )}
                  </div>
                )
              })}
            </div>
          </>
        )}

        {tab === 'kelabos' && (
          <>
            <div className="menu-label">{hits ? 'Search results' : 'Recent kelabos'}</div>
            <div className="picker-list">
              {searching && kelaboRows.length === 0 && <div className="menu-empty">Searching…</div>}
              {!searching && records === null && kelaboRows.length === 0 && <div className="menu-empty">Loading…</div>}
              {!searching && records !== null && kelaboRows.length === 0 && (
                <div className="menu-empty">
                  {!hits && <span className="empty-mark" aria-hidden="true"></span>}
                  {hits ? 'Nothing in your titles or minutes matches that.' : 'No past kelabos yet.'}
                </div>
              )}
              {kelaboRows.map(r => (
                <button type="button" className="picker-row" key={r.archiveId} onClick={() => openRecord(r.archiveId)}>
                  <Icon name={kelaboKindIcon(r)} size={14} className="kind-icon" />
                  <span className="search-hit">
                    <span className="search-hit-title">{r.title}</span>
                    {r.snippet && <span className="search-hit-snippet">{r.snippet}</span>}
                  </span>
                  {r.matched === 'minutes' && <span className="chip">minutes</span>}
                  <span className="row-meta">{r.endedAt ? timeAgo(r.endedAt) : ''}</span>
                </button>
              ))}
              {minutesCapped && (
                <div className="menu-note">Minutes of older kelabos were not searched — titles still were.</div>
              )}
            </div>
          </>
        )}

        {tab === 'journeys' && (
          <>
            <div className="menu-label">{journeyHits ? 'Search results' : 'Your journeys'}</div>
            <div className="picker-list">
              {searching && journeyRows.length === 0 && <div className="menu-empty">Searching…</div>}
              {!searching && journeys === null && journeyRows.length === 0 && <div className="menu-empty">Loading…</div>}
              {!searching && journeys !== null && journeyRows.length === 0 && (
                <div className="menu-empty">
                  {!journeyHits && <span className="empty-mark" aria-hidden="true"></span>}
                  {journeyHits ? 'Nothing in your journeys matches that.' : 'No journeys yet.'}
                </div>
              )}
              {journeyRows.map(j => (
                <button type="button" className="picker-row" key={j.journeyId} onClick={() => openJourney(j.journeyId)}>
                  {/* Seeded by journeyId, the same identicon the journey list
                      and its own page draw — a journey is recognised by it. */}
                  <Avatar id={j.journeyId} variant={j.avatarVariant} size={22} />
                  <span className="search-hit">
                    <span className="search-hit-title">{j.title}</span>
                    {j.snippet && <span className="search-hit-snippet">{j.snippet}</span>}
                  </span>
                  {j.matched === 'body' && <span className="chip">description</span>}
                  <span className="row-meta">{j.updatedAt ? timeAgo(j.updatedAt) : ''}</span>
                </button>
              ))}
              {bodyCapped && (
                <div className="menu-note">Descriptions of older journeys were not searched — titles still were.</div>
              )}
            </div>
          </>
        )}
      </div>
    </Modal>
  )
}
