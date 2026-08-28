import { Fragment, useMemo } from 'react'
import { Icon } from '../components/ui/Icon'
import { SpeakerTag } from '../components/SpeakerTag'
import { annotateDays, fmtFullAt, fmtTime } from '../time'

/**
 * A scrolling list of chat bubbles, with day dividers and backward paging.
 *
 * Lifted out of `room/SidePanel.jsx` for the journey channel (docs 20 §19).
 * The room and the channel are genuinely the same list — same bubbles, same
 * dividers, same "load earlier" scroll-restoration problem — and the one
 * thing that differs is what goes *inside* a bubble: the room has a live,
 * unconfirmed tail on an open message, the channel has settled text and
 * possibly a tombstone. That is the `renderBody` prop, and it is the only
 * seam between them.
 *
 * Items are already projected: `{ messageId, at, speakerLabel, mine }`.
 * Neither caller passes its own storage shape in.
 */
export function MessageList({ items, scroll, empty, history, renderBody, className = 'side-scroll', unreadAfterId = '' }) {
  // Day dividers appear only when the list actually spans days (annotateDays) —
  // a channel that has run for months reads like a chat history, a one-hour
  // kelabo stays exactly as clean as before.
  const dated = useMemo(() => annotateDays(items), [items])

  // A button rather than infinite scroll, deliberately: digging days back is
  // rare, and prepending on a scroll event has to fight the viewport for
  // position. The prepended page grows the list ABOVE the reader, so the
  // scroll offset is restored manually to keep what they were looking at
  // exactly where it was.
  const loadEarlier = async () => {
    const el = scroll.ref.current
    const prevHeight = el?.scrollHeight ?? 0
    const prevTop = el?.scrollTop ?? 0
    await history.onLoadEarlier()
    requestAnimationFrame(() => {
      const now = scroll.ref.current
      if (now) now.scrollTop = prevTop + (now.scrollHeight - prevHeight)
    })
  }

  return (
    <>
      <div className={className} ref={scroll.ref} onScroll={scroll.onScroll}>
        {history?.hasMore && (
          <button className="chip chip-btn load-earlier" disabled={history.loading} onClick={loadEarlier}>
            {history.loading ? 'Loading…' : 'Load earlier messages'}
          </button>
        )}
        {items.length === 0 && <div className="empty">{empty}</div>}
        {dated.map(({ item: m, divider }) => (
          <Fragment key={m.messageId}>
            {divider && <div className="day-divider" role="separator">{divider}</div>}
            {/* Where the reader had got to, drawn once and never moved while
                they read — a line that creeps down the screen as the cursor
                advances is worse than no line. */}
            {unreadAfterId && m.messageId === unreadAfterId && (
              <div className="day-divider day-divider-new" role="separator">New</div>
            )}
            <div className={'chat-msg' + (m.mine ? ' mine' : '')}>
              <div className="chat-meta">
                <SpeakerTag name={m.speakerLabel} />
                <span className="chat-time" title={fmtFullAt(m.at)}>{fmtTime(m.at)}</span>
              </div>
              {/* `mentionsMe` marks the whole bubble rather than only the
                  `@handle` inside it: scanning a channel for "was I asked
                  something" should not require reading every line. */}
              <div
                className={
                  'chat-bubble' + (m.state === 'open' ? ' open' : '') + (m.mentionsMe ? ' chat-bubble-mention' : '')
                }
              >
                {renderBody(m)}
              </div>
            </div>
          </Fragment>
        ))}
      </div>

      {scroll.pinned && (
        <button className="jump-latest" onClick={scroll.jump}>
          <Icon name="chevron-down" size={13} /> Jump to latest
        </button>
      )}
    </>
  )
}
