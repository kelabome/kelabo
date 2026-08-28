/**
 * How much of a journey's conversation you have not read (docs 20 §19.3).
 *
 * Pure and shared because two services answer the same question from
 * different angles and must not disagree: the Gateway computes it per leg
 * when you open one, and rest-api rolls it up per journey for the list. Two
 * implementations of "how many unread" is how a rail badge says 3 and the
 * leg it points at shows 5.
 *
 * The arithmetic is a difference of two counters and never a scan, which is
 * the whole reason `messageCount` and `mentionCount` only ever grow — an
 * edit does not touch them and a delete is soft. A counter that can go down
 * cannot be differenced against a cursor written before it went down.
 */

/**
 * Unread for one leg, given its row and this identity's cursor for it.
 *
 * Clamped at zero: a cursor written before a counter existed, or before rows
 * were tidied by hand, must read as "nothing unread" rather than as a
 * negative badge.
 */
export function legUnread(leg, cursor) {
  return {
    legId: leg?.legId || "",
    unread: Math.max(0, (leg?.messageCount || 0) - (cursor?.messageCountAtRead || 0)),
    mentions: Math.max(0, (cursor?.mentionCount || 0) - (cursor?.mentionCountAtRead || 0)),
  };
}

/**
 * Roll every leg in a journey up into one pair of numbers.
 *
 * A journey-level counter cannot be stored instead of this. Reading one
 * leg would advance it to the journey's total and hide every other
 * leg's unread — the badge would clear itself by looking at the wrong
 * conversation. Summing per-leg cursors is what makes "read this, not
 * that" work at all.
 *
 * `cursors` is keyed by legId. Legs with no cursor count as entirely
 * unread, which is correct: never having opened a leg is not the same as
 * having read it, and it is what makes a new member see the backlog.
 */
export function journeyUnread(legs, cursors) {
  let unread = 0;
  let mentions = 0;
  const perLeg = {};
  for (const leg of legs || []) {
    if (leg?.archived) continue;
    const one = legUnread(leg, cursors?.[leg.legId]);
    perLeg[leg.legId] = one;
    unread += one.unread;
    mentions += one.mentions;
  }
  return { unread, mentions, perLeg };
}

/** `cursors` as a map, from the flat list a Query returns. */
export function cursorsByLeg(rows) {
  const out = {};
  for (const r of rows || []) if (r?.legId) out[r.legId] = r;
  return out;
}
