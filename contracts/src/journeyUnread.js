/**
 * How much of a journey's conversation you have not read (docs 20 §19.3).
 *
 * Pure and shared because two services answer the same question from
 * different angles and must not disagree: the Gateway computes it per thread
 * when you open one, and rest-api rolls it up per journey for the list. Two
 * implementations of "how many unread" is how a rail badge says 3 and the
 * thread it points at shows 5.
 *
 * The arithmetic is a difference of two counters and never a scan, which is
 * the whole reason `messageCount` and `mentionCount` only ever grow — an
 * edit does not touch them and a delete is soft. A counter that can go down
 * cannot be differenced against a cursor written before it went down.
 */

/**
 * Unread for one thread, given its row and this identity's cursor for it.
 *
 * Clamped at zero: a cursor written before a counter existed, or before rows
 * were tidied by hand, must read as "nothing unread" rather than as a
 * negative badge.
 */
export function threadUnread(thread, cursor) {
  return {
    threadId: thread?.threadId || "",
    unread: Math.max(0, (thread?.messageCount || 0) - (cursor?.messageCountAtRead || 0)),
    mentions: Math.max(0, (cursor?.mentionCount || 0) - (cursor?.mentionCountAtRead || 0)),
  };
}

/**
 * Roll every thread in a journey up into one pair of numbers.
 *
 * A journey-level counter cannot be stored instead of this. Reading one
 * thread would advance it to the journey's total and hide every other
 * thread's unread — the badge would clear itself by looking at the wrong
 * conversation. Summing per-thread cursors is what makes "read this, not
 * that" work at all.
 *
 * `cursors` is keyed by threadId. Threads with no cursor count as entirely
 * unread, which is correct: never having opened a thread is not the same as
 * having read it, and it is what makes a new member see the backlog.
 */
export function journeyUnread(threads, cursors) {
  let unread = 0;
  let mentions = 0;
  const perThread = {};
  for (const thread of threads || []) {
    if (thread?.archived) continue;
    const one = threadUnread(thread, cursors?.[thread.threadId]);
    perThread[thread.threadId] = one;
    unread += one.unread;
    mentions += one.mentions;
  }
  return { unread, mentions, perThread };
}

/** `cursors` as a map, from the flat list a Query returns. */
export function cursorsByThread(rows) {
  const out = {};
  for (const r of rows || []) if (r?.threadId) out[r.threadId] = r;
  return out;
}
