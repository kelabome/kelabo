// Journey channel reducer tests (docs 20 §19). Plain node, no DOM, no network
// — `src/chat/messageStore.js` is pure for exactly this reason, the same one
// the transcript modules are.
//
// What is asserted here is everything that is invisible until it is wrong:
// that create, edit and delete all merge through one path; that a late or
// duplicated delivery cannot un-edit a message; that ordering is by id rather
// than timestamp; and where the unread line goes.
import assert from 'node:assert/strict'
import {
  apply,
  applyPage,
  emptyChannel,
  firstUnreadId,
  projectMessages,
} from '../src/chat/messageStore.js'
import { findMentionTokens, mentionsIdentity, MENTION_SOURCE } from '../src/chat/mentions.js'
import { journeyUnread, threadUnread, cursorsByThread } from '../../contracts/src/journeyUnread.js'

let passed = 0
const ok = msg => {
  console.log('ok -', msg)
  passed++
}

const msg = (msgId, over = {}) => ({
  msgId,
  threadId: 'general',
  at: Number(msgId.split('-')[0]),
  author: 'alice@example.com',
  text: 'hello',
  kind: 'message',
  ...over,
})

// --- ordering ---------------------------------------------------------------

{
  const a = msg('0000000000001-aaaaaa')
  const b = msg('0000000000002-bbbbbb')
  const c = msg('0000000000003-cccccc')
  const state = apply(emptyChannel(), [c, a, b])
  assert.deepEqual(state.messages.map(m => m.msgId), [a.msgId, b.msgId, c.msgId])
  ok('messages sort into id order however they arrive')
}

{
  // Two messages in the same millisecond. `at` alone is a partial order and
  // would let them swap between renders; the id is total, which is why the
  // server issues it from a monotonic clock and why this sorts on it.
  const first = { ...msg('0000000000005-aaaaaa'), at: 5 }
  const second = { ...msg('0000000000005-bbbbbb'), at: 5 }
  const state = apply(emptyChannel(), [second, first])
  assert.deepEqual(state.messages.map(m => m.msgId), [first.msgId, second.msgId])
  ok('a shared timestamp still has one stable order')
}

// --- one merge path for create, edit and delete -----------------------------

{
  const original = msg('0000000000001-aaaaaa', { text: 'teh plan' })
  let state = apply(emptyChannel(), original)

  const edited = { ...original, text: 'the plan', editedAt: 500 }
  state = apply(state, edited)
  assert.equal(state.messages.length, 1, 'an edit is the same message, not a second one')
  assert.equal(state.messages[0].text, 'the plan')

  const removed = { ...original, text: '', deletedAt: 900 }
  state = apply(state, removed)
  assert.equal(state.messages.length, 1)
  assert.equal(state.messages[0].text, '')
  assert.ok(state.messages[0].deletedAt)
  ok('create, edit and delete are one wire shape through one merge path')
}

{
  // The poll and the local echo of your own POST deliver the same message.
  // Twice through the reducer must be indistinguishable from once — this is
  // the property that lets the component apply its own result optimistically.
  const m = msg('0000000000001-aaaaaa')
  const once = apply(emptyChannel(), m)
  const twice = apply(once, m)
  assert.equal(twice.messages.length, 1)
  assert.equal(twice, once, 'an unchanged merge returns the same object')
  ok('a duplicate delivery changes nothing, and does not re-render')
}

{
  // A page fetched before an edit, arriving after it. Without the staleness
  // check the older copy wins and the message silently reverts.
  const original = msg('0000000000001-aaaaaa', { text: 'teh plan' })
  const edited = { ...original, text: 'the plan', editedAt: 500 }
  let state = apply(emptyChannel(), edited)
  state = apply(state, original)
  assert.equal(state.messages[0].text, 'the plan', 'a late stale copy does not un-edit')

  let deleted = apply(emptyChannel(), { ...original, text: '', deletedAt: 900 })
  deleted = apply(deleted, edited)
  assert.ok(deleted.messages[0].deletedAt, 'a late stale copy does not un-delete')
  ok('out-of-order delivery never rolls a message backwards')
}

// --- paging -----------------------------------------------------------------

{
  const backward = applyPage(emptyChannel(), {
    messages: [msg('0000000000002-bbbbbb')],
    hasMore: true,
    nextBefore: '0000000000002-bbbbbb',
    lastReadAt: 1,
    unreadCount: 3,
  }, { backward: true })
  assert.equal(backward.hasMore, true)
  assert.equal(backward.nextBefore, '0000000000002-bbbbbb')
  assert.equal(backward.unreadCount, 3)

  // A forward (`since`) page is a catch-up. It knows nothing about how much
  // history sits behind the oldest thing loaded, so it must not overwrite what
  // the backward page established — doing so silently hides "load earlier".
  const forward = applyPage(backward, { messages: [msg('0000000000003-cccccc')], hasMore: false, nextBefore: '' })
  assert.equal(forward.hasMore, true, 'a catch-up page does not clear hasMore')
  assert.equal(forward.nextBefore, '0000000000002-bbbbbb')
  assert.equal(forward.messages.length, 2)
  ok('only a backward page may set the history cursor')
}

// --- the unread boundary ----------------------------------------------------

{
  const messages = [
    msg('0000000000001-aaaaaa', { at: 1 }),
    msg('0000000000002-bbbbbb', { at: 2 }),
    msg('0000000000003-cccccc', { at: 3, author: 'bob@example.com' }),
  ]
  assert.equal(firstUnreadId(messages, 0, 'me@example.com'), messages[0].msgId, 'never opened: all of it is new')
  assert.equal(firstUnreadId(messages, 2, 'me@example.com'), messages[2].msgId)
  assert.equal(firstUnreadId(messages, 3, 'me@example.com'), '', 'caught up: no line')

  // Your own message is not news to you. Without this, sending anything from a
  // second device puts a "New" line above your own words.
  assert.equal(firstUnreadId(messages, 1, 'alice@example.com'), messages[2].msgId)
  ok('the unread line skips your own messages, and disappears when caught up')
}

// --- projection -------------------------------------------------------------

{
  const items = projectMessages(
    [
      msg('0000000000001-aaaaaa'),
      msg('0000000000002-bbbbbb', { author: 'bot', kind: 'assistant', text: 'here' }),
      msg('0000000000003-cccccc', { author: 'bob@example.com', text: '', deletedAt: 9 }),
      msg('0000000000004-dddddd', { editedAt: 9 }),
    ],
    { myIdentity: 'alice@example.com', nameFor: id => (id === 'alice@example.com' ? 'Alice' : null) }
  )
  assert.equal(items[0].messageId, '0000000000001-aaaaaa', 'keyed as messageId, like the room list it shares')
  assert.equal(items[0].mine, true)
  assert.equal(items[0].speakerLabel, 'Alice')
  assert.equal(items[1].speakerLabel, 'Kelabo')
  assert.equal(items[1].assistant, true)
  assert.equal(items[1].mine, false)
  // The Gateway has no users table and never learns display names, so an
  // unresolvable identity shows the identity rather than a blank.
  assert.equal(items[2].speakerLabel, 'bob@example.com')
  assert.equal(items[2].deleted, true)
  assert.equal(items[3].edited, true)
  assert.equal(items[2].edited, false, 'a deleted message does not also read as edited')
  ok('projection resolves names, ownership and state for the shared list')
}

// --- the mention grammar (docs 20 §19.8) ------------------------------------
//
// This restates the rule in contracts/src/mention.js, which the SPA cannot
// import. The restatement is only safe if it fails in the styling direction —
// so the case worth pinning is the false positive, not the miss.

{
  assert.deepEqual(findMentionTokens('@bob take a look').map(t => t.token), ['@bob'])
  assert.deepEqual(findMentionTokens('cc @bob and @carol').map(t => t.token), ['@bob', '@carol'])
  assert.deepEqual(findMentionTokens('@bob@example.com').map(t => t.token), ['@bob@example.com'])
  assert.deepEqual(findMentionTokens('nothing here'), [])
  ok('mention tokens are found with their offsets')
}

{
  // The whole reason for the lookbehind. Without it this matches at the `@`
  // and styles "@example.com" as a mention of a domain.
  assert.deepEqual(findMentionTokens('write to bob@example.com about it'), [])
  assert.deepEqual(findMentionTokens('see foo.bar@example.com'), [])
  // A deliberate full-address mention still matches — once, not twice: the
  // domain half must not be picked up as a mention of its own.
  assert.equal(findMentionTokens('@bob@example.com please').length, 1)
  ok('an email address in prose is not styled as a mention')
}

{
  // It is a /g/ regex behind a helper. A shared lastIndex between calls would
  // make every other message lose its first mention — invisibly, and only for
  // some messages.
  for (let i = 0; i < 3; i++) assert.equal(findMentionTokens('@bob hi').length, 1)
  ok('the matcher is stateless across calls')
}

{
  assert.equal(mentionsIdentity('@bob hi', 'bob@example.com'), true, 'local part')
  assert.equal(mentionsIdentity('@bob@example.com hi', 'bob@example.com'), true, 'whole address')
  assert.equal(mentionsIdentity('@Bob hi', 'bob@example.com'), true, 'case-insensitive')
  assert.equal(mentionsIdentity('@carol hi', 'bob@example.com'), false)
  assert.equal(mentionsIdentity('mail bob@example.com', 'bob@example.com'), false, 'prose is not a mention')
  assert.equal(mentionsIdentity('@bob hi', null), false)
  ok('an identity is matched by local part or whole address')
}

{
  // Markdown.jsx composes this into its inline alternation. If the source ever
  // gains a capturing group, `m[0]` in renderInline still works but the
  // alternation's group numbering shifts under every other token — so the
  // grammar stays group-free by construction.
  assert.equal(/\((?!\?)/.test(MENTION_SOURCE), false, 'no capturing groups')
  assert.doesNotThrow(() => new RegExp(`(x)|(${MENTION_SOURCE})`, 'gi'))
  ok('the token source composes into the inline alternation')
}

// --- mentions and pins in the projection ------------------------------------

{
  const items = projectMessages(
    [
      msg('0000000000001-aaaaaa', { mentionsMe: true }),
      msg('0000000000002-bbbbbb', { pinnedAs: 'board-uuid' }),
      msg('0000000000003-cccccc'),
    ],
    { myIdentity: 'alice@example.com' }
  )
  // Carried from the server, never re-derived from the text: the server
  // resolved handles against a real roster to decide whose badge to raise, and
  // a second implementation here could disagree with the count it is built from.
  assert.equal(items[0].mentionsMe, true)
  assert.equal(items[1].mentionsMe, false)
  assert.equal(items[1].pinnedAs, 'board-uuid')
  assert.equal(items[2].pinnedAs, '')
  ok('mentionsMe and pinnedAs come from the server, not from the text')
}

{
  // Pinning changes `pinnedAs` and stamps no new timestamp, so a dedupe that
  // compared only `text` treated the local update as a duplicate and dropped
  // it — the pin marker then appeared only when a later poll happened to
  // bring it. Anything that can change without moving the stamp belongs in
  // the comparison.
  const m = msg('0000000000001-aaaaaa')
  let state = apply(emptyChannel(), m)
  state = apply(state, { ...m, pinnedAs: 'board-uuid' })
  assert.equal(state.messages[0].pinnedAs, 'board-uuid')
  assert.equal(state.messages.length, 1)

  state = apply(state, { ...m, pinnedAs: 'board-uuid', mentionsMe: true })
  assert.equal(state.messages[0].mentionsMe, true)
  ok('a change that moves no timestamp is still a change')
}

{
  const page = applyPage(emptyChannel(), { messages: [], unreadCount: 4, unreadMentions: 2 }, { backward: true })
  assert.equal(page.unreadMentions, 2)
  // A catch-up page that says nothing about mentions must not clear the count.
  assert.equal(applyPage(page, { messages: [] }).unreadMentions, 2)
  ok('the mention badge survives a page that does not mention it')
}

// --- the unread rollup (docs 20 §19.3) --------------------------------------
//
// Shared with rest-api through contracts, because the Gateway answers this per
// thread and the journey list rolls it up, and two implementations is how a
// badge says 3 while the thread it points at shows 5.

{
  const threads = [
    { threadId: 'a', messageCount: 5 },
    { threadId: 'b', messageCount: 2 },
  ]
  const cursors = cursorsByThread([
    { SK: 'READ#me@x.com#a', threadId: 'a', messageCountAtRead: 5, mentionCount: 2, mentionCountAtRead: 1 },
  ])
  const roll = journeyUnread(threads, cursors)
  // Thread b has no cursor at all: never having opened a thread is not the
  // same as having read it, which is what makes a new member see the backlog.
  assert.equal(roll.unread, 2)
  assert.equal(roll.mentions, 1)
  assert.equal(roll.perThread.a.unread, 0)
  assert.equal(roll.perThread.b.unread, 2)
  ok('a journey rolls up to the sum of its threads')
}

{
  // The reason a journey-level counter cannot replace the sum: it would be
  // advanced by reading one thread and would hide every other thread's unread.
  const threads = [
    { threadId: 'a', messageCount: 3 },
    { threadId: 'b', messageCount: 4 },
  ]
  const readA = cursorsByThread([{ threadId: 'a', messageCountAtRead: 3 }])
  assert.equal(journeyUnread(threads, readA).unread, 4, 'reading one thread does not clear the other')
}

{
  // Clamped: a cursor written before a counter existed, or rows tidied by
  // hand, must read as nothing-unread rather than as a negative badge.
  assert.equal(threadUnread({ messageCount: 1 }, { messageCountAtRead: 9 }).unread, 0)
  assert.equal(threadUnread({ messageCount: 3 }, null).unread, 3)
  assert.equal(threadUnread(null, null).unread, 0)
  // An archived thread contributes nothing to the journey badge.
  assert.equal(journeyUnread([{ threadId: 'a', messageCount: 9, archived: true }], {}).unread, 0)
  ok('the rollup clamps at zero and ignores archived threads')
}

console.log(`\nspa/journeyChat: ${passed} passed`)
