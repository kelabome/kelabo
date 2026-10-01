/**
 * Taking a post off the board — the two decisions, kept pure (no React, no
 * fetch) so `test/boardRemoval.mjs` can run them under plain node.
 *
 * The server is the control: `DELETE /kelabos/:id/board/:cid` applies the
 * host-or-author rule itself (rest-api kelabos.removeContribution). This only
 * decides whether to OFFER the control, and it must agree with that rule, or
 * the room shows a button that always fails — or hides one somebody is owed.
 */

/**
 * Who it is "by", for removal: `authorIdentity` (the note's writer, or the
 * developer whose local agent posted it), falling back to `author` on a typed
 * note written before that field existed. Never `author` on an assistant post —
 * that is "assistant", which is nobody.
 */
export function contributionOwner(con) {
  if (!con) return ''
  if (con.authorIdentity) return con.authorIdentity
  return con.tag === 'note' ? con.author || '' : ''
}

/**
 * Whether to show the remove control on this card.
 *
 * Not on a live kelabo's ephemeral cards (working / skipped), which were never
 * stored and have nothing to remove; not on a `local-` note that failed to
 * send and exists only in this tab; not once the kelabo has ended.
 *
 * @param {object} con
 * @param {{ isHost?: boolean, me?: string, ended?: boolean }} who
 *   `me` is the caller's PARTICIPANT identity (`kelabo.me`) — for a guest a
 *   generated id, never an email — because that is what the server compares.
 */
export function canRemoveContribution(con, { isHost = false, me = '', ended = false } = {}) {
  if (!con?.id || ended) return false
  if (con.status === 'working' || con.status === 'skipped') return false
  if (String(con.id).startsWith('local-')) return false
  if (isHost) return true
  const owner = contributionOwner(con)
  return !!(me && owner && owner === me)
}

/** The board without this card. Same array back when it was not there. */
export function withoutContribution(list, id) {
  if (!id || !list.some(c => c.id === id)) return list
  return list.filter(c => c.id !== id)
}
