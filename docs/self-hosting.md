# Self-hosting Kelabo

Kelabo is a meeting and calling workspace for one organisation: live rooms with
transcription, an AI assistant that answers into the meeting, minutes written
for you, journeys that carry context from one meeting to the next, and a
searchable archive of everything your team decided. Each live room is a
*kelabo* — the word the app and the rest of this guide use. This guide takes
you from an empty AWS account to your team signing in at
`kelabo.mycompany.com`.

It is written for the person who runs infrastructure at a small-to-medium
organisation. You do not need to know the codebase; you do need to be
comfortable with a terminal, DNS, and an AWS bill.

If that is not you — no Route 53 domain, nobody who wants to own an AWS
deployment — the hosted service at [kelabo.me](https://kelabo.me) is the same
product without the operating: see the [README](../README.md) for the
comparison.

---

## A. What self-hosting takes

Self-hosting puts the data boundary inside your organisation's own AWS
account — transcripts, minutes and the archive never leave infrastructure you
control (audio goes to your own speech-to-text provider account for
transcription; assistant prompts go to your own LLM account).

| | |
|---|---|
| **Requirements** | An AWS account with admin access, a domain (or subdomain) whose DNS is a Route 53 hosted zone, an API key from a speech-to-text provider (**Soniox or Deepgram** — pick one, you can add or switch later), an LLM API key (DeepSeek), and optionally Cloudflare Realtime credentials for conference audio/video. Locally: Node 20+, Docker, the AWS CLI. |
| **Effort** | An afternoon for the first deployment, most of it waiting on account signups and certificate validation. Ongoing effort is close to zero: the stack is serverless except one small container, and `make deploy` is the whole upgrade procedure. |
| **Risk** | You are the operator. If SES stays in sandbox mode, sign-in emails only reach verified addresses until you request production access (see §C1). If a supplier key expires, that feature degrades (calls without Cloudflare credentials fall back to transcript + board). Nothing in the stack holds unrecoverable state outside your account. |
| **Benefit** | Totally self-contained, and you pay for what you actually use: every datastore and function is pay-per-request. The only always-on cost is one Fargate task (0.5 vCPU / 1 GB — roughly US$15–20/month) plus its load balancer; an idle deployment costs little more than that, and a busy one scales with actual kelabos, not seats. |

---

## B. The suppliers, and why each one

Kelabo deliberately buys rather than builds four things:

- **AWS** — everything that is Kelabo itself runs here: the web app (S3 +
  CloudFront), the REST API (Lambda), the realtime gateway (one Fargate
  container behind a load balancer), storage (DynamoDB + S3), sign-in email
  (SES), DNS and certificates (Route 53 + ACM), and secrets (Secrets Manager).
  One account, one region, one `make deploy`.
- **A speech-to-text provider** — live transcription quality is the floor
  under everything Kelabo does (the board, the assistant, the minutes all
  read the transcript). Kelabo supports two, behind one provider seam —
  **Deepgram** and **Soniox** — and either free tier is enough to evaluate
  seriously. Deepgram bills per audio minute received; Soniox bills per
  stream wall-clock but bundles speaker diarization for free, and Kelabo's
  client opens streams only while someone is actually speaking. You choose
  with one config value (`stt.provider`, §D2) and can switch later.
- **DeepSeek** — the LLM behind the in-kelabo assistant, the generated
  minutes and journey reports. Chosen as the default for cost: minutes
  generation reads whole transcripts, and DeepSeek makes that a rounding
  error. The key goes in your account; the provider is configurable (any
  OpenAI-compatible API, or Anthropic).
- **Cloudflare Realtime** *(optional)* — the SFU and TURN service that carries
  conference audio and video between participants. Running your own media
  servers is the single hardest part of a product like this; Cloudflare sells
  it as an API, priced per usage. **Without it, Kelabo still works** — rooms
  run in transcript + board mode, and peer-to-peer ("secure") calls for small
  groups still connect directly.

Whichever STT provider you pick, the browser streams audio **directly to
them** with a short-lived token your deployment mints — audio never passes
through your AWS infrastructure.

---

## C. Set up each supplier

### C1. AWS

1. Use (or create) an AWS account you administer. Create an IAM identity with
   admin access and configure it locally: `aws configure --profile myorg`
   (any profile name; pass it to every make command as `AWS_PROFILE=myorg`,
   or export it).
2. Put your domain's DNS in a **Route 53 hosted zone**. Either transfer the
   whole domain, or delegate just a subdomain (create a zone for
   `kelabo.mycompany.com` and add its NS records at your main DNS host).
   Note the **hosted zone ID** (`Z…`) — the config needs it.
3. **SES sandbox**: new AWS accounts can only send email to addresses you have
   individually verified. That is fine for testing (verify your own address in
   the SES console), but before the whole team signs in, request **production
   access** in SES (a one-page form, usually approved within a day).

   **If that request is refused, you are not stuck.** Production access is
   granted case by case and refusals are common, and a permanently sandboxed
   account cannot run a deployment — everyone would have to be verified one at
   a time, forever. Switch to another provider instead (§C5) — a publish from
   `/admin`, no deploy; nothing else about the deployment changes.
4. One-time per account/region: bootstrap the CDK (step D3 below).

### C2. Speech-to-text: Deepgram or Soniox

Pick one (the `stt` credential slot holds a key per provider, so you can add
the other later and switch with one config value). Whichever you use, Kelabo
never sends your key to the
browser — it uses it server-side to mint short-lived tokens, and the browser
streams audio to the provider directly.

**Deepgram** — create an account at deepgram.com and create an API key **with
the Member role — not the default owner/admin scope**. Kelabo mints per-session
tokens via Deepgram's `/v1/auth/grant` endpoint, and that endpoint rejects
owner/admin-scoped keys. The symptom of the wrong scope is not an obvious
error at deploy time — it is transcription failing later with
`stt_unavailable` (a `deepgram grant 4xx` line in the REST API log, §G).

**Soniox** — create an account at soniox.com and create an API key. No scope
gotcha; Kelabo mints temporary keys via Soniox's `/v1/auth/temporary-api-key`
endpoint. Speaker diarization comes bundled at no extra cost.

That is all — the key goes into the `stt` credential slot in step D4 and is
never stored anywhere else.

### C3. DeepSeek

Create an API key at platform.deepseek.com. Same handling: the `llm`
credential slot, nowhere else.

### C4. Cloudflare Realtime (optional, for conference audio/video)

In the Cloudflare dashboard create a **Realtime (Calls) app** — note the app
ID and secret — and a **TURN key** (ID + token). You can skip this entirely
at first and fill the `rtc` credential slot later (step D4); the gateway
re-reads a credential every five minutes, so no restart is needed. Rooms
degrade gracefully until then.

### C5. MailerSend (only if you are not sending through SES)

Skip this unless C1.3 went badly. SES is the default and needs no account, no
key and no step here — the Lambda authenticates with its own IAM role.

1. Create an account at mailersend.com and add your sending domain, then
   publish the DNS records it gives you (SPF, DKIM and a return-path CNAME) in
   the Route 53 zone from C1.2. Wait for the domain to read as **verified** in
   their dashboard; until it does, every send is refused and Kelabo reports
   `mail_not_configured`.
2. Create an API token with the **Email → full access** permission. Nothing
   else is used.
3. Put it in the `mail` credential slot's `mailersend` field — `/admin` →
   Suppliers, or `make credential-set` (step D4) — then publish
   `mail.provider` from `/admin` → Services. The next send picks it up; there
   is no redeploy and no IAM change, because the SES grant is unconditional
   rather than conditional on the provider (doc 23 §8). That is the whole
   reason this became publishable: a refused production-access request is
   news you get from outside, and it cannot wait for a rollout.

Two things that differ from SES and are worth knowing before you debug them:

- **Their API answers `202 Accepted` for mail it does not send** — a recipient
  on your account's suppression list, or an account with sending paused, comes
  back as a success with a warning in the body. Kelabo reads the body and
  fails the request instead, so a suppressed address shows up as
  `email_suppressed` rather than as a code that never arrives. If someone
  cannot sign in, look for them on the suppression list first.
- **The SES `mail` records are not just unnecessary, they are wrong.** Setting
  `mail.provider` to anything but `ses` stops Kelabo creating the SES stack,
  because the SPF record that stack publishes
  (`v=spf1 include:amazonses.com -all`) names Amazon as the only permitted
  sender for your domain and would fail every message MailerSend sends. If you
  are switching an existing deployment, `cdk destroy kelabo-<env>-ses` after
  the switch — that is deliberately not automatic, since it deletes DNS
  records.

---

## D. Configure the deployment

Configuration comes in two tiers, and knowing which is which will save you a
deploy later.

**`config/kelabo.json` is what CDK needs to build the stack** — your account,
region, domains, hosted zone, the WAF list, the gateway's size, secret names.
Changing one of those is a deploy, because a value read at synth cannot follow a
row in a table.

**Everything a running deployment might want to change is published from
`/admin` instead** — which model the assistant answers with, which speech-to-text
engine transcribes, which transport carries a sign-in code, every rate limit and
TTL, and the supplier keys themselves. Those values *also* appear in
`config/kelabo.json`, and this is the part worth internalising: **there they are
only the bootstrap.** They are what the deployment falls back to until somebody
publishes, so a fresh deployment behaves exactly as its config file says, and
from then on the console wins. Doc 23 is the full account.

So: fill in this file to get the deployment standing up, and expect to do the
day-to-day from the console afterwards.

1. **Create your config from the template:**

   ```bash
   cp config/template.json config/kelabo.json
   ```

   `config/kelabo.json` is gitignored — it is *your* deployment's identity and
   never belongs in a public repository.

2. **Edit `config/kelabo.json`.** The fields that must change:

   | Field | Meaning |
   |---|---|
   | `environments.<env>.baseDomain` | e.g. `mycompany.com` — the registrable domain this environment's names hang off. **Per environment, with no shared default**, so an environment can sit on a different domain entirely (test on `mycompany.dev`, production on `mycompany.com`) and none can silently inherit the wrong one. Cookies are scoped to the portal host, so environments sharing a registrable domain also send each other their session cookies — harmless, since each verifies with its own key, but not hygiene |
   | `environments.<env>.account` / `region` | your AWS account ID and region |
   | `environments.<env>.hostedZone.name` / `id` | the Route 53 zone from C1 |
   | `environments.<env>.subdomains.portal` / `gateway` | e.g. `kelabo` and `gw.kelabo` → `kelabo.mycompany.com`, `gw.kelabo.mycompany.com` |
   | `rootAdminEmail` (at the **root** of the file, not inside an environment) | your own address — the one identity that may administer this deployment: grant other administrators, publish configuration, rotate supplier keys. **Deploy-time and only deploy-time**, deliberately: everything else below is editable from a web page, so the answer to *who may edit* must not be, or an administrator could lock you out of your own deployment in one request. **Empty fails closed** — nobody is root and `/admin` refuses everyone, which is safe but inert, so set it now. It must be an address that can actually sign in, i.e. one at your `allowedEmailDomain`. Per-environment override goes in the environment block |
| `environments.<env>.allowedEmailDomain` | e.g. `mycompany.com` — **this is your tenant boundary**: only addresses at this domain can sign in, and everyone at it is one organisation. Two halves with different lifetimes: the **enforcement** is publishable (`/admin` → Access), while the sign-in page's prefill reaches the browser as a build-time `VITE_*` value. So publishing a new domain admits it immediately, but the page keeps naming the old one until `make frontend` |
   | `environments.<env>.organizationName` | e.g. `Acme Corp` — what the deployment calls itself, on the sign-in page ("Use your Acme Corp email…") and in the browser tab. **Display only**: it never decides who may sign in — `allowedEmailDomain` does — so a deployment may call itself anything. Omit it and the wording stays generic. Build-time, so changing it needs `make frontend` — and it is deliberately **not** publishable for exactly that reason: nothing server-side reads it, so a console field for it would look like it worked and would not (doc 23 §7.2) |
   | `environments.<env>.stt.provider` | `deepgram` (the default) or `soniox` — which speech-to-text provider this environment uses (§C2). The key for it must be in the `stt` credential slot (step D4). Bootstrap only: publish it from `/admin` → Services instead, and the next room picks it up. Changing it here needs `make backend` and only matters until something is published |
   | `environments.<env>.stt.providers.<id>` | per-provider tuning (model, token TTL, Soniox endpointing) — the template's values are sensible; leave them unless you know why. Bootstrap only; publishable as `stt.settings.<id>`, and a published block for one engine **merges** over the other's rather than replacing it |
   | `environments.<env>.allowIps` | empty (the default) means anyone can reach the deployment; sign-in is still the access control. A list of CIDRs closes it to those sources only — your corporate egress range while a pilot runs, say. It covers the portal, the API and the Gateway; add IPv6 ranges too if your network has them, or a browser preferring IPv6 is locked out. Manage it with `make allow-ip` / `allow-list` / `allow-rm` rather than by hand |
   | `environments.<env>.api.originSecret` | `off` (default), `send` or `require`. API Gateway also answers on its own `execute-api` URL, which reaches the same Lambda without passing CloudFront or the WAF — so with `allowIps` set and this left `off`, your portal is closed and your entire API is not. `require` makes CloudFront prove itself with a secret header. Roll it out in that order: `make origin-secret`, then `send` + deploy, then `require` + deploy. Going straight to `require` takes the API down for the length of a deploy, because the Lambda stack deploys before CloudFront |
   | `environments.<env>.mail.fromAddress` | e.g. `kelabo@mycompany.com` — where sign-in codes and invitations come from. (Older configs say `ses.fromAddress`; that still works and means the same thing.) Bootstrap only; publishable. **Check it after publishing**: the IAM grant is fenced to the sending *domain*, so a typo in the local part sends successfully from an address that does not exist rather than failing loudly (doc 23 §8) |
   | `environments.<env>.mail.provider` | `ses` (the default) or `mailersend`. Only worth changing if SES production access was refused (§C1.3) — see §C5, which is also where the API key comes from. A value that is not a known provider fails at config load rather than at the first sign-in. Bootstrap only: switching transport is a publish from `/admin` → Services, which is the whole reason it moved — SES production access is refused often enough that waiting for a deploy to react is not a plan |
   | `environments.<env>.ses.createIdentity` | leave unset. Set `false` only when another env in the same account already verified the sending domain (SES identities are account-scoped; two stacks can't create the same one). Any non-SES `mail.provider` turns it off regardless |
   | `environments.<env>.ses.dmarc` | omit unless your sending domain has no DMARC record yet — it is one record per domain, so publishing a second one where your mail provider already wrote one fails the deploy. `true` publishes `v=DMARC1; p=none;` beside the DKIM CNAMEs: monitor-only, which is the sole safe opening policy, since anything stricter quarantines mail from senders you have not yet inventoried. `{ "policy": "none", "rua": "mailto:…" }` to add an aggregate-report address — but only one you actually read, and if it is at another domain that domain must publish a `<sender>._report._dmarc` record or the reports go nowhere |
   | `environments.<env>.ses.mailFrom` | optional. `true` publishes a custom MAIL FROM subdomain (`mail.<your-domain>`) with its MX and SPF records, so SES's envelope sender is your own domain and mail passes DMARC on SPF *and* DKIM rather than DKIM alone — worth setting before requesting production access (§C1). A string names a different subdomain |
   | `environments.<env>.ses.region` | leave unset — mail then goes from the env's own region. Set it only to put an environment's mail in a *different* region, which is the one way to give it its own sandbox status, quota, reputation and bounce list (§C1). The identity must be verified in that region, and production access requested there separately |

   Leave `auth.socialProviders` as `[]` — work-email sign-in is the
   self-hosting identity path. (Google/Apple sign-in requires registering
   OAuth apps and adding their client secrets first.)

   The `environments` block has `dev`, `staging` and `prod` entries — they are
   independent deployments; configure the ones you will use (§E uses two).

3. **Install and bootstrap:**

   ```bash
   make bootstrap                                  # npm install everywhere
   cd infra && npx cdk bootstrap aws://<account-id>/<region> -c env=dev && cd ..
   ```

   `cdk bootstrap` is once per account+region, ever.

4. **Create the secrets, then fill the supplier credential slots:**

   ```bash
   AWS_PROFILE=myorg make secrets env=dev
   ```

   That creates the only two Secrets Manager entries the deployment still
   reads: the cookie signing key and the CloudFront→API origin secret —
   identity and perimeter, both generated, never typed.

   The **supplier** keys are not secrets any more. They are rows in
   `kelabo-<env>-credentials`, one per slot (`llm`, `stt`, `rtc`, `mail`),
   under that table's own customer-managed KMS key — docs 08 §6c explains why.
   The table is created by CDK, so this step comes **after** the first
   `make deploy` (§E). Write a slot with `make credential-set`:

   ```bash
   AWS_PROFILE=myorg make credential-set env=dev slot=llm        # what the slot takes
   KELABO_CRED_LLM_API_KEY=sk-… AWS_PROFILE=myorg \
     make credential-set env=dev slot=llm write=1
   ```

   Run with no `write=1` first: it prints which fields it would set and which
   it would keep, and writes nothing. Every field can equally be passed as an
   argument (`fields="apiKey=sk-…"`), but the environment form above keeps the
   key out of your shell history and out of `ps`. Nothing ever prints a
   credential, or a prefix of one.

   The fields per slot (`contracts/src/credentials.js`, docs 08 §6c —
   `make credential-set env=dev slot=<slot>` prints the same list, with the
   env-var name for each):

   | Slot | Fields |
   |---|---|
   | `llm` | `apiKey` |
   | `stt` | `deepgram` and/or `soniox` — one key per provider, so you can hold both and switch by `stt.provider` alone |
   | `rtc` | `sfuAppId`, `sfuAppSecret`, and the optional `turnKeyId` / `turnKeyApiToken` pair (C4) |
   | `mail` | `mailersend` — leave the slot empty if you send through SES |

   Setting a field **merges** it into the slot rather than replacing it, which
   is what lets you fill `rtc` in two goes, or add a second STT provider's key
   without losing the first. A field name the slot does not define is refused
   outright rather than stored, so a typo cannot leave you with a credential
   that looks set and is not.

   `make credentials-show env=dev` lists which slots are set, never the
   values. A slot you leave empty is not an error: the matching capability
   reports itself unconfigured and the rest of the product runs (docs 19).

   **You only need the CLI once.** After the first deploy the same four slots
   are settable from `/admin` → Suppliers, with the same merge rule and the
   same refusal of unknown fields. The CLI stays because a brand-new
   environment has nobody who can sign in yet, and because it is the only way
   to *remove* a field — the console can write a key and never read one back,
   so there is no reveal and no clearing (§D5, doc 23 §5).

   **Upgrading a deployment that predates the credentials table:**
   `make credentials-migrate env=dev` prints what it would copy out of
   Secrets Manager; add `write=1` to commit it. The source secrets are left
   in place.

### D5. The `/admin` console

Once the deployment is up (§E) and you can sign in, the address you put in
`rootAdminEmail` gets an **Administration** entry in the account menu.
Everything in it is guarded server-side; hiding the entry is a courtesy, not
the control.

| Tab | What it holds |
|---|---|
| **Assistant** | Provider, model, small model, endpoint; the eight gate and orchestrator knobs (sensitivity, cooldown, contributions per minute, research fan-out and deadline). Changing the model re-initialises the running agent worker within seconds |
| **Services** | Transcription engine and language; mail provider and from-address; conference audio defaults |
| **Suppliers** | The four credential slots: which fields are filled, when, by whom — and a box to set or rotate each |
| **Limits** | Sign-in code and join-code limits, session/token lifetimes, retention, external contacts |
| **Access** | The sign-in domain, and the administrator roster |
| **History** | Every published version, newest first, with its author and note |

Four things about it are worth knowing before you use it in anger:

- **Every field shows the deployment's own value underneath it.** An empty box
  means *not published — fall back to `config/kelabo.json`*, never *set to
  empty*. That is why the fallback is displayed: without it you cannot tell "I
  set this to `sfu`" from "`sfu` is what the config file says".
- **Publishing needs a note, and appends a version.** Nothing is edited and
  nothing is deleted; rolling a value back means publishing the old one again,
  which records that too. If two administrators publish at once the second gets
  `version_conflict` and reloads rather than overwriting the first.
- **It tells you the truth about latency.** "Live now" means the Gateway
  acknowledged the change; "the gateway will pick this up within a minute"
  means it did not and the 60-second cache is carrying it. Supplier keys take
  up to five minutes, which is their own cache.
- **The roster is root's alone.** A granted administrator can publish and rotate
  keys but cannot grant or revoke — otherwise they would be root after one hop.
  Root itself is `rootAdminEmail` and changes only by a deploy.

---

## E. Test deployment first

Don't aim the first deploy at the address your team will bookmark. The config
already gives you the mechanism: use one environment block as the rehearsal.
For example, in `environments.dev` set `subdomains.portal` to `test-kelabo`
(→ `test-kelabo.mycompany.com`) and keep `environments.prod` pointed at
`kelabo` for later.

```bash
AWS_PROFILE=myorg make deploy env=dev
```

The first run builds the gateway image, deploys nine CloudFormation stacks
(DNS records, two certificates, tables, mail identity, the REST Lambda, API,
gateway, portal)
and syncs the web app. Certificate validation can add ~10 quiet minutes the
first time.

**Then rehearse the product, not just the deploy:**

1. Open `https://test-kelabo.mycompany.com`, sign in with a company address
   (in SES sandbox: one you verified). The code email should arrive within
   seconds.
2. Start a kelabo, speak — the transcript should follow you. Address the
   assistant and watch the board.
3. Second browser/colleague: join by invite link, and try a call from
   Contacts. If you configured Cloudflare, you should hear each other; if
   not, you should still see transcript + board.
4. End it, and check the record appears under Kelabos with minutes arriving a
   moment later; try the search.
5. Create a journey, link the ended kelabo into it, and ask the journey a
   question under Reports — the answer should draw on that kelabo's minutes.
6. Open `/admin` from the account menu and confirm the deployment recognises
   you as root. Do this in the rehearsal rather than in production: an empty
   or mistyped `rootAdminEmail` fails **closed**, so the symptom is a console
   that refuses you, and the fix is a config edit plus `make backend` (§D5).
   Publish one harmless change — bump the assistant's cooldown — and check the
   toast says "Live now" rather than "within a minute": that is the Gateway
   reload path working end to end.

`make test` (no AWS needed) runs every package's test suite locally if you
want the belt-and-braces check first.

---

## F. Final deployment

When the rehearsal holds up, do the same thing at the real address:

1. Fill in `environments.prod` (same account or a separate one; `subdomains.portal: "kelabo"`).
2. `cdk bootstrap` if prod lives in a different account/region.
3. `make secrets env=prod` — secrets and credential slots are both per
   environment, so the §D4 `make credential-set env=prod …` writes have to be
   repeated against `kelabo-prod-credentials`. **Published configuration is
   per environment too, and nothing copies it**: prod starts with nothing
   published and runs on its own `config/kelabo.json` block, so any tuning you
   did in the rehearsal has to be published again. `make opconfig-show
   env=prod` tells you what it has; `make opconfig-seed env=prod` publishes
   the config file's values in one act if you want the console to own them
   from the start — read doc 23 §9 first, it is not the obvious default.
4. `AWS_PROFILE=myorg make deploy env=prod`
5. Confirm SES production access is granted (C1.3) *before* announcing it —
   sandbox mode is the classic "works for me, broken for everyone else".

Upgrades from then on: pull the new code, `make deploy env=prod`. The test
environment is also your upgrade rehearsal: deploy there first, click through
§E, then promote. To tear an environment down, delete its CloudFormation
stacks (`kelabo-<env>-*`); tables and the archive bucket are retained on
delete so data outlives mistakes.

**Upgrading a deployment made before the credentials table**, when the
supplier keys were Secrets Manager entries (`kelabo/<env>/stt`,
`kelabo/<env>/llm`, `kelabo/<env>/cloudflare-realtime`, `kelabo/<env>/mail`):
deploy first so the table exists, then run
`make credentials-migrate env=<env>` to see what it would copy and
`make credentials-migrate env=<env> write=1` to commit. It normalises on the
way in — an unknown field name is reported and dropped rather than carried
forward — and the old secrets are left in place so a rollback is possible.

---

## G. Something broke — collecting logs for a GitHub issue

Every server-side log is in CloudWatch, in your account. The two that matter:

```bash
# REST API (sign-in, kelabos, journeys, records, contacts):
aws logs tail /kelabo/<env>/rest-api --since 1h --profile myorg

# Realtime gateway (transcription, presence, calls, assistant):
aws logs tail /kelabo/<env>/gateway --since 1h --profile myorg
```

Both services log single-line JSON with an `msg` field and no message
contents — grep for `"level":"warn"` and `"level":"error"` first. For browser
issues, the devtools console plus the failing request from the Network tab
(status + response body) is what the issue needs.

If the deployment is not behaving the way the console says it should, these are
the lines that explain it (doc 23 §9.1):

| Grep for | Means |
|---|---|
| `opconfig_published` | a version was published — carries who, which version, and their note |
| `opconfig_gateway_reload_failed` | the publish saved; the Gateway did not hear about it and will catch up within a minute |
| `opconfig_unreadable` | the config table could not be read, so the last version read successfully is still in force. **The deployment is not running what the console is showing** |
| `credential_rotated` | a supplier key was written — carries the caller, the slot and the field *names*, never a value |
| `admin_granted` / `admin_revoked` | the administrator roster changed |
| `agent_model_reconfigured` | a running agent worker picked up a new model |
| `agent_knobs_reconfigured` | a running agent worker picked up new behaviour knobs (sensitivity, cooldown, …) with the model unchanged |

When you open an issue at github.com/kelabome/kelabo, include: what you did,
what happened instead, the relevant log lines from the commands above
(**check them for anything your org considers sensitive first** — log lines
carry ids and email addresses, not content, but it is your call), your
`config/kelabo.json` **with account/zone ids removed**, and the commit you
deployed (`git rev-parse --short HEAD`).
