# Operational configuration — published, not deployed

Changing which model the assistant runs used to be a docker build, a
CloudFormation update and a service rollout. So did switching the transport that
carries a sign-in code, tightening a rate limit after somebody fished a join
code, and turning the trigger gate's sensitivity down because the assistant
would not stop talking. None of those is code, and none of them should need a
deploy.

Worse, the obvious thing to try did not work. `make restart` re-deploys the
*same* task-definition revision, so editing `config/kelabo.json` and restarting
silently kept the old value — a trap documented in three places precisely
because everyone hit it.

This doc is the two-tier split that replaced that: what stays in
`config/kelabo.json`, what became a row in `kelabo-<env>-config`, who may change
it, and how a change reaches a running task.

---

## 1. The test

One question decides where a value lives:

> **Does CloudFormation need this value to build the stack?**
> Yes → `config/kelabo.json`. No → publishable operational config.

An account id, a region, a hosted zone, a subdomain, a WAF address list, the
gateway's CPU and memory, a log retention period, a Secrets Manager *name* — CDK
reads every one of them at synth, and **a value read at synth cannot follow a row
in a table**. They stay where they are.

A model name, a rate limit, a TTL, a transcription language is read by
application code at request time. It is now published.

**The split was historical, not principled.** Before this, `config/kelabo.json`
held both kinds because it held everything, and the only reason the model lived
beside the account id is that they arrived on the same day.

### 1.1 What stays deploy-time, and why each one has to

| Value | Why it cannot be published |
|---|---|
| `account`, `region`, `baseDomain`, `hostedZone`, `subdomains` | Read by CDK at synth; they *are* the stack's identity |
| `portalAliases` | Certificate SANs, CloudFront aliases and DNS records — all synth-time |
| `allowIps` | Compiles to WAF rules and ALB listener rules |
| `api.originSecret` | Decides whether CloudFront sends the header and whether the Lambda demands it — two stacks, both at synth |
| `gateway.cpu/memoryMiB/desiredCount/imageTag/arch` | Task definition properties; `arch` also picks the image the build pushes |
| `logRetentionDays` | A CloudWatch log group property |
| `secrets.*` | Secret *names*, resolved into IAM grants at synth |
| `rootAdminEmail` | **Deliberate**, not technical — see §4 |
| `organizationName` | Compiled into the SPA bundle as `VITE_ORG_NAME`; see §7.2 |
| `stt.providers.<id>` shape, `mail.provider` list | Validated at config load so a typo fails the build, not somebody's sign-in — the *values* are publishable, the enumeration is not |

### 1.2 What is publishable

`contracts/src/opconfig.js` `opConfigSchema` is the list, and it is the only
list. Groups: `llm` (provider, model, smallModel, baseUrl), `stt` (provider,
language, per-provider settings), `mail` (provider, fromAddress), `agent` (all
eight gate and orchestrator knobs), `rtc` (defaultMode, meshMaxParticipants,
iceTtlSeconds, disconnectGraceSeconds, video), `otp` (seven limits), `joinCode`
(four), `auth` (four TTLs plus `socialProviders`), `org.allowedEmailDomain`,
`contacts.external`, `retentionDays`.

Two schema fields have no console control, deliberately, and both are still
publishable through the API or `opconfig-seed`: `auth.socialProviders`, because
its meaningful empty (`[]` = social sign-in off) is one accidental Publish away
from a form that renders it, and `stt.settings`, because it is an opaque
per-provider map whose keys belong to the providers — a form for it would be a
JSON textarea, which is the API with extra steps.

---

## 2. Published wins, the environment is the bootstrap

`resolveOpConfig(cfg, published)` folds one over the other. A published value
wins where it is set; where it is not, the service's own config answers.

**That order is what made this safe to ship.** A deployment that has published
nothing behaves *exactly* as it did before — every `KELABO_*` environment
variable still reaches the task, still means what it meant, and the first
published version takes over field by field rather than all at once. There was
no migration and no cutover.

It is also what makes it recoverable. A published value that breaks something is
fixed by publishing another one, and if the table itself is unreadable the cache
serves the last version it read successfully (§6), never the empty defaults.

### 2.1 The sentinel is `null`, not falsiness

This is the one place where copying the obvious pattern is a bug, and it has its
own tests (`contracts/test/opconfig.mjs`).

`agent.maxConcurrentRuns: 0` means **unlimited**.
`agent.turnDeadlineSeconds: 0` means **no deadline**.
`rtc.video: false` means **audio only**.
`auth.socialProviders: []` means **social sign-in off**.

A `published || fallback` check discards all four and restores the deployment's
value — the exact opposite of what the operator just asked for, with nothing in
any log to say it happened. So "unset" is `null`, and every numeric and boolean
field is nullable.

**Strings keep the familiar rule**: empty means unset, never set-to-empty. These
are hand-typed values, and a cleared text box in a form must not point the
deployment at a provider named `""`. `auth.socialProviders` is nullable rather
than defaulting to `[]` for exactly that reason — an empty list is a meaningful
published value and has to be distinguishable from "not published".

### 2.2 Two shapes, one translation

`resolveOpConfig` groups values the way the console shows them (`agent`, `org`).
The services hold them the way `config/kelabo.json` does (`gateway.agent`, a
top-level `allowedEmailDomain`). `applyOpConfig` writes the fold back into the
**service's own shape**, so adopting published config at a call site is a
one-line change: `config.otp.maxAttempts` becomes
`(await settings()).otp.maxAttempts` and nothing else moves.

That matters more than the convenience. The alternative was every consumer
learning a second shape — and a consumer that reads the wrong one does not fail,
it silently keeps the deployment's value while the published setting has no
effect. One translation, in one place, and the call sites cannot get it wrong.

**A published field that nothing reads is worse than an absent one**: the
operator edits it, saves, reloads, sees no change, and cannot tell that from a
broken save. `rest-api/test/admin.mjs` reads the consumer sources and fails if
any of them goes back to reading `config` directly.

---

## 3. Publishing is an append

`PK = OPCONFIG`, `SK = V#000001` (six-digit zero-pad, so a string sort is a
version sort). A change is a new version with an author and a note; the previous
one stays. See docs 08 §6d for the storage.

**There is no edit and no delete.** Rolling a setting back is publishing the old
value again, which records *that* act too — an operator asking "when did this
deployment start answering with a different model, and who decided?" gets an
answer.

**The note is required by the route, not by the schema.** The seeded default has
nobody to attribute and no change to explain, so a schema that demanded one would
make the fallback unconstructable. A human publishing one always has a reason,
and a version chain of blank notes is an audit record that answers nothing.

**The write is conditional on the key not existing.** Two administrators who hit
Publish in the same second both computed the same next version; without the
condition the second would overwrite the first, losing a change *and* the record
of who made it. The loser gets `409 version_conflict` and reloads — the remedy is
to publish on top of what the other person wrote, which is different from a
blind retry.

**The body is the whole document, not a patch.** A patch needs a way to say
"unset this field", which is precisely the `null`-versus-absent distinction that
makes §2.1 subtle. Sending the complete document means the console's form state
*is* the version, and a field the operator cleared is a field that is `null` in
the item.

---

## 4. Who may publish is not publishable

Two tiers, and the distinction is the whole access-control argument.

**Root** is one address, `rootAdminEmail` in `config/kelabo.json`, reaching the
Lambda as `KELABO_ROOT_ADMIN_EMAIL`. It cannot be changed by any request — only
by a deploy.

That is deliberate and it is the reason this value is the one exception in §1.1
that is not technical. Everything else in this doc is editable from a web page,
so the answer to *who may edit* must not be, or the boundary is circular: an
administrator who could rewrite the roster could remove the operator from their
own deployment in a single request, with no way back that did not involve the
AWS console.

**Granted administrators** are `ADMIN#` rows that only root may write or remove.
They may publish configuration and rotate supplier keys; they may not change who
else can. A granted admin who could grant would be root after one hop.

**Empty root fails closed.** Nobody is root, `requireRoot` refuses everyone, and
the roster is whatever rows already exist — on a fresh deployment, none, so
`/admin` refuses every caller. A misconfigured deployment must fail toward a
locked console, never toward an open one. The same rule covers a read failure:
if the roster cannot be read we do not know the caller is an administrator, and
"we could not check" resolves to "no".

`GET /admin/whoami` is the one route that answers a non-admin instead of refusing
them. It is what the app asks on load to decide whether to render the menu entry,
and a 403 there would be a 403 on every page load for every ordinary user. It
discloses nothing but whether *you* are an administrator, and hiding the entry is
a courtesy — every route re-checks server-side.

---

## 5. Supplier keys are a different thing

Configuration says *which* supplier. A credential says *how to authenticate to
it*. They are deliberately in different tables: credentials have their own
customer-managed key, and they are not versioned, because a key is not a decision
anyone needs the history of. See docs 08 §6c.

**Not one byte of key material goes in the config table.** It is an ordinary
DynamoDB item with no customer-managed key over it, in a table that admin tooling
scans, PITR copies and the gateway's task role reads. A credential in it would be
one table export away from being everywhere. There is not even a secret *name* to
point at any more — the slot is the address.

Keys were CLI-only (`make credential-set`), which is not a console: a self-hoster
with no shell could configure everything except the four keys the product needs
to work. `/admin` → Suppliers now sets and rotates them.

**What that cost, stated plainly.** The Lambda now holds `GetItem` and `PutItem`
on the four named `CRED#` partitions. IAM unions `Allow`, so the attribute fence
that limited it to non-secret attributes on `CRED#llm` and `CRED#rtc` **no longer
binds**. The property that fence described — the control plane can know the LLM
key exists but cannot read it — is not true any more, and cannot be while a
credential-write console exists. The two original statements are kept in
`infra/lib/lambda-stack.js`, unchanged, because they are the honest description
of what this role would need if the console were removed: delete the third
statement and the boundary returns with nothing else to unpick.

**What was not conceded.** Still no `Scan` — the one call that returns every
credential in the deployment in a single response, and the accident the whole
design exists to prevent. Still no `Query`. Still no `DeleteItem`: a credential is
replaced, never removed, so a compromised session cannot take transcription down
with no way back. The slots are enumerated from `CREDENTIAL_SLOTS` rather than
matched as `CRED#*`, so an undesigned partition key fails closed instead of being
silently covered.

**What replaced the fence is an application limit: no route returns a credential
value.** `credentials.getRaw` exists and `admin.js` deliberately does not call
it; a test asserts that. A key can be written from the console and never read out
of it, so a stolen admin session can break this deployment without exfiltrating
the supplier keys it runs on. Rotating at the supplier is the recovery for the
first; there is no recovery for the second.

**A save merges.** `stt` holds one key per engine and `rtc` holds an SFU pair
plus an optional TURN pair; a form only ever submits what someone typed. A
replacing write would delete the Deepgram key the moment anyone rotated the
Soniox one — silently, with the console reporting success and transcription
failing on the next kelabo that used the other engine. So an empty box means
"leave this alone", which is also what lets the form render a slot without the
operator re-pasting keys they are not changing. Clearing a field is therefore not
expressible from the console; that is what the CLI is for, and "I cannot remove a
key from a browser" is the safer gap of the two.

Every write logs `credential_rotated` naming the caller, the slot and the **field
names** — never the values.

---

## 6. How a change reaches a running deployment

Each service holds one `createOpConfigCache` per process, 60-second TTL, one
in-flight read at a time (`contracts/src/versioned.js`, shared with the same
machinery a rate card would use).

**A read that fails keeps serving the last known version**, never the seeded
defaults. A deployment that silently reverted to bootstrap values mid-call would
be far harder to diagnose than one running slightly stale settings — and the
console would be showing something else entirely. `status()` reports
`table | stale | default`, and the console renders a banner when it is `stale`.

An **empty partition is not a failure**: it is a deployment where nobody has
published yet, and the seeded value is the right answer. Reporting it turned
every read on a fresh environment into an error log, which is how a real
unreadable table would have been missed.

**Consumers resolve per request, never at construction.** A Lambda container is
reused for minutes; a handler that captured the resolved config when it was built
would keep serving whatever was published when that container started and would
never see a publish — the exact failure this replaced, one layer down.

### 6.1 The reload

`POST /internal/config/reload` on the Gateway, on the same internal JWT as every
other `/internal/*` route. It invalidates the op-config cache and calls
`agentDispatcher.reconfigure()`, which re-initialises the running agent worker
with the new model and knobs. The model and the knobs are **compared
separately** (`sameModelConfig` / `sameKnobs` in `agent/runner.js`): the
motivating publish — turning sensitivity down against a live room — touches no
model field at all, and a dispatcher that only compared the model would keep it
from every running worker until the next task restart.

**It is an optimisation of the wait, not the mechanism.** The task converges on
the published config within the TTL whether or not the call ever arrives, which is
why the control plane treats a failure as a log line rather than a failed
publish — the write is already durable, and reporting an error for a change that
*was* saved is the worse failure.

What it buys is the case the TTL covers badly: `ensureWorker` only reconfigures
when it is called, so in a **quiet kelabo** a model change would sit unapplied for
as long as nobody spoke.

It carries no body — it is a "look again", not a value — so nothing an
administrator typed reaches the Gateway except through the table.

### 6.2 Convergence, honestly

| Reader | Sees a published change after |
|---|---|
| The publishing Lambda container | immediately (its own cache is invalidated) |
| The Gateway task | immediately, via the reload; ≤ 60 s if it fails |
| Other warm Lambda containers | ≤ 60 s |
| A supplier credential, either service | ≤ 5 min (the credential cache) |

The publish response carries `gatewayReloaded`, and the console says **"Live
now"** or **"the gateway will pick this up within a minute"** rather than
implying it is already live everywhere.

---

## 7. Three asymmetries worth knowing

### 7.1 `retentionDays` stamps at write time

It is publishable, but a change reaches **new** material only. Lengthening it
does not resurrect what has already expired; shortening it does not reach back to
shorten what is already stored.

The same shape applies to `auth.*`: a shortened TTL affects tokens minted from
now on and does not revoke a session already issued. Nothing here revokes —
that is `/logout-all`.

And to `rtc.*`: those are defaults for a **new** kelabo. A kelabo keeps the
`rtcMode` stamped on its META, because a kelabo's transport never changes after
creation (docs 15 §1.1) and publishing a new default must not become a way around
that rule for a call already in progress.

### 7.2 `organizationName` is deliberately absent

It sits beside `allowedEmailDomain` in `kelabo.json` and reads like the same kind
of value. It is compiled into the SPA bundle as `VITE_ORG_NAME` at build time
(`scripts/deploy-frontend.sh`) and **no server-side code reads it**, so publishing
it would change nothing anyone could see.

A knob that appears to work and does not is worse than an absent one: the
operator edits it, saves, reloads, sees the old name, and has no way to tell that
from a broken save. It becomes publishable when the SPA fetches its bootstrap at
run time, and that is a separate change.

`allowedEmailDomain` is only half in the same position, and the seam is real: the
**enforcement** in `otp.js` and `oidc.js` reads the published value, while the
sign-in page's prefill is still `VITE_ALLOWED_EMAIL_DOMAIN`. A deployment that
publishes a new domain without running `make frontend` will accept the new domain
while the page still names the old one.

### 7.3 A changed domain does not re-stamp what exists

Rows are stamped with the *creator's* email domain at creation, so a deployment
that publishes a corrected domain has rows under both. The Gateway's settlement
sweeper (`kelabosByStatus` in `gateway/src/db.js`) therefore deliberately keeps
querying by the **bootstrap** tenant rather than the published one: following
the publish would silently stop it seeing everything stamped before it, which is
worse than the stable-but-stale alternative. A deployment genuinely changing its
domain should expect the sweep to need the multi-tenant Scan path — that is a
deploy-shaped change, not a publish-shaped one.

---

## 8. Mail: why the IAM grant had to widen

`mail.provider` and `mail.fromAddress` are published and resolved **per send**.
The reason this one could not wait for a deploy arrives from outside: SES
production access is granted case by case and is regularly refused, and a
permanently sandboxed account can mail only addresses verified one at a time,
which is not a service.

That forced two changes in `infra/lib/lambda-stack.js`, and both are the same
lesson — **a deploy-time IAM decision cannot follow a run-time value**:

- The grant is **unconditional** rather than wrapped in
  `if (cfg.mail.provider === "ses")`. A deployment whose file still said
  `mailersend` while the published version said `ses` would hold no send
  permission and fail every sign-in code, with the publish itself having reported
  success.
- It is fenced by the **sending domain** (`StringLike *@<domain>`) rather than by
  the exact address. `StringEquals` on one address would turn "publish a new
  sender" into an AccessDenied on every send.

The narrowing that survives: the function still cannot send as another verified
identity in the account, and SES independently refuses any domain it has not
verified.

**The cost, seen on day one.** A typo'd from-address (`opt@` for `otp@`) used to
be an instant AccessDenied on every sign-in — loud, and traced in a minute. Under
a domain fence it sends perfectly, from an address that does not exist. That is
the price of publishable mail, and it is why the console shows the from-address
beside its deployment default.

---

## 9. Operating it

```
make opconfig-show env=dev     # which versions this env has published
make opconfig-seed env=dev     # dry run: what publishing kelabo.json would write
```

`opconfig-seed` publishes the deployment's current `config/kelabo.json` values as
a version, handing ownership of them to the console. **Most deployments should
not run it.** An unpublished field already falls back, and `/admin` already shows
it as "Deployment default" — nothing is missing and nothing is broken.

What it changes is ownership, and that is a trap worth stating twice: after a
field is published, editing `kelabo.json` for it has **no effect at all** — no
error, no warning, just a redeploy that appears to do nothing. Bulk-seeding forty
fields makes forty entries in `kelabo.json` misleading in exchange for making a
console that already displayed them display them slightly differently.

It is genuinely useful in one case: a deployment that wants the console to be the
single source of truth going forward, typically because the people who will
operate it do not have the repo. `groups="llm,agent"` seeds part of it.

**Never run it against an environment that has already been configured from the
console** — it publishes `kelabo.json` values over whatever was set there.

### 9.1 Log lines an operator greps for

| Event | Where | Means |
|---|---|---|
| `opconfig_published` | Lambda | a version was published; carries `by`, `version`, `note` |
| `opconfig_gateway_reload_failed` | Lambda | the publish succeeded; the Gateway will converge on the TTL |
| `opconfig_unreadable` | either | the table could not be read; the last known version is being served |
| `credential_rotated` | Lambda | a supplier key was written; carries `by`, `slot`, field **names** |
| `admin_granted` / `admin_revoked` | Lambda | the roster changed; root-only |
| `internal_request` `action=config_reload` | Gateway | the reload arrived; carries `reconfigured` |
| `agent_model_reconfigured` | Gateway | a running worker took a new model |
| `agent_knobs_reconfigured` | Gateway | a running worker took new gate/orchestrator knobs, model unchanged |

---

## 10. Adding a new publishable setting

1. A field in `opConfigSchema` (`contracts/src/opconfig.js`) — nullable if it is
   a number or a boolean, so `0`/`false` survive the fold.
2. A line in `resolveOpConfig`, and one in `applyOpConfig` if the service holds it
   under a different name.
3. A control in `spa/src/components/opconfig/OpConfigForms.jsx`, in the group
   it belongs to — the group components are shared so a console other than
   `/admin` (the saas branch's `/superadmin`) grows the field on its next
   merge instead of forking the form. `Admin.jsx` only places groups in tabs.
4. The consumer reads the resolved value, never `config.x` — in the Lambda that
   is `(await settings()).x`, on the Gateway it is `effectiveConfig(c)` (or
   `effectiveConfigNow(c)` inside a callback that cannot await).
   `rest-api/test/admin.mjs` and `gateway/test/opconfig.mjs` read the consumer
   sources and fail if one regresses to `config`.
5. Leave the `KELABO_*` env var and the `kelabo.json` key alone. They are the
   bootstrap now, and removing them would break a deployment that has published
   nothing.
6. Say what `config/template.json` does about it, in `TEMPLATE_KEY` in
   `infra/test/config.mjs`. A new group in `opConfigSchema` that is not named
   there fails that test — deliberately, because the decision is not obvious
   and the wrong answer is invisible. The default is `null`: the template does
   **not** carry it, because a value in the file stops doing anything the
   moment the field is published (§9). The template carries a publishable
   field only when it has no working fallback (`llm`, `stt.providers`,
   `mail.fromAddress`, `org.allowedEmailDomain` — a deployment missing those
   cannot run the agent or send a sign-in code, and cannot publish its way out
   because root must be an address at `allowedEmailDomain`) or when it has no
   console control at all (`auth.socialProviders`, `stt.settings`, §1.2).

Adding an STT **provider** needs none of this: `stt.settings` is an opaque
`z.record`, deliberately, so a new engine's block does not edit this schema, the
console, or every deployed task definition.

---

## See also

- docs 08 §6d — the `config` table; §6c — the credentials table and the IAM trade
- docs 09 §15 — the publish and credential-rotation flows
- docs 02 §3.7 — every `/admin` route; §6 — the Lambda's IAM
- docs 03 §6b — the Gateway's reader and the reload route
- docs 01 §5.10 — the console
- docs 07 §1, §5 — what CDK still owns, and the grants
- docs 19 — a capability can now be switched on without a deploy
- `docs/self-hosting.md` §D — setting this up for the first time
