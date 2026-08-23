import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Outbound-mail transports the REST API can drive (`rest-api/src/mail/`).
 * Restated here rather than imported because this file is loaded by CDK and by
 * the Lambda alike and must not reach into either one's source. Keep it in step
 * with `MAIL_PROVIDERS` there — the list exists so a typo in `mail.provider`
 * fails at config load, where it can be read, rather than at the first send.
 */
const MAIL_PROVIDERS = ["ses", "mailersend"];

/**
 * Load the single source-of-truth config and derive every env-specific value
 * (domains, URLs, table names, bucket, ECR image). No value may be hard-coded
 * elsewhere; secrets are referenced by name only.
 *
 * @param {string} env - dev | staging | prod
 * @param {string} [configPath]
 */
export function loadConfig(env,   configPath = join(here, "kelabo.json")) {
  const raw = JSON.parse(readFileSync(configPath, "utf8"));
  const block = raw.environments?.[env];
  if (!block) throw new Error(`kelabo config: unknown env "${env}" (have: ${Object.keys(raw.environments || {}).join(", ")})`);

  // The registrable domain this environment answers on — declared by the
  // environment itself, with no shared default.
  //
  // Environments routinely live on different domains (test on kelabo.dev,
  // production on kelabo.me), because cookies are scoped to .<portalDomain>:
  // two environments under one registrable domain send each other their session
  // cookies. Harmless — each verifies with its own signing key — but not
  // hygiene, and production tokens have no business transiting a test host.
  //
  // A root-level fallback used to supply this. It was dropped because it made
  // the most important fact about an environment the one thing its own block
  // did not state, and because it failed silently: an absent value is
  // `undefined`, and `gw.${undefined}` is the string "gw.undefined", so a typo
  // bought a certificate request, DNS records and cookies for a domain nobody
  // owns rather than an error.
  const baseDomain = block.baseDomain;
  if (!baseDomain) {
    throw new Error(
      `kelabo config: env "${env}" has no baseDomain. Every environment declares its own ` +
        `(e.g. "baseDomain": "example.com"); there is deliberately no shared default.`
    );
  }
  const portalDomain = block.subdomains.portal
    ? `${block.subdomains.portal}.${baseDomain}`
    : baseDomain;
  const gatewayDomain = `${block.subdomains.gateway}.${baseDomain}`;
  // Extra full domains the portal answers on, e.g. the bare apex when the
  // portal lives on www: browsers never fall back from kelabo.me to
  // www.kelabo.me on their own, so the apex must be served explicitly — cert
  // SAN, CloudFront alias and DNS records all come from this list. Every entry
  // must live inside the env's hosted zone (DNS-validated cert).
  const portalAliases = Array.isArray(block.portalAliases) ? block.portalAliases : [];

  const portalUrl = `https://${portalDomain}`;
  const gatewayBaseUrl = `https://${gatewayDomain}`;
  // The REST API is served on the portal host under the /api prefix (CloudFront
  // strips /api before forwarding to the API origin), keeping it separate from
  // SPA client routes like /records and /kelabos.
  const apiBaseUrl = `${portalUrl}/api`;

  const names = {
    kelabos: `kelabo-${block.endpoint}-kelabos`,
    users: `kelabo-${block.endpoint}-users`,
    otp: `kelabo-${block.endpoint}-otp`,
    refresh: `kelabo-${block.endpoint}-refresh`,
    history: `kelabo-${block.endpoint}-history`,
    mcp: `kelabo-${block.endpoint}-mcp`,
    contacts: `kelabo-${block.endpoint}-contacts`,
    journeys: `kelabo-${block.endpoint}-journeys`,
  };

  // Close the whole deployment to everything but a list of source addresses —
  // a corporate egress range while a pilot runs, the team's addresses while an
  // environment is under test. Empty (the default) is open, which is what every
  // kelabo.json written before this knob existed means.
  //
  // It has to cover the WHOLE deployment or it covers nothing: the browser
  // reaches CloudFront and the Gateway ALB by separate paths on separate names,
  // so restricting one only moves the door. Both families are kept because
  // CloudFront answers on IPv6 by default — an allowlist holding only someone's
  // IPv4 address blocks them the moment their browser prefers IPv6, and that
  // failure looks like an outage, not like a rule.
  const allowIps = (Array.isArray(block.allowIps) ? block.allowIps : [])
    .map((s) => String(s).trim())
    .filter(Boolean);
  const allowIpsV4 = allowIps.filter((c) => !c.includes(":"));
  const allowIpsV6 = allowIps.filter((c) => c.includes(":"));

  // SES sandbox status, sending quota, reputation and the bounce/complaint
  // suppression list are all account+**region** scoped, and nothing inside an
  // identity separates two domains that share one — configuration sets give
  // per-set metrics and IP pools, never a per-set sandbox. So a deployment that
  // wants one environment's mail unable to affect another's sends it from a
  // different region: staged rollout (production access granted to test while
  // production stays sandboxed) is only expressible that way. Defaults to the
  // environment's own region, which is what a single-region deployment wants
  // and what every kelabo.json written before this knob existed means.
  //
  // DMARC is opt-in rather than on by default, even though `p=none` is
  // harmless, because the record is a singleton per domain: a self-hoster whose
  // domain already carries a DMARC policy from their corporate mail provider
  // would get a second `_dmarc` record and a failed deploy, and the failure
  // would arrive as CloudFormation noise rather than as advice. Set it and the
  // SES stack publishes the policy beside the DKIM CNAMEs it already writes.
  //
  // `rua` is optional and deliberately unset by default: an aggregate-report
  // address that nobody reads is worse than none, and an address at another
  // domain only receives reports if THAT domain publishes a
  // `<sender>._report._dmarc` authorisation record — so a plausible-looking
  // mailto: silently collects nothing.
  const dmarc = block.ses?.dmarc
    ? { policy: "none", ...(block.ses.dmarc === true ? {} : block.ses.dmarc) }
    : null;

  // SPF, same opt-in reasoning: one record per domain, so a deployment whose
  // domain already publishes one must not get a second.
  //
  // Worth being clear about what this does and does not do. SPF is checked
  // against the envelope sender, and SES's default envelope is
  // `…@<region>.amazonses.com` — so this record does NOT authenticate our own
  // mail, and it is not what makes DMARC pass (Easy DKIM is). What it does is
  // state that nothing may use this domain as an envelope sender, which closes
  // that avenue to a spoofer and is what a deliverability review expects to
  // find. SPF *alignment* needs a custom MAIL FROM subdomain, which is a
  // separate thing this knob deliberately does not pretend to be.
  const spf = block.ses?.spf
    ? block.ses.spf === true
      ? "v=spf1 include:amazonses.com -all"
      : block.ses.spf
    : null;

  // Custom MAIL FROM domain — the missing half of the SPF story above. With it,
  // SES uses `<mailFrom>` as the envelope sender instead of amazonses.com, so
  // SPF authenticates *this domain's* mail and aligns for DMARC: the message
  // then passes on both SPF and DKIM rather than DKIM alone, which is what a
  // deliverability (or SES production-access) review means by "fully set up".
  // Opt-in like dmarc/spf; `true` derives `mail.<from-domain>`, a string names
  // the subdomain outright. Must be a subdomain of the verified identity — SES
  // rejects anything else at deploy time. The MX and SPF records the subdomain
  // needs are published by the SES stack alongside the DKIM CNAMEs.
  const sesIdentityDomain = block.ses?.hostedZone?.name || block.baseDomain;
  const sesMailFrom = block.ses?.mailFrom
    ? block.ses.mailFrom === true
      ? `mail.${sesIdentityDomain}`
      : block.ses.mailFrom
    : "";

  // Bounce and complaint visibility. The account suppression list already stops
  // mailing an address that hard-bounces — silently, which is the problem: the
  // person types their address, sees "code sent", and no code ever arrives
  // again, while our logs record a successful send. A configuration set with an
  // event destination is the only way to learn it happened.
  //
  // Opt-in, and only meaningful where the environment creates its own SES stack
  // (`createIdentity !== false`), since that stack is where the set is made.
  // The name is derived rather than configured: naming a set that does not
  // exist makes SES reject every send outright, so the fewer places the string
  // is written, the better.
  const sesEvents = block.ses?.events === true;
  if (sesEvents && block.ses?.createIdentity === false) {
    throw new Error(
      `kelabo config: env "${env}" sets ses.events but also ses.createIdentity:false. ` +
        `The configuration set is created by this environment's SES stack, which that turns off.`,
    );
  }

  // Which service actually puts the mail on the wire.
  //
  // SES is the default and stays it: nothing to sign up for, no key to hold,
  // and it is already in the account. What it is not is guaranteed to be
  // *available* — production access is granted case by case and is regularly
  // refused, and a permanently sandboxed account can mail only addresses
  // someone has verified one at a time, which is not a deployment. Since the
  // way out of that is a different provider rather than different code, the
  // provider is a config value.
  const mailProvider = block.mail?.provider || "ses";
  if (!MAIL_PROVIDERS.includes(mailProvider)) {
    throw new Error(
      `kelabo config: env "${env}" sets mail.provider "${mailProvider}"; known providers are ${MAIL_PROVIDERS.join(", ")}`,
    );
  }

  // The sending address belongs to the mail, not to SES — every provider needs
  // one. It reads `ses.fromAddress` when `mail.fromAddress` is absent so a
  // kelabo.json written before this block still loads and still sends, and the
  // resolved value is written back onto `ses` below so the two names cannot
  // drift apart (the Lambda's IAM condition and the SES stack's output are
  // both derived from it).
  const mailFromAddress = block.mail?.fromAddress || block.ses?.fromAddress || "";

  const ses = {
    ...block.ses,
    fromAddress: mailFromAddress,
    dmarc,
    spf,
    mailFrom: sesMailFrom,
    events: sesEvents,
    configurationSetName: sesEvents ? `kelabo-${block.endpoint}-mail` : "",
    // `||`, not `??`: this file is hand-edited JSON, and an empty string left
    // behind from a template is "unset", not "region named the empty string".
    region: block.ses?.region || block.region,
    // Whether this environment publishes DKIM/SPF/DMARC and verifies an
    // identity at all. Already false when another environment owns the shared
    // identity; false as well when the mail does not go through SES, because
    // the SPF record that stack publishes (`include:amazonses.com -all`) names
    // the WRONG sender for another provider and would fail its mail.
    createIdentity: mailProvider === "ses" && block.ses?.createIdentity !== false,
  };

  const mail = {
    provider: mailProvider,
    fromAddress: mailFromAddress,
    // Per-provider settings, derived rather than restated in a consumer.
    ses: { region: ses.region, configurationSet: ses.configurationSetName },
    mailersend: { ...(block.mail?.mailersend ?? {}) },
  };

  // Cloudflare Realtime's API host. Derived here (not written in a consumer) so
  // the "no hard-coded env values" rule holds; the app id and both secrets stay
  // in Secrets Manager and never appear in config.
  const rtcApiBase = raw.rtcApiBase ?? "https://rtc.live.cloudflare.com/v1";
  // Defaulted rather than required: an existing kelabo.json predating conference
  // audio still loads, and the kelabo simply runs board+transcript only until
  // the Cloudflare secret is set.
  const rtc = {
    provider: "cloudflare",
    defaultMode: "sfu",
    // Mesh only. Counted in *units*: each participant is one, each active
    // screen share is one more — a share is an extra uplink to every peer,
    // which is what the cap exists to bound. SFU rooms are not capped.
    meshMaxParticipants: 5,
    iceTtlSeconds: 3600,
    // How long a participant whose last SSE stream closed keeps their seat
    // before being evicted. Bridges the reload / brief-network-blip gap so the
    // room does not churn; the client holds its transport for slightly less
    // (see spa/src/rtc/useRtc.js) so the two windows must move together.
    disconnectGraceSeconds: 20,
    // Camera video is built (docs 15 §8). A deployment can still turn it off —
    // the flag reaches the SPA on the /rtc/join response and hides the control
    // rather than letting someone publish a track nobody wants paid for.
    video: true,
    ...(block.rtc ?? {}),
  };

  // Contacts (docs 18 §4). Favourites — private, one-way, same-org markers —
  // are always available. External contacts (mutual cross-org links) require a
  // multi-domain / open-signup deployment that self-host mode cannot support, so
  // they are OFF by default and the routes that create them 501 until a
  // multi-domain deployment sets `contacts.external: true`.
  const contacts = {
    external: false,
    ...(block.contacts ?? {}),
  };

  // Social sign-in is OFF unless a deployment turns it on: it needs OAuth apps
  // registered with Google/Apple and their client secrets in Secrets Manager,
  // none of which a self-hosted org has on day one — and work-email OTP is the
  // identity path such a deployment actually wants. A deployment that has
  // registered OAuth apps flips this on in its own config.
  const auth = {
    sessionTtlSeconds: 3600,
    refreshTtlDays: 60,
    participantTtlSeconds: 43200,
    socialProviders: [],
    ...(block.auth ?? {}),
  };

  // Join codes (rest-api/src/joinCode.js): the two-minute spoken stand-in for a
  // kelabo URL. Always available — it needs no third-party service and no
  // secret, so there is nothing for a deployment to turn on. What a deployment
  // may want to move are the abuse dials: `redeemPerIp*` bounds guessing and is
  // the one to tighten, `mintPerKelaboPerHour` bounds how many codes a single
  // room can have live at once.
  const joinCode = {
    ttlSeconds: 120,
    mintPerKelaboPerHour: 20,
    redeemPerIpWindowSeconds: 3600,
    redeemPerIpMaxRequests: 20,
    ...(block.joinCode ?? {}),
  };

  // How long CloudWatch keeps the Lambda's and the Gateway's application logs.
  //
  // Set explicitly because the AWS default is **never expire**, and these logs
  // are not anonymous: they record the identity performing an action, which for
  // a signed-in person is their email address. Everything else the product
  // stores has a stated lifetime — a kelabo 30 days, usage counters 90,
  // financial records 5.5 years — and logs quietly outliving all of them is not
  // a decision anyone made.
  //
  // 120 days is longer than `retentionDays` on purpose: a log's job is to
  // explain an incident, and an incident is often reported well after the
  // kelabo it concerns has expired. Long enough to investigate one, short
  // enough that it is not a second, permanent copy of who spoke to whom.
  //
  // Not `retentionDays`: that is a promise to the person whose kelabo it is,
  // this is an operational window. Tying them together would mean a deployment
  // that wanted longer forensics silently keeping everyone's transcripts longer
  // too.
  const logRetentionDays = Number(block.logRetentionDays ?? 120);
  if (!Number.isInteger(logRetentionDays) || logRetentionDays <= 0) {
    throw new Error(
      `kelabo config: env "${env}" sets logRetentionDays "${block.logRetentionDays}"; it must be a positive whole number of days`,
    );
  }

  // What this deployment calls itself, shown to people and used for nothing
  // else: the sign-in sentence and the browser tab. Strictly cosmetic —
  // tenancy is the verified email domain (`allowedEmailDomain`), and this must
  // never become a second source of truth for it. A deployment may well call
  // itself "Acme" while admitting acme-corp.com. Normalised here so no
  // consumer has to decide what a missing or padded value means; empty is
  // fine and falls back to generic wording.
  const organizationName = String(block.organizationName ?? "").trim();

  // The API's own front door. CloudFront is not the only way in: API Gateway
  // always answers on its own `https://<id>.execute-api.<region>.amazonaws.com`
  // URL, which reaches the same Lambda while passing neither the distribution
  // nor the WAF — so `allowIps` closes the portal and the Gateway and quietly
  // does nothing for the control plane.
  //
  // It cannot be closed by address. HTTP APIs support neither WAF (that is REST
  // APIs) nor resource policies, and an IP rule could not work anyway: requests
  // arrive from CloudFront's edge, not the visitor's, so allowing the visitor
  // blocks CloudFront and allowing CloudFront admits everyone else's
  // distribution. Nor does `disableExecuteApiEndpoint` help — it needs a custom
  // domain, which must resolve publicly, and so becomes the new bypass.
  //
  // What works is a secret only CloudFront knows: it injects the header, the
  // Lambda requires it. The raw endpoint stays up and becomes useless.
  //
  // Three states rather than a boolean, because the safe rollout has a middle
  // one and a boolean cannot express it. The Lambda stack deploys BEFORE the
  // portal stack, so enforcing in the same pass that first sends the header
  // means the API rejects CloudFront's own traffic until the distribution
  // catches up — a control-plane outage for the length of a deploy.
  //
  //   "off"     nothing sent, nothing required. The default, so an existing
  //             deployment upgrading into this changes nothing and needs no
  //             secret to exist.
  //   "send"    CloudFront sends the header; the API still serves anyone.
  //             Phase one, and harmless on its own.
  //   "require" the API rejects whatever arrives without it. Phase two.
  //
  // Anything else throws rather than defaulting: a typo silently meaning "off"
  // would leave the control plane open while the config claims otherwise, and
  // that is the one failure this knob exists to prevent.
  const ORIGIN_SECRET_MODES = ["off", "send", "require"];
  const originSecret = block.api?.originSecret ?? "off";
  if (!ORIGIN_SECRET_MODES.includes(originSecret)) {
    throw new Error(
      `kelabo config: env "${env}" has api.originSecret "${originSecret}"; ` +
        `expected one of ${ORIGIN_SECRET_MODES.join(", ")}.`,
    );
  }
  const api = {
    ...(block.api ?? {}),
    originSecret,
    // Convenience for the two consumers, so neither restates the rule.
    sendOriginSecret: originSecret !== "off",
    requireOriginSecret: originSecret === "require",
  };

  return {
    ...block,
    env,
    organizationName,
    api,
    app: raw.app,
    rtcApiBase,
    rtc,
    ses,
    mail,
    allowIps,
    allowIpsV4,
    allowIpsV6,
    contacts,
    auth,
    joinCode,
    logRetentionDays,
    secrets: {
      ...block.secrets,
      // Same defaulting reason as `rtc` above: keep a pre-conference-audio
      // kelabo.json loadable, using the conventional name.
      cloudflareRealtime:
        block.secrets?.cloudflareRealtime ?? `kelabo/${block.endpoint}/cloudflare-realtime`,
      // Shared between CloudFront (which sends it) and the Lambda (which
      // checks it). Defaulted like the others so a deployment upgrading into
      // this needs no config edit — only `make origin-secret` to create the
      // value, which is generated, never typed.
      apiOrigin: block.secrets?.apiOrigin ?? `kelabo/${block.endpoint}/api-origin`,
      // The outbound-mail provider's API key. Named for every environment,
      // created only where one is needed: SES authenticates with the Lambda's
      // IAM role and reads nothing here, so an SES deployment can leave this
      // secret absent and never notice it. Shaped like the STT secret — a key
      // per provider — so changing provider does not mean re-entering one.
      mail: block.secrets?.mail ?? `kelabo/${block.endpoint}/mail`,
    },
    baseDomain,
    portalDomain,
    portalAliases,
    gatewayDomain,
    portalUrl,
    gatewayBaseUrl,
    apiBaseUrl,
    joinUrl: (kelaboId) => `${portalUrl}/join/${kelaboId}`,
    inviteUrl: (kelaboId) => `${portalUrl}/invite/${kelaboId}`,
    cookieDomain: `.${portalDomain}`,
    tableNames: names,
    archiveBucket: `kelabo-${block.endpoint}-archives-${block.account}`,
    archiveKeyPrefix: "archives",
    ecrRepoName: `kelabo-${block.endpoint}-gateway`,
    gatewayImageUri: `${block.account}.dkr.ecr.${block.region}.amazonaws.com/kelabo-${block.endpoint}-gateway:${block.gateway.imageTag}`,
    tags: { app: raw.app, endpoint: block.endpoint },
  };
}
