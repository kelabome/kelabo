import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api'
import { useAuth } from '../auth'
import { SkeletonRows } from '../components/ui/Skeleton'
import { Banner } from '../components/ui/Banner'
import { Icon } from '../components/ui/Icon'
import { Avatar } from '../components/ui/Avatar'
import { timeAgo } from '../timeAgo'

/** health -> the chip class already used for kelabo/RSVP status (docs 20 §5) —
 *  no new colour vocabulary, the same fixed success/warn/danger tokens.
 *  Labels are the journey metaphor's own vocabulary — the stored value
 *  (`green`/`yellow`/`red`, the API contract, docs 20 §5) is unchanged. */
// Unread has to arrive without a reload, and until threads are pushed over the
// presence stream (docs 20 §19.9) that means polling. 20s rather than the
// rail's 8s: this call rolls up unread across every journey's threads, and a
// badge is not something anyone watches by the second.
const POLL_MS = 20000

const HEALTH_CHIP = { green: 'chip-live', yellow: 'chip-warn', red: 'chip-danger' }
const HEALTH_LABEL = { green: 'Full Steam', yellow: 'Shoal Waters', red: 'Anchored' }

export function JourneyHealthChip({ health }) {
  if (!health) return null
  return <span className={'chip ' + (HEALTH_CHIP[health] || '')}>{HEALTH_LABEL[health] || health}</span>
}

function JourneyRow({ j, delay }) {
  return (
    <Link className={'row anim-in' + (delay ? ` anim-in-d${Math.min(delay, 4)}` : '')} to={`/journeys/${j.journeyId}`}>
      <Avatar id={j.journeyId} variant={j.avatarVariant} size={32} />
      <div className="row-main">
        <div className="row-title">
          {j.title}
          {/* Unread in a thread of this journey (docs 20 §19.3). A mention
              outranks a plain count — "somebody wants you" and "there is
              something here" are different messages. */}
          {j.mentions > 0 ? (
            <span className="thread-badge thread-badge-mention" title={`${j.mentions} unread mention${j.mentions === 1 ? '' : 's'}`}>
              @{j.mentions}
            </span>
          ) : j.unread > 0 ? (
            <span className="thread-badge" title={`${j.unread} unread message${j.unread === 1 ? '' : 's'}`}>{j.unread}</span>
          ) : null}
          {j.status === 'completed' && <span className="chip chip-ended">completed</span>}
          {j.visibility === 'public' && <span className="chip">public</span>}
          <JourneyHealthChip health={j.health} />
        </div>
        <div className="row-sub">
          {j.kelaboCount} kelabo{j.kelaboCount === 1 ? '' : 's'}
          {typeof j.progress === 'number' ? ` · ${j.progress}%` : ''}
          {j.reportCount ? ` · ${j.reportCount} question${j.reportCount === 1 ? '' : 's'}` : ''}
        </div>
      </div>
      <span className="row-meta">{timeAgo(j.updatedAt || j.createdAt)}</span>
      <span className="row-chevron"><Icon name="chevron-right" /></span>
    </Link>
  )
}

export default function Journeys() {
  const { identity } = useAuth()
  const [data, setData] = useState(null)
  const [error, setError] = useState(false)

  useEffect(() => {
    if (!identity) return undefined
    let live = true
    const load = () => {
      // Not while the tab is in the background: this call rolls up unread
      // across every journey's threads, and paying for that on a page nobody
      // is looking at is the definition of waste.
      if (document.hidden) return
      api
        .listJourneys()
        .then(d => {
          if (!live) return
          setData(d)
          setError(false)
        })
        // A failed refresh keeps whatever is on screen: the list is already
        // rendered, and replacing it with an error because one poll missed
        // would be worse than showing counts a few seconds stale.
        .catch(() => live && setData(prev => (prev ? prev : (setError(true), prev))))
    }
    load()
    // Until threads are pushed over the presence stream (docs 20 §19.9), a
    // badge that only appears on reload is a badge nobody sees. Slower than
    // the rail's 8s kelabo poll because this one is several queries per
    // journey, and unread is not a thing anyone watches by the second.
    const t = setInterval(load, POLL_MS)
    // A tab coming back to the front should be current immediately rather
    // than up to POLL_MS stale.
    document.addEventListener('visibilitychange', load)
    return () => {
      live = false
      clearInterval(t)
      document.removeEventListener('visibilitychange', load)
    }
  }, [identity])

  const mine = data?.mine || []
  const accessible = data?.accessible || []
  const publicJourneys = data?.public || []
  const empty = data && mine.length === 0 && accessible.length === 0 && publicJourneys.length === 0

  return (
    <main className="page">
      <div className="title-row">
        <h1 className="page-title">Journeys</h1>
      </div>
      <p className="page-sub">
        A journey links related kelabos so decisions, documents and history carry from one meeting to the next.
        {/* Creating one is a sidebar action now ("New journey", next to
            Join), reachable from any page — not repeated here. */}
      </p>

      {data === null && !error && <SkeletonRows n={3} />}
      {error && <Banner kind="warn">Couldn't load your journeys — check your connection and reload.</Banner>}
      {empty && (
        <div className="empty empty-hero">
          <span className="empty-mark" aria-hidden="true"></span>
          No journeys yet — create one, then link the kelabos that belong to it.
        </div>
      )}

      {mine.length > 0 && (
        <>
          <div className="section-title">Mine</div>
          {mine.map((j, i) => <JourneyRow key={j.journeyId} j={j} delay={i} />)}
        </>
      )}
      {accessible.length > 0 && (
        <>
          <div className="section-title">Shared with me</div>
          {accessible.map((j, i) => <JourneyRow key={j.journeyId} j={j} delay={i + mine.length} />)}
        </>
      )}
      {publicJourneys.length > 0 && (
        <>
          <div className="section-title">Public in your tenant</div>
          {publicJourneys.map((j, i) => <JourneyRow key={j.journeyId} j={j} delay={i + mine.length + accessible.length} />)}
        </>
      )}
    </main>
  )
}
