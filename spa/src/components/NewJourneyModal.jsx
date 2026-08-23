import { useRef, useState } from 'react'
import { api } from '../api'
import { Icon } from './ui/Icon'
import { Button } from './ui/Button'
import { Modal } from './ui/Modal'
import { useToast } from './Toaster'

/**
 * Create a journey (docs 20 §11). Shared rather than owned by `Journeys.jsx`
 * — the trigger lives in `AppShell.jsx`'s sidebar (reachable from any page,
 * matching "New kelabo"/"Schedule"/"Join"), not on the journeys list page
 * itself.
 */
export function NewJourneyModal({ onClose, onCreated }) {
  const [title, setTitle] = useState('')
  const [visibility, setVisibility] = useState('private')
  const [description, setDescription] = useState('')
  const [saving, setSaving] = useState(false)
  const toast = useToast()
  const titleRef = useRef(null)

  const submit = async e => {
    e?.preventDefault()
    if (saving || !title.trim()) return
    setSaving(true)
    try {
      const created = await api.createJourney({
        title: title.trim(),
        visibility,
        ...(description.trim() ? { description: description.trim() } : {}),
      })
      onCreated(created.journeyId)
    } catch {
      setSaving(false)
      toast('Could not create the journey — try again')
    }
  }

  return (
    <Modal
      open
      onDismiss={onClose}
      label="New journey"
      as="form"
      onSubmit={submit}
      badge={<span className="modal-icon modal-icon-neutral"><Icon name="book-open" /></span>}
      title="New journey"
      actions={
        <>
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={saving || !title.trim()}>
            {saving ? 'Creating…' : 'Create journey'}
          </Button>
        </>
      }
    >
      <div className="field form-stack">
        <label className="label" htmlFor="j-title">Title</label>
        <input
          id="j-title"
          ref={titleRef}
          className="input"
          autoFocus
          maxLength={80}
          placeholder="Q3 launch"
          value={title}
          onChange={e => setTitle(e.target.value)}
        />
      </div>
      <div className="field form-stack">
        <label className="label" htmlFor="j-desc">Description (optional)</label>
        <textarea
          id="j-desc"
          className="input"
          rows={3}
          maxLength={20000}
          placeholder="What this project is, so the second kelabo starts with context"
          value={description}
          onChange={e => setDescription(e.target.value)}
        />
      </div>
      <div className="settings-row settings-row-plain">
        <div className="sr-main">
          <div className="sr-title">Visibility</div>
          <div className="sr-sub">
            {visibility === 'public'
              ? 'Everyone at your tenant can view, edit and link kelabos into it.'
              : 'Only you and accessors you add can see it.'}
          </div>
        </div>
        <div className="hstack">
          <Button
            type="button"
            size="sm"
            variant={visibility === 'private' ? 'primary' : 'outline'}
            onClick={() => setVisibility('private')}
          >
            Private
          </Button>
          <Button
            type="button"
            size="sm"
            variant={visibility === 'public' ? 'primary' : 'outline'}
            onClick={() => setVisibility('public')}
          >
            Public
          </Button>
        </div>
      </div>
    </Modal>
  )
}
