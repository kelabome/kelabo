import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { journeyChat } from '../api'
import { useAuth } from '../auth'
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
 * The journey's threads (docs 20 §19) — the persistent conversation that
 * outlives any one kelabo, split into named topics.
 *
 * A journey is already the thing that carries context between meetings; this
 * is the same container with places to talk in it. Writable for exactly as
 * long as the journey is active, which is what makes "the context stays until
 * it ends" structural rather than a promise: completing the journey freezes
 * every thread, reopening it thaws them, and nothing is archived or moved.
 *
 * Ordering, deduplication and the unread boundary are in `messageStore.js`,
 * which is pure and tested. This component fetches, polls and renders.
 */

// Phase 2 replaces this with a push over the presence stream, which is already
// open on every page. Deliberately slower than a chat feels: it is a stopgap,
// and making it fast enough to pass for live would make it expensive enough to
// be worth keeping.
const POLL_MS = 5000

// Debounced so scrolling through a busy thread does not write a cursor per
// frame.
const READ_DEBOUNCE_MS = 1200

export function JourneyThreads({ journeyId, isMember, isActive, threads, reloadThreads }) {
  const { identity } = useAuth()
  const me = identity?.email
  const confirm = useConfirm()
  const prompt = usePrompt()
  const toast = useToast()

  const [threadId, setThreadId] = useState('')
  const [channel, setChannel] = useState(emptyChannel)
  const [loading, setLoading] = useState(true)
  const [loadingEarlier, setLoadingEarlier] = useState(false)
  const [error, setError] = useState(null)

  const current = useMemo(() => threads?.find(t => t.threadId === threadId) || null, [threads, threadId])

  // The newest id we hold, as a ref: the poll closure must read it without
  // being torn down and rebuilt on every message.
  const newestRef = useRef('')
  newestRef.current = channel.messages.at(-1)?.msgId || ''

  // Frozen per thread. Recomputing it as the cursor advances would walk the
  // "New" line down the screen while somebody is reading past it.
  const [unreadAfterId, setUnreadAfterId] = useState('')
  const frozeUnread = useRef('')

  const scroll = useFollowingScroll(channel.messages, true)

  // --- threads ---------------------------------------------------------------
  //
  // The list itself is owned by JourneyDetail, which polls it whichever tab is
  // open — the Threads tab needs a badge while you are looking at Overview
  // (docs 20 §19.3), and a list fetched by this component would only exist
  // once you were already here.

  useEffect(() => {
    if (!threads?.length) return
    // Land on the first thread with something unread, else the most recently
    // active — which is the order the list already arrives in, General first.
    setThreadId(prev => (prev && threads.some(t => t.threadId === prev) ? prev : (threads.find(t => t.unread > 0) || threads[0]).threadId))
  }, [threads])

  const newThread = async () => {
    const title = await prompt({ title: 'New thread', placeholder: 'What is it about?', confirmLabel: 'Create' })
    if (!title?.trim()) return
    try {
      const { thread } = await journeyChat.createThread(journeyId, title.trim())
      await reloadThreads()
      setThreadId(thread.threadId)
    } catch {
      toast('Could not create that thread.')
    }
  }

  const renameThread = async t => {
    const title = await prompt({ title: 'Rename thread', initialValue: t.title, confirmLabel: 'Save' })
    if (!title?.trim() || title.trim() === t.title) return
    try {
      await journeyChat.renameThread(journeyId, t.threadId, title.trim())
      await reloadThreads()
    } catch {
      toast('Could not rename that thread.')
    }
  }

  // --- messages --------------------------------------------------------------

  useEffect(() => {
    if (!threadId) return undefined
    let live = true
    setLoading(true)
    setChannel(emptyChannel())
    journeyChat
      .messages(journeyId, threadId)
      .then(page => {
        if (!live) return
        setChannel(prev => applyPage(prev, page, { backward: true }))
        if (frozeUnread.current !== threadId) {
          setUnreadAfterId(firstUnreadId(page.messages || [], page.lastReadAt, me))
          frozeUnread.current = threadId
        }
      })
      .catch(e => live && setError(e))
      .finally(() => live && setLoading(false))
    return () => {
      live = false
    }
  }, [journeyId, threadId, me])

  useEffect(() => {
    if (!isMember || !threadId) return undefined
    const tick = async () => {
      // Nothing loaded yet means the initial fetch is still in flight; a
      // `since`-less poll would race it and re-page the whole thread.
      if (!newestRef.current || document.hidden) return
      try {
        const page = await journeyChat.messages(journeyId, threadId, { since: newestRef.current })
        if (page.messages?.length) {
          setChannel(prev => applyPage(prev, page))
          // An assistant reply, or anyone else's message, changes the other
          // threads' counts too.
          reloadThreads().catch(() => {})
        }
      } catch {
        // A failed poll is not worth a banner: the next one is 5s away, and
        // the initial load already reported anything fatal.
      }
    }
    const t = setInterval(tick, POLL_MS)
    return () => clearInterval(t)
  }, [journeyId, threadId, isMember, reloadThreads])

  // --- read cursor -----------------------------------------------------------

  const lastMarked = useRef(0)
  const markRead = useCallback(() => {
    const newest = channel.messages.at(-1)
    if (!newest || !threadId || newest.at <= lastMarked.current) return
    lastMarked.current = newest.at
    journeyChat
      .markRead(journeyId, threadId, { at: newest.at, msgId: newest.msgId })
      .then(() => reloadThreads().catch(() => {}))
      .catch(() => {
        // The cursor is monotonic server-side and re-sent on the next message;
        // a lost write costs a stale badge for a moment, never correctness.
        lastMarked.current = 0
      })
  }, [journeyId, threadId, channel.messages, reloadThreads])

  useEffect(() => {
    // Only while actually looking at it — marking a thread read in a
    // background tab is how unread stops meaning anything.
    if (document.hidden || !channel.messages.length) return undefined
    const t = setTimeout(markRead, READ_DEBOUNCE_MS)
    return () => clearTimeout(t)
  }, [channel.messages, markRead])

  // --- actions ---------------------------------------------------------------

  const send = async text => {
    try {
      const { message } = await journeyChat.post(journeyId, threadId, text)
      // Applied locally rather than waiting for the next poll: the same
      // "publish to everyone, apply to me" exit the room's own typed messages
      // take, so the sender never watches their own message take five seconds
      // to appear.
      setChannel(prev => apply(prev, message))
      scroll.jump()
    } catch (e) {
      toast(e.code === 'journey_completed' ? 'This journey is completed — its threads are read-only.' : 'Message not sent.')
    }
  }

  const edit = async m => {
    const next = await prompt({ title: 'Edit message', initialValue: m.text, confirmLabel: 'Save', multiline: true })
    if (next == null || !next.trim() || next.trim() === m.text) return
    try {
      const { message } = await journeyChat.edit(journeyId, threadId, m.messageId, next.trim())
      setChannel(prev => apply(prev, message))
    } catch {
      toast('Could not edit that message.')
    }
  }

  const remove = async m => {
    if (!(await confirm({ title: 'Delete this message?', body: 'It stays in place as “deleted”, so the conversation around it still reads.', confirmLabel: 'Delete', danger: true }))) return
    try {
      const { message } = await journeyChat.remove(journeyId, threadId, m.messageId)
      setChannel(prev => apply(prev, message))
    } catch {
      toast('Could not delete that message.')
    }
  }

  const pin = async m => {
    try {
      const { boardMsgId } = await journeyChat.pin(journeyId, threadId, m.messageId)
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
      const page = await journeyChat.messages(journeyId, threadId, { before: channel.nextBefore })
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
    <div className="threads">
      <aside className="thread-rail">
        <div className="thread-rail-head">
          <span className="menu-label">Threads</span>
          {isActive && (
            <Button variant="ghost" size="sm" iconOnly onClick={newThread} title="New thread" aria-label="New thread">
              <Icon name="plus" size={15} />
            </Button>
          )}
        </div>
        <div className="thread-rail-list">
          {threads === null && <div className="menu-empty">Loading…</div>}
          {threads?.map(t => (
            <button
              type="button"
              key={t.threadId}
              className={'thread-item' + (t.threadId === threadId ? ' is-on' : '')}
              onClick={() => setThreadId(t.threadId)}
              onDoubleClick={() => isActive && renameThread(t)}
              title={isActive ? 'Double-click to rename' : t.title}
            >
              <span className="thread-item-title">{t.title}</span>
              {/* A mention badge outranks a plain count: "somebody wants you"
                  and "there is something here" are different messages. */}
              {t.mentions > 0 ? (
                <span className="thread-badge thread-badge-mention">@{t.mentions}</span>
              ) : t.unread > 0 ? (
                <span className="thread-badge">{t.unread}</span>
              ) : null}
            </button>
          ))}
        </div>
      </aside>

      <div className="channel">
        {error && <Banner kind="danger">Could not load this thread.</Banner>}
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
            empty={`No messages in “${current?.title || 'this thread'}” yet. Threads stay here between kelabos — start the conversation.`}
            history={{ hasMore: channel.hasMore, loading: loadingEarlier, onLoadEarlier: loadEarlier }}
            renderBody={renderBody}
            renderActions={renderActions}
          />
        )}

        {isActive ? (
          <Composer
            onSend={send}
            placeholder={`Message ${current?.title || 'this thread'}… or @kelabo to ask`}
            ariaLabel="Message this thread"
            disabled={!threadId}
          />
        ) : (
          <div className="channel-frozen">
            This journey is completed — its threads are read-only. Reopen it from the Helm to continue.
          </div>
        )}
      </div>
    </div>
  )
}
