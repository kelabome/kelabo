// Completing the email domain on a deployment locked to one.
//
// A self-hosted deployment pins `allowedEmailDomain`, and the server rejects
// every other domain before it does anything else (rest-api/src/otp.js:13).
// Once the domain is fixed, making every colleague type it is ceremony — but a
// hard suffix-locked field breaks email autofill and turns a pasted address
// into `rico@acme.com@acme.com`. So the input stays a real `type="email"` box
// and this module decides, for whatever was typed, which address to submit.
//
// Pure — no React, no fetch — so spa/test/emailDomain.mjs can run it under
// plain node; imports elsewhere carry `.js` for the same reason.

/**
 * Normalise a configured domain. Empty, absent or whitespace means open
 * registration, which is exactly how the server reads it.
 * @param {string|undefined|null} domain
 * @returns {string} bare lowercased domain, or '' when unlocked
 */
export function normaliseDomain(domain) {
  return String(domain ?? '').trim().toLowerCase().replace(/^@+/, '')
}

/**
 * @typedef {Object} ResolvedEmail
 * @property {boolean} ok
 * @property {string} email      the address to submit (only meaningful when ok)
 * @property {boolean} completed true when the domain was filled in for the user
 * @property {'empty'|'not_an_email'|'wrong_domain'} [reason]
 */

/**
 * Resolve what was typed into the address to send.
 *
 * With a locked domain a bare local part ("rico") and a trailing "@"
 * ("rico@") both complete to rico@<domain>; a full address is left exactly as
 * typed unless its domain differs, which is refused here rather than by a 403
 * round-trip. With no locked domain the behaviour is what it always was: an
 * address needs an "@".
 *
 * The local part is never case-folded — only the domain is compared
 * case-insensitively, matching `tenantOf` on the server.
 *
 * An organisation may own several domains (issue #14): `aliases` are the
 * others that may sign in. A bare local part still completes to the primary.
 *
 * @param {string} input
 * @param {string} domain normalised, from normaliseDomain
 * @param {string[]} [aliases] other domains of the same organisation
 * @returns {ResolvedEmail}
 */
export function resolveEmail(input, domain, aliases = []) {
  const value = String(input ?? '').trim()
  if (!value) return { ok: false, email: '', completed: false, reason: 'empty' }

  const at = value.indexOf('@')

  // No "@" at all: complete it when we know the domain, otherwise it is not
  // an address yet.
  if (at === -1) {
    if (!domain) return { ok: false, email: value, completed: false, reason: 'not_an_email' }
    return { ok: true, email: `${value}@${domain}`, completed: true }
  }

  // More than one "@" is never a valid unquoted address — and is what a naive
  // suffix-append produces, so it must not be silently accepted.
  if (value.indexOf('@', at + 1) !== -1) {
    return { ok: false, email: value, completed: false, reason: 'not_an_email' }
  }

  const local = value.slice(0, at)
  const typedDomain = value.slice(at + 1).toLowerCase()
  if (!local) return { ok: false, email: value, completed: false, reason: 'not_an_email' }

  // "rico@" — they started the domain and stopped; finish it for them.
  if (!typedDomain) {
    if (!domain) return { ok: false, email: value, completed: false, reason: 'not_an_email' }
    return { ok: true, email: `${local}@${domain}`, completed: true }
  }

  if (domain && typedDomain !== domain && !aliases.map(normaliseDomain).includes(typedDomain)) {
    return { ok: false, email: value, completed: false, reason: 'wrong_domain' }
  }
  return { ok: true, email: value, completed: false }
}

/** The domain half of an address, lowercased; '' when there is none. */
export function domainOfEmail(email) {
  const s = String(email ?? '')
  const at = s.lastIndexOf('@')
  return at < 0 ? '' : normaliseDomain(s.slice(at + 1))
}

/**
 * Could `email` be a colleague of `me`? Mirrors the server's rule
 * (rest-api/src/tenancy.js `sameOrg`) so the UI does not offer a favourite the
 * server will refuse:
 *
 *  - `org.colleagues` false — a public mailbox tenant (gmail.com…) under open
 *    registration — means nobody is;
 *  - with the organisation's domains known, any of them is;
 *  - under open registration (`domains` null), only your own domain is.
 *
 * `org` absent (an older server) keeps the previous behaviour: same domain.
 *
 * @param {string} email
 * @param {string} me the signed-in address
 * @param {{ domains: string[]|null, colleagues: boolean }|null|undefined} org
 */
export function canBeColleague(email, me, org) {
  const d = domainOfEmail(email)
  if (!d || !String(email).includes('@')) return false
  if (org && org.colleagues === false) return false
  if (org && Array.isArray(org.domains)) return org.domains.map(normaliseDomain).includes(d)
  return d === domainOfEmail(me)
}
