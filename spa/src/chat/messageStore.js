/**
 * The journey channel's reducer (docs 20 §19) — pure, so `spa/test/journeyChat.mjs`
 * can run it under plain node.
 *
 * It exists for the same reason `transcript/composer.js` and
 * `transcript/transcriptStore.js` do: everything else in the channel needs a
 * browser, a session cookie and a live journey, so a merge bug is only
 * findable in a real deployment. Ordering, deduplication and the unread
 * boundary are decided here — no React, no fetch, no clock of its own — and
 * the components below stay dumb enough to be obviously correct.
 *
 * Imports carry `.js` for the same reason the transcript modules' do.
 */

/**
 * One list, one merge path.
 *
 * A message arrives from three places — the page you loaded, the reply to
 * your own POST, and (from phase 2) the live fan-out — and all three go
 * through `apply`. This is the same rule the room's transcript learned:
 * a second path for "my" messages versus "theirs" is what made a speaker and
 * a listener render different things.
 */
export function emptyChannel() {
  return { messages: [], hasMore: false, nextBefore: '', lastReadAt: 0, unreadCount: 0, unreadMentions: 0 }
}

/**
 * Upsert by `msgId`, newest state wins, kept in id order.
 *
 * Sorting by `msgId` rather than `at` is not an optimisation: the id is
 * `<pad(at,13)>-<rand6>`, so it is a total order where `at` alone is only a
 * partial one, and two messages sharing a millisecond would otherwise sort
 * differently on every render.
 *
 * Last-write-wins is what makes one wire shape enough for create, edit and
 * delete: an edit is the same message with new text, and a tombstone is the
 * same message with `deletedAt`, so neither needs an event of its own.
 */
export function apply(state, incoming) {
  const list = Array.isArray(incoming) ? incoming : [incoming]
  if (!list.length) return state
  const byId = new Map(state.messages.map(m => [m.msgId, m]))
  let changed = false
  for (const m of list) {
    if (!m?.msgId) continue
    const prev = byId.get(m.msgId)
    // An out-of-order delivery must not un-edit or un-delete a message we
    // already have in a later state.
    if (prev && stamp(prev) > stamp(m)) continue
    if (prev && stamp(prev) === stamp(m) && same(prev, m)) continue
    byId.set(m.msgId, m)
    changed = true
  }
  if (!changed) return state
  const messages = [...byId.values()].sort((a, b) => (a.msgId < b.msgId ? -1 : a.msgId > b.msgId ? 1 : 0))
  return { ...state, messages }
}

/** How current a copy of a message is: its last mutation, or its birth. */
const stamp = m => m.deletedAt || m.editedAt || m.at || 0

/**
 * Is this the same copy we already hold, for a delivery of the same age?
 *
 * `text` alone is not enough, and the gap was real: pinning changes only
 * `pinnedAs` and stamps no new timestamp, so the local update after a pin
 * compared equal to the copy already held, was skipped as a duplicate, and the
 * pin marker did not appear until the next poll happened to bring it.
 * Anything that can change without moving `stamp` has to be listed here.
 */
const same = (a, b) => a.text === b.text && (a.pinnedAs || '') === (b.pinnedAs || '') && !!a.mentionsMe === !!b.mentionsMe

/**
 * Fold a page response in, keeping the paging fields that came with it.
 *
 * `hasMore`/`nextBefore` are only meaningful for a backward page — a forward
 * (`since`) page is a catch-up and says nothing about how much history exists
 * behind it, so it must not overwrite what a backward page established.
 */
export function applyPage(state, page, { backward = false } = {}) {
  const next = apply(state, page?.messages ?? [])
  return {
    ...next,
    ...(backward ? { hasMore: !!page?.hasMore, nextBefore: page?.nextBefore || '' } : {}),
    lastReadAt: typeof page?.lastReadAt === 'number' ? page.lastReadAt : next.lastReadAt,
    unreadCount: typeof page?.unreadCount === 'number' ? page.unreadCount : next.unreadCount,
    unreadMentions: typeof page?.unreadMentions === 'number' ? page.unreadMentions : next.unreadMentions,
  }
}

/**
 * The id of the first message the reader has not seen, or `''`.
 *
 * Frozen by the caller for the life of a visit rather than recomputed as the
 * cursor advances: a "new messages" line that moves down the screen while you
 * are reading is worse than no line at all.
 */
export function firstUnreadId(messages, lastReadAt, myIdentity) {
  if (!lastReadAt) return messages.length ? messages[0].msgId : ''
  const first = messages.find(m => m.at > lastReadAt && m.author !== myIdentity)
  return first ? first.msgId : ''
}

/**
 * Project stored messages into what the list renders.
 *
 * `messageId` rather than `msgId` because the shared `MessageList` keys on it,
 * and it renders the room's transcript too — one key name, one component.
 * Display names are resolved here, from whatever the caller knows: the
 * Gateway never learns them (it has no users table), so the identity is the
 * honest fallback rather than a blank.
 */
export function projectMessages(messages, { myIdentity, nameFor } = {}) {
  return messages.map(m => ({
    messageId: m.msgId,
    at: m.at,
    text: m.text || '',
    author: m.author,
    mine: !!myIdentity && m.author === myIdentity,
    speakerLabel: m.kind === 'assistant' ? 'Kelabo' : (nameFor?.(m.author) || m.author),
    assistant: m.kind === 'assistant',
    edited: !!m.editedAt && !m.deletedAt,
    deleted: !!m.deletedAt,
    // Taken from the server, never re-derived from the text. The server
    // resolved the handles against a real roster to decide whose badge to
    // raise, and a second implementation here could disagree with the count
    // the badge is built from.
    mentionsMe: !!m.mentionsMe,
    pinnedAs: m.pinnedAs || '',
  }))
}
