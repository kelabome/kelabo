import { Link } from 'react-router-dom'
import { useAuth, displayName } from '../auth'
import { useAppData } from '../components/AppShell'
import { SkeletonRows } from '../components/ui/Skeleton'
import { Banner } from '../components/ui/Banner'
import { Button } from '../components/ui/Button'
import { Icon } from '../components/ui/Icon'
import { timeAgo } from '../timeAgo'
import { kelaboKindIcon } from '../kelaboKind'

function greeting() {
  const h = new Date().getHours()
  if (h < 12) return 'Good morning'
  if (h < 18) return 'Good afternoon'
  return 'Good evening'
}

function durationMin(start, end) {
  if (!start || !end) return null
  return Math.max(1, Math.round((end - start) / 60000))
}

/** "Thu 14:00", or "Today 14:00" / "Tomorrow 14:00" where those are clearer. */
function whenText(at) {
  if (!at) return ''
  const d = new Date(at)
  const days = Math.round(
    (new Date(at).setHours(0, 0, 0, 0) - new Date().setHours(0, 0, 0, 0)) / 86400000
  )
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  if (days === 0) return `Today ${time}`
  if (days === 1) return `Tomorrow ${time}`
  if (days === -1) return `Yesterday ${time}`
  return `${d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })} ${time}`
}

/**
 * How an invitation reads at a glance (notes #8).
 *
 * The colour is the whole point: an invitation list is scanned, not read, and
 * "which of these have I not dealt with?" has to be answerable without parsing a
 * word. So the three states get the three meanings the app already assigns to
 * green / red / amber everywhere else, and `pending` is the one that stands out
 * — it is the only state that is asking for something.
 */
const RSVP = {
  accepted: { chip: 'chip-accepted', label: 'Going', icon: 'check-circle' },
  declined: { chip: 'chip-declined', label: 'Not going', icon: 'x-circle' },
  pending: { chip: 'chip-pending', label: 'No reply', icon: 'clock' },
}

function InviteRow({ m, delay, onRespond }) {
  const answer = m.myResponse === 'accepted' || m.myResponse === 'declined' ? m.myResponse : 'pending'
  const look = RSVP[answer]
  return (
    <div className={'row anim-in' + (delay ? ` anim-in-d${Math.min(delay, 4)}` : '')}>
      <span className={'sdot sdot-' + answer}></span>
      <div className="row-main">
        <div className="row-title">
          {m.title}
          <span className={'chip ' + look.chip}>
            <Icon name={look.icon} size={12} />{look.label}
          </span>
        </div>
        <div className="row-sub">
          {whenText(m.scheduledAt)}
          {m.durationMinutes ? ` · ${m.durationMinutes} min` : ''}
          {m.hostIdentity ? ` · ${m.hostIdentity}` : ''}
        </div>
      </div>
      {/* Both answers are always offered, and the one already given is the one
          that undoes itself. Two buttons that never move is easier to hit than a
          row whose controls rearrange the moment you answer — and "I clicked the
          wrong one" needs a way back that is not a second wrong answer. */}
      <div className="row-actions row-actions-tight">
        <Button
          size="sm"
          className={answer === 'accepted' ? 'is-on' : ''}
          title={answer === 'accepted' ? 'Withdraw — back to no reply' : 'Accept this invitation'}
          onClick={() => onRespond(m, answer === 'accepted' ? 'pending' : 'accepted')}
        >
          <Icon name="check" size={14} />{answer === 'accepted' ? 'Going' : 'Accept'}
        </Button>
        <Button
          size="sm"
          variant={answer === 'declined' ? 'outline-danger' : 'ghost'}
          title={answer === 'declined' ? 'Withdraw — back to no reply' : 'Decline this invitation'}
          onClick={() => onRespond(m, answer === 'declined' ? 'pending' : 'declined')}
        >
          <Icon name="x" size={14} />{answer === 'declined' ? 'Declined' : 'Decline'}
        </Button>
        <Button as={Link} size="sm" variant="ghost" to={`/scheduled/${m.kelaboId}`} title="Open the kelabo">
          <Icon name="chevron-right" size={14} />
        </Button>
      </div>
    </div>
  )
}

export default function Home() {
  const { identity } = useAuth()
  const name = displayName(identity)
  const first = name?.split(/[\s.]/)[0] || 'there'
  // Fetched once by the shell (the rail shows the same lists) instead of each
  // route polling the same two endpoints on its own.
  const { kelabos, records, scheduled, kelabosError, pendingArchive, endLiveKelabo, respondToInvite, cancelScheduled } = useAppData()

  // Invitations are kelabos somebody else scheduled and put you in. A host's
  // own kelabos are not invitations — they never need an answer, and listing
  // them here would bury the ones that do.
  const byWhen = (a, b) => a.scheduledAt - b.scheduledAt
  const invitations = (scheduled || []).filter(m => m.status === 'scheduled' && !m.isHost).sort(byWhen)
  // …and the ones you are running. They had no home on this page at all: the
  // only way to change or cancel a kelabo you had scheduled was to remember it
  // existed and find it in the rail. Start / Change / Cancel now sit where the
  // kelabo itself does.
  const mine = (scheduled || []).filter(m => m.status === 'scheduled' && m.isHost).sort(byWhen)

  return (
    <main className="page">
        <div className="page-head">
          <h1 className="page-title">{greeting()}, {first}</h1>
          <Button as={Link} variant="primary" to="/new">
            <Icon name="plus" />New kelabo
          </Button>
        </div>

        {invitations.length > 0 && (
          <>
            <div className="section-title">Invitations</div>
            {invitations.map((m, i) => (
              <InviteRow key={m.kelaboId} m={m} delay={i} onRespond={respondToInvite} />
            ))}
          </>
        )}

        {mine.length > 0 && (
          <>
            <div className="section-title">Scheduled by you</div>
            {mine.map((m, i) => (
              <div className={'row anim-in' + (i ? ` anim-in-d${Math.min(i, 4)}` : '')} key={m.kelaboId}>
                <span className="sdot sdot-scheduled"></span>
                <div className="row-main">
                  <div className="row-title">{m.title}</div>
                  <div className="row-sub">
                    {whenText(m.scheduledAt)}
                    {m.durationMinutes ? ` · ${m.durationMinutes} min` : ''}
                    {m.rsvp ? ` · ${m.rsvp.accepted} coming · ${m.rsvp.pending} no reply` : ''}
                  </div>
                </div>
                <div className="row-actions row-actions-tight">
                  <Button as={Link} size="sm" to={`/scheduled/${m.kelaboId}`}>Open</Button>
                  {/* Change goes to the detail page, where the reschedule form
                      lives — a date, a duration, a title and a note is not a
                      thing to inline in a list row. Cancel acts here, because it
                      is one decision and its own dialog already explains it. */}
                  <Button
                    variant="ghost"
                    size="sm"
                    iconOnly
                    as={Link}
                    to={`/scheduled/${m.kelaboId}`}
                    title={`Change the time or details of ${m.title}`}
                    aria-label={`Change ${m.title}`}
                  >
                    <Icon name="calendar" size={15} />
                  </Button>
                  <Button
                    variant="danger-ghost"
                    size="sm"
                    iconOnly
                    title={`Cancel ${m.title}`}
                    aria-label={`Cancel ${m.title}`}
                    onClick={() => cancelScheduled(m)}
                  >
                    <Icon name="x-circle" size={16} />
                  </Button>
                </div>
              </div>
            ))}
          </>
        )}

        <div className="section-title">Live now</div>
        {kelabos === null && !kelabosError && <SkeletonRows n={2} />}
        {kelabosError && <Banner kind="warn">Couldn't load kelabos — retrying in the background.</Banner>}
        {kelabos !== null && kelabos.length === 0 && !kelabosError && (
          <div className="empty empty-hero">
            <span className="empty-mark" aria-hidden="true"></span>
            No kelabos yet — start one with <strong>New kelabo</strong> and share the invite link.
          </div>
        )}
        {(kelabos || []).map((m, i) => {
          const live = m.status === 'active'
          const isHost = !!(identity && m.hostIdentity && m.hostIdentity === identity.email)
          // Ended here a moment ago, record not written yet: keep the row,
          // but "View" would open a record that does not exist.
          const archiving = !live && pendingArchive?.has(m.kelaboId)
          return (
            <div className={'row anim-in' + (i ? ` anim-in-d${Math.min(i, 4)}` : '')} key={m.kelaboId}>
              <Icon name={kelaboKindIcon(m)} size={15} className={'kind-icon' + (live ? ' kind-icon-live' : '')} />
              <div className="row-main">
                <div className="row-title">
                  {m.title}
                  {live
                    ? <span className="chip chip-live"><span className="dot"></span>live</span>
                    : archiving
                      ? <span className="chip">archiving…</span>
                      : <span className="chip chip-ended">ended</span>}
                </div>
                <div className="row-sub">
                  {m.participantCount ?? 0} participants
                  {m.hostIdentity ? ` · host: ${m.hostIdentity}` : ''}
                  {m.hasMinutes ? ' · minutes ready' : ''}
                </div>
              </div>
              <span className="row-meta">{timeAgo(m.startedAt)}</span>
              <div className="row-actions row-actions-tight">
                {live
                  ? <Button as={Link} size="sm" to={`/join/${m.kelaboId}`}>Open</Button>
                  : !archiving && <Button as={Link} size="sm" to={`/kelabos/${m.kelaboId}`}>View</Button>}
                {/* Ending a kelabo you are not in (notes #6). The one that gets
                    left running is the one everybody already walked away from,
                    and rejoining it — mic, camera, conference audio — just to
                    press End is a lot of machinery for a decision already made. */}
                {live && isHost && (
                  <Button
                    variant="danger-ghost"
                    size="sm"
                    iconOnly
                    title="End this kelabo for everyone"
                    aria-label={`End ${m.title}`}
                    onClick={() => endLiveKelabo(m)}
                  >
                    <Icon name="stop-circle" size={16} />
                  </Button>
                )}
              </div>
            </div>
          )
        })}

        <div className="section-title section-title-row">
          Recent kelabos
          <Link className="link-plain" to="/kelabos">See all</Link>
        </div>
        {records === null && <SkeletonRows n={2} />}
        {records !== null && records.length === 0 && (
          <div className="empty">
            Nothing here yet — kelabos appear once they have ended.
          </div>
        )}
        {(records || []).slice(0, 3).map((r, i) => {
          const mins = durationMin(r.startedAt, r.endedAt)
          const hasMinutes = !!(r.minutes || r.hasMinutes)
          return (
            <div className={'row anim-in' + (i ? ` anim-in-d${Math.min(i + 2, 4)}` : ' anim-in-d2')} key={r.archiveId || r.kelaboId}>
              <Icon name={kelaboKindIcon(r)} size={15} className="kind-icon" />
              <div className="row-main">
                <div className="row-title">
                  {r.title}
                  {r.titleGenerated && (
                    <span className="chip" title="Title generated by the assistant">
                      <Icon name="sparkles" size={12} />AI title
                    </span>
                  )}
                  {hasMinutes && (
                    <span className="chip" title="Minutes available">
                      <Icon name="file-text" size={12} />minutes
                    </span>
                  )}
                </div>
                <div className="row-sub">
                  {(r.participants || []).length || r.participantCount || 0} people
                  {mins ? ` · ${mins} min` : ''} · {r.boardCount ?? 0} board
                </div>
              </div>
              <span className="row-meta">{timeAgo(r.endedAt || r.startedAt)}</span>
              <Button as={Link} variant="ghost" size="sm" to={`/kelabos/${r.archiveId || r.kelaboId}`}>View</Button>
            </div>
          )
        })}
    </main>
  )
}
