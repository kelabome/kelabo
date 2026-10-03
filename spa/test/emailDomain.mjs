// Domain completion on the sign-in page (spa/src/emailDomain.js).
//
// The property that matters: whatever the participant types, the address that
// leaves the page has exactly one "@" and the deployment's domain — or it is
// refused here, with a reason, instead of costing a 403 round-trip.
import assert from 'node:assert/strict'
import { canBeColleague, domainOfEmail, normaliseDomain, resolveEmail } from '../src/emailDomain.js'

const D = 'acme.com'

// --- normaliseDomain ------------------------------------------------------
assert.equal(normaliseDomain('acme.com'), 'acme.com')
assert.equal(normaliseDomain('  ACME.com  '), 'acme.com', 'trimmed and folded')
assert.equal(normaliseDomain('@acme.com'), 'acme.com', 'a leading @ in config is tolerated')
assert.equal(normaliseDomain(''), '', 'empty = open registration')
assert.equal(normaliseDomain(undefined), '', 'absent = open registration')
assert.equal(normaliseDomain(null), '')
assert.equal(normaliseDomain('   '), '', 'whitespace-only = open registration')

// --- locked domain: the point of the feature ------------------------------
{
  const r = resolveEmail('rico', D)
  assert.equal(r.ok, true)
  assert.equal(r.email, 'rico@acme.com', 'bare local part is completed')
  assert.equal(r.completed, true)
}
{
  const r = resolveEmail('  rico  ', D)
  assert.equal(r.email, 'rico@acme.com', 'surrounding whitespace is trimmed first')
}
{
  const r = resolveEmail('rico@', D)
  assert.equal(r.ok, true)
  assert.equal(r.email, 'rico@acme.com', 'a trailing @ is finished, not doubled')
  assert.equal(r.completed, true)
}

// A full, correct address survives untouched — this is the autofill/paste
// path, and the regression a naive suffix-append would cause.
{
  const r = resolveEmail('rico@acme.com', D)
  assert.equal(r.ok, true)
  assert.equal(r.email, 'rico@acme.com')
  assert.equal(r.completed, false, 'nothing was added')
}
assert.equal(
  resolveEmail('rico@acme.com', D).email.split('@').length - 1, 1,
  'never rico@acme.com@acme.com',
)
{
  const r = resolveEmail('Rico@ACME.com', D)
  assert.equal(r.ok, true, 'domain compares case-insensitively')
  assert.equal(r.email, 'Rico@ACME.com', 'the local part is never case-folded')
}

// Wrong domain is caught here rather than by the server's 403.
for (const bad of ['eve@gmail.com', 'eve@notacme.com', 'eve@sub.acme.com', 'eve@acme.com.evil.io']) {
  const r = resolveEmail(bad, D)
  assert.equal(r.ok, false, `${bad} refused`)
  assert.equal(r.reason, 'wrong_domain', `${bad} -> wrong_domain`)
}

// Malformed input is refused, never patched up.
for (const bad of ['@acme.com', '@', 'a@b@acme.com', 'rico@acme.com@acme.com']) {
  const r = resolveEmail(bad, D)
  assert.equal(r.ok, false, `${bad} refused`)
  assert.equal(r.reason, 'not_an_email', `${bad} -> not_an_email`)
}
for (const empty of ['', '   ', null, undefined]) {
  assert.equal(resolveEmail(empty, D).reason, 'empty')
}

// --- unlocked (open registration): prior behaviour is unchanged -----------
{
  const r = resolveEmail('rico', '')
  assert.equal(r.ok, false, 'no domain to guess with')
  assert.equal(r.reason, 'not_an_email')
}
assert.equal(resolveEmail('rico@', '').ok, false, 'nothing to complete a trailing @ with')
{
  const r = resolveEmail('eve@gmail.com', '')
  assert.equal(r.ok, true, 'any domain is allowed when none is configured')
  assert.equal(r.email, 'eve@gmail.com')
  assert.equal(r.completed, false)
}
assert.equal(resolveEmail('a@b@c.com', '').reason, 'not_an_email')

// --- one organisation, several domains (issue #14) ------------------------
{
  const A = ['acme.io', 'acme.com.au']
  assert.equal(resolveEmail('rico@acme.io', D, A).ok, true, 'an alias address signs in')
  assert.equal(resolveEmail('rico@ACME.com.au', D, A).ok, true, 'aliases compare case-insensitively')
  assert.equal(resolveEmail('rico', D, A).email, 'rico@acme.com', 'a bare name still completes to the primary')
  assert.equal(resolveEmail('eve@gmail.com', D, A).reason, 'wrong_domain', 'anything else is still refused')
}

// --- who can be a colleague ------------------------------------------------
assert.equal(domainOfEmail('Rico@Acme.IO'), 'acme.io')
assert.equal(domainOfEmail('guest:123'), '')
{
  const org = { domains: ['acme.com', 'acme.io'], colleagues: true }
  assert.equal(canBeColleague('bob@acme.io', 'ann@acme.com', org), true, 'an alias is the organisation')
  assert.equal(canBeColleague('eve@evil.com', 'ann@acme.com', org), false)
  assert.equal(canBeColleague('guest:1', 'ann@acme.com', org), false)
}
{
  // Open registration: a company domain is its own organisation...
  const open = { domains: null, colleagues: true }
  assert.equal(canBeColleague('erin@startup.io', 'dan@startup.io', open), true)
  assert.equal(canBeColleague('eve@other.io', 'dan@startup.io', open), false)
  // ...and a public mailbox domain is nobody's.
  const gmail = { domains: null, colleagues: false }
  assert.equal(canBeColleague('mallory@gmail.com', 'alice@gmail.com', gmail), false)
}
assert.equal(canBeColleague('b@x.com', 'a@x.com', undefined), true, 'an older server: same domain, as before')

console.log('emailDomain: ok')
