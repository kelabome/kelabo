import { Fragment, useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { api } from '../api'
import { Tabs } from '../components/ui/Tabs'
import { SkeletonRows, Skeleton } from '../components/ui/Skeleton'
import { Banner } from '../components/ui/Banner'
import { Button } from '../components/ui/Button'
import { Icon } from '../components/ui/Icon'
import { Crumbs } from '../components/ui/Crumbs'
import { ContributionCard } from '../components/ContributionCard'
import { SpeakerTag } from '../components/SpeakerTag'
import { annotateDays, fmtFullAt, fmtTime } from '../time'

/** A heading over a plain string list (open questions). */
function MinutesList({ title, items }) {
  if (!(items || []).length) return null
  return (
    <div className="section-block">
      <div className="section-title">{title}</div>
      <ul className="bullets">
        {items.map((x, i) => <li key={i}>{typeof x === 'string' ? x : x?.text}</li>)}
      </ul>
    </div>
  )
}

/**
 * Minutes written before the richer document stored topics/decisions/findings as
 * plain strings. Records are kept for months, so every section reads through
 * this rather than assuming the current shape.
 */
const asText = x => (typeof x === 'string' ? x : x?.text || x?.title || '')

/** Topics carry the substance of the discussion — the part worth reading. */
function MinutesTopics({ topics }) {
  if (!(topics || []).length) return null
  return (
    <div className="section-block">
      <div className="section-title">Discussion</div>
      <div className="vstack-sm">
        {topics.map((t, i) => {
          const title = typeof t === 'string' ? t : t?.title
          const detail = typeof t === 'string' ? '' : t?.detail
          const speakers = (typeof t === 'string' ? [] : t?.speakers) || []
          return (
            <div className="min-topic" key={i}>
              <div className="min-topic-head">
                <span className="min-topic-title">{title}</span>
                {speakers.map((s, j) => <SpeakerTag key={j} name={s} />)}
              </div>
              {detail && <p className="min-topic-detail">{detail}</p>}
            </div>
          )
        })}
      </div>
    </div>
  )
}

/** A decision plus why it went that way. */
function MinutesDecisions({ decisions }) {
  if (!(decisions || []).length) return null
  return (
    <div className="section-block">
      <div className="section-title">Decisions</div>
      <ul className="bullets">
        {decisions.map((d, i) => (
          <li key={i}>
            {asText(d)}
            {d?.rationale && <span className="min-rationale"> — {d.rationale}</span>}
          </li>
        ))}
      </ul>
    </div>
  )
}

/** What the assistant looked up during the kelabo, with its citations. */
function MinutesFindings({ findings }) {
  if (!(findings || []).length) return null
  return (
    <div className="section-block">
      <div className="section-title">Looked up during the kelabo</div>
      <ul className="bullets">
        {findings.map((f, i) => {
          const sources = (typeof f === 'string' ? [] : f?.sources) || []
          return (
            <li key={i}>
              {asText(f)}
              {sources.length > 0 && (
                <span className="min-src">
                  {sources.map((s, j) =>
                    s.url ? (
                      <a key={j} className="chip kind-link" href={s.url} target="_blank" rel="noreferrer noopener">{s.title}</a>
                    ) : (
                      <span key={j} className="chip kind-link">{s.title}</span>
                    ),
                  )}
                </span>
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}

function fmtDateLong(ts) {
  return new Date(ts).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })
}

function fmtClock(ms) {
  const total = Math.max(0, Math.floor((ms || 0) / 1000))
  const m = String(Math.floor(total / 60)).padStart(2, '0')
  const s = String(total % 60).padStart(2, '0')
  return `${m}:${s}`
}

function durationMin(start, end) {
  if (!start || !end) return null
  return Math.max(1, Math.round((end - start) / 60000))
}

export default function RecordDetail() {
  const { id } = useParams()
  const [record, setRecord] = useState(null)
  const [error, setError] = useState(null)
  const [tab, setTab] = useState('transcript')
  // The minutes poll gave up. Flipped so the tab can stop promising — a
  // spinner that outlives its poll is an eternal promise (docs 19 §2/§3).
  const [minutesTimedOut, setMinutesTimedOut] = useState(false)

  useEffect(() => {
    api.getRecord(id)
      .then(setRecord)
      .catch(e => setError(e.status === 403 || e.status === 401 ? 'forbidden' : 'error'))
  }, [id])

  // Minutes are generated asynchronously after a kelabo ends; if absent, poll a
  // few times so they appear without a manual refresh.
  useEffect(() => {
    if (!record || record.minutes) return undefined
    // Minutes land within a minute or two of the end. A record opened long
    // after its kelabo ended and still without them is not "generating" —
    // say so at once, and don't poll for something that is not coming.
    const MINUTES_GRACE_MS = 10 * 60 * 1000
    if (record.endedAt && Date.now() - record.endedAt > MINUTES_GRACE_MS) {
      setMinutesTimedOut(true)
      return undefined
    }
    let tries = 0
    const t = setInterval(() => {
      tries += 1
      api.getRecord(id)
        .then(r => { if (r?.minutes) setRecord(r) })
        .catch(() => {})
      // Give up out loud, not silently: the Minutes tab switches from a
      // spinner to a status the moment nothing more is coming.
      if (tries >= 20) {
        clearInterval(t)
        setMinutesTimedOut(true)
      }
    }, 3000)
    return () => clearInterval(t)
  }, [record?.minutes, record == null, id]) // eslint-disable-line react-hooks/exhaustive-deps

  const download = () => {
    const blob = new Blob([JSON.stringify(record, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `kelabo-record-${id}.json`
    a.click()
    URL.revokeObjectURL(url)
  }

  const transcript = record?.transcript || []
  const board = record?.board || []
  const minutes = record?.minutes
  const mins = record ? durationMin(record.startedAt, record.endedAt) : null

  return (
    <main className="page">
      {record === null && !error && (
        <>
          <Skeleton className="skel-title" />
          <SkeletonRows n={4} />
        </>
      )}

      {error && (
        <Banner kind={error === 'forbidden' ? 'danger' : 'warn'}>
          {error === 'forbidden'
            ? 'This record is only available to signed-in participants of the kelabo.'
            : "Couldn't load this record — it may not exist yet."}
        </Banner>
      )}

      {record && (
        <>
          <Crumbs
            className="crumbs-head"
            to="/kelabos"
            backLabel="Kelabos"
            here={`${record.title} · ${fmtDateLong(record.endedAt || record.startedAt)}`}
          />
          <div className="title-row">
            <h1 className="page-title">{record.title}</h1>
            <span className="chip chip-ended">ended</span>
            <span className="chip">{fmtDateLong(record.endedAt || record.startedAt)}</span>
            {mins && <span className="chip">{mins} min</span>}
            <span className="chip">{(record.participants || []).length} participants</span>
            {(record.journeys || []).map(j => (
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
          <p className="page-sub">
            Host: {record.host || '—'} · archived transcript, board and minutes
          </p>

          <Tabs
            tabs={[
              { id: 'transcript', label: 'Transcript' },
              { id: 'board', label: 'Board' },
              { id: 'minutes', label: 'Minutes' },
            ]}
            active={tab}
            onChange={setTab}
          />

          {tab === 'transcript' && (
            <section className="anim-in record-panel record-transcript">
              {transcript.length === 0 && (
                <div className="empty">No transcript was captured for this kelabo.</div>
              )}
              {/* A record can span days, so lines show wall-clock time under
                  day dividers where the archive carries it; pre-2026-08
                  archives have only meeting-relative offsets and keep them. */}
              {annotateDays(transcript, u => u.at).map(({ item: u, divider }, i) => (
                <Fragment key={i}>
                  {divider && <div className="day-divider" role="separator">{divider}</div>}
                  <div className="line">
                    <SpeakerTag name={u.speaker} />
                    <span className="text">
                      <span className="tstamp" title={fmtFullAt(u.at)}>
                        {u.at ? fmtTime(u.at) : fmtClock(u.tStart)}
                      </span>
                      {/* Same marker as the live panel: a typed line is something
                          somebody wrote, not Deepgram's hearing of them. */}
                      {u.source === 'typed' && (
                        <Icon name="pencil" size={11} className="chat-typed line-typed" label="Typed" />
                      )}
                      {u.text}
                    </span>
                  </div>
                </Fragment>
              ))}
              <div className="action-row action-row-start">
                <Button size="sm" onClick={download}>
                  <Icon name="download" size={14} />Download .json
                </Button>
              </div>
            </section>
          )}

          {tab === 'board' && (
            <section className="anim-in record-panel vstack-sm">
              {board.length === 0 && (
                <div className="empty">No board contributions in this kelabo.</div>
              )}
              {board.map(c => <ContributionCard key={c.id || `${c.at}-${c.title}`} con={c} />)}
            </section>
          )}

          {tab === 'minutes' && (
            <section className="anim-in record-panel">
              {!minutes && !minutesTimedOut && (
                <div className="empty hstack">
                  <span className="con-spinner" aria-hidden="true"></span>
                  Minutes are being generated… they'll appear here shortly.
                </div>
              )}
              {!minutes && minutesTimedOut && (
                <div className="empty">
                  No minutes yet. They may still be generating — reload to check —
                  or minutes may not be enabled on this deployment.
                </div>
              )}
              {minutes && (
                <div className="vstack-lg">
                  {minutes.summary && (
                    <div className="section-block">
                      <div className="section-title">Summary</div>
                      <p className="min-summary">{minutes.summary}</p>
                    </div>
                  )}
                  {/* Topic names alone used to be the whole "Topics" section: a
                      row of chips that named subjects and said nothing about
                      them. They are now the headings of the write-up. */}
                  <MinutesTopics topics={minutes.topics} />
                  <MinutesDecisions decisions={minutes.decisions} />
                  {(minutes.actionItems || []).length > 0 && (
                    <div className="section-block">
                      <div className="section-title">Action items</div>
                      <ul className="bullets">
                        {minutes.actionItems.map((a, i) => (
                          <li key={i}>
                            {a.owner ? <><strong>{a.owner}</strong> — </> : null}{a.text}
                            {a.due && <span className="min-rationale"> ({a.due})</span>}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  <MinutesList title="Open questions" items={minutes.openQuestions} />
                  <MinutesFindings findings={minutes.findings} />
                  <div className="text-meta">
                    Generated by {minutes.generatedBy || 'server'} agent
                    {minutes.generatedAt ? ` · ${new Date(minutes.generatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ''}
                  </div>
                </div>
              )}
            </section>
          )}
        </>
      )}
    </main>
  )
}
