import { useState } from 'react'
import { Markdown } from './Markdown'
import { Icon } from './ui/Icon'
import { fmtFullAt } from '../time'

/**
 * One assistant contribution, collapsed to its headline until opened.
 *
 * Built for the narrowest column it appears in — the room's side panel, around
 * 300px — and it is the same card on the wide record page, because a card that
 * survives 300px is not improved by being given 900.
 *
 * That constraint is what removed most of the text. The head used to be a row
 * of a kind chip, the title, a `to: all` chip, sometimes an origin chip and a
 * caret; at panel width every one of those wrapped, so a two-word contribution
 * took four lines and the working card said "working" twice — once in the
 * title it was given and once in a status chip beside it. Now anything that can
 * be a symbol is one, anything that is always true (`to: all`) is not said at
 * all, and the things that remain are stacked in rows rather than competing for
 * one.
 */

// The kind is carried by an icon and the left border colour, never a word: the
// word was the longest thing in the head and the least useful.
const KIND_ICON = {
  answer: 'sparkles',
  link: 'link',
  code: 'code',
  clarify: 'help',
  minutes: 'file-text',
  note: 'pencil',
}

/**
 * Time of day, and the date too when the card is not from today.
 *
 * An agent can post to a kelabo's board before the kelabo starts (docs 16 §5),
 * so a card written yesterday afternoon sits at the top of the board rendering
 * as "14:30" — indistinguishable from something said thirty seconds ago. The
 * date is the whole fix; a prep card is otherwise an ordinary contribution and
 * deliberately has no badge of its own.
 */
function fmtAt(at, now = Date.now()) {
  if (!at) return ''
  try {
    const d = new Date(at)
    const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    const today = new Date(now)
    const sameDay =
      d.getFullYear() === today.getFullYear() &&
      d.getMonth() === today.getMonth() &&
      d.getDate() === today.getDate()
    return sameDay ? time : `${d.toLocaleDateString([], { day: 'numeric', month: 'short' })} ${time}`
  } catch {
    return ''
  }
}

export function ContributionCard({ con }) {
  const [open, setOpen] = useState(false)
  const kind = con.kind || 'note'
  const working = con.status === 'working'
  const skipped = con.status === 'skipped'

  // A working card says what it is doing right now, and keeps the trail of what
  // it has already done. A spinner alone answers "is it alive?"; twenty seconds
  // of spinner with no reason to trust it does not.
  if (working) {
    const steps = Array.isArray(con.steps) ? con.steps.slice(-3) : []
    return (
      <div className="con con-working" data-kind={kind} aria-busy="true">
        <div className="con-head">
          <span className="con-spinner" aria-hidden="true"></span>
          <span className="con-title">{con.title || 'Thinking…'}</span>
        </div>
        {con.progress && (
          <div className="con-progress" aria-live="polite">{con.progress}</div>
        )}
        {/* The concluding turn streams: `markdown` on a working card is the
            answer so far, and showing it as it grows is what turns the tail
            of the wait from a spinner into reading. The step trail is hidden
            once text is flowing — the work it describes is over. */}
        {con.markdown
          ? <div className="con-body"><Markdown text={con.markdown} /></div>
          : steps.length > 0 && (
            <ul className="con-steps">
              {steps.map((s, i) => <li key={i}>{s}</li>)}
            </ul>
          )}
      </div>
    )
  }

  // The agent heard the room, worked on it, and is not going to post. Saying so
  // is the whole point of this state: the card used to be deleted, which read as
  // a glitch and left no way to tell "decided not to" from "crashed".
  if (skipped) {
    return (
      <div className="con con-skipped" data-kind={kind}>
        <div className="con-head">
          <span className="con-mark" aria-hidden="true"><Icon name="minus-circle" size={14} /></span>
          <span className="con-title">{con.title || 'No contribution'}</span>
        </div>
        <div className="con-sub"><span title={fmtFullAt(con.at)}>{fmtAt(con.at)}</span></div>
        {con.reason && <div className="con-reason">{con.reason}</div>}
      </div>
    )
  }

  // `to` is a targeting hint and is "all" almost every time, so it earns its
  // space only when it says something.
  const targeted = con.to && con.to !== 'all' ? con.to : null
  const sources = Array.isArray(con.sources) ? con.sources : []

  return (
    <div
      className={'con' + (open ? ' open' : '')}
      data-kind={kind}
      onClick={() => setOpen(o => !o)}
      role="button"
      tabIndex={0}
      aria-expanded={open}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen(o => !o) } }}
    >
      <div className="con-head">
        <span className="con-mark" title={kind} aria-label={kind}>
          <Icon name={KIND_ICON[kind] || 'pencil'} size={14} />
        </span>
        <span className="con-title">{con.title}</span>
        <span className="con-caret"><Icon name="chevron-right" size={13} /></span>
      </div>

      <div className="con-sub">
        <span title={fmtFullAt(con.at)}>{fmtAt(con.at)}</span>
        {targeted && <span className="con-to" title={`Aimed at ${targeted}`}>→ {targeted}</span>}
        {sources.length > 0 && (
          <span title={`${sources.length} source${sources.length === 1 ? '' : 's'}`}>
            <Icon name="link" size={11} />{sources.length}
          </span>
        )}
        {(con.origin === 'local' || con.origin === 'opencode') && (
          <span
            title={`Produced from a local repo by ${con.agentLabel || con.runtime || 'opencode'}`}
          >
            <Icon name="terminal" size={11} />
          </span>
        )}
      </div>

      <div className="con-body">
        {con.markdown && <Markdown text={con.markdown} />}
        {sources.length > 0 && (
          <div className="con-src">
            {sources.map((s, i) =>
              s.url ? (
                <a
                  key={i}
                  className="chip kind-link"
                  href={s.url}
                  target="_blank"
                  rel="noreferrer noopener"
                  onClick={e => e.stopPropagation()}
                >
                  {s.title}
                </a>
              ) : (
                <span key={i} className="chip kind-link">{s.title}</span>
              ),
            )}
          </div>
        )}
      </div>
    </div>
  )
}
