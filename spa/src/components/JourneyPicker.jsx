import { useEffect, useState } from 'react'
import { api } from '../api'
import { Icon } from './ui/Icon'
import { Modal } from './ui/Modal'
import { Button } from './ui/Button'

/**
 * Link this kelabo into one or more journeys at creation time (docs 20
 * §11) — `journeyIds` on the create/schedule body, already accepted
 * server-side (`contracts/src/schemas.js`, capped at 10 there too).
 *
 * `api.listJourneys()` cannot return a completed journey in `mine` or
 * `public` by construction (the tenant-status-index's own partition key),
 * and `accessible` is now filtered the same way server-side — so nothing
 * here re-checks `status`; a journey this call returns at all is one that
 * can actually be linked.
 */
const MAX_JOURNEYS = 10

function PickJourneyModal({ exclude, onClose, onPick }) {
  const [journeys, setJourneys] = useState(null)
  const [q, setQ] = useState('')

  useEffect(() => {
    api.listJourneys()
      .then(d => {
        const seen = new Set()
        const all = [...(d.mine || []), ...(d.accessible || []), ...(d.public || [])].filter(j => {
          if (seen.has(j.journeyId)) return false
          seen.add(j.journeyId)
          return true
        })
        setJourneys(all)
      })
      .catch(() => setJourneys([]))
  }, [])

  const candidates = (journeys || []).filter(j => !exclude.includes(j.journeyId))
  const filtered = q.trim()
    ? candidates.filter(j => j.title?.toLowerCase().includes(q.trim().toLowerCase()))
    : candidates

  return (
    <Modal
      open
      onDismiss={onClose}
      label="Link to a journey"
      title="Link to a journey"
      badge={<span className="modal-icon modal-icon-neutral"><Icon name="link" /></span>}
      actions={<Button variant="ghost" onClick={onClose}>Close</Button>}
    >
      <input
        className="input"
        placeholder="Filter by title"
        autoFocus
        value={q}
        onChange={e => setQ(e.target.value)}
      />
      {journeys === null && <p className="text-meta">Loading…</p>}
      <div className="vstack-sm" style={{ maxHeight: 320, overflowY: 'auto' }}>
        {journeys !== null && filtered.length === 0 && <div className="empty">No matching journeys.</div>}
        {filtered.map(j => (
          <button
            key={j.journeyId}
            type="button"
            className="row row-static"
            onClick={() => onPick(j)}
            style={{ cursor: 'pointer', width: '100%', textAlign: 'left' }}
          >
            <div className="row-main">
              <div className="row-title">{j.title || 'Untitled journey'}</div>
              <div className="row-sub">{j.visibility}</div>
            </div>
          </button>
        ))}
      </div>
    </Modal>
  )
}

/**
 * `value`: array of `{id, title}`. `onChange(next)` with the whole array —
 * the same controlled-list shape `EmailPicker` uses, reusing its `.epick*`
 * chip-box styling (there is no typing here, so only the box/chip classes
 * apply, not the typeahead/suggestion ones).
 */
export function JourneyPicker({ value, onChange, disabled }) {
  const [showPick, setShowPick] = useState(false)
  const full = value.length >= MAX_JOURNEYS

  const pick = j => {
    setShowPick(false)
    if (full || value.some(v => v.id === j.journeyId)) return
    onChange([...value, { id: j.journeyId, title: j.title }])
  }
  const remove = id => onChange(value.filter(v => v.id !== id))

  return (
    <div className="epick">
      <div className={'epick-box' + (disabled ? ' is-disabled' : '')}>
        {value.map(v => (
          <span className="epick-chip" key={v.id}>
            {v.title || 'Untitled journey'}
            <button
              type="button"
              onClick={() => remove(v.id)}
              aria-label={`Remove ${v.title || 'journey'}`}
              disabled={disabled}
            >
              <Icon name="x" size={12} />
            </button>
          </span>
        ))}
        {!disabled && !full && (
          <button
            type="button"
            className="epick-input"
            style={{ textAlign: 'left', cursor: 'pointer' }}
            onClick={() => setShowPick(true)}
          >
            {value.length ? 'Add another…' : 'Link to a journey…'}
          </button>
        )}
      </div>
      {showPick && (
        <PickJourneyModal exclude={value.map(v => v.id)} onClose={() => setShowPick(false)} onPick={pick} />
      )}
    </div>
  )
}
