// Email domains: what one is, and whether it may become an organisation.
//
// An organisation IS an email domain — the tenant boundary registration already
// establishes. That only works where the domain belongs to one company. On
// gmail.com, outlook.com or a disposable-address service the tenant is a
// coincidence, and letting one form an organisation would make a stranger the
// default admin over — and the payer for — thousands of unrelated people.
//
// So the list below is a refusal, and it lives in contracts rather than in
// config on purpose: it is a fact about the internet, identical in every
// deployment, and a deploy-time value would let one environment be wrong about
// gmail.com. There is deliberately no runtime override, because an override is
// how gmail.com eventually gets one.

/**
 * The domain half of an email address, lowercased.
 *
 * `lastIndexOf`, not `split("@")[1]`: a quoted local part may itself contain an
 * `@` (`"a@b"@example.com` is a legal address), and the split form returns `b"`
 * for it. The five sites that still split inline agree with this on every
 * ordinary address and are folded onto it separately, so that this module
 * lands additively.
 *
 * A trailing dot is stripped: `example.com.` is the fully-qualified spelling of
 * `example.com` and a resolver accepts both, so a blocklist that only knew one
 * of them would be trivially bypassable.
 */
export function domainOf(email) {
  const at = String(email ?? "").lastIndexOf("@");
  return at < 0 ? "" : normaliseDomain(String(email).slice(at + 1));
}

/** Lowercase, trimmed, no trailing dot. The one spelling everything compares. */
export function normaliseDomain(domain) {
  return String(domain ?? "")
    .trim()
    .toLowerCase()
    .replace(/\.+$/, "");
}

/**
 * Domains whose suffix is enough to refuse them.
 *
 * `*.onmicrosoft.com` is every Microsoft 365 tenant's default routing domain.
 * They are per-tenant, so unlike the rest of this file they are not *shared* —
 * but they are also not a company's identity, they are handed out before anyone
 * verifies anything, and a tenant name is claimable by whoever registers it
 * first. An organisation keyed on one would be keyed on something its owner
 * does not really own.
 */
export const PUBLIC_EMAIL_SUFFIXES = Object.freeze([".onmicrosoft.com"]);

/**
 * Public mailbox providers, alias/relay services and disposable-address
 * services. Grouped by operator so a maintainer can see what is already
 * covered; the grouping has no meaning at run time.
 *
 * It will be incomplete — it is a hand-maintained fact about the internet. A
 * miss is a one-line change here and a deploy, and until then one company on a
 * shared domain can form an organisation over strangers. That is the accepted
 * failure mode; the alternative (a heuristic) fails the other way and refuses
 * real customers.
 */
export const PUBLIC_EMAIL_DOMAINS = Object.freeze(
  new Set([
    // Google
    "gmail.com", "googlemail.com",
    // Microsoft consumer
    "outlook.com", "outlook.com.au", "outlook.co.id", "outlook.de", "outlook.es",
    "outlook.fr", "outlook.it", "outlook.jp", "outlook.pt", "outlook.sa",
    "hotmail.com", "hotmail.co.jp", "hotmail.co.nz", "hotmail.co.uk",
    "hotmail.com.au", "hotmail.com.br", "hotmail.de", "hotmail.es",
    "hotmail.fr", "hotmail.it", "hotmail.ca",
    "live.com", "live.com.au", "live.ca", "live.co.uk", "live.de", "live.fr",
    "live.it", "live.nl", "live.se", "msn.com", "windowslive.com", "passport.com",
    // Yahoo / AOL
    "yahoo.com", "yahoo.ca", "yahoo.co.id", "yahoo.co.in", "yahoo.co.jp",
    "yahoo.co.uk", "yahoo.com.ar", "yahoo.com.au", "yahoo.com.br",
    "yahoo.com.mx", "yahoo.com.sg", "yahoo.de", "yahoo.es", "yahoo.fr",
    "yahoo.gr", "yahoo.ie", "yahoo.in", "yahoo.it", "yahoo.se",
    "ymail.com", "rocketmail.com", "aol.com", "aol.co.uk", "aim.com",
    // Apple
    "icloud.com", "me.com", "mac.com",
    // Privacy-first providers
    "proton.me", "protonmail.com", "protonmail.ch", "pm.me",
    "tutanota.com", "tutanota.de", "tutamail.com", "tuta.io", "tuta.com",
    "hushmail.com", "mailfence.com", "posteo.de", "posteo.net", "disroot.org",
    "riseup.net", "startmail.com", "runbox.com", "countermail.com", "cock.li",
    // Fastmail / Zoho / mail.com family
    "fastmail.com", "fastmail.fm", "zoho.com", "zohomail.com", "zoho.eu",
    "mail.com", "email.com", "usa.com", "consultant.com", "engineer.com",
    "gmx.com", "gmx.us", "gmx.net", "gmx.de", "gmx.at", "gmx.ch",
    // Germany / Austria / Switzerland
    "web.de", "t-online.de", "freenet.de", "arcor.de", "bluewin.ch", "aon.at",
    // Russia / Ukraine / CIS
    "yandex.com", "yandex.ru", "ya.ru", "mail.ru", "bk.ru", "inbox.ru",
    "list.ru", "internet.ru", "rambler.ru", "ukr.net", "i.ua", "meta.ua",
    "bigmir.net",
    // China
    "qq.com", "vip.qq.com", "foxmail.com", "163.com", "126.com", "yeah.net",
    "sina.com", "sina.cn", "sohu.com", "aliyun.com", "21cn.com", "tom.com",
    "139.com", "189.cn", "wo.cn",
    // Japan
    "docomo.ne.jp", "ezweb.ne.jp", "softbank.ne.jp", "i.softbank.jp",
    "nifty.com", "biglobe.ne.jp", "ocn.ne.jp", "so-net.ne.jp", "excite.co.jp",
    "auone.jp",
    // Korea
    "naver.com", "hanmail.net", "daum.net", "nate.com", "korea.com",
    // India / South Asia
    "rediffmail.com", "rediff.com", "sify.com",
    // Brazil / Portugal / Spain / Italy
    "uol.com.br", "bol.com.br", "terra.com.br", "ig.com.br", "globo.com",
    "sapo.pt", "telefonica.net", "terra.es", "libero.it", "virgilio.it",
    "tiscali.it", "alice.it", "tin.it", "email.it",
    // France
    "free.fr", "orange.fr", "wanadoo.fr", "laposte.net", "sfr.fr", "neuf.fr",
    "bbox.fr", "club-internet.fr", "voila.fr",
    // Benelux / Nordics
    "ziggo.nl", "kpnmail.nl", "hetnet.nl", "home.nl", "planet.nl", "xs4all.nl",
    "telenet.be", "skynet.be", "online.no", "telia.com", "bredband.net",
    "hotmail.dk", "live.dk",
    // Central and Eastern Europe
    "seznam.cz", "centrum.cz", "email.cz", "wp.pl", "o2.pl", "onet.pl",
    "interia.pl", "gazeta.pl", "abv.bg", "mail.bg", "freemail.hu", "citromail.hu",
    "mynet.com",
    // UK & Ireland ISPs
    "btinternet.com", "sky.com", "virginmedia.com", "talktalk.net",
    "ntlworld.com", "blueyonder.co.uk", "eircom.net",
    // North American ISPs
    "comcast.net", "verizon.net", "att.net", "sbcglobal.net", "bellsouth.net",
    "cox.net", "charter.net", "earthlink.net", "juno.com", "netzero.net",
    "roadrunner.com", "rr.com", "optonline.net", "frontier.com",
    "windstream.net", "centurylink.net", "shaw.ca", "rogers.com",
    "sympatico.ca", "telus.net", "videotron.ca", "lycos.com", "excite.com",
    // Australia & New Zealand ISPs
    "bigpond.com", "bigpond.net.au", "optusnet.com.au", "iinet.net.au",
    "tpg.com.au", "internode.on.net", "ozemail.com.au", "dodo.com.au",
    "westnet.com.au", "xtra.co.nz",
    // Alias and relay services — one person's forwarding address, never a company
    "duck.com", "simplelogin.com", "simplelogin.io", "anonaddy.com",
    "anonaddy.me", "addy.io", "mozmail.com", "relay.firefox.com",
    "icloud.me", "privaterelay.appleid.com", "33mail.com",
    // Disposable / throwaway
    "mailinator.com", "guerrillamail.com", "guerrillamail.info",
    "sharklasers.com", "10minutemail.com", "yopmail.com", "yopmail.fr",
    "temp-mail.org", "tempmail.com", "tempmailo.com", "tempr.email",
    "throwawaymail.com", "trashmail.com", "trashmail.de", "getnada.com",
    "maildrop.cc", "dispostable.com", "fakeinbox.com", "mailnesia.com",
    "spamgourmet.com", "mintemail.com", "mohmal.com", "emailondeck.com",
    "moakt.com", "burnermail.io", "spam4.me", "grr.la", "einrot.com",
    "discard.email", "mailcatch.com", "inboxbear.com", "linshiyouxiang.net",
  ])
);

/**
 * A public mailbox, relay or disposable domain: one person's address, never a
 * company's. The one predicate every "is this an organisation?" question asks.
 */
export function isPublicEmailDomain(domain) {
  const d = normaliseDomain(domain);
  return PUBLIC_EMAIL_DOMAINS.has(d) || PUBLIC_EMAIL_SUFFIXES.some((s) => d.endsWith(s));
}

// --- one organisation, several domains ----------------------------------------
//
// A deployment restricted to its own organisation names a *primary* domain
// (`allowedEmailDomain`) and, optionally, *aliases* (`emailDomainAliases`) —
// acme.com plus acme.com.au, acme.io, a pre-rename domain. Everyone at any of
// them is one tenant, and the tenant is the primary: `tenantOf` maps an alias
// to it, so `tenantId` stays one string and every boundary keyed on it (the
// tenant GSIs, presence, contacts, search, journeys, ringing) holds unchanged.
//
// The primary is what every row is stamped with, so it is the one value that
// must not move. Aliases may be added and removed freely: removing one stops
// new sign-ins from it and sends those people back to their own domain's
// tenant on their next session.

/**
 * The deployment's organisation, normalised: `{ primary, aliases }`. Empty
 * `primary` means open registration — no organisation, every domain its own
 * tenant — and aliases are then meaningless and ignored.
 *
 * An alias that is a public mailbox domain is dropped, never honoured: aliasing
 * gmail.com would make every Gmail user on the internet a colleague. So is an
 * alias equal to the primary, or not a domain at all.
 *
 * @param {{ allowedEmailDomain?: string, emailDomainAliases?: string[] | string }} [cfg]
 */
export function orgDomains(cfg) {
  const primary = normaliseDomain(cfg?.allowedEmailDomain ?? "");
  if (!primary) return { primary: "", aliases: [] };
  const raw = Array.isArray(cfg?.emailDomainAliases)
    ? cfg.emailDomainAliases
    : String(cfg?.emailDomainAliases ?? "").split(",");
  const aliases = [
    ...new Set(
      raw
        .map(normaliseDomain)
        .filter((d) => d && d !== primary && d.includes(".") && !d.includes("@") && !isPublicEmailDomain(d))
    ),
  ];
  return { primary, aliases };
}

/** Every domain that may sign in, or `null` for open registration. */
export function allowedDomains(org) {
  return org?.primary ? [org.primary, ...(org.aliases ?? [])] : null;
}

/** May this address hold an account here? Open registration admits any domain. */
export function domainAllowed(email, org) {
  const d = domainOf(email);
  if (!d) return false;
  const allowed = allowedDomains(org);
  return !allowed || allowed.includes(d);
}

/**
 * The tenant an address belongs to: its own domain, or the primary when that
 * domain is one of the organisation's aliases. The one derivation every site
 * that turns an identity into a `tenantId` must use.
 */
export function tenantOf(email, org) {
  const d = domainOf(email);
  if (!d) return "";
  return org?.primary && (org.aliases ?? []).includes(d) ? org.primary : d;
}

/**
 * Does a tenant have colleagues? Every colleague feature — people search,
 * presence, ringing, the tenant's live and scheduled kelabos, organisation-wide
 * journeys — treats "same tenant" as "same organisation". Under open
 * registration that is false for a public mailbox domain: everyone at
 * gmail.com shares the tenant `gmail.com` and are strangers to each other.
 * Such a tenant has no colleagues; its people reach each other only through
 * what names them specifically (an invite, an accepted contact, a link).
 */
export function hasColleagues(tenantId) {
  const t = normaliseDomain(tenantId);
  return !!t && !isPublicEmailDomain(t);
}
