import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { api } from '../api'
import { Button } from '../components/ui/Button'
import { Banner } from '../components/ui/Banner'
import { Icon } from '../components/ui/Icon'
import { Avatar } from '../components/ui/Avatar'
import { SkeletonRows } from '../components/ui/Skeleton'
import { DateTimePicker } from '../components/DateTimePicker'
import { EmailPicker } from '../components/EmailPicker'
import { useToast } from '../components/Toaster'
import { useConfirm } from '../components/ConfirmDialog'
import { useAuth, displayName } from '../auth'

/**
 * One scheduled kelabo, from the host's side: the link to share, who has
 * replied, and the button that turns it into a live kelabo.
 *
 * "Start now" is available whatever the clock says. A scheduled time is an
 * intention, not a lock — kelabos start early, and a host staring at a
 * disabled button because it is 13:58 is a worse outcome than one starting two
 * minutes early.
 */

const RESPONSE = {
  accepted: { label: 'Coming', icon: 'check', cls: 'yes' },
  declined: { label: "Can't make it", icon: 'x', cls: 'no' },
  pending: { label: 'No reply yet', icon: 'chevron-right', cls: 'pending' },
}

function whenText(at, minutes) {
  if (!at) return ''
  const d = new Date(at)
  const date = d.toLocaleString([], {
    weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit',
  })
  return minutes ? `${date} · ${minutes} min` : date
}

export default function ScheduledKelabo() {
  const { id } = useParams()
  const toast = useToast()
  const confirm = useConfirm()
  const navigate = useNavigate()
  const { identity } = useAuth()
  const [kelabo, setKelabo] = useState(null)
  const [state, setState] = useState('loading') // loading | ready | invalid
  const [starting, setStarting] = useState(false)
  const [editing, setEditing] = useState(false)
  const [busy, setBusy] = useState(false)
  // Reschedule form state, seeded from the kelabo when the panel opens.
  const [rAt, setRAt] = useState(null)
  const [rDuration, setRDuration] = useState(30)
  const [rTitle, setRTitle] = useState('')
  const [rNote, setRNote] = useState('')
  // Invitees form state — a separate panel from Reschedule, same reasoning
  // as the two being separate routes server-side: changing who is coming and
  // changing when it is are different questions with different blast radius.
  const [editingInvitees, setEditingInvitees] = useState(false)
  const [invitees, setInvitees] = useState([])

  // Polled, not fetched once: this is where the starting-soon prompt (notes #9)
  // sends everyone, so an invitee is often sitting on this page at the moment
  // the host presses Start. Without a reload their side stays "scheduled" and
  // the Join button they are waiting for never appears.
  useEffect(() => {
    let cancelled = false
    let timer = null
    const load = () => {
      api.getScheduled(id)
        .then(m => {
          if (cancelled) return
          setKelabo(m)
          setState('ready')
          // Nothing else changes on its own — a cancelled or ended kelabo is
          // where this stops, and so does the timer.
          if (m.status !== 'scheduled') { clearInterval(timer); timer = null }
        })
        .catch(() => { if (!cancelled) setState('invalid') })
    }
    load()
    timer = setInterval(load, 5000)
    return () => { cancelled = true; if (timer) clearInterval(timer) }
  }, [id])

  const copy = async () => {
    try { await navigator.clipboard.writeText(kelabo.inviteUrl) } catch {}
    toast('Invitation link copied')
  }

  const start = async () => {
    setStarting(true)
    try {
      const res = await api.startScheduled(id)
      // Starting the kelabo is not the same as joining it: joining is what
      // mints the participant cookie every in-room call (stt-token, board,
      // caption/replies) authenticates with. Without this the host lands in
      // the room with no cookie and every one of those calls is a 401 — the
      // create path (NewKelabo) has always joined here, the scheduled path
      // did not. Same name resolution as NewKelabo: the locally-set name is
      // the user's own choice and wins over the email local-part.
      const name = localStorage.getItem('kelabo-name') || displayName(identity) || 'Host'
      try {
        await api.joinKelabo(res.kelaboId, name, 'audio-board')
        localStorage.setItem('kelabo-mode', 'audio-board')
      } catch {}
      navigate(`/m/${res.kelaboId}`)
    } catch (e) {
      setStarting(false)
      if (e?.code === 'kelabo_cancelled') toast('This kelabo was cancelled')
      else toast('Could not start the kelabo — try again')
    }
  }

  const cancel = async () => {
    const ok = await confirm({
      title: 'Cancel this kelabo?',
      body: 'Invitees with an email will be told it was called off. This cannot be undone.',
      confirmLabel: 'Cancel kelabo',
      cancelLabel: 'Keep it',
    })
    if (!ok) return
    setBusy(true)
    try {
      await api.cancelKelabo(id)
      toast('Kelabo cancelled')
      setKelabo(m => ({ ...m, status: 'cancelled' }))
    } catch (e) {
      setBusy(false)
      if (e?.code === 'already_active') toast('It has already started — end it from the room instead')
      else toast('Could not cancel — try again')
    }
  }

  const openReschedule = () => {
    setRAt(kelabo.scheduledAt || Date.now())
    setRDuration(kelabo.durationMinutes || 30)
    setRTitle(kelabo.title || '')
    setRNote(kelabo.note || '')
    setEditing(true)
  }

  const saveReschedule = async () => {
    setBusy(true)
    try {
      const body = {}
      if (Number.isFinite(rAt) && rAt !== kelabo.scheduledAt) body.scheduledAt = rAt
      if (rDuration && rDuration !== kelabo.durationMinutes) body.durationMinutes = rDuration
      if (rTitle.trim() && rTitle.trim() !== kelabo.title) body.title = rTitle.trim()
      if ((rNote || '') !== (kelabo.note || '')) body.note = rNote.trim()
      if (Object.keys(body).length === 0) { setEditing(false); setBusy(false); return }
      const res = await api.rescheduleKelabo(id, body)
      toast(res.rsvpsReset ? 'Rescheduled — invitees asked to reply again' : 'Kelabo updated')
      // Re-fetch so the replies list reflects any reset.
      const fresh = await api.getScheduled(id)
      setKelabo(fresh)
      setEditing(false)
    } catch (e) {
      if (e?.code === 'nothing_to_change') { setEditing(false) }
      else toast('Could not reschedule — try again')
    } finally {
      setBusy(false)
    }
  }

  const openInvitees = () => {
    // Who the host actually typed an address for — not the host's own
    // auto-RSVP row and not a guest who only ever gave a name from the link,
    // neither of which this panel can touch (scheduling.js §3.5).
    setInvitees((kelabo.invites || []).filter(i => i.email && !i.isGuest && !i.isHost).map(i => i.email))
    setEditingInvitees(true)
  }

  const saveInvitees = async () => {
    setBusy(true)
    try {
      const res = await api.updateInvitees(id, invitees)
      const parts = []
      if (res.added?.length) parts.push(`invited ${res.added.length}`)
      if (res.removed?.length) parts.push(`removed ${res.removed.length}`)
      if (res.failed?.length) parts.push(`${res.failed.length} could not be emailed`)
      toast(parts.length ? parts.join(', ') : 'Invitees updated')
      const fresh = await api.getScheduled(id)
      setKelabo(fresh)
      setEditingInvitees(false)
    } catch (e) {
      if (e?.code === 'nothing_to_change') { setEditingInvitees(false) }
      else toast('Could not update invitees — try again')
    } finally {
      setBusy(false)
    }
  }

  if (state === 'loading') {
    return <main className="page"><SkeletonRows n={3} /></main>
  }
  if (state === 'invalid') {
    return (
      <main className="page">
        <h1 className="page-title">Kelabo not found</h1>
        <Banner kind="danger">
          This scheduled kelabo no longer exists, or you were not invited to it.
        </Banner>
      </main>
    )
  }

  const live = kelabo.status === 'active'
  const ended = kelabo.status === 'ended'
  const cancelled = kelabo.status === 'cancelled'
  const scheduled = !live && !ended && !cancelled

  return (
    <main className="page">
      <div className="title-row">
        <h1 className="page-title">{kelabo.title}</h1>
        {live && <span className="chip chip-live"><span className="dot"></span>live</span>}
        {ended && <span className="chip chip-ended">ended</span>}
        {cancelled && <span className="chip chip-ended">cancelled</span>}
        {scheduled && <span className="chip chip-accent">scheduled</span>}
        {(kelabo.journeys || []).map(j => (
          <Link
            key={j.id}
            className="chip chip-accent"
            to={`/journeys/${j.id}`}
            title={`Part of the journey "${j.title || 'Untitled journey'}"`}
          >
            <Icon name="link" size={12} />{j.title || 'Untitled journey'}
          </Link>
        ))}
      </div>
      <p className="page-sub">{whenText(kelabo.scheduledAt, kelabo.durationMinutes)}</p>

      {cancelled && (
        <Banner kind="warn">This kelabo was cancelled. The invitation link no longer works.</Banner>
      )}

      {kelabo.note && <p className="invite-note">{kelabo.note}</p>}

      <div className="field">
        <span className="label">Invitation link</span>
        <div className="linkbox">
          <span className="link-url">{kelabo.inviteUrl}</span>
          <Button size="sm" onClick={copy}>
            <Icon name="copy" size={14} />Copy
          </Button>
        </div>
        <p className="form-note">
          Anyone with this link can reply, and join once you start. No account needed.
        </p>
      </div>

      {kelabo.isHost && (live || scheduled) && !editing && !editingInvitees && (
        <div className="action-row action-row-start">
          <Button variant="primary" onClick={start} disabled={starting}>
            {live ? 'Rejoin' : starting ? 'Starting…' : 'Start now'}
          </Button>
          {scheduled && (
            <>
              <Button variant="outline" onClick={openReschedule} disabled={busy}>
                <Icon name="calendar" size={14} />Reschedule
              </Button>
              <Button variant="outline" onClick={openInvitees} disabled={busy}>
                <Icon name="user-plus" size={14} />Edit invitees
              </Button>
              <Button variant="outline-danger" onClick={cancel} disabled={busy}>
                <Icon name="x" size={14} />Cancel
              </Button>
            </>
          )}
          <span className="text-meta">Start whenever you like — the time above is only the plan.</span>
        </div>
      )}

      {kelabo.isHost && scheduled && editing && (
        <div className="panel-inset">
          <div className="section-title">Reschedule</div>
          <div className="field">
            <span className="label">Title</span>
            <input className="input" value={rTitle} onChange={e => setRTitle(e.target.value)} maxLength={80} />
          </div>
          <div className="field">
            <span className="label">When</span>
            <DateTimePicker value={rAt} onChange={setRAt} disabled={busy} minDate={new Date()} />
          </div>
          <div className="field">
            <span className="label">Duration (minutes)</span>
            <input
              className="input" type="number" min={5} max={1440} value={rDuration}
              onChange={e => setRDuration(Number(e.target.value) || 0)}
            />
          </div>
          <div className="field">
            <span className="label">Note</span>
            <textarea className="input" rows={2} value={rNote} onChange={e => setRNote(e.target.value)} maxLength={500} />
          </div>
          <p className="form-note">Changing the time asks everyone who replied to reply again.</p>
          <div className="action-row action-row-start">
            <Button variant="primary" onClick={saveReschedule} disabled={busy}>Save changes</Button>
            <Button variant="ghost" onClick={() => setEditing(false)} disabled={busy}>Discard</Button>
          </div>
        </div>
      )}

      {kelabo.isHost && scheduled && editingInvitees && (
        <div className="panel-inset">
          <div className="section-title">Edit invitees</div>
          <div className="field">
            <span className="label">Invited</span>
            <EmailPicker value={invitees} onChange={setInvitees} disabled={busy} />
          </div>
          <p className="form-note">
            A new address is emailed the invitation; removing someone is emailed that they no longer need to come.
            The kelabo itself is unaffected either way.
          </p>
          <div className="action-row action-row-start">
            <Button variant="primary" onClick={saveInvitees} disabled={busy}>Save changes</Button>
            <Button variant="ghost" onClick={() => setEditingInvitees(false)} disabled={busy}>Discard</Button>
          </div>
        </div>
      )}

      {!kelabo.isHost && live && (
        <Button variant="primary" onClick={() => navigate(`/join/${id}`)}>Join now</Button>
      )}

      <div className="section-title section-title-row">
        Replies
        <span className="text-meta">
          {kelabo.rsvp.accepted} coming · {kelabo.rsvp.declined} can't · {kelabo.rsvp.pending} no reply
        </span>
      </div>

      {(kelabo.invites || []).length === 0 && (
        <div className="empty">Nobody has been invited yet — share the link above.</div>
      )}
      {(kelabo.invites || []).map(i => {
        const r = RESPONSE[i.response] || RESPONSE.pending
        const who = i.displayName || i.email || 'Guest'
        return (
          <div className="row" key={i.email || who}>
            <Avatar id={i.email} name={who} variant={i.avatarVariant} />
            <div className="row-main">
              <div className="row-title">
                {who}
                {i.isHost && <span className="chip">host</span>}
                {i.isGuest && <span className="chip">guest</span>}
              </div>
              {i.email && i.displayName && <div className="row-sub">{i.email}</div>}
            </div>
            <span className={'rsvp rsvp-' + r.cls}>
              <Icon name={r.icon} size={13} />{r.label}
            </span>
          </div>
        )
      })}
    </main>
  )
}
