import { ASSISTANT_NAME } from "./persona.js";

/**
 * Addressing the assistant in **typed** text.
 *
 * Deliberately nothing like the speech path. Spoken address is fuzzy and has to
 * be — `ADDRESSED_NOTE` lists a dozen ways speech-to-text mangles "Kelabo", and
 * a model weighs them against context. Typed text has no such excuse: the person
 * saw what they wrote. So this is an exact match on an explicit mention, and it
 * is a *decision*, not a hint — an addressed message skips the trigger gate
 * entirely and always gets an answer.
 *
 * That is the whole reason the two must not share an implementation. Making the
 * typed matcher tolerant would mean typing "our book club" in the transcript
 * panel forced a lookup that nobody asked for, with no gate left to stop it.
 */

const NAME = ASSISTANT_NAME.toLowerCase();

// `@kelabo` anywhere, or the bare name in vocative position at the very start
// ("kelabo, what's …" / "kelabo: check …"). A bare name mid-sentence is not an
// address — "I asked kelabo yesterday" is a remark about it, not to it.
const AT_MENTION = new RegExp(`(^|[^\\p{L}\\p{N}_])@${NAME}\\b`, "iu");
const VOCATIVE = new RegExp(`^\\s*${NAME}\\s*[,:—-]\\s*\\S`, "iu");

/** Is this typed message addressed to the assistant? */
export function addressesAssistant(text) {
  const s = String(text || "");
  return AT_MENTION.test(s) || VOCATIVE.test(s);
}

/**
 * The message without the address, for use as a question on its own.
 *
 * The mention is how you got the assistant's attention, not part of what you
 * asked — leaving it in produced board cards titled "@kelabo what is the retry
 * policy". If stripping leaves nothing (someone typed just "@kelabo"), the
 * original is returned rather than an empty string: an empty query downstream is
 * far worse than a redundant one.
 */
export function stripAddress(text) {
  const s = String(text || "");
  const out = s
    .replace(AT_MENTION, (m) => (m[0] === "@" ? "" : m[0]))
    .replace(VOCATIVE, (m) => m.slice(m.length - 1))
    // Removing a mention from the middle of a sentence leaves the space on
    // either side of it behind.
    .replace(/\s{2,}/g, " ")
    .trim();
  return out || s.trim();
}

// ---------------------------------------------------------------------------
// Mentioning a *person* (docs 20 §19.8)
//
// Same file because it is the same grammar — `@` followed by a handle — and
// splitting it would be how the two drift. Deliberately NOT the same function:
// addressing the assistant is a decision that skips the trigger gate, while
// mentioning a colleague only raises a badge. A false positive costs a
// needless LLM call in one case and a needless notification in the other, and
// those are not the same price.
// ---------------------------------------------------------------------------

// `@bob` or `@bob@example.com`.
//
// The left-hand lookbehind is what stops an ordinary email address in prose
// ("write to bob@example.com") reading as a mention of `@example.com`. It also
// excludes a second `@`, so the domain half of a full address is never picked
// up as a mention of its own.
//
// Global and indexed, unlike the two above: those answer a yes/no about the
// whole message, this one has to enumerate.
const HANDLE = /(?<![\w@.])@([a-z0-9][a-z0-9._%+-]*(?:@[a-z0-9.-]+\.[a-z]{2,})?)/giu;

/**
 * Every `@handle` in the text, lowercased and de-duplicated, in order.
 *
 * Handles, not identities: resolving one to a person needs a roster, which
 * this package has no access to. `resolveMentions` below does that half, given
 * the roster its caller already holds.
 */
export function parseMentionHandles(text) {
  const s = String(text || "");
  const seen = new Set();
  for (const m of s.matchAll(HANDLE)) seen.add(m[1].toLowerCase());
  return [...seen];
}

/**
 * Resolve handles against a set of known identities.
 *
 * A handle matches either a whole identity (`@bob@example.com`) or its local
 * part (`@bob`). An ambiguous local part — two people whose addresses differ
 * only by domain — resolves to **nobody**: notifying both would tell the wrong
 * person they were named, and picking one would do it silently.
 *
 * The assistant's own name is never returned. It is addressed through
 * `addressesAssistant`, which is a different decision with a different
 * consequence, and returning it here would put the assistant on a human
 * mention list.
 */
export function resolveMentions(text, identities) {
  const handles = parseMentionHandles(text);
  if (!handles.length) return [];
  const byLocal = new Map();
  const whole = new Set();
  for (const id of identities || []) {
    const lower = String(id).toLowerCase();
    whole.add(lower);
    const local = lower.split("@")[0];
    // `null` marks a local part claimed by more than one identity.
    byLocal.set(local, byLocal.has(local) && byLocal.get(local) !== lower ? null : lower);
  }
  const out = [];
  for (const handle of handles) {
    if (handle === NAME) continue;
    const hit = whole.has(handle) ? handle : byLocal.get(handle);
    if (hit && !out.includes(hit)) out.push(hit);
  }
  return out;
}
