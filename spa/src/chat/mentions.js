/**
 * The `@mention` grammar, SPA side (docs 20 §19.8).
 *
 * This restates `contracts/src/mention.js`. It has to: the SPA has no
 * dependency on the contracts package — see `spa/package.json` — and the
 * exports there are non-global and non-indexed anyway, so they answer "is this
 * message addressed to the assistant?" rather than "where are the mentions in
 * it?", which is what a renderer needs.
 *
 * The restatement is safe in the only direction it can fail. This module
 * decides what to **style**; the server decides, authoritatively and against a
 * real roster, who was actually mentioned and whose badge to raise. A token
 * highlighted here that resolved to nobody there is a word in a slightly
 * different colour. The reverse cannot happen, because the server's grammar is
 * the same one and its roster only ever narrows the result.
 *
 * It lives in a `.js` module rather than inside `Markdown.jsx` so plain node
 * can check it — the same reason `composer.js`, `reconcile.js` and
 * `messageStore.js` are where they are. A regex with a lookbehind and two
 * optional groups is exactly the kind of thing that is wrong in one direction
 * and untested in the other.
 */

/**
 * The source of one mention token, for composing into a larger alternation
 * (`Markdown.jsx`'s `INLINE_RE`). A source string rather than a `RegExp` so
 * there is one copy of the grammar and not two that drift.
 *
 * The lookbehind is the load-bearing part: without it an ordinary email
 * address in prose — "write to bob@example.com" — matches at the `@` and
 * renders `@example.com` as a mention. Excluding `@` and `.` as well as word
 * characters also stops the domain half of a deliberate `@bob@example.com`
 * being picked up a second time on its own.
 */
export const MENTION_SOURCE = '(?<![\\w@.])@[a-z0-9][a-z0-9._%+-]*(?:@[a-z0-9.-]+\\.[a-z]{2,})?'

const MENTION_RE = new RegExp(MENTION_SOURCE, 'gi')

/** Every mention token in the text, with its offset — `[{ token, index }]`. */
export function findMentionTokens(text) {
  return [...String(text || '').matchAll(MENTION_RE)].map(m => ({ token: m[0], index: m.index }))
}

/** Does this text name the given identity? Display-side only — the server's
 *  `mentionsMe` on the message is what the badge is built from. */
export function mentionsIdentity(text, identity) {
  if (!identity) return false
  const lower = String(identity).toLowerCase()
  const local = lower.split('@')[0]
  return findMentionTokens(text).some(({ token }) => {
    const handle = token.slice(1).toLowerCase()
    return handle === lower || handle === local
  })
}
