import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useTypeAnywhere } from '../useTypeAnywhere'
import { api } from '../api'
import { useAuth } from '../auth'
import { Button } from '../components/ui/Button'
import { Select } from '../components/ui/Select'
import { Switch } from '../components/ui/Switch'
import { Icon } from '../components/ui/Icon'
import { Banner } from '../components/ui/Banner'
import { EmailPicker } from '../components/EmailPicker'
import { JourneyPicker } from '../components/JourneyPicker'
import { DateTimePicker } from '../components/DateTimePicker'
import { useToast } from '../components/Toaster'

/**
 * Schedule a kelabo for later and get a link you can share now.
 *
 * The link is the point. It is minted here, before the kelabo exists as a live
 * thing, and it is the same link that works once the host starts — because a
 * scheduled kelabo is the same kelabo in an earlier state, not a placeholder
 * that gets swapped for a real one.
 */

/** The next half hour — nobody schedules a kelabo for 14:07. */
function defaultStart() {
  const d = new Date(Date.now() + 60 * 60 * 1000)
  d.setMinutes(d.getMinutes() > 30 ? 60 : 30, 0, 0)
  return d.getTime()
}

const DURATIONS = [15, 30, 45, 60, 90, 120]

/**
 * Turns a failure into something the reader can act on.
 *
 * "Try again" was every failure's answer, including the ones where trying again
 * cannot possibly help — a route the backend does not have yet, or a session
 * that expired. It was also the *only* answer in practice, because API Gateway
 * speaks HTTP/2, HTTP/2 has no reason phrase, so `statusText` is empty and the
 * generic fallback won every time.
 */
function scheduleError(e) {
  switch (e?.code) {
    case 'not_found':
      return 'Scheduling is not available on this deployment yet — the backend needs updating.'
    case 'unauthenticated':
      return 'Your session expired. Sign in again and your details will still be here.'
    case 'bad_request':
      return e.message || 'Something in the form was not accepted — check the title and time.'
    case 'email_not_verified':
    case 'email_suppressed':
    case 'mail_not_configured':
    case 'mail_failed':
      return 'The kelabo could not be created because invitation email is not set up for this deployment.'
    default:
      if (e?.status >= 500) return 'The server had a problem creating that kelabo. Try again in a moment.'
      if (!e?.status) return 'Could not reach the server — check your connection.'
      return e?.message || `Could not schedule that kelabo (${e.status}).`
  }
}

export default function Schedule() {
  const navigate = useNavigate()
  const toast = useToast()
  const { identity } = useAuth()
  const [searchParams] = useSearchParams()

  const [title, setTitle] = useState('')
  const [scheduledAt, setScheduledAt] = useState(defaultStart)
  const [duration, setDuration] = useState(30)
  const [invitees, setInvitees] = useState([])
  const [note, setNote] = useState('')
  // Same opt-in as New kelabo (notes #3), decided when the kelabo is made
  // rather than when it starts, because that is the only moment the host is
  // asked anything about it.
  const [historyEnabled, setHistoryEnabled] = useState(false)
  const [state, setState] = useState('idle') // idle | saving | done
  const titleRef = useRef(null)
  // Typing or pasting anywhere lands in the title until another field is
  // focused — the form's first and only always-wanted input.
  useTypeAnywhere(titleRef, state !== 'done')
  const [result, setResult] = useState(null)
  const [error, setError] = useState('')
  // Which journey(s) this kelabo belongs to (docs 20 §11) — same shape and
  // ?journeyId= pre-fill as NewKelabo.jsx.
  const [journeys, setJourneys] = useState([])
  useEffect(() => {
    const journeyId = searchParams.get('journeyId')
    if (!journeyId) return
    api.getJourney(journeyId)
      .then(j => setJourneys(prev => (prev.some(p => p.id === journeyId) ? prev : [...prev, { id: journeyId, title: j.title }])))
      .catch(() => {})
  }, [searchParams])
  // A linked journey supersedes historyEnabled server-side regardless of
  // this toggle's value (docs 20 §12.1) — reset rather than just hide, so
  // the record does not carry a `true` that never applied.
  useEffect(() => {
    if (journeys.length > 0 && historyEnabled) setHistoryEnabled(false)
  }, [journeys.length]) // eslint-disable-line react-hooks/exhaustive-deps

  const hostDomain = useMemo(() => identity?.email?.split('@')[1] || '', [identity])
  const inPast = Number.isFinite(scheduledAt) && scheduledAt < Date.now()

  const submit = async e => {
    e.preventDefault()
    if (!title.trim()) { setError('Give the kelabo a title'); return }
    if (!Number.isFinite(scheduledAt)) { setError('Pick a date and time'); return }
    setError('')
    setState('saving')
    try {
      const res = await api.scheduleKelabo({
        title: title.trim(),
        scheduledAt,
        durationMinutes: duration,
        invitees,
        ...(note.trim() ? { note: note.trim() } : {}),
        ...(historyEnabled ? { historyEnabled: true } : {}),
        ...(journeys.length ? { journeyIds: journeys.map(j => j.id) } : {}),
      })
      setResult(res)
      setState('done')
      // Partial success is still success: the kelabo exists and the link
      // works, so say what failed rather than pretending the whole thing did.
      const failedJourneys = (res.journeyLinks || []).filter(l => !l.linked)
      if (res.failed?.length) {
        toast(`Scheduled — but ${res.failed.length} invitation${res.failed.length === 1 ? '' : 's'} could not be sent`)
      } else if (failedJourneys.length) {
        toast(`Scheduled — but ${failedJourneys.length} journey link${failedJourneys.length === 1 ? '' : 's'} failed`)
      } else {
        toast(invitees.length ? 'Scheduled and invitations sent' : 'Kelabo scheduled')
      }
    } catch (e) {
      setState('idle')
      setError(scheduleError(e))
    }
  }

  const copyLink = async () => {
    try { await navigator.clipboard.writeText(result.inviteUrl) } catch {}
    toast('Invitation link copied')
  }

  if (state === 'done' && result) {
    return (
      <main className="page">
        <h1 className="page-title">“{result.title}” is scheduled</h1>
        <p className="page-sub">
          {new Date(result.scheduledAt).toLocaleString([], {
            weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit',
          })}
        </p>

        <div className="field">
          <span className="label">Share this link</span>
          <div className="linkbox">
            <span className="link-url">{result.inviteUrl}</span>
            <Button size="sm" onClick={copyLink}>
              <Icon name="copy" size={14} />Copy
            </Button>
          </div>
          <p className="form-note">
            Anyone with the link can say whether they are coming — no account needed.
          </p>
        </div>

        {result.failed?.length > 0 && (
          <Banner kind="warn">
            Could not email {result.failed.join(', ')}. The kelabo is scheduled and the link above still
            works — send it to them another way.
            {/* One cause is worth naming: while the mail account is in its
                sandbox, only pre-verified addresses can be written to, which
                otherwise reads as "invitations are broken". */}
            {result.invited?.some(i => i.reason === 'email_not_verified') && (
              <> This address has not been verified for sending yet, so mail to it is refused.</>
            )}
          </Banner>
        )}

        <div className="action-row action-row-start">
          <Button variant="primary" onClick={() => navigate('/scheduled/' + result.kelaboId)}>
            Open it
          </Button>
          <Button variant="ghost" onClick={() => navigate('/')}>Back home</Button>
        </div>
      </main>
    )
  }

  return (
    <main className="page">
      <h1 className="page-title">Schedule a kelabo</h1>
      <p className="page-sub">
        Pick a time, invite people, and share the link now. You can start the kelabo whenever you like.
      </p>

      <form onSubmit={submit}>
        <div className="field">
          <label className="label" htmlFor="title">Title</label>
          <input
            className="input"
            id="title"
            ref={titleRef}
            autoFocus
            maxLength={80}
            placeholder="Sprint review"
            value={title}
            onChange={e => setTitle(e.target.value)}
          />
        </div>

        <div className="field">
          <span className="label">When</span>
          <DateTimePicker value={scheduledAt} onChange={setScheduledAt} disabled={state === 'saving'} />
        </div>

        <div className="field">
          <label className="label" htmlFor="dur">For how long</label>
          <Select
            id="dur"
            className="input-narrow"
            value={duration}
            onChange={setDuration}
            disabled={state === 'saving'}
            options={DURATIONS.map(d => ({
              value: d,
              label: d < 60 ? `${d} minutes` : `${d / 60} hour${d === 60 ? '' : 's'}`,
            }))}
          />
        </div>

        {inPast && (
          <Banner kind="warn">
            That time has already passed. The kelabo will still be created and you can start it now — but
            invitees will see a time in the past.
          </Banner>
        )}

        <div className="field">
          <span className="label">Invite</span>
          <EmailPicker value={invitees} onChange={setInvitees} hostDomain={hostDomain} disabled={state === 'saving'} />
          <p className="form-note">
            {hostDomain
              ? `Start typing to find people at ${hostDomain}. Any other address works too.`
              : 'Any email address works.'}
          </p>
        </div>

        <div className="field">
          <label className="label" htmlFor="note">Note <span className="text-meta">(optional)</span></label>
          <textarea
            className="input"
            id="note"
            rows={5}
            maxLength={500}
            placeholder="What to bring, what it's about…"
            value={note}
            onChange={e => setNote(e.target.value)}
          />
        </div>

        <div className="field">
          <span className="label">Journey <span className="text-meta">(optional)</span></span>
          <JourneyPicker value={journeys} onChange={setJourneys} disabled={state === 'saving'} />
          <p className="form-note">
            Links this kelabo into that journey — the assistant gets its full context automatically, and it
            shows up under the journey's own Kelabos tab.
          </p>
        </div>

        {journeys.length === 0 && (
          <div className="settings-row settings-row-plain">
            <div className="sr-main">
              <div className="sr-title">Let the assistant read my past kelabos</div>
              <div className="sr-sub">
                It can answer “what did we decide last time” from the minutes of kelabos you attended — nobody
                else's. Everyone in the room is told this is on.
              </div>
            </div>
            <Switch
              checked={historyEnabled}
              onChange={setHistoryEnabled}
              ariaLabel="Let the assistant read my past kelabos"
            />
          </div>
        )}

        {error && <Banner kind="danger">{error}</Banner>}

        <Button type="submit" variant="primary" block disabled={state === 'saving'}>
          {state === 'saving'
            ? 'Scheduling…'
            : invitees.length
              ? `Schedule and invite ${invitees.length}`
              : 'Schedule kelabo'}
        </Button>
      </form>
    </main>
  )
}
