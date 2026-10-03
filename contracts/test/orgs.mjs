// Organisations: the domain refusal.
//
// The blocklist is the whole of the access control in v1 — DNS TXT verification
// is deferred — so what it lets through is the security boundary, and it is
// asserted here rather than trusted.
import assert from "node:assert/strict";
import {
  allowedDomains,
  domainAllowed,
  domainOf,
  hasColleagues,
  isPublicEmailDomain,
  normaliseDomain,
  orgDomains,
  PUBLIC_EMAIL_DOMAINS,
  PUBLIC_EMAIL_SUFFIXES,
  tenantOf,
} from "../src/orgDomains.js";

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
  } catch (err) {
    console.error(`FAIL ${name}`);
    throw err;
  }
}

// --- the domain of an address -----------------------------------------------

await test("the domain is the part after the LAST @, lowercased", () => {
  assert.equal(domainOf("Rico@Example.COM"), "example.com");
  // A quoted local part may legally contain an @. `split("@")[1]` returns `b"`
  // here, which is the reason this module exists rather than a sixth inline
  // split.
  assert.equal(domainOf('"a@b"@example.com'), "example.com");
  assert.equal(domainOf("  rico@example.com  "), "example.com");
  // The fully-qualified spelling. A blocklist that knew only one of the two
  // would be bypassable by typing a dot.
  assert.equal(domainOf("rico@gmail.com."), "gmail.com");
  assert.equal(domainOf("not-an-address"), "");
  assert.equal(domainOf(""), "");
  assert.equal(domainOf(null), "");
  assert.equal(domainOf(undefined), "");
});

await test("normaliseDomain is the one spelling everything compares", () => {
  assert.equal(normaliseDomain("  GMAIL.com.. "), "gmail.com");
  assert.equal(normaliseDomain("Example.Com."), "example.com");
});

// --- the blocklist -----------------------------------------------------------

await test("shared providers, aliases and disposables are in the blocklist", () => {
  for (const domain of [
    "gmail.com",
    "outlook.com",
    "hotmail.co.uk",
    "yahoo.com.au",
    "icloud.com",
    "proton.me",
    "fastmail.com",
    "gmx.de",
    "mail.ru",
    "qq.com",
    "naver.com",
    "free.fr",
    "comcast.net",
    "bigpond.com",
    "duck.com",
    "mozmail.com",
    "mailinator.com",
    "yopmail.com",
  ]) {
    assert.equal(PUBLIC_EMAIL_DOMAINS.has(domain), true, domain);
  }
});

await test("the list is a Set of already-normalised domains", () => {
  // A capitalised or dotted entry would be unreachable, since every lookup is
  // normalised first — a silent hole in a security list.
  for (const domain of PUBLIC_EMAIL_DOMAINS) {
    assert.equal(domain, normaliseDomain(domain), domain);
  }
  assert.ok(PUBLIC_EMAIL_DOMAINS.size > 150, "the list should cover the providers that matter");
});

await test("the suffix list carries its leading dot, so it can never match a bare parent", () => {
  assert.equal(PUBLIC_EMAIL_SUFFIXES.includes(".onmicrosoft.com"), true);
  for (const suffix of PUBLIC_EMAIL_SUFFIXES) {
    assert.ok(suffix.startsWith("."), suffix);
    assert.equal(suffix, suffix.trim().toLowerCase(), suffix);
  }
});

// --- one organisation, several domains ---------------------------------------

const acme = orgDomains({ allowedEmailDomain: "Acme.com", emailDomainAliases: ["acme.io", " ACME.com.au. ", "acme.io"] });

await test("orgDomains normalises the primary and dedupes the aliases", () => {
  assert.deepEqual(acme, { primary: "acme.com", aliases: ["acme.io", "acme.com.au"] });
  // A comma list is what an env var carries.
  assert.deepEqual(orgDomains({ allowedEmailDomain: "acme.com", emailDomainAliases: "acme.io, acme.dev" }).aliases, [
    "acme.io",
    "acme.dev",
  ]);
  assert.deepEqual(allowedDomains(acme), ["acme.com", "acme.io", "acme.com.au"]);
});

await test("an alias is never a public mailbox domain, the primary itself, or not a domain", () => {
  // Aliasing gmail.com would make every Gmail user on the internet a colleague.
  const org = orgDomains({
    allowedEmailDomain: "acme.com",
    emailDomainAliases: ["gmail.com", "x.onmicrosoft.com", "acme.com", "localhost", "a@b.com", "", "acme.io"],
  });
  assert.deepEqual(org.aliases, ["acme.io"]);
});

await test("open registration has no organisation, so aliases are ignored", () => {
  const open = orgDomains({ allowedEmailDomain: "", emailDomainAliases: ["acme.io"] });
  assert.deepEqual(open, { primary: "", aliases: [] });
  assert.equal(allowedDomains(open), null);
  assert.equal(domainAllowed("anyone@anywhere.org", open), true);
  assert.equal(tenantOf("rico@acme.io", open), "acme.io");
});

await test("every listed domain may sign in, and nothing else", () => {
  assert.equal(domainAllowed("a@acme.com", acme), true);
  assert.equal(domainAllowed("a@ACME.io", acme), true);
  assert.equal(domainAllowed("a@acme.com.au", acme), true);
  assert.equal(domainAllowed("a@evil.com", acme), false);
  assert.equal(domainAllowed("a@sub.acme.com", acme), false, "subdomains are not implied");
  assert.equal(domainAllowed("not-an-address", acme), false);
});

await test("an alias folds into the primary's tenant; identities stay full emails", () => {
  assert.equal(tenantOf("rico@acme.io", acme), "acme.com");
  assert.equal(tenantOf("Rico@Acme.Com.AU", acme), "acme.com");
  assert.equal(tenantOf("rico@acme.com", acme), "acme.com");
  // Not part of the organisation: its own domain, exactly as before.
  assert.equal(tenantOf("rico@partner.org", acme), "partner.org");
  assert.equal(tenantOf("", acme), "");
});

await test("a public mailbox tenant has no colleagues; a company's does", () => {
  assert.equal(isPublicEmailDomain("gmail.com"), true);
  assert.equal(isPublicEmailDomain("Contoso.onmicrosoft.com"), true);
  assert.equal(hasColleagues("gmail.com"), false);
  assert.equal(hasColleagues("outlook.com"), false);
  assert.equal(hasColleagues("acme.com"), true);
  assert.equal(hasColleagues(""), false);
  assert.equal(hasColleagues(undefined), false);
});

console.log(`contracts/orgs: ${passed} passed`);
