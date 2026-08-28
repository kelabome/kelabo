import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { api } from '../api'
import { useAuth } from '../auth'
import { useAppData } from '../components/AppShell'
import { useConfirm } from '../components/ConfirmDialog'
import { usePrompt } from '../components/PromptDialog'
import { useToast } from '../components/Toaster'
import { Avatar } from '../components/ui/Avatar'
import { Banner } from '../components/ui/Banner'
import { Button } from '../components/ui/Button'
import { Crumbs } from '../components/ui/Crumbs'
import { Icon } from '../components/ui/Icon'
import { Modal } from '../components/ui/Modal'
import { Skeleton, SkeletonRows } from '../components/ui/Skeleton'
import { Switch } from '../components/ui/Switch'
import { Tabs } from '../components/ui/Tabs'
import { Markdown } from '../components/Markdown'
import { JourneyThreads } from '../chat/JourneyThreads'
import { journeyChat } from '../api'
import { JourneyHealthChip } from './Journeys'
import { JourneyHelmExtra } from '../variant'
import { annotateDays, fmtFullAt, fmtTime } from '../time'
import { timeAgo } from '../timeAgo'

// A journey link (docs 20 §9.3) persists a kelabo's status as a snapshot:
// taken at link time and re-stamped "ended" by the gateway's end path
// (`markLinkEnded`), so an ended kelabo routes to its record rather than a
// join page nobody can use. Staleness in the other shapes self-corrects on
// load: `/scheduled/:id` does its own live fetch and renders whatever the
// current status actually is, and `/join/:id` redirects an ended kelabo to
// `/kelabos/:id` itself (which also rescues rows linked before the end
// stamp existed).
function kelaboHref(kelaboId, status) {
  if (status === 'active') return `/join/${kelaboId}`
  if (status === 'ended') return `/kelabos/${kelaboId}`
  return `/scheduled/${kelaboId}`
}

const TABS = [
  { id: 'overview', label: 'Overview' },
  // Second in the strip but still the tab that opens (docs 20 §19): Overview
  // is what you read once and threads are what you come back for, so the
  // order reflects the hierarchy while the default reflects the traffic.
  // Its body owns the viewport height, which is why `.page` becomes a flex
  // column for this tab alone.
  { id: 'chat', label: 'Threads' },
  { id: 'timeline', label: 'Timeline' },
  { id: 'kelabos', label: 'Kelabos' },
  // "Questions" is display vocabulary over an unchanged `reports` mechanism
  // (docs 20 §13's rename note): the tab id, the REST path, the REPORT# item
  // and the kelabo_journey_reports tool all keep the stored word.
  { id: 'reports', label: 'Questions' },
  { id: 'board', label: 'Board' },
  { id: 'documents', label: 'Documents' },
]

// Where the journey is steered from — the lead's own controls, gathered in
// one place instead of scattered across the title row (rename, avatar), a
// floating action row (complete, delete), the Overview tab (assistant
// posting) and a conditional tab of its own (accessors). Owner-only and
// appended last, so the tab strip a member sees is unchanged. Named for the
// vocabulary the rest of the journey already speaks — Full Steam / Shoal
// Waters / Anchored, and the Lead who is at it.
const HELM_TAB = { id: 'helm', label: 'Helm' }

// The thread list is polled here so the Threads tab can carry a badge while
// another tab is open. Same cadence as the journey list's own poll: unread is
// not something anyone watches by the second, and this is several rows per
// journey. Replaced by a push over the presence stream when that lands
// (docs 20 §19.9).
const THREADS_POLL_MS = 20000

const TIMELINE_TYPES = [
  { id: '', label: 'All' },
  { id: 'description', label: 'Description' },
  { id: 'status', label: 'Status' },
  { id: 'kelabo_linked', label: 'Linked' },
  { id: 'kelabo_unlinked', label: 'Unlinked' },
  { id: 'board_message', label: 'Board' },
  { id: 'document', label: 'Documents' },
]

// --- Overview ----------------------------------------------------------------

function EditDescriptionModal({ current, onClose, onSaved }) {
  const [markdown, setMarkdown] = useState(current || '')
  const [changeNote, setChangeNote] = useState('')
  const [saving, setSaving] = useState(false)
  const toast = useToast()

  const submit = async e => {
    e?.preventDefault()
    if (saving || !markdown.trim()) return
    setSaving(true)
    try {
      await onSaved(markdown.trim(), changeNote.trim() || undefined)
      onClose()
    } catch {
      setSaving(false)
      toast('Could not save the description')
    }
  }

  return (
    <Modal
      open
      onDismiss={onClose}
      label="Edit description"
      as="form"
      onSubmit={submit}
      badge={<span className="modal-icon modal-icon-neutral"><Icon name="pencil" /></span>}
      title="Edit description"
      actions={
        <>
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={saving || !markdown.trim()}>
            {saving ? 'Saving…' : 'Save version'}
          </Button>
        </>
      }
    >
      <div className="field form-stack">
        <label className="label" htmlFor="j-markdown">Description</label>
        <textarea
          id="j-markdown"
          className="input"
          rows={8}
          maxLength={20000}
          autoFocus
          value={markdown}
          onChange={e => setMarkdown(e.target.value)}
        />
      </div>
      <div className="field form-stack">
        <label className="label" htmlFor="j-note">What changed (optional)</label>
        <input
          id="j-note"
          className="input"
          maxLength={200}
          placeholder="Clarified scope"
          value={changeNote}
          onChange={e => setChangeNote(e.target.value)}
        />
      </div>
      <p className="text-meta">Every edit keeps the version before it — nothing here is ever overwritten.</p>
    </Modal>
  )
}

function DescriptionHistoryModal({ id, onClose }) {
  const [versions, setVersions] = useState(null)
  useEffect(() => { api.getJourneyDescriptionHistory(id).then(d => setVersions(d.versions || [])).catch(() => setVersions([])) }, [id])
  return (
    <Modal
      open
      onDismiss={onClose}
      label="Description history"
      title="Description history"
      badge={<span className="modal-icon modal-icon-neutral"><Icon name="clock" /></span>}
      actions={<Button variant="primary" onClick={onClose}>Close</Button>}
    >
      {versions === null && <SkeletonRows n={2} />}
      {versions && versions.length === 0 && <p className="modal-body">No versions yet.</p>}
      <div className="vstack-sm">
        {(versions || []).map(v => (
          <div className="section-block" key={v.version}>
            <div className="text-meta">
              v{v.version} · {v.editedBy} · {fmtFullAt(v.editedAt)}{v.changeNote ? ` · ${v.changeNote}` : ''}
            </div>
            <p className="min-summary">{v.markdown}</p>
          </div>
        ))}
      </div>
    </Modal>
  )
}

const HEALTH_OPTIONS = [
  { value: 'green', label: 'Full Steam' },
  { value: 'yellow', label: 'Shoal Waters' },
  { value: 'red', label: 'Anchored' },
]

function StatusModal({ journey, onClose, onSaved }) {
  const [health, setHealth] = useState(journey.health ?? null)
  const [progress, setProgress] = useState(journey.progress ?? '')
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)
  const toast = useToast()

  const submit = async e => {
    e?.preventDefault()
    if (saving) return
    setSaving(true)
    try {
      await onSaved({
        health,
        progress: progress === '' ? null : Math.max(0, Math.min(100, Number(progress))),
        ...(note.trim() ? { note: note.trim() } : {}),
      })
      onClose()
    } catch {
      setSaving(false)
      toast('Could not update status')
    }
  }

  return (
    <Modal
      open
      onDismiss={onClose}
      label="Update status"
      as="form"
      onSubmit={submit}
      badge={<span className="modal-icon modal-icon-neutral"><Icon name="check-circle" /></span>}
      title="Update status"
      actions={
        <>
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={saving}>{saving ? 'Saving…' : 'Save'}</Button>
        </>
      }
    >
      <div className="field form-stack">
        <span className="label">Health</span>
        <div className="hstack">
          {HEALTH_OPTIONS.map(o => (
            <Button
              key={String(o.value)}
              type="button"
              size="sm"
              variant={health === o.value ? 'primary' : 'outline'}
              onClick={() => setHealth(o.value)}
            >
              {o.label}
            </Button>
          ))}
        </div>
      </div>
      <div className="field form-stack">
        <label className="label" htmlFor="j-progress">Progress (%, optional — leave blank to clear)</label>
        <input
          id="j-progress"
          className="input input-narrow"
          type="number"
          min={0}
          max={100}
          placeholder="0–100"
          value={progress}
          onChange={e => setProgress(e.target.value)}
        />
      </div>
      <div className="field form-stack">
        <label className="label" htmlFor="j-status-note">Note (optional)</label>
        <input
          id="j-status-note"
          className="input"
          maxLength={500}
          placeholder="Blocked on design review"
          value={note}
          onChange={e => setNote(e.target.value)}
        />
      </div>
    </Modal>
  )
}

function OverviewTab({ journey, isOwner, isMember, reload }) {
  const [description, setDescription] = useState(null)
  const [editing, setEditing] = useState(false)
  const [showHistory, setShowHistory] = useState(false)
  const [showStatus, setShowStatus] = useState(false)
  const [contributors, setContributors] = useState(null)
  const toast = useToast()

  useEffect(() => {
    api.listJourneyContributors(journey.journeyId).then(d => setContributors(d.contributors || [])).catch(() => setContributors([]))
  }, [journey.journeyId])

  useEffect(() => {
    api.getJourneyDescriptionHistory(journey.journeyId)
      .then(d => {
        const versions = d.versions || []
        const latest = versions.reduce((a, b) => (a && a.version > b.version ? a : b), null)
        setDescription(latest?.markdown || '')
      })
      .catch(() => setDescription(''))
  }, [journey.journeyId])

  const saveDescription = async (markdown, changeNote) => {
    await api.updateJourneyDescription(journey.journeyId, { markdown, changeNote })
    setDescription(markdown)
    toast('Description updated')
  }

  const saveStatus = async body => {
    await api.updateJourneyStatus(journey.journeyId, body)
    await reload()
    toast('Status updated')
  }



  return (
    <section className="anim-in vstack-lg">
      <div className="section-block">
        <div className="hstack" style={{ justifyContent: 'space-between' }}>
          <div className="section-title">Description</div>
          {isMember && !journey.completedAt && journey.status === 'active' && (
            <div className="hstack">
              <Button size="sm" onClick={() => setShowHistory(true)}>
                <Icon name="clock" size={14} />History
              </Button>
              <Button size="sm" onClick={() => setEditing(true)}>
                <Icon name="pencil" size={14} />Edit
              </Button>
            </div>
          )}
          {journey.status === 'completed' && (
            <Button size="sm" onClick={() => setShowHistory(true)}>
              <Icon name="clock" size={14} />History
            </Button>
          )}
        </div>
        {description === null && <SkeletonRows n={1} />}
        {description === '' && <div className="empty">No description yet.</div>}
        {description && <Markdown text={description} />}
      </div>

      <div className="section-block">
        <div className="hstack" style={{ justifyContent: 'space-between' }}>
          <div className="section-title">Status</div>
          {isMember && journey.status === 'active' && (
            <Button size="sm" onClick={() => setShowStatus(true)}>
              <Icon name="check-circle" size={14} />Update
            </Button>
          )}
        </div>
        <div className="hstack">
          <JourneyHealthChip health={journey.health} />
          {typeof journey.progress === 'number'
            ? <span className="chip chip-accent">{journey.progress}% complete</span>
            : <span className="text-meta">No health/progress set</span>}
        </div>
      </div>

      {/* aiCanPost (docs 20 §7, §12.2) is disclosed here to every member and
          changed only at the Helm — the same "a capability nobody can see is
          one nobody can object to" rule historyEnabled follows: the switch
          being owner-only must not make the state owner-only too. */}
      <div className="section-block">
        <div className="section-title">Assistant</div>
        <div className="settings-row settings-row-plain">
          <div className="sr-main">
            <div className="sr-title">Assistant can post to the board</div>
            <div className="sr-sub">
              Lets an attached assistant pin its own board messages — the outcome of work it finished.
              {isOwner ? ' Change it at the Helm.' : ' Only the journey lead can change this.'}
            </div>
          </div>
          <span className={`chip${journey.aiCanPost ? ' chip-accent' : ''}`}>{journey.aiCanPost ? 'On' : 'Off'}</span>
        </div>
      </div>

      <div className="section-block">
        <div className="section-title">People</div>
        <div className="row">
          <Avatar id={journey.ownerIdentity} size={28} />
          <div className="row-main">
            <div className="row-title">{journey.ownerIdentity}</div>
            <div className="row-sub">Lead</div>
          </div>
        </div>
        {/* Contributor rollups (docs 20 §10) — cumulative, never live: how
            many of this journey's kelabos each person has been in, and how
            many reports they have asked for. Settles when a linked kelabo
            has already ended; a still-live one is not counted yet. */}
        {contributors === null && <SkeletonRows n={1} />}
        {(contributors || []).filter(c => c.contributorIdentity !== journey.ownerIdentity).map(c => (
          <div className="row" key={c.contributorIdentity}>
            <Avatar id={c.contributorIdentity} size={28} />
            <div className="row-main">
              <div className="row-title">{c.contributorIdentity}</div>
              <div className="row-sub">
                {c.kelaboJoinCount || 0} kelabo{(c.kelaboJoinCount || 0) === 1 ? '' : 's'} joined · {c.reportRequestCount || 0} question{(c.reportRequestCount || 0) === 1 ? '' : 's'} asked
              </div>
            </div>
          </div>
        ))}
        <p className="text-meta">
          {journey.kelaboCount} linked kelabo{journey.kelaboCount === 1 ? '' : 's'} · {journey.documentCount} document{journey.documentCount === 1 ? '' : 's'} · {journey.boardMessageCount} board message{journey.boardMessageCount === 1 ? '' : 's'} · {journey.reportCount} question{journey.reportCount === 1 ? '' : 's'}
          {journey.visibility === 'private' ? ` · ${journey.accessorCount} accessor${journey.accessorCount === 1 ? '' : 's'}` : ''}
        </p>
      </div>

      {editing && (
        <EditDescriptionModal current={description} onClose={() => setEditing(false)} onSaved={saveDescription} />
      )}
      {showHistory && <DescriptionHistoryModal id={journey.journeyId} onClose={() => setShowHistory(false)} />}
      {showStatus && <StatusModal journey={journey} onClose={() => setShowStatus(false)} onSaved={saveStatus} />}
    </section>
  )
}

// --- Timeline ------------------------------------------------------------------

function timelineIcon(type) {
  if (type === 'description') return 'pencil'
  if (type === 'status') return 'check-circle'
  if (type === 'kelabo_linked') return 'link'
  if (type === 'kelabo_unlinked') return 'x-circle'
  if (type === 'board_message') return 'message-square'
  if (type === 'document') return 'file-text'
  return 'clock'
}

function TimelineTab({ journeyId, isMember, onOpenDocument }) {
  const [type, setType] = useState('')
  const [entries, setEntries] = useState(null)
  const [nextBefore, setNextBefore] = useState(undefined)
  const [loadingMore, setLoadingMore] = useState(false)

  const load = (before) => {
    api.getJourneyTimeline(journeyId, { type: type || undefined, before, limit: 30 })
      .then(d => {
        setEntries(prev => (before ? [...(prev || []), ...d.entries] : d.entries))
        setNextBefore(d.nextBefore)
      })
      .catch(() => setEntries(prev => prev || []))
      .finally(() => setLoadingMore(false))
  }

  useEffect(() => { setEntries(null); setNextBefore(undefined); load(undefined) }, [journeyId, type]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!isMember) return <div className="empty">You don't have access to this journey's timeline.</div>

  return (
    <section className="anim-in vstack-sm journey-tab">
      <div className="hstack" style={{ flexWrap: 'wrap' }}>
        {TIMELINE_TYPES.map(t => (
          <button
            key={t.id}
            type="button"
            className={'chip chip-btn' + (type === t.id ? ' is-on' : '')}
            onClick={() => setType(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {entries === null && <SkeletonRows n={4} />}
      {entries && entries.length === 0 && <div className="empty">Nothing here yet.</div>}
      {entries && annotateDays(entries, e => e.at).map(({ item: e, divider }, i) => {
        // Link straight to the kelabo, routed by its status snapshot at the
        // time of this event (kelaboHref, above) rather than always
        // /kelabos/:id — that shape only ever resolves once archived, so a
        // still-live/scheduled one used to 404 there.
        // A document has no page of its own, so its click instead switches
        // to the Documents tab and opens that document inline there.
        const kelaboId = (e.type === 'kelabo_linked' || e.type === 'kelabo_unlinked') ? e.detail?.kelaboId : null
        const docId = e.type === 'document' ? e.detail?.docId : null
        const RowTag = kelaboId ? Link : 'div'
        const rowProps = kelaboId
          ? { to: kelaboHref(kelaboId, e.detail?.statusSnapshot) }
          : docId
            ? { onClick: () => onOpenDocument(docId), style: { cursor: 'pointer' } }
            : {}
        return (
          <Fragment key={`${e.at}-${i}`}>
            {divider && <div className="day-divider" role="separator">{divider}</div>}
            <RowTag className="row" {...rowProps}>
              <Icon name={timelineIcon(e.type)} size={15} className="kind-icon" />
              <div className="row-main">
                <div className="row-title">{e.summary}</div>
                <div className="row-sub">{e.actor}</div>
              </div>
              <span className="row-meta" title={fmtFullAt(e.at)}>{fmtTime(e.at)}</span>
            </RowTag>
          </Fragment>
        )
      })}
      {nextBefore !== undefined && (
        <div className="action-row action-row-start">
          <Button size="sm" disabled={loadingMore} onClick={() => { setLoadingMore(true); load(nextBefore) }}>
            {loadingMore ? 'Loading…' : 'Load earlier'}
          </Button>
        </div>
      )}
    </section>
  )
}

// --- Kelabos ---------------------------------------------------------------

function AddKelaboModal({ onClose, onPick }) {
  const { kelabos, records, scheduled } = useAppData()
  const [q, setQ] = useState('')
  const candidates = [
    ...(kelabos || []).map(m => ({ id: m.kelaboId, title: m.title, note: 'live' })),
    ...(scheduled || []).map(m => ({ id: m.kelaboId, title: m.title, note: 'scheduled' })),
    ...(records || []).map(r => ({ id: r.archiveId || r.kelaboId, title: r.title, note: 'ended' })),
  ]
  const filtered = q.trim()
    ? candidates.filter(c => c.title?.toLowerCase().includes(q.trim().toLowerCase()))
    : candidates

  return (
    <Modal
      open
      onDismiss={onClose}
      label="Add a kelabo"
      title="Add a kelabo"
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
      <p className="text-meta">Only kelabos you host or participate in can be linked.</p>
      <div className="vstack-sm" style={{ maxHeight: 320, overflowY: 'auto' }}>
        {filtered.length === 0 && <div className="empty">No matching kelabos.</div>}
        {filtered.map(c => (
          <button key={c.id} type="button" className="row row-static" onClick={() => onPick(c.id)} style={{ cursor: 'pointer', width: '100%', textAlign: 'left' }}>
            <div className="row-main">
              <div className="row-title">{c.title || 'Untitled'}</div>
              <div className="row-sub">{c.note}</div>
            </div>
          </button>
        ))}
      </div>
    </Modal>
  )
}

function KelabosTab({ journeyId, isMember, isActive }) {
  const [items, setItems] = useState(null)
  const [showAdd, setShowAdd] = useState(false)
  const confirm = useConfirm()
  const toast = useToast()

  const load = () => api.listJourneyKelabos(journeyId).then(d => setItems(d.kelabos || [])).catch(() => setItems([]))
  useEffect(() => { load() }, [journeyId]) // eslint-disable-line react-hooks/exhaustive-deps

  const pick = async kelaboId => {
    setShowAdd(false)
    try {
      await api.linkJourneyKelabo(journeyId, kelaboId)
      toast('Kelabo linked')
      load()
    } catch (e) {
      toast(e?.code === 'not_kelabo_member' ? 'You must host or participate in that kelabo' : 'Could not link that kelabo')
    }
  }

  const unlink = async k => {
    const ok = await confirm({
      title: `Unlink “${k.title}”?`,
      body: 'This only removes it from the journey — the kelabo and its record are untouched.',
      confirmLabel: 'Unlink',
      danger: false,
    })
    if (!ok) return
    try {
      await api.unlinkJourneyKelabo(journeyId, k.kelaboId)
      setItems(list => list.filter(x => x.kelaboId !== k.kelaboId))
    } catch {
      toast('Could not unlink that kelabo')
    }
  }

  return (
    <section className="anim-in vstack-sm journey-tab">
      {isMember && isActive && (
        <div className="action-row action-row-start">
          <Button onClick={() => setShowAdd(true)}><Icon name="plus" size={14} />Add a kelabo</Button>
          <Button as={Link} variant="outline" to={`/new?journeyId=${journeyId}`}>
            <Icon name="plus" size={14} />New kelabo
          </Button>
          <Button as={Link} variant="outline" to={`/schedule?journeyId=${journeyId}`}>
            <Icon name="calendar" size={14} />Schedule kelabo
          </Button>
        </div>
      )}
      {items === null && <SkeletonRows n={2} />}
      {items && items.length === 0 && <div className="empty">No kelabos linked yet.</div>}
      {(items || []).map(k => (
        <Link className="row row-removable" to={kelaboHref(k.kelaboId, k.statusSnapshot)} key={k.kelaboId}>
          <Icon name="archive" size={15} className="kind-icon" />
          <div className="row-main">
            <div className="row-title">{k.title}</div>
            <div className="row-sub">host: {k.hostIdentity} · linked by {k.linkedBy}</div>
          </div>
          <span className="row-meta">{timeAgo(k.linkedAt)}</span>
          {isMember && isActive && (
            <button
              className="remove-btn"
              onClick={e => { e.preventDefault(); e.stopPropagation(); unlink(k) }}
              title={`Unlink ${k.title}`}
              aria-label={`Unlink ${k.title}`}
            >
              <Icon name="x" size={15} />
            </button>
          )}
        </Link>
      ))}
      {showAdd && <AddKelaboModal onClose={() => setShowAdd(false)} onPick={pick} />}
    </section>
  )
}

// --- Board -------------------------------------------------------------------

function BoardMessageModal({ initial, onClose, onSave }) {
  const [content, setContent] = useState(initial || '')
  const [saving, setSaving] = useState(false)
  const toast = useToast()
  const submit = async e => {
    e?.preventDefault()
    if (saving || !content.trim()) return
    setSaving(true)
    try { await onSave(content.trim()); onClose() } catch { setSaving(false); toast('Could not save that message') }
  }
  return (
    <Modal
      open
      onDismiss={onClose}
      label={initial ? 'Edit message' : 'Add message'}
      as="form"
      onSubmit={submit}
      badge={<span className="modal-icon modal-icon-neutral"><Icon name="message-square" /></span>}
      title={initial ? 'Edit message' : 'Add message'}
      actions={
        <>
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={saving || !content.trim()}>{saving ? 'Saving…' : 'Save'}</Button>
        </>
      }
    >
      <textarea className="input" rows={4} maxLength={4000} autoFocus value={content} onChange={e => setContent(e.target.value)} />
    </Modal>
  )
}

function BoardMessageHistoryModal({ journeyId, msgId, onClose }) {
  const [versions, setVersions] = useState(null)
  useEffect(() => { api.getJourneyBoardMessageHistory(journeyId, msgId).then(d => setVersions(d.versions || [])).catch(() => setVersions([])) }, [journeyId, msgId])
  return (
    <Modal open onDismiss={onClose} label="Message history" title="Message history"
      badge={<span className="modal-icon modal-icon-neutral"><Icon name="clock" /></span>}
      actions={<Button variant="primary" onClick={onClose}>Close</Button>}>
      {versions === null && <SkeletonRows n={2} />}
      <div className="vstack-sm">
        {(versions || []).map(v => (
          <div className="section-block" key={v.version}>
            <div className="text-meta">v{v.version} · {v.action} · {v.actor} · {fmtFullAt(v.at)}</div>
            <p className="min-summary">{v.content}</p>
          </div>
        ))}
      </div>
    </Modal>
  )
}

function BoardTab({ journeyId, isMember, isActive, isOwner }) {
  const [items, setItems] = useState(null)
  const [showAdd, setShowAdd] = useState(false)
  const [editing, setEditing] = useState(null)
  const [historyFor, setHistoryFor] = useState(null)
  // Archived messages are hidden by default (they are no longer important,
  // not outstanding — but never erased) and revealed here on demand.
  const [showArchived, setShowArchived] = useState(false)
  const { identity } = useAuth()
  const toast = useToast()

  const load = () => api.listJourneyBoard(journeyId).then(d => setItems(d.messages || [])).catch(() => setItems([]))
  useEffect(() => { load() }, [journeyId]) // eslint-disable-line react-hooks/exhaustive-deps

  const add = async content => { await api.addJourneyBoardMessage(journeyId, content); toast('Message added'); load() }
  const edit = async content => { await api.editJourneyBoardMessage(journeyId, editing.msgId, content); toast('Message updated'); load() }
  // Reversible and low-stakes, so no confirmation dialog — Unarchive is one
  // click away on the same row once revealed.
  const archive = async m => {
    try { await api.archiveJourneyBoardMessage(journeyId, m.msgId); toast('Message archived'); load() } catch { toast('Could not archive that message') }
  }
  const unarchive = async m => {
    try { await api.unarchiveJourneyBoardMessage(journeyId, m.msgId); toast('Message unarchived'); load() } catch { toast('Could not unarchive that message') }
  }

  const active = (items || []).filter(m => !m.archived)
  const archived = (items || []).filter(m => m.archived)

  // Archiving is narrower than the general write access every member has:
  // only the message's own poster or the journey's lead may archive it.
  const canArchive = m => identity?.email === m.createdBy || isOwner

  const renderRow = m => (
    <div className={'con' + (m.archived ? ' con-skipped' : '')} data-kind="note" key={m.msgId}>
      <div className="con-head">
        <span className="con-mark"><Icon name="message-square" size={14} /></span>
        <span className="con-title">{m.content}</span>
      </div>
      <div className="con-sub">
        <span title={fmtFullAt(m.updatedAt || m.createdAt)}>{m.createdBy}{m.updatedBy ? ` (edited by ${m.updatedBy})` : ''} · {timeAgo(m.updatedAt || m.createdAt)}</span>
      </div>
      {isMember && (
        <div className="hstack">
          <Button size="sm" onClick={() => setHistoryFor(m.msgId)}>History</Button>
          {isActive && !m.archived && (
            <>
              <Button size="sm" onClick={() => setEditing(m)}>Edit</Button>
              {canArchive(m) && <Button size="sm" variant="danger-ghost" onClick={() => archive(m)}>Archive</Button>}
            </>
          )}
          {isActive && m.archived && (
            <Button size="sm" onClick={() => unarchive(m)}><Icon name="rotate-ccw" size={13} />Unarchive</Button>
          )}
        </div>
      )}
    </div>
  )

  return (
    <section className="anim-in vstack-sm journey-tab">
      {isMember && isActive && (
        <div className="action-row action-row-start">
          <Button onClick={() => setShowAdd(true)}><Icon name="plus" size={14} />Add message</Button>
        </div>
      )}
      {items === null && <SkeletonRows n={2} />}
      {items && items.length === 0 && <div className="empty">No pinned messages yet.</div>}
      {active.map(renderRow)}
      {archived.length > 0 && (
        <div className="action-row action-row-start">
          <Button size="sm" variant="ghost" onClick={() => setShowArchived(v => !v)}>
            <Icon name={showArchived ? 'chevron-down' : 'chevron-right'} size={13} />
            {showArchived ? 'Hide' : 'Show'} archived ({archived.length})
          </Button>
        </div>
      )}
      {showArchived && archived.map(renderRow)}
      {showAdd && <BoardMessageModal onClose={() => setShowAdd(false)} onSave={add} />}
      {editing && <BoardMessageModal initial={editing.content} onClose={() => setEditing(null)} onSave={edit} />}
      {historyFor && <BoardMessageHistoryModal journeyId={journeyId} msgId={historyFor} onClose={() => setHistoryFor(null)} />}
    </section>
  )
}

// --- Documents ---------------------------------------------------------------

function AddDocumentModal({ onClose, onSave }) {
  const [title, setTitle] = useState('')
  const [content, setContent] = useState('')
  const [saving, setSaving] = useState(false)
  const toast = useToast()
  const submit = async e => {
    e?.preventDefault()
    if (saving || !title.trim() || !content.trim()) return
    setSaving(true)
    try { await onSave(title.trim(), content); onClose() } catch { setSaving(false); toast('Could not save that document') }
  }
  return (
    <Modal
      open onDismiss={onClose} label="Add document" as="form" onSubmit={submit}
      badge={<span className="modal-icon modal-icon-neutral"><Icon name="file-text" /></span>}
      title="Add document"
      actions={
        <>
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={saving || !title.trim() || !content.trim()}>{saving ? 'Saving…' : 'Add'}</Button>
        </>
      }
    >
      <div className="field form-stack">
        <label className="label" htmlFor="d-title">Title</label>
        <input id="d-title" className="input" maxLength={160} autoFocus value={title} onChange={e => setTitle(e.target.value)} />
      </div>
      <div className="field form-stack">
        <label className="label" htmlFor="d-content">Text</label>
        <textarea id="d-content" className="input" rows={8} value={content} onChange={e => setContent(e.target.value)} />
      </div>
      <p className="text-meta">Pasted text only — no file upload. Once added, this can be removed but never edited.</p>
    </Modal>
  )
}

function DocumentsTab({ journeyId, isMember, isActive, isOwner, initialOpenDocId }) {
  const [items, setItems] = useState(null)
  const [showAdd, setShowAdd] = useState(false)
  // Seeded from a Timeline click-through (docs 20 §9), if that's how this
  // tab got mounted — safe as a plain useState initializer because this
  // component unmounts and remounts fresh on every tab switch (it never
  // receives a changed prop while already mounted).
  const [open, setOpen] = useState(initialOpenDocId || null)
  // Removed documents are hidden by default (gone from future report/agent
  // context, but never erased from the record) and revealed here on
  // demand — same pattern as the Board tab's archived-messages toggle.
  const [showRemoved, setShowRemoved] = useState(false)
  const { identity } = useAuth()
  const confirm = useConfirm()
  const toast = useToast()

  const load = () => api.listJourneyDocuments(journeyId).then(d => setItems(d.documents || [])).catch(() => setItems([]))
  useEffect(() => { load() }, [journeyId]) // eslint-disable-line react-hooks/exhaustive-deps

  const add = async (title, content) => { await api.addJourneyDocument(journeyId, { title, content }); toast('Document added'); load() }
  const remove = async d => {
    const ok = await confirm({ title: `Remove “${d.title}”?`, body: 'This cannot be undone, and the removed document can no longer be edited.', confirmLabel: 'Remove' })
    if (!ok) return
    try { await api.removeJourneyDocument(journeyId, d.docId); load() } catch { toast('Could not remove that document') }
  }

  const active = (items || []).filter(d => !d.removed)
  const removed = (items || []).filter(d => d.removed)
  // Removal is narrower than the general write access every member has:
  // only the document's own poster or the journey's lead may remove it.
  const canRemove = d => identity?.email === d.addedBy || isOwner

  const renderRow = d => (
    <div className="row row-removable" key={d.docId} onClick={() => setOpen(open === d.docId ? null : d.docId)} style={{ cursor: 'pointer' }}>
      <Icon name="file-text" size={15} className="kind-icon" />
      <div className="row-main">
        <div className="row-title">
          {d.title}
          {d.removed && <span className="chip chip-ended">removed</span>}
        </div>
        <div className="row-sub">
          {d.addedBy} · {(d.sizeBytes / 1024).toFixed(1)} KB
          {open === d.docId && <div style={{ marginTop: 6 }}><Markdown text={d.content} hardBreaks /></div>}
        </div>
      </div>
      <span className="row-meta">{timeAgo(d.addedAt)}</span>
      {isMember && isActive && !d.removed && canRemove(d) && (
        <button className="remove-btn" onClick={e => { e.stopPropagation(); remove(d) }} title={`Remove ${d.title}`} aria-label={`Remove ${d.title}`}>
          <Icon name="x" size={15} />
        </button>
      )}
    </div>
  )

  return (
    <section className="anim-in vstack-sm journey-tab">
      {isMember && isActive && (
        <div className="action-row action-row-start">
          <Button onClick={() => setShowAdd(true)}><Icon name="plus" size={14} />Add document</Button>
        </div>
      )}
      {items === null && <SkeletonRows n={2} />}
      {items && items.length === 0 && <div className="empty">No documents yet.</div>}
      {active.map(renderRow)}
      {removed.length > 0 && (
        <div className="action-row action-row-start">
          <Button size="sm" variant="ghost" onClick={() => setShowRemoved(v => !v)}>
            <Icon name={showRemoved ? 'chevron-down' : 'chevron-right'} size={13} />
            {showRemoved ? 'Hide' : 'Show'} removed ({removed.length})
          </Button>
        </div>
      )}
      {showRemoved && removed.map(renderRow)}
      {showAdd && <AddDocumentModal onClose={() => setShowAdd(false)} onSave={add} />}
    </section>
  )
}

// --- Reports (docs 20 §6) ----------------------------------------------------

function AskModal({ onClose, onAsk }) {
  const [question, setQuestion] = useState('')
  const [isPrivate, setIsPrivate] = useState(false)
  const [asking, setAsking] = useState(false)
  const toast = useToast()
  const submit = async e => {
    e?.preventDefault()
    if (asking || !question.trim()) return
    setAsking(true)
    try { await onAsk(question.trim(), isPrivate ? 'private' : 'public'); onClose() } catch { setAsking(false); toast('Could not ask that question') }
  }
  return (
    <Modal
      open onDismiss={onClose} label="Ask a question" as="form" onSubmit={submit}
      badge={<span className="modal-icon modal-icon-neutral"><Icon name="help" /></span>}
      title="Ask a question"
      actions={
        <>
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={asking || !question.trim()}>{asking ? 'Asking…' : 'Ask'}</Button>
        </>
      }
    >
      <textarea
        className="input" rows={3} maxLength={2000} autoFocus
        placeholder="What's the status of the redesign, and what's still blocking it?"
        value={question} onChange={e => setQuestion(e.target.value)}
      />
      <div className="settings-row settings-row-plain">
        <div className="sr-main">
          <div className="sr-title">Only me</div>
          <div className="sr-sub">
            Keeps the question and its answer to you — not the other members, not the journey's lead. The
            timeline records that you asked something, never what.
          </div>
        </div>
        <Switch checked={isPrivate} onChange={setIsPrivate} ariaLabel="Only me" />
      </div>
      <p className="text-meta">
        Answered from everything already in this journey — its description, pinned messages, documents, and the
        minutes of every linked kelabo.
      </p>
    </Modal>
  )
}

function ReportRow({ r }) {
  const [open, setOpen] = useState(false)
  const pending = r.status === 'pending'

  // The whole card toggles, not just its first line. `.con` has carried
  // `cursor: pointer` since it was written, but the handler sat on `.con-head`
  // alone — so the asker/date line, and the padding around everything,
  // advertised a click that did nothing.
  //
  // Clicks originating inside the expanded body are left alone: selecting a
  // sentence of the answer or following a link in it must not collapse the
  // card out from under the pointer.
  const toggle = e => {
    if (pending) return
    if (e.target.closest?.('.con-body')) return
    setOpen(o => !o)
  }

  return (
    <div
      className={'con' + (open ? ' open' : '') + (r.status === 'failed' ? ' con-skipped' : '')}
      data-kind="answer"
      onClick={toggle}
      style={pending ? { cursor: 'default' } : undefined}
      role={pending ? undefined : 'button'}
      tabIndex={pending ? undefined : 0}
      aria-expanded={pending ? undefined : open}
      onKeyDown={e => {
        if (pending || (e.key !== 'Enter' && e.key !== ' ')) return
        e.preventDefault()
        setOpen(o => !o)
      }}
    >
      <div className="con-head">
        {pending
          ? <span className="con-spinner" aria-hidden="true"></span>
          : <span className="con-mark"><Icon name={r.status === 'failed' ? 'x-circle' : 'sparkles'} size={14} /></span>}
        <span className="con-title">{r.question}</span>
        {!pending && <span className="con-caret"><Icon name="chevron-right" size={13} /></span>}
      </div>
      <div className="con-sub">
        <span title={fmtFullAt(r.requestedAt)}>{r.requestedBy} · {timeAgo(r.requestedAt)}</span>
        {r.visibility === 'private' && <span className="chip chip-sm">Only me</span>}
      </div>
      {pending && <div className="con-progress">Generating…</div>}
      {r.status === 'failed' && <div className="con-reason">Could not answer this question ({r.error || 'unknown error'}).</div>}
      {open && r.status === 'ready' && (
        <div className="con-body"><Markdown text={r.answer} /></div>
      )}
    </div>
  )
}

function ReportsTab({ journeyId, isMember, isActive }) {
  const [reports, setReports] = useState(null)
  const [showAsk, setShowAsk] = useState(false)
  const toast = useToast()

  const load = () => api.listJourneyReports(journeyId).then(d => setReports(d.reports || [])).catch(() => setReports([]))
  useEffect(() => { load() }, [journeyId]) // eslint-disable-line react-hooks/exhaustive-deps

  // Poll while any report is still pending — the same "minutes are
  // generating, check back" pattern RecordDetail.jsx already uses.
  useEffect(() => {
    if (!reports?.some(r => r.status === 'pending')) return undefined
    const t = setInterval(load, 3000) // eslint-disable-line react-hooks/exhaustive-deps
    return () => clearInterval(t)
  }, [reports, journeyId]) // eslint-disable-line react-hooks/exhaustive-deps

  const ask = async (question, visibility) => {
    const res = await api.requestJourneyReport(journeyId, question, visibility)
    setReports(list => [{ reportId: res.reportId, question, requestedBy: '…', requestedAt: Date.now(), status: 'pending', visibility }, ...(list || [])])
    toast(visibility === 'private' ? 'Question asked — only you will see it' : 'Question asked')
    load()
  }

  return (
    <section className="anim-in vstack-sm journey-tab">
      {isMember && isActive && (
        <div className="action-row action-row-start">
          <Button onClick={() => setShowAsk(true)}><Icon name="help" size={14} />Ask a question</Button>
        </div>
      )}
      {reports === null && <SkeletonRows n={2} />}
      {reports && reports.length === 0 && <div className="empty">No questions yet — ask one about this journey and the answer will appear here.</div>}
      {(reports || []).map(r => <ReportRow key={r.reportId} r={r} />)}
      {showAsk && <AskModal onClose={() => setShowAsk(false)} onAsk={ask} />}
    </section>
  )
}

// --- Journey chrome (avatar, status actions, delete) ------------------------

// Same generated-identicon re-roll as the personal avatar in Settings.jsx —
// no upload, a client-chosen salt the owner may change (docs 20 §13).
function AvatarReroll({ journey, onSaved }) {
  const roll = async () => {
    let v = journey.avatarVariant
    while (v === journey.avatarVariant) v = 1 + Math.floor(Math.random() * 9998)
    await onSaved({ avatarVariant: v })
  }
  return (
    <div className="hstack">
      <Avatar id={journey.journeyId} variant={journey.avatarVariant} size={48} />
      <Button size="sm" onClick={roll} title="Re-roll the avatar">
        <Icon name="sparkles" size={14} />
      </Button>
    </div>
  )
}

// --- Helm ----------------------------------------------------------------------

/**
 * The lead's controls, in one place: identity (name, avatar), who can see it
 * (visibility + the accessor roster, which used to be a tab of its own),
 * what the assistant may do, and the two lifecycle actions.
 *
 * Rendered only for the owner — a member cannot act on any of it, and a tab
 * of disabled controls teaches nobody anything. What a member does need to
 * know (assistant posting is on) stays disclosed on Overview.
 */
function HelmTab({ journey, isActive, accessors, onRename, onSaveAvatar, onComplete, onReopen, onDelete, onAddAccessor, onRemoveAccessor, reload }) {
  const toast = useToast()

  const patch = async (body, ok, fail) => {
    try {
      await api.patchJourney(journey.journeyId, body)
      await reload()
      toast(ok)
    } catch {
      toast(fail)
    }
  }

  return (
    <section className="anim-in vstack-lg journey-tab">
      <div className="section-block">
        <div className="section-title">Journey</div>
        <div className="settings-row settings-row-plain">
          <div className="sr-main">
            <div className="sr-title">Name</div>
            <div className="sr-sub">{journey.title}</div>
          </div>
          <Button size="sm" onClick={onRename} disabled={!isActive}>
            <Icon name="pencil" size={14} />Rename
          </Button>
        </div>
        <div className="settings-row settings-row-plain">
          <div className="sr-main">
            <div className="sr-title">Avatar</div>
            <div className="sr-sub">Generated from the journey's id — re-roll for a different one.</div>
          </div>
          {isActive
            ? <AvatarReroll journey={journey} onSaved={onSaveAvatar} />
            : <Avatar id={journey.journeyId} variant={journey.avatarVariant} size={48} />}
        </div>
      </div>

      <div className="section-block">
        <div className="section-title">Who can see it</div>
        <div className="settings-row settings-row-plain">
          <div className="sr-main">
            <div className="sr-title">Private journey</div>
            <div className="sr-sub">
              {journey.visibility === 'private'
                ? 'Only you and the accessors below. Off, everyone at your organisation can see it.'
                : 'Everyone at your organisation can see this journey. On, only you and the accessors you name.'}
            </div>
          </div>
          <Switch
            checked={journey.visibility === 'private'}
            onChange={v => patch({ visibility: v ? 'private' : 'public' }, v ? 'Journey is now private' : 'Journey is now visible to your organisation', 'Could not change visibility')}
            disabled={!isActive}
            ariaLabel="Private journey"
          />
        </div>

        {journey.visibility === 'private' && (
          <>
            <div className="action-row action-row-start">
              <Button size="sm" onClick={onAddAccessor} disabled={!isActive}>
                <Icon name="user-plus" size={14} />Add accessor
              </Button>
            </div>
            {accessors === null && <SkeletonRows n={2} />}
            {accessors && accessors.length === 0 && <div className="empty">No accessors yet — only you can see this journey.</div>}
            {(accessors || []).map(a => (
              <div className="row row-removable" key={a.identity}>
                <Avatar id={a.identity} size={28} />
                <div className="row-main">
                  <div className="row-title">{a.identity}</div>
                  <div className="row-sub">added by {a.addedBy}</div>
                </div>
                <span className="row-meta">{timeAgo(a.addedAt)}</span>
                {isActive && (
                  <button className="remove-btn" onClick={() => onRemoveAccessor(a)} title={`Remove ${a.identity}`} aria-label={`Remove ${a.identity}`}>
                    <Icon name="x" size={15} />
                  </button>
                )}
              </div>
            ))}
          </>
        )}
      </div>

      <div className="section-block">
        <div className="section-title">Assistant</div>
        <div className="settings-row settings-row-plain">
          <div className="sr-main">
            <div className="sr-title">Assistant can post to the board</div>
            <div className="sr-sub">
              Lets an attached assistant pin its own board messages — the outcome of work it finished.
              Everyone who can see this journey is shown whether it is on.
            </div>
          </div>
          <Switch
            checked={!!journey.aiCanPost}
            onChange={v => patch({ aiCanPost: v }, v ? 'Assistant posting turned on' : 'Assistant posting turned off', 'Could not change assistant posting')}
            disabled={!isActive}
            ariaLabel="Assistant can post to the board"
          />
        </div>
      </div>

      <div className="section-block">
        <div className="section-title">Lifecycle</div>
        <div className="settings-row settings-row-plain">
          <div className="sr-main">
            <div className="sr-title">{isActive ? 'Mark complete' : 'Reopen'}</div>
            <div className="sr-sub">
              {isActive
                ? 'Freezes the journey: no further edits, kelabo links, board messages or documents until it is reopened.'
                : 'This journey is complete and frozen. Reopening allows edits again.'}
            </div>
          </div>
          {isActive
            ? <Button variant="outline" onClick={onComplete}><Icon name="check-circle" size={14} />Mark complete</Button>
            : <Button variant="outline" onClick={onReopen}><Icon name="rotate-ccw" size={14} />Reopen</Button>}
        </div>
        <div className="settings-row settings-row-plain">
          <div className="sr-main">
            <div className="sr-title">Delete journey</div>
            <div className="sr-sub">
              Permanently removes the description history, questions, board and documents. Linked kelabos are
              untouched.
            </div>
          </div>
          <Button variant="danger-ghost" onClick={onDelete}><Icon name="x" size={14} />Delete</Button>
        </div>
      </div>

      {/* Null in this build (see variant.js): a deployment that bills for the
          journey's AI puts what it costs here, beside the controls that spend
          it, rather than forking this page to add a panel. */}
      {JourneyHelmExtra ? <JourneyHelmExtra journey={journey} reload={reload} /> : null}
    </section>
  )
}

export default function JourneyDetail() {
  const { id } = useParams()
  const navigate = useNavigate()
  const confirm = useConfirm()
  const prompt = usePrompt()
  const toast = useToast()

  const [journey, setJourney] = useState(null)
  const [error, setError] = useState(null)
  const [tab, setTab] = useState('chat')
  const [accessors, setAccessors] = useState(null)
  // A Timeline "document" entry switches to the Documents tab and opens
  // that document there (documents have no page of their own to link to).
  // Cleared right after the switch, not on some later user action: it only
  // needs to be correct at the instant DocumentsTab mounts and reads it as
  // its own initial state (see DocumentsTab's own comment) — leaving it set
  // would re-open the same document every time the user returns to this
  // tab by any other route.
  const [focusDocId, setFocusDocId] = useState(null)
  const openDocument = docId => { setFocusDocId(docId); setTab('documents') }
  useEffect(() => {
    if (tab === 'documents' && focusDocId) setFocusDocId(null)
  }, [tab]) // eslint-disable-line react-hooks/exhaustive-deps

  const reload = () => api.getJourney(id).then(setJourney).catch(e => setError(e.status === 403 || e.status === 401 ? 'forbidden' : e.status === 404 ? 'not_found' : 'error'))
  useEffect(() => { reload() }, [id]) // eslint-disable-line react-hooks/exhaustive-deps

  // Declared before the thread poll below, which reads `isMember` in its
  // dependency array — a `const` referenced above its declaration is a
  // temporal-dead-zone throw during render, not an undefined.
  const isOwner = journey?.myRole === 'owner'
  const isMember = !!journey?.myRole
  const isActive = journey?.status === 'active'

  // The thread list lives here rather than in the Threads tab, because the
  // tab needs a badge while you are looking at a *different* one (docs 20
  // §19.3) — a list fetched by that component would only exist once you had
  // already navigated to it, which is exactly too late to tell you to.
  //
  // It also means one poll per journey page instead of one per tab visit.
  const [threads, setThreads] = useState(null)
  const reloadThreads = useCallback(
    () => journeyChat.threads(id).then(d => { setThreads(d.threads || []); return d.threads || [] }),
    [id]
  )
  useEffect(() => {
    if (!isMember) return undefined
    const load = () => { if (!document.hidden) reloadThreads().catch(() => {}) }
    load()
    const t = setInterval(load, THREADS_POLL_MS)
    document.addEventListener('visibilitychange', load)
    return () => {
      clearInterval(t)
      document.removeEventListener('visibilitychange', load)
    }
  }, [reloadThreads, isMember]) // eslint-disable-line react-hooks/exhaustive-deps

  const threadUnread = useMemo(
    () => (threads || []).reduce(
      (acc, t) => ({ unread: acc.unread + (t.unread || 0), mentions: acc.mentions + (t.mentions || 0) }),
      { unread: 0, mentions: 0 }
    ),
    [threads]
  )

  useEffect(() => {
    if (journey?.visibility === 'private') api.listJourneyAccessors(id).then(d => setAccessors(d.accessors || [])).catch(() => setAccessors([]))
  }, [id, journey?.visibility])

  const complete = async () => {
    const ok = await confirm({ title: 'Mark this journey complete?', body: 'No further edits, kelabo links, board messages or documents until it is reopened.', confirmLabel: 'Mark complete', danger: false })
    if (!ok) return
    try { await api.completeJourney(id); reload(); toast('Journey marked complete') } catch { toast('Could not complete the journey') }
  }
  const reopen = async () => {
    try { await api.reopenJourney(id); reload(); toast('Journey reopened') } catch { toast('Could not reopen the journey') }
  }
  const remove = async () => {
    const ok = await confirm({ title: `Delete “${journey.title}”?`, body: 'This permanently removes the journey — its description history, questions, board and documents. Linked kelabos are untouched.', confirmLabel: 'Delete permanently' })
    if (!ok) return
    try { await api.deleteJourney(id); toast('Journey deleted'); navigate('/journeys', { replace: true }) } catch { toast('Could not delete the journey') }
  }
  const rename = async () => {
    const v = await prompt({ title: 'Rename journey', initialValue: journey.title, confirmLabel: 'Rename' })
    if (!v) return
    try { await api.patchJourney(id, { title: v }); reload() } catch { toast('Could not rename the journey') }
  }
  const saveAvatar = async body => { await api.patchJourney(id, body); reload() }

  const addAccessor = async () => {
    const email = await prompt({ title: 'Add an accessor', placeholder: 'name@example.com', confirmLabel: 'Add' })
    if (!email) return
    try {
      await api.addJourneyAccessor(id, email.trim())
      const d = await api.listJourneyAccessors(id)
      setAccessors(d.accessors || [])
      reload()
    } catch { toast('Could not add that accessor') }
  }
  const removeAccessor = async a => {
    try {
      await api.removeJourneyAccessor(id, a.identity)
      setAccessors(list => list.filter(x => x.identity !== a.identity))
      reload()
    } catch { toast('Could not remove that accessor') }
  }

  return (
    /* The channel is the one tab whose body must fill the remaining height
       rather than flow: a message list that grows the page scrollbar puts the
       composer below the fold and the newest message off-screen. Everything
       else keeps the ordinary block-flow page. */
    <main className={'page' + (tab === 'chat' ? ' page-channel' : '')}>
      {journey === null && !error && (
        <>
          <Skeleton className="skel-title" />
          <SkeletonRows n={4} />
        </>
      )}

      {error && (
        <Banner kind={error === 'forbidden' ? 'danger' : 'warn'}>
          {error === 'forbidden' && 'This journey is only visible to its lead, its accessors, or your tenant if it is public.'}
          {error === 'not_found' && "This journey doesn't exist — it may have been deleted."}
          {error === 'error' && "Couldn't load this journey — check your connection and reload."}
        </Banner>
      )}

      {journey && (
        <>
          <Crumbs className="crumbs-head" to="/journeys" backLabel="Journeys" here={journey.title} />

          {/* Rename, the avatar re-roll, complete/delete and the accessor
              roster all used to live out here or in a tab of their own. They
              are at the Helm now; this is identity and state only. */}
          <div className="title-row">
            <Avatar id={journey.journeyId} variant={journey.avatarVariant} size={48} />
            <h1 className="page-title">{journey.title}</h1>
            <span className={'chip' + (journey.status === 'completed' ? ' chip-ended' : ' chip-live')}>{journey.status}</span>
            <span className="chip">{journey.visibility}</span>
            <JourneyHealthChip health={journey.health} />
          </div>
          <p className="page-sub">
            Lead: {journey.ownerIdentity} · {journey.kelaboCount} kelabo{journey.kelaboCount === 1 ? '' : 's'}
            {typeof journey.progress === 'number' ? ` · ${journey.progress}% complete` : ''}
          </p>

          {!isMember && (
            <Banner kind="warn">You can view this journey but are not a member — some actions are unavailable.</Banner>
          )}

          <Tabs
            tabs={(isOwner ? [...TABS, HELM_TAB] : TABS).map(t =>
              t.id === 'chat'
                ? { ...t, badge: threadUnread.mentions || threadUnread.unread, mention: threadUnread.mentions > 0 }
                : t
            )}
            active={tab}
            onChange={setTab}
          />

          {tab === 'chat' && (
            <JourneyThreads
              journeyId={id}
              isMember={isMember}
              isActive={isActive}
              threads={threads}
              reloadThreads={reloadThreads}
            />
          )}
          {tab === 'overview' && <OverviewTab journey={journey} isOwner={isOwner} isMember={isMember} reload={reload} />}
          {tab === 'timeline' && <TimelineTab journeyId={id} isMember={isMember} onOpenDocument={openDocument} />}
          {tab === 'kelabos' && <KelabosTab journeyId={id} isMember={isMember} isActive={isActive} />}
          {tab === 'reports' && <ReportsTab journeyId={id} isMember={isMember} isActive={isActive} />}
          {tab === 'board' && <BoardTab journeyId={id} isMember={isMember} isActive={isActive} isOwner={isOwner} />}
          {tab === 'documents' && <DocumentsTab journeyId={id} isMember={isMember} isActive={isActive} isOwner={isOwner} initialOpenDocId={focusDocId} />}
          {tab === 'helm' && isOwner && (
            <HelmTab
              journey={journey}
              isActive={isActive}
              accessors={accessors}
              onRename={rename}
              onSaveAvatar={saveAvatar}
              onComplete={complete}
              onReopen={reopen}
              onDelete={remove}
              onAddAccessor={addAccessor}
              onRemoveAccessor={removeAccessor}
              reload={reload}
            />
          )}
        </>
      )}
    </main>
  )
}
