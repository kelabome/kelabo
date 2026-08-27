// Organisations: the domain refusal (docs/saas/design-organisations.md §1.2).
//
// The blocklist is the whole of the access control in v1 — DNS TXT verification
// is deferred (plan-organisations §5, D1) — so what it lets through is the
// security boundary, and it is asserted here rather than trusted.
import assert from "node:assert/strict";
import {
  domainOf,
  normaliseDomain,
  PUBLIC_EMAIL_DOMAINS,
  PUBLIC_EMAIL_SUFFIXES,
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

console.log(`contracts/orgs: ${passed} passed`);
