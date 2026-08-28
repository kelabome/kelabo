import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { journeyChat } from '../api'
import { useAuth } from '../auth'
import { useConfirm } from '../components/ConfirmDialog'
import { usePrompt } from '../components/PromptDialog'
import { useToast } from '../components/Toaster'
import { Icon } from '../components/ui/Icon'
import { Markdown } from '../components/Markdown'
import { Banner } from '../components/ui/Banner'
import { MessageList } from './MessageList'
import { Composer } from './Composer'
import { useFollowingScroll } from './useFollowingScroll'
import { apply, applyPage, emptyChannel, firstUnreadId, projectMessages } from './messageStore.js'

/**
 * The journey's channel (docs 20 §19) — the persistent chat that outlives any
 * one kelabo.
 *
 * A journey is already the thing that carries context between meetings; this
 * is the same container with a place to talk in it. Writable for exactly as
 * long as the journey is active, which is what makes "the context stays until
 * it ends" structural rather than a promise: completing the journey freezes
 * the channel, reopening it thaws it, and nothing is archived or moved.
 *
 * Ordering, deduplication and the unread boundary are in `messageStore.js`,
 * which is pure and tested. This component fetches, polls and renders.
 */

// Phase 1 polls; phase 2 replaces this with a push over the presence stream,
// which is already open on every page. Deliberately slower than a chat feels:
// it is a stopgap, and making it fast enough to pass for live would make it
// expensive enough to be worth keeping.
const POLL_MS = 5000

// Debounced so scrolling through a busy channel does not write a cursor per
// frame; flushed on unmount and on tab-hide so leaving still marks it read.
const READ_DEBOUNCE_MS = 1200

export function JourneyChat({ journeyId, isMember, isActive, nameFor }) {
  const { identity } = useAuth()
  const me = identity?.email
  const confirm = useConfirm()
  const prompt = usePrompt()
  const toast = useToast()

  const [channel, setChannel] = useState(emptyChannel)
  const [loading, setLoading] = useState(true)
  const [loadingEarlier, setLoadingEarlier] = useState(false)
  const [error, setError] = useState(null)

  // The newest id we hold, as a ref: the poll closure must read it without
  // being torn down and rebuilt on every message.
  const newestRef = useRef('')
  newestRef.current = channel.messages.at(-1)?.msgId || ''

  // Frozen at first load. Recomputing it as the cursor advances would walk the
  // "New" line down the screen while somebody is reading past it.
  const [unreadAfterId, setUnreadAfterId] = useState('')
  const frozeUnread = useRef(false)

  const scroll = useFollowingScroll(channel.messages, true)

  // --- initial load + polling ------------------------------------------------

  useEffect(() => {
    let live = true
    setLoading(true)
    setError(null)
    journeyChat
      .messages(journeyId)
      .then(page => {
        if (!live) return
        setChannel(prev => applyPage(prev, page, { backward: true }))
        if (!frozeUnread.current) {
          setUnreadAfterId(firstUnreadId(page.messages || [], page.lastReadAt, me))
          frozeUnread.current = true
        }
      })
      .catch(e => live && setError(e))
      .finally(() => live && setLoading(false))
    return () => {
      live = false
    }
  }, [journeyId, me])

  useEffect(() => {
    if (!isMember) return undefined
    const tick = async () => {
      // Nothing loaded yet means the initial fetch is still in flight; a
      // `since`-less poll would race it and re-page the whole channel.
      if (!newestRef.current || document.hidden) return
      try {
        const page = await journeyChat.messages(journeyId, { since: newestRef.current })
        if (page.messages?.length) setChannel(prev => applyPage(prev, page))
      } catch {
        // A failed poll is not worth a banner: the next one is 5s away, and
        // the initial load already reported anything fatal.
      }
    }
    const t = setInterval(tick, POLL_MS)
    return () => clearInterval(t)
  }, [journeyId, isMember])

  // --- read cursor -----------------------------------------------------------

  const lastMarked = useRef(0)
  const markRead = useCallback(() => {
    const newest = channel.messages.at(-1)
    if (!newest || newest.at <= lastMarked.current) return
    lastMarked.current = newest.at
    journeyChat.markRead(journeyId, { at: newest.at, msgId: newest.msgId }).catch(() => {
      // The cursor is monotonic server-side and re-sent on the next message;
      // a lost write costs a stale badge for a moment, never correctness.
      lastMarked.current = 0
    })
  }, [journeyId, channel.messages])

  useEffect(() => {
    // Only while actually looking at it — marking a channel read in a
    // background tab is how unread stops meaning anything.
    if (document.hidden || !channel.messages.length) return undefined
    const t = setTimeout(markRead, READ_DEBOUNCE_MS)
    return () => clearTimeout(t)
  }, [channel.messages, markRead])

  // --- actions ---------------------------------------------------------------

  const send = async text => {
    try {
      const { message } = await journeyChat.post(journeyId, text)
      // Applied locally rather than waiting for the next poll: the same
      // "publish to everyone, apply to me" exit the room's own typed messages
      // take, so the sender never watches their own message take five seconds
      // to appear.
      setChannel(prev => apply(prev, message))
      scroll.jump()
    } catch (e) {
      toast(e.code === 'journey_completed' ? 'This journey is completed — its channel is read-only.' : 'Message not sent.')
    }
  }

  const edit = async m => {
    const next = await prompt({ title: 'Edit message', initialValue: m.text, confirmLabel: 'Save', multiline: true })
    if (next == null || !next.trim() || next.trim() === m.text) return
    try {
      const { message } = await journeyChat.edit(journeyId, m.messageId, next.trim())
      setChannel(prev => apply(prev, message))
    } catch {
      toast('Could not edit that message.')
    }
  }

  const remove = async m => {
    if (!(await confirm({ title: 'Delete this message?', body: 'It stays in place as “deleted”, so the conversation around it still reads.', confirmLabel: 'Delete', danger: true }))) return
    try {
      const { message } = await journeyChat.remove(journeyId, m.messageId)
      setChannel(prev => apply(prev, message))
    } catch {
      toast('Could not delete that message.')
    }
  }

  const pin = async m => {
    try {
      const { boardMsgId } = await journeyChat.pin(journeyId, m.messageId)
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
      const page = await journeyChat.messages(journeyId, { before: channel.nextBefore })
      setChannel(prev => applyPage(prev, page, { backward: true }))
    } catch {
      toast('Could not load earlier messages.')
    } finally {
      setLoadingEarlier(false)
    }
  }

  // --- render ----------------------------------------------------------------

  const items = useMemo(
    () => projectMessages(channel.messages, { myIdentity: me, nameFor }),
    [channel.messages, me, nameFor]
  )

  if (!isMember) {
    return <Banner kind="warn">You are not a member of this journey.</Banner>
  }

  const renderBody = m => {
    if (m.deleted) return <span className="chat-deleted">Message deleted</span>
    return (
      <>
        <Markdown text={m.text} hardBreaks />
        {m.edited && <span className="chat-edited" title="This message was edited"> (edited)</span>}
        {m.pinnedAs && (
          <span className="chat-edited" title="Pinned to the board">
            {' '}<Icon name="pin" size={11} />
          </span>
        )}
        {isActive && (
          <span className="chat-actions">
            {/* Anyone may pin — the board is the journey's shared surface and
                the message is already readable by everyone here. Editing and
                deleting stay with the author. */}
            {!m.pinnedAs && (
              <button className="chat-action" onClick={() => pin(m)} title="Pin to board" aria-label="Pin to board">
                <Icon name="pin" size={12} />
              </button>
            )}
            {m.mine && (
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
        )}
      </>
    )
  }

  return (
    <div className="channel">
      {error && <Banner kind="danger">Could not load this channel.</Banner>}
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
          empty="No messages yet. This channel stays here between kelabos — start the conversation."
          history={{ hasMore: channel.hasMore, loading: loadingEarlier, onLoadEarlier: loadEarlier }}
          renderBody={renderBody}
        />
      )}

      {isActive ? (
        <Composer onSend={send} placeholder="Message this journey…" ariaLabel="Message this journey" />
      ) : (
        <div className="channel-frozen">
          This journey is completed — its channel is read-only. Reopen it from the Helm to continue.
        </div>
      )}
    </div>
  )
}
