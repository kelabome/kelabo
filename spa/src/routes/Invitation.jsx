import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { api } from '../api'
import { useAuth, displayName } from '../auth'
import { TopBar } from '../components/TopBar'
import { Button } from '../components/ui/Button'
import { Banner } from '../components/ui/Banner'
import { Icon } from '../components/ui/Icon'
import { Skeleton } from '../components/ui/Skeleton'
import { useToast } from '../components/Toaster'

/**
 * "Can you make it?" — the page an invitation link opens.
 *
 * Readable and answerable without an account, because an invitation that
 * demands a sign-up before it will tell you what the kelabo is has failed at
 * the only job it has. A signed-in visitor is never asked their name; the
 * session already knows it. A guest is asked once, and a cookie remembers them
 * so changing their mind updates their answer instead of adding a second
 * person to the list.
 *
 * Declining is never a lock. The link keeps working, and the answer can be
 * changed right up to the kelabo — people say no and then find they can come.
 *
 * The mail's Accept / Decline buttons land here as `?t=<signed token>&r=<answer>`.
 * The token names the invitee, so the answer is recorded at once, on their own
 * row, with no name to type; the server then sets the RSVP cookie and the
 * token is dropped from the address bar, so it is not left in history or
 * shared by copying the URL.
 */

function whenText(at, minutes) {
  if (!at) return ''
  const d = new Date(at)
  const date = d.toLocaleString([], {
    weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit',
  })
  return minutes ? `${date} · ${minutes} min` : date
}

export default function Invitation() {
  const { id } = useParams()
  const toast = useToast()
  const navigate = useNavigate()
  const { identity, loading: authLoading } = useAuth()
  const [params] = useSearchParams()
  // Read once: the URL is cleaned after the first answer is recorded.
  const [token] = useState(() => params.get('t') || undefined)
  const [mailAnswer] = useState(() => (['accepted', 'declined'].includes(params.get('r')) ? params.get('r') : null))
  const applied = useRef(false)

  const [invite, setInvite] = useState(null)
  const [state, setState] = useState('loading') // loading | ready | invalid
  const [name, setName] = useState('')
  const [saving, setSaving] = useState(false)

  const load = () => {
    api.getInvitation(id, token)
      .then(data => {
        setInvite(data)
        setName(prev => prev || data.myName || '')
        setState('ready')
      })
      .catch(() => setState('invalid'))
  }

  useEffect(() => { load() }, [id]) // eslint-disable-line react-hooks/exhaustive-deps

  // A visitor who signs in halfway through should stop being asked for a name.
  useEffect(() => {
    if (!authLoading && identity) load()
  }, [authLoading, identity]) // eslint-disable-line react-hooks/exhaustive-deps

  // One click in the mail is the answer: record it as soon as the invitation
  // is known to still be answerable, then clean the URL.
  useEffect(() => {
    if (applied.current || !mailAnswer || state !== 'ready' || authLoading || !invite) return
    applied.current = true
    if (invite.status === 'cancelled' || invite.status === 'ended') return
    respond(mailAnswer).finally(() => navigate(`/invite/${id}`, { replace: true }))
  }, [state, authLoading, invite]) // eslint-disable-line react-hooks/exhaustive-deps

  const respond = async response => {
    const needName = invite?.needsName && !identity
    const chosen = name.trim()
    if (needName && !chosen) {
      toast('Please enter your name first')
      return
    }
    setSaving(true)
    try {
      const res = await api.rsvp(id, response, needName ? chosen : undefined, token)
      setInvite(prev => ({ ...prev, myResponse: res.response, myName: res.displayName, needsName: false }))
      toast(response === 'accepted' ? "Great — you're on the list" : 'Thanks for letting them know')
    } catch (e) {
      toast(e?.code === 'name_required' ? 'Please enter your name first' : 'Could not save your answer — try again')
    } finally {
      setSaving(false)
    }
  }

  if (state === 'loading' || authLoading) {
    return (
      <>
        <TopBar minimal showSignIn />
        <main className="page-narrow">
          <section className="card card-pad">
            <Skeleton className="skel-title" />
            <Skeleton className="skel-text" />
          </section>
        </main>
      </>
    )
  }

  if (state === 'invalid') {
    return (
      <>
        <TopBar minimal showSignIn />
        <main className="page-narrow">
          <section className="card card-pad">
            <h1 className="page-title">Invitation not found</h1>
            <Banner kind="danger">This invitation link is invalid, or the kelabo was removed.</Banner>
            <p className="page-sub page-sub-tight">Ask whoever invited you for a fresh link.</p>
          </section>
        </main>
      </>
    )
  }

  const started = invite.status === 'active'
  const ended = invite.status === 'ended'
  const cancelled = invite.status === 'cancelled'
  // 'pending' is a stored answer meaning "no answer" — someone who un-accepted.
  // Treating it as answered puts "You said you can't make it" on the page.
  const answered = invite.myResponse && invite.myResponse !== 'pending' ? invite.myResponse : null
  const askName = invite.needsName && !identity

  return (
    <>
      <TopBar minimal showSignIn />
      <main className="page-narrow">
        <section className="card card-pad anim-in">
          <div className="title-row">
            <h1 className="page-title">{invite.title}</h1>
            {started && <span className="chip chip-live"><span className="dot"></span>live now</span>}
            {ended && <span className="chip chip-ended">ended</span>}
            {cancelled && <span className="chip chip-ended">cancelled</span>}
          </div>
          <p className="page-sub">
            {invite.hostIdentity} invited you · {whenText(invite.scheduledAt, invite.durationMinutes)}
          </p>

          {invite.note && <p className="invite-note">{invite.note}</p>}

          {cancelled ? (
            <Banner kind="warn">This kelabo was cancelled by the host.</Banner>
          ) : ended ? (
            <Banner kind="warn">This kelabo has already ended.</Banner>
          ) : (
            <>
              {answered && (
                <div className={'invite-answer invite-answer-' + answered}>
                  <Icon name={answered === 'accepted' ? 'check' : 'x'} size={15} />
                  {answered === 'accepted'
                    ? `You said you're coming${invite.myName ? `, ${invite.myName}` : ''}.`
                    : "You said you can't make it."}
                </div>
              )}

              {askName && (
                <div className="field">
                  <label className="label" htmlFor="rsvp-name">Your name</label>
                  <input
                    className="input"
                    id="rsvp-name"
                    placeholder="Sam"
                    autoComplete="name"
                    value={name}
                    autoFocus
                    onChange={e => setName(e.target.value)}
                  />
                  <p className="form-note">
                    So the host knows who is coming. <Link to="/login">Sign in</Link> instead if you have an account.
                  </p>
                </div>
              )}

              <div className="invite-actions">
                <Button
                  className={answered === 'accepted' ? 'is-on' : ''}
                  onClick={() => respond('accepted')}
                  disabled={saving}
                >
                  <Icon name="check" size={15} />{answered ? "I'm coming" : 'Yes, count me in'}
                </Button>
                <Button
                  variant={answered === 'declined' ? 'outline-danger' : 'ghost'}
                  onClick={() => respond('declined')}
                  disabled={saving}
                >
                  <Icon name="x" size={15} />Can't make it
                </Button>
              </div>

              {invite.going > 0 && (
                <p className="form-note">
                  {invite.going} {invite.going === 1 ? 'person is' : 'people are'} coming.
                </p>
              )}

              {started && (
                <div className="invite-live">
                  <Banner kind="warn">This kelabo has started.</Banner>
                  <Button variant="primary" block onClick={() => navigate(`/join/${id}`)}>
                    Join now
                  </Button>
                </div>
              )}

              {!started && (
                <p className="form-note">
                  {/* Said plainly, because "I RSVP'd, am I in?" is the obvious
                      next question and the answer is not obvious. */}
                  You'll be able to join from this same link once the host starts the kelabo.
                </p>
              )}
            </>
          )}
        </section>
      </main>
    </>
  )
}
