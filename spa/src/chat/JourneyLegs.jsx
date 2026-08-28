import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { journeyLegs } from '../api'
import { useAuth } from '../auth'
import { usePresenceContext } from '../presence/PresenceContext'
import { useConfirm } from '../components/ConfirmDialog'
import { usePrompt } from '../components/PromptDialog'
import { useToast } from '../components/Toaster'
import { Icon } from '../components/ui/Icon'
import { Button } from '../components/ui/Button'
import { Markdown } from '../components/Markdown'
import { Banner } from '../components/ui/Banner'
import { MessageList } from './MessageList'
import { Composer } from './Composer'
import { useFollowingScroll } from './useFollowingScroll'
import { apply, applyPage, emptyChannel, firstUnreadId, projectMessages } from './messageStore.js'

/**
 * The journey's legs (docs 20 §19) — the persistent conversation that
 * outlives any one kelabo, split into named topics.
 *
 * A journey is already the thing that carries context between meetings; this
 * is the same container with places to talk in it. Writable for exactly as
 * long as the journey is active, which is what makes "the context stays until
 * it ends" structural rather than a promise: completing the journey freezes
 * every leg, reopening it thaws them, and nothing is archived or moved.
 *
 * Ordering, deduplication and the unread boundary are in `messageStore.js`,
 * which is pure and tested. This component fetches, polls and renders.
 */

// Messages arrive by push over the presence stream (docs 20 §19.9). This poll
// is the backstop for the one thing push cannot promise: that stream has no
// replay, so an event missed across a reconnect would otherwise be a message
// that never appears. `since` makes each check cheap — usually an empty page.
const POLL_MS = 45000

// Debounced so scrolling through a busy leg does not write a cursor per
// frame.
const READ_DEBOUNCE_MS = 1200

export function JourneyLegs({ journeyId, isMember, isActive, legs, reloadLegs }) {
  const { identity } = useAuth()
  const { onJourneyMessage } = usePresenceContext()
  const me = identity?.email
  const confirm = useConfirm()
  const prompt = usePrompt()
  const toast = useToast()

  const [legId, setLegId] = useState('')
  const [channel, setChannel] = useState(emptyChannel)
  const [loading, setLoading] = useState(true)
  const [loadingEarlier, setLoadingEarlier] = useState(false)
  const [error, setError] = useState(null)

  const current = useMemo(() => legs?.find(t => t.legId === legId) || null, [legs, legId])

  // --- filtering the rail ----------------------------------------------------
  //
  // A journey that has run for months has a long list, and the leg somebody
  // wants is usually one they can name. Purely a view over what is already
  // loaded: no fetch, no server round trip, instant.
  //
  // It filters what is *rendered* and nothing else. The selection effect below
  // still reads the full `legs`, deliberately — feeding it a filtered list
  // would make typing into this box silently switch which conversation you
  // are reading.
  const [filtering, setFiltering] = useState(false)
  const [filter, setFilter] = useState('')
  const filterRef = useRef(null)

  const closeFilter = () => {
    setFiltering(false)
    setFilter('')
  }
  const toggleFilter = () => (filtering ? closeFilter() : setFiltering(true))
  useEffect(() => {
    if (filtering) filterRef.current?.focus()
  }, [filtering])

  const visibleLegs = useMemo(() => {
    const q = filter.trim().toLowerCase()
    if (!q) return legs || []
    // Substring, case-insensitive — the same rule the record and journey
    // searches use, so "what counts as a match" means one thing in this
    // product.
    return (legs || []).filter(t => (t.title || '').toLowerCase().includes(q))
  }, [legs, filter])

  const hiddenCount = (legs?.length || 0) - visibleLegs.length

  // The newest id we hold, as a ref: the poll closure must read it without
  // being torn down and rebuilt on every message.
  const newestRef = useRef('')
  newestRef.current = channel.messages.at(-1)?.msgId || ''

  // Frozen per leg. Recomputing it as the cursor advances would walk the
  // "New" line down the screen while somebody is reading past it.
  const [unreadAfterId, setUnreadAfterId] = useState('')
  const frozeUnread = useRef('')

  const scroll = useFollowingScroll(channel.messages, true)

  // --- legs ---------------------------------------------------------------
  //
  // The list itself is owned by JourneyDetail, which polls it whichever tab is
  // open — the Legs tab needs a badge while you are looking at Overview
  // (docs 20 §19.3), and a list fetched by this component would only exist
  // once you were already here.

  useEffect(() => {
    if (!legs?.length) return
    // Land on the first leg with something unread, else the most recently
    // active — which is the order the list already arrives in, Trunk first.
    setLegId(prev => (prev && legs.some(t => t.legId === prev) ? prev : (legs.find(t => t.unread > 0) || legs[0]).legId))
  }, [legs])

  const newLeg = async () => {
    const title = await prompt({ title: 'New leg', placeholder: 'What is it about?', confirmLabel: 'Create' })
    if (!title?.trim()) return
    try {
      const { leg } = await journeyLegs.createLeg(journeyId, title.trim())
      await reloadLegs()
      setLegId(leg.legId)
    } catch {
      toast('Could not create that leg.')
    }
  }

  const renameLeg = async t => {
    const title = await prompt({ title: 'Rename leg', initialValue: t.title, confirmLabel: 'Save' })
    if (!title?.trim() || title.trim() === t.title) return
    try {
      await journeyLegs.renameLeg(journeyId, t.legId, title.trim())
      await reloadLegs()
    } catch {
      toast('Could not rename that leg.')
    }
  }

  // --- messages --------------------------------------------------------------

  useEffect(() => {
    if (!legId) return undefined
    let live = true
    setLoading(true)
    setChannel(emptyChannel())
    journeyLegs
      .messages(journeyId, legId)
      .then(page => {
        if (!live) return
        setChannel(prev => applyPage(prev, page, { backward: true }))
        if (frozeUnread.current !== legId) {
          setUnreadAfterId(firstUnreadId(page.messages || [], page.lastReadAt, me))
          frozeUnread.current = legId
        }
      })
      .catch(e => live && setError(e))
      .finally(() => live && setLoading(false))
    return () => {
      live = false
    }
  }, [journeyId, legId, me])

  // A message in the leg you are reading is applied the moment it arrives
  // (docs 20 §19.9) — the whole message rides the event, so there is nothing
  // to go and fetch. This is the difference between a chat and a page that
  // refreshes.
  useEffect(() => {
    if (!isMember || !legId) return undefined
    return onJourneyMessage(evt => {
      if (evt.journeyId !== journeyId || evt.legId !== legId || !evt.message) return
      // Through the same reducer as everything else: it merges by msgId, so
      // the echo of your own message and a duplicate delivery both collapse
      // into the copy already held.
      setChannel(prev => apply(prev, evt.message))
    })
  }, [journeyId, legId, isMember, onJourneyMessage])

  useEffect(() => {
    if (!isMember || !legId) return undefined
    const tick = async () => {
      // Nothing loaded yet means the initial fetch is still in flight; a
      // `since`-less poll would race it and re-page the whole leg.
      if (!newestRef.current || document.hidden) return
      try {
        const page = await journeyLegs.messages(journeyId, legId, { since: newestRef.current })
        if (page.messages?.length) {
          setChannel(prev => applyPage(prev, page))
          // An assistant reply, or anyone else's message, changes the other
          // legs' counts too.
          reloadLegs().catch(() => {})
        }
      } catch {
        // A failed poll is not worth a banner: the next one is a while away,
        // and the initial load already reported anything fatal.
      }
    }
    const t = setInterval(tick, POLL_MS)
    return () => clearInterval(t)
  }, [journeyId, legId, isMember, reloadLegs])

  // --- read cursor -----------------------------------------------------------

  const lastMarked = useRef(0)
  const markRead = useCallback(() => {
    const newest = channel.messages.at(-1)
    if (!newest || !legId || newest.at <= lastMarked.current) return
    lastMarked.current = newest.at
    journeyLegs
      .markRead(journeyId, legId, { at: newest.at, msgId: newest.msgId })
      .then(() => reloadLegs().catch(() => {}))
      .catch(() => {
        // The cursor is monotonic server-side and re-sent on the next message;
        // a lost write costs a stale badge for a moment, never correctness.
        lastMarked.current = 0
      })
  }, [journeyId, legId, channel.messages, reloadLegs])

  useEffect(() => {
    // Only while actually looking at it — marking a leg read in a
    // background tab is how unread stops meaning anything.
    if (document.hidden || !channel.messages.length) return undefined
    const t = setTimeout(markRead, READ_DEBOUNCE_MS)
    return () => clearTimeout(t)
  }, [channel.messages, markRead])

  // --- actions ---------------------------------------------------------------

  const send = async text => {
    try {
      const { message } = await journeyLegs.post(journeyId, legId, text)
      // Applied locally rather than waiting for the next poll: the same
      // "publish to everyone, apply to me" exit the room's own typed messages
      // take, so the sender never watches their own message take five seconds
      // to appear.
      setChannel(prev => apply(prev, message))
      scroll.jump()
    } catch (e) {
      toast(e.code === 'journey_completed' ? 'This journey is completed — its legs are read-only.' : 'Message not sent.')
    }
  }

  const edit = async m => {
    const next = await prompt({ title: 'Edit message', initialValue: m.text, confirmLabel: 'Save', multiline: true })
    if (next == null || !next.trim() || next.trim() === m.text) return
    try {
      const { message } = await journeyLegs.edit(journeyId, legId, m.messageId, next.trim())
      setChannel(prev => apply(prev, message))
    } catch {
      toast('Could not edit that message.')
    }
  }

  const remove = async m => {
    if (!(await confirm({ title: 'Delete this message?', body: 'It stays in place as “deleted”, so the conversation around it still reads.', confirmLabel: 'Delete', danger: true }))) return
    try {
      const { message } = await journeyLegs.remove(journeyId, legId, m.messageId)
      setChannel(prev => apply(prev, message))
    } catch {
      toast('Could not delete that message.')
    }
  }

  const pin = async m => {
    try {
      const { boardMsgId } = await journeyLegs.pin(journeyId, legId, m.messageId)
      setChannel(prev => apply(prev, { ...prev.messages.find(x => x.msgId === m.messageId), pinnedAs: boardMsgId }))
      toast('Pinned to the board.')
    } catch (e) {
      toast(e.code === 'message_deleted' ? 'A deleted message cannot be pinned.' : 'Could not pin that message.')
    }
  }

  const loadEarlier = async () => {
    if (!channel.nextBefore) return
    setLoadingEarlier(true)
    try {
      const page = await journeyLegs.messages(journeyId, legId, { before: channel.nextBefore })
      setChannel(prev => applyPage(prev, page, { backward: true }))
    } catch {
      toast('Could not load earlier messages.')
    } finally {
      setLoadingEarlier(false)
    }
  }

  // --- render ----------------------------------------------------------------

  const items = useMemo(() => projectMessages(channel.messages, { myIdentity: me }), [channel.messages, me])

  if (!isMember) return <Banner kind="warn">You are not a member of this journey.</Banner>

  const renderBody = m => {
    if (m.deleted) return <span className="chat-deleted">Message deleted</span>
    return (
      <>
        <Markdown text={m.text} hardBreaks />
        {m.edited && <span className="chat-edited" title="This message was edited"> (edited)</span>}
      </>
    )
  }

  /** Controls sit on the metadata line, after the timestamp — not in the
   *  bubble. Markdown emits block elements, so anything appended to the body
   *  is pushed onto a line of its own beneath the message. */
  const renderActions = m => {
    if (m.deleted) return null
    const canPin = isActive && !m.pinnedAs && !m.assistant
    const canEdit = isActive && m.mine
    if (!m.pinnedAs && !canPin && !canEdit) return null
    return (
      <span className="chat-actions">
        {m.pinnedAs && (
          <span className="chat-pinned" title="Pinned to the board">
            <Icon name="pin" size={11} />
          </span>
        )}
        {/* Anyone may pin — the board is the journey's shared surface and the
            message is already readable by everyone here. Editing and deleting
            stay with the author. */}
        {canPin && (
          <button className="chat-action" onClick={() => pin(m)} title="Pin to board" aria-label="Pin to board">
            <Icon name="pin" size={12} />
          </button>
        )}
        {canEdit && (
          <>
            <button className="chat-action" onClick={() => edit(m)} title="Edit" aria-label="Edit message">
              <Icon name="pencil" size={12} />
            </button>
            <button className="chat-action" onClick={() => remove(m)} title="Delete" aria-label="Delete message">
              <Icon name="x" size={12} />
            </button>
          </>
        )}
      </span>
    )
  }

  return (
    <div className="legs">
      <aside className="leg-rail">
        <div className="leg-rail-head">
          <span className="menu-label">Legs</span>
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            onClick={toggleFilter}
            title={filtering ? 'Close filter' : 'Filter legs'}
            aria-label={filtering ? 'Close filter' : 'Filter legs'}
            aria-expanded={filtering}
          >
            <Icon name={filtering ? 'x' : 'search'} size={15} />
          </Button>
          {isActive && (
            <Button variant="ghost" size="sm" iconOnly onClick={newLeg} title="New leg" aria-label="New leg">
              <Icon name="plus" size={15} />
            </Button>
          )}
        </div>

        {filtering && (
          <div className="leg-filter">
            <Icon name="search" size={13} />
            <input
              ref={filterRef}
              className="input"
              value={filter}
              placeholder="Filter legs…"
              aria-label="Filter legs by name"
              onChange={e => setFilter(e.target.value)}
              // Escape closes and clears, so the list is never left filtered
              // by a box the reader has already dismissed from their mind.
              onKeyDown={e => {
                if (e.key === 'Escape') closeFilter()
              }}
            />
          </div>
        )}

        <div className="leg-rail-list">
          {legs === null && <div className="menu-empty">Loading…</div>}
          {legs !== null && visibleLegs.length === 0 && (
            <div className="menu-empty">{filter.trim() ? 'No leg matches that.' : 'No legs yet.'}</div>
          )}
          {visibleLegs.map(t => (
            <button
              type="button"
              key={t.legId}
              className={'leg-item' + (t.legId === legId ? ' is-on' : '')}
              onClick={() => setLegId(t.legId)}
              onDoubleClick={() => isActive && renameLeg(t)}
              title={isActive ? 'Double-click to rename' : t.title}
            >
              <span className="leg-item-title">{t.title}</span>
              {/* A mention badge outranks a plain count: "somebody wants you"
                  and "there is something here" are different messages. */}
              {t.mentions > 0 ? (
                <span className="leg-badge leg-badge-mention">@{t.mentions}</span>
              ) : t.unread > 0 ? (
                <span className="leg-badge">{t.unread}</span>
              ) : null}
            </button>
          ))}
          {/* Says plainly that the list is a subset. Without it a filtered
              rail and a journey with three legs look identical, and somebody
              concludes the rest are gone. */}
          {hiddenCount > 0 && (
            <div className="leg-filter-note">
              {hiddenCount} more hidden by the filter
            </div>
          )}
        </div>
      </aside>

      <div className="channel">
        {error && <Banner kind="danger">Could not load this leg.</Banner>}
        {channel.unreadMentions > 0 && (
          <div className="channel-mentions">
            <Icon name="at" size={13} />
            {channel.unreadMentions} unread mention{channel.unreadMentions === 1 ? '' : 's'}
          </div>
        )}
        {loading && !channel.messages.length ? (
          <div className="channel-scroll"><div className="empty">Loading…</div></div>
        ) : (
          <MessageList
            items={items}
            scroll={scroll}
            className="channel-scroll"
            unreadAfterId={unreadAfterId}
            empty={`No messages in “${current?.title || 'this leg'}” yet. Legs stay here between kelabos — start the conversation.`}
            history={{ hasMore: channel.hasMore, loading: loadingEarlier, onLoadEarlier: loadEarlier }}
            renderBody={renderBody}
            renderActions={renderActions}
          />
        )}

        {isActive ? (
          <Composer
            onSend={send}
            placeholder={`Message ${current?.title || 'this leg'}… or @kelabo to ask`}
            ariaLabel="Message this leg"
            disabled={!legId}
          />
        ) : (
          <div className="channel-frozen">
            This journey is completed — its legs are read-only. Reopen it from the Helm to continue.
          </div>
        )}
      </div>
    </div>
  )
}
