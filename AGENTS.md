# AGENTS.md — Kelabo

Kelabo assistant: browser SPA captures audio → STT provider (Deepgram or Soniox —
direct, never through our infra) → captions POSTed to a single ECS Gateway → LLM agent → contributions fanned
to a live SSE "board". The SPA also hosts the **conference call** over Cloudflare
Realtime (`sfu` or peer-to-peer `mesh`), signalled by the same Gateway. Design docs:
`ARCHITECTURE.md` first, then `docs/README.md` (component docs in `docs/components/`).

## Layout (not an npm workspace)

Independently-installed packages, each with its own `package.json` and
`node_modules`. There is **no** root workspace config; `npm install` at the root
installs nothing but esbuild.

| Dir | What | Runtime |
|---|---|---|
| `config/` | `loadConfig.mjs` — everything CDK needs at synth, and the **bootstrap** for everything else (docs 23) | build/deploy time |
| `contracts/` | `@kelabo/contracts`: constants, zod schemas, WSS frames, `[LLM_CON]` parsing, supplier credential slots, the published-config schema (`opconfig.js`) | shared |
| `rest-api/` | control plane (auth/OTP/OIDC, kelabos, records, STT credential mint — `stt-token`) | Lambda + API GW |
| `gateway/` | caption ingest, SSE hub, `/rig` WSS tunnel, in-task agent worker | ECS Fargate ×1 |
| `connector/` | the agent bridge: an MCP server a developer's own coding agent spawns, which tunnels to the Gateway (docs 16). `private`; publishes as `@kelabome/agents` via `build/pack.mjs` (docs 17) | dev laptop |
| `rig/` | Docker image packaging opencode + the bridge for people who do not configure an agent themselves; no `package.json` — it bundles `connector/` | dev laptop |
| `spa/` | Vite + React + Tailwind, pure JSX | S3 + CloudFront |
| `infra/` | CDK app (`infra/bin/kelabo.js`), 9 stacks per env from 9 files in `infra/lib/` (+ `-waf` when `allowIps` is set) | AWS CDK |

## Hard rules

- **Pure JS ESM, no TypeScript, anywhere.** Shared types are JSDoc typedefs
  (`contracts/src/typedefs.js`) validated with zod at trust boundaries.
- **No hard-coded env values.** Domains, table names, bucket names, ECR URIs and
  the gateway image URI are all *derived* in `config/loadConfig.mjs`. Add new
  derived values there, not in consumers.
- **A new setting goes to `config/kelabo.json` only if CDK needs it at synth**
  (docs 23). An account, a region, a domain, a WAF list, the gateway's size, a
  secret *name* — yes. Anything read by application code at request time — a
  model, a rate limit, a TTL, a provider — is a field in `opConfigSchema`
  (`contracts/src/opconfig.js`), published from `/admin`, with the config file
  as its bootstrap. A value read at synth cannot follow a row in a table.
  **`config/template.json` carries the deploy-time half only** — the published
  blocks were removed from it, because `loadConfig.mjs` defaults each field to
  exactly the fold's own fallback, and a value left in the file stops doing
  anything the moment that field is published. The exceptions are the four
  with no working fallback (`llm`, `stt.providers`, `mail.fromAddress`,
  `allowedEmailDomain`) and the two with no console control
  (`auth.socialProviders`, `stt.settings`). `infra/test/config.mjs` enforces
  both halves and fails on a new `opConfigSchema` group that says neither.
- **`rootAdminEmail` is deploy-time and only deploy-time**, and empty **fails
  closed**. Everything else operational is editable from a web page, so who may
  edit must not be — otherwise an administrator can lock the operator out of
  their own deployment in one request.
- Target runtimes are **Node 20** (Lambda) and **Node 22** (containers) even though
  local Node may be newer.
- Every AWS resource is tagged `app=kelabo` + `endpoint=<env>` at the CDK app root.
- `tenantId` = verified email domain; stamped on every persisted item.

## Setup

`config/kelabo.json` is **gitignored**. Copy `config/template.json` to
`config/kelabo.json` and fill in account/region/domains — nothing (including
`make check`/`make test`/`cdk synth`) works without it. The template is
deploy-time only; rate limits, TTLs, agent knobs and RTC defaults are not
missing from it, they are `/admin`'s (docs 23).

```
make bootstrap     # npm install at root + contracts, infra, rest-api, gateway, connector, spa
```

Dev-mode Rig (optional, opencode-on-laptop path): `make -f rig/Makefile rig-setup`
generates the gitignored `rig/rig-profile.json`, then `rig-build` / `rig-up` /
`rig-logs`. The rig image is also built from the repo root.

`@kelabo/contracts` is a `file:../contracts` dep and npm **symlinks** it into each
consumer's `node_modules`. Editing contracts takes effect immediately — no
reinstall. But adding a new subpath export requires updating `contracts/package.json`
`exports`.

## Verify

There is **no linter, formatter, typechecker, or CI**. The only gates are:

```
make check                       # node --check over every .js/.mjs (syntax only)
make test                        # rest-api + gateway + connector smoke, spa test + build, cdk synth
cd contracts && npm test         # frames (the agent wire protocol), mention, speaker, orgs, credentials, entitlement, opconfig
cd gateway  && npm test          # agent, mcp, rtc, roster, presence, repairJson, minutesAnswer, cors, opconfig, smoke, journeys, journeyLegs
cd rest-api && npm test          # smoke, wiring, reserved, admin, mail, otpMail, journeys, closeAccount
cd connector && npm test         # queue + envelope + persona + cards + install + runtimes + launch + channel + control (pure), smoke, pack
cd infra && npm test             # config/template.json: nothing CDK writes is "undefined", no published block crept back
cd spa && npm test               # test/transcript.mjs (compose + project) + test/rtc.mjs (pull reconcile, retry policy) + test/presence.mjs
cd spa && npm run build          # the only syntax gate for JSX
```

`make check` deliberately skips `spa/src` (JSX is not parseable by `node --check`),
so `npm run build` in `spa/` is the only syntax gate for frontend changes.

The SPA's test suites cover the transcript pipeline and the two pure pieces of
the conference transports, and only because
`transcript/composer.js` and `transcript/transcriptStore.js` are deliberately
pure — no React, no fetch, an injected clock — so plain node can load them
(their imports carry `.js` extensions for that reason, unlike the rest of
`spa/src`). Keep new transcript logic in those modules rather than in a hook or a
component, or it becomes untestable and the next boundary bug is again only
findable in a live kelabo.

`connector/src/envelope.js` and `connector/src/transcriptQueue.js` exist for the
same reason on the bridge side: everything else there needs a real coding agent
attached, so it can only be exercised in a live kelabo. What the agent *sees*
and *when* it sees it live in those two pure modules (imports carry `.js`), and
`connector/test/smoke.mjs` drives the whole bridge against a **stub adapter** —
proving the contract without opencode or Claude Code installed.

`connector/src/install.js` is pure for a sharper version of the same reason: it
decides how to edit **the developer's own opencode config**, and the invariant it
serves is that `kelabo uninstall` restores that file exactly. Getting it wrong
does not fail a test, it damages someone's working setup, so the round-trip
property is asserted in `connector/test/install.mjs` against every shape of
pre-existing config. Keep config-editing decisions there, not in `cli.js`.

`spa/src/rtc/reconcile.js` and `spa/src/rtc/retry.js` exist for the same reason:
everything else in the transports needs a real `RTCPeerConnection`, so it can
only be exercised in a live kelabo — which is exactly where a track that never
arrives is indistinguishable from a bad network. Decisions about *whether to
re-pull* and *whether to retry* live in those two pure modules (imports carry
`.js`, like the transcript ones) so plain node can check them.

Tests are hand-rolled `node` scripts (no jest/vitest), offline, with stubbed AWS
clients. They work because the entrypoints take injected deps:
`createContainer(overrides)` in `gateway/src/container.js` and `createApp(deps)` in
`rest-api/src/index.js`. Keep new code reachable through those seams — do not
construct AWS SDK clients or read `process.env` inside request handlers.

Agent pipeline harness (real `TriggerGate` → `MainAgent` → `SubAgent`, no AWS,
no server): `cd gateway && node test/devAgent.mjs --provider scripted`. Use
`--provider anthropic|openai` with `KELABO_LLM_API_KEY` for live runs.

## Deploy (`make` targets; `env=dev` by default, `AWS_PROFILE` from your environment)

`make` with no target prints `help` (targets are self-documented via `## `
comments — keep them in sync when adding one).

```
make deploy env=dev      # docker push -> cdk deploy --all -> force ECS redeploy -> SPA
make docker env=dev      # build + push gateway image to ECR
make restart env=dev     # force-new-deployment only (re-pull :latest)
make gateway|backend|frontend|infra|synth env=dev
make secrets env=dev     # the only Secrets Manager entries left: cookie key + origin secret
```

Supplier credentials (LLM/STT/RTC/mail) are **not** secrets any more — they are
rows in the credentials table (`CRED#<slot>`, docs 08 §6c), under their own
customer-managed key.

**The normal way to set one is now `/admin` → Suppliers.** The `make` targets
below remain the first-run path — a brand-new environment has nobody who can
sign in yet — and are the only way to *remove* a field, since the console writes
a key and never reads one back.

```
make credential-set env=dev slot=llm            # what the slot takes
make credential-set env=dev slot=llm fields="apiKey=…" write=1
make credentials-migrate env=dev write=1        # or copy them out of Secrets Manager
make credentials-show env=dev                   # which slots are set, never the values
```

Operational configuration (docs 23) is published from `/admin`, not deployed:

```
make opconfig-show env=dev                      # which versions this env has published
make opconfig-seed env=dev                      # dry run; write=1 publishes kelabo.json's values
```

`opconfig-seed` hands ownership of the config file's values to the console.
**Most deployments should not run it** — an unpublished field already falls back
and `/admin` already shows it — and it must never be run against an environment
already configured from the console, because it publishes over what is there.

`credential-set` is the first-run path (`rest-api/scripts/put-credential.mjs`):
it merges the named fields into the slot, refuses a field name the slot does not
define, and is dry until `write=1`. Fields can equally come from
`KELABO_CRED_<SLOT>_<FIELD>` in the environment, which is what to use for a real
key — an argument is in the shell history and in `ps`. `credentials-migrate` is
the upgrade path for an environment that still has the keys in Secrets Manager;
the source secrets are left in place.

Order matters and is non-obvious:

- The gateway ECS stack **imports** the ECR repo by name
  (`ecr.Repository.fromRepositoryName`) — CDK does not build the image. Push the
  image (`make docker`) before the first `cdk deploy` of `kelabo-<env>-gateway`.
- The task definition pins the mutable `:latest` tag, so a new image alone does not
  roll the service. Use `make restart` (or `make deploy`, which does it).
- **Removing a shared resource takes two deploys, in the opposite order to
  creating one.** When one stack grants another access to a resource, CDK emits
  a CloudFormation *export* in the owner and an *import* in the consumer.
  Creating goes owner-first; removing must go **consumer-first**, because
  CloudFormation refuses to delete an export that anything still imports:
  `Delete canceled. Cannot delete export … as it is in use by …`. `make deploy`
  runs `cdk deploy --all`, which is always owner-first, so it *cannot* remove
  one — it fails and rolls back (harmlessly; the stack lands in
  `UPDATE_ROLLBACK_COMPLETE`, which is updatable). Deploy the consumer alone
  first (`make backend` for the Lambda), then everything:

  ```
  make backend env=dev     # drops the import
  make deploy  env=dev     # now the owner can drop the export
  ```

  `aws cloudformation list-imports --export-name <name>` names the stacks still
  holding one.
- **A new DynamoDB table needs `cdk deploy` before the code that uses it ships.**
  `config/loadConfig.mjs` derives the name, `dynamodb-stack.js` creates it and
  `lambda-stack.js` grants access — deploying the Lambda alone gives it an env
  var pointing at a table that does not exist, and the failure is a runtime
  `ResourceNotFoundException` on the first request, not a deploy error.
- **`make restart` rolls the image, never the config** — but read docs 23
  first, because for most settings the answer is now "do not deploy at all".
  Model, STT engine, mail transport, agent knobs, RTC defaults, every rate limit
  and TTL, `allowedEmailDomain` and `retentionDays` are **published** from
  `/admin` and take effect in seconds. What is left in the task definition is
  the bootstrap.
  For a genuinely deploy-time value (account, region, domains, `allowIps`,
  gateway size, log retention, secret names, `rootAdminEmail`): on ECS the
  gateway never reads `config/` at all — `loadGatewayConfig()` returns
  `fromEnv()` the moment `KELABO_TABLE_KELABOS` is set, and CDK sets it — so
  every value reaches the task as a `KELABO_*` variable written into the **task
  definition** by `infra/lib/gateway-ecs-stack.js`. `make restart` forces a new
  deployment of the *same* revision, so editing the config and restarting
  silently keeps the old value. Those need `make gateway` or `make deploy`. The
  same applies to the Lambda via `infra/lib/lambda-stack.js`.
- The gateway Docker build context is the **repo root** (`gateway/Dockerfile` copies
  `contracts/` and `config/`), not `gateway/`.
- The Lambda is bundled by CDK's `NodejsFunction` **from `rest-api/src/index.js`**
  with `depsLockFilePath` = the root `package-lock.json`. `rest-api/npm run build`
  (esbuild → `dist/`) is not part of any deploy path.
- SPA `VITE_*` values are computed from config by `scripts/deploy-frontend.sh` at
  build time; local dev falls back to `localhost` defaults in `spa/src/config.js`.

## Component notes

- **Gateway** (`gateway/src/server.js`): plain `node:http` with a manual `route()`
  switch — no framework. The LLM agent runs in a `worker_thread`
  (`agent/runner.js` spawns `agent/worker.js`); worker↔main talks via
  `postMessage` with `log`/`debug` message types that surface in the SPA
  DebugPanel. In-process state (`state.js`) is rebuilt from DynamoDB on boot,
  which is why `desiredCount` stays 1.
- **Gateway config** (`gateway/src/config.js`): if `KELABO_TABLE_KELABOS` is set it
  reads everything from env (the ECS path); otherwise it imports
  `config/loadConfig.mjs` (the local path). Add new settings to *both* `fromEnv()`
  and `fromBase()`, and to the task env in `infra/lib/gateway-ecs-stack.js`. If
  the setting is operational rather than structural it also needs a field in
  `opConfigSchema` and a line in `resolveOpConfig`/`applyOpConfig`, or it is
  deploy-only forever (docs 23 §10).
- **Operational configuration** (`contracts/src/opconfig.js`, docs 23): the
  model, the STT engine, the mail transport, the agent knobs, every rate limit
  and TTL are **published** from `/admin` into `kelabo-<env>-config`
  (append-only, `PK=OPCONFIG`), not deployed. `resolveOpConfig` folds a published
  version over the service's own config — published wins, the environment is the
  bootstrap — so a deployment that has published nothing behaves exactly as
  before. Both services read through a 60 s cache;
  `POST /internal/config/reload` makes a publish land at once and re-inits the
  agent worker. Consumers resolve **per request** (`await settings()`), never at
  construction: a warm Lambda container would otherwise never see a publish.
- **REST API** is served under `/api` on the portal host; CloudFront strips the
  prefix before forwarding.
- **Agent bridge** (`connector/`, docs 16): the interface between Kelabo and a
  developer's **own** interactive coding agent. Three contracts: the KAP wire
  protocol on WSS `/rig`, the MCP tool surface (`kelabo_join`/`kelabo_post`/…)
  which is identical for every runtime, and a ~100-line adapter per runtime that
  does nothing but inject transcript. Kelabo supplies a token and a channel;
  the model, MCP servers and permissions are the developer's and are never read
  or written. Tunnel is transcript/contribution/lifecycle only — there is
  deliberately no opencode-in-browser surface or proxy.
- **Agent distribution** (docs 17): `connector/package.json` is `private` — it
  has a `file:../contracts` dep npm cannot resolve elsewhere. `build/pack.mjs`
  emits `connector/dist/agent/` with contracts and zod inlined by esbuild.
  **One package, one `kelabo`, every runtime** — `src/runtimes.js` is the
  registry the CLI dispatches on, and `--runtime <id>`/`--all` selects. Two
  packages was tried and reverted: both declared the same `bin`, so npm refused
  the second global install with EEXIST and they could not coexist at all.
  `kelabo setup` adds keys to **one config file per runtime** and copies no
  files, so `kelabo uninstall` can restore it exactly; what was written is in
  `~/.kelabo/install-<runtime>.json`. opencode gets three keys (`plugin`,
  `mcp.kelabo`, `command.kstart`/`kend`); Claude Code gets one
  (`mcpServers.kelabo` in `~/.claude.json`) because there is no plugin and no
  handover. An opencode npm plugin must `export default { id, server() }` and is
  loaded via `exports["./server"]`.
- **The adapter is chosen at run time from `KELABO_RUNTIME`,** which `setup`
  writes into the MCP entry it creates — the runtime that spawns the bridge is
  the one that says what it is. An unknown id throws rather than defaulting: a
  default is the wrong injection path, and that failure is silent everywhere.
- **`kelabo opencode` / `kelabo claude` start the runtime,** because both need a
  launch argument that is easy to forget and silent when omitted — opencode a
  free `--port` plus `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS`, Claude Code
  the channel flag. Composed from `launch` in `src/runtimes.js`, run by
  `src/launch.js`, flags pinned by `test/launch.mjs`. Everything after `--` is
  forwarded verbatim and uninspected; the full command is always echoed,
  shell-quoted. **A user-supplied flag makes the launcher stand aside, not
  lose** — opencode binds a *random* port when `--port` is repeated (verified
  1.18.6), so passing both would give neither and leave `OPENCODE_BASE_URL`
  pointing nowhere.
- **The opencode plugin spec is a `file:` URL of the installed package,** never
  `@kelabome/agents@x.y.z`. A registry spec opencode cannot fetch produces **no
  error at any level** — empty cache dir, no plugin, so `/kstart` has no hook, no
  session reaches the bridge, and `kelabo_join` says "run /kstart" forever while
  the tools and kelabo list work fine over the tunnel. Verified both ways
  against 1.18.6 with an instrumented plugin. `kelabo status` now checks the spec
  resolves; `describePluginSpec` in install.js is the pure half.
- **The install manifest is per runtime.** One shared `install.json` meant
  `uninstall` for opencode followed the Claude Code manifest's `configPath` and
  removed *its* key instead — uninstalling one uninstalled the other, and said
  it had succeeded.
- **Conference audio** (`gateway/src/rtc/`, `spa/src/rtc/`, docs 15): `/rtc/*` on
  the Gateway, signalled down the *existing* SSE stream as an `rtc` event — no new
  transport. The Gateway proxies the Cloudflare SFU API so app credentials never
  reach a browser, and always resolves the caller's session id from its own peer
  record, never from the request body. Presence is in-process
  (`state.rtcRooms`); the durable half is `rtcMode` on the kelabo META.
  Conference audio degrades cleanly (`rtc_unavailable`) until the `rtc`
  credential slot is filled — a table row now, like every supplier key.
- **Outbound mail** (`rest-api/src/mail/`): `messages.js` says what a mail
  contains, a transport (`ses.js`, `mailersend.js`) says how it travels, and
  `index.js` picks one per send. `mail.provider` and `mail.fromAddress` are
  **published** op-config resolved per send — SES is the floor and needs no key
  (IAM role), everything else reads the `mail` credential slot. Because the
  provider is a run-time value the Lambda's `ses:SendEmail` grant is
  unconditional and fenced by sending *domain* rather than exact address: a
  deploy-time IAM decision cannot follow a published one, and the cost is that a
  typo'd local part sends successfully from an address that does not exist
  (docs 23 §8). The boundary between the two
  halves is a *message object*, never a MIME string: MIME is an SES workaround
  for `Simple` content not carrying a part, and MailerSend takes the same inline
  logo as a JSON attachment. `mime.js` is therefore SES-only. Adding a provider is one file
  exporting `{ id, send(message) }` plus a line in `FACTORIES` and in
  `MAIL_PROVIDERS` (restated in `config/loadConfig.mjs`, so a typo fails at
  config load rather than at somebody's sign-in).

## Domain conventions (enforced in code, easy to break)

- Board gate, **server mode**: an agent reply reaches the board only if it starts
  with an `[LLM_CON]` line followed by `to:` and `title:` headers. Parsing lives
  in `contracts/src/llmcon.js`.
- Board gate, **dev mode**: the `kelabo_post` tool. `[LLM_CON]` is deliberately
  **not** on the agent wire protocol — in a shared interactive session a text
  marker cannot tell a deliberate board post from the agent answering the
  developer's own typed question.
- Transcript given to a local agent is one `<kelabo-transcript untrusted="true">`
  envelope per batch, composed in `connector/src/envelope.js`. That attribute is
  the prompt-injection boundary, not decoration.
- `:KELABO-END` is likewise **not** on the agent wire protocol: summary and
  archive are `requestId`-correlated `request` frames. As an in-band token it
  fired on any caption merely *containing* the string, and the answer was
  recovered by intercepting the next board post.
- Dev-mode slash commands: `/kstart` (hand the opencode session id and server URL
  to the bridge), `/kend`. `/kstart` is a **handover, not a join** — joining is
  `kelabo_join`, which the agent calls. **opencode only**: on Claude Code the
  channel targets the session that spawned the MCP server, so there is nothing to
  hand over and no slash command.
- **The persona does not fit Claude Code's `instructions`,** which are truncated
  to 2048 chars at connect time with only a DEBUG line to show for it. So
  `persona.js` splits: `PERSONA_CORE` (identity, silence, the injection gate,
  `kelabo_post` is the only route out) goes in the system prompt, and the full
  `PERSONA` is returned by `kelabo_join`. Keep the injection gate in the core —
  a security control that only arrives in a tool result can be compacted away.
- **A provider that accepts a message has not necessarily sent it.** MailerSend
  answers `202 Accepted` for a suppressed recipient or a paused account, with a
  warning in the body and no `x-message-id`. Taken at face value that is the
  worst failure here: the person is told a code was sent, the log records a
  send, and nothing arrives. `mailersend.js` reads the body on success, not
  only on failure, and turns those into `email_suppressed` /
  `mail_not_configured`. Any new transport owes the same.
- **A prep binding cannot receive transcript.** An agent attached to a *scheduled*
  kelabo lives in `state.prepByKelabo`; `caption.js` reads only
  `state.tunnelByKelabo`. Attending is a second, deliberate attach after the
  kelabo starts, so "I prepared but I am not joining" is structural rather than
  a convention.
- **Three token families share one signing key** (browser cookies, the internal
  REST→Gateway JWT, agent tokens). `aud` is the only thing separating them, so
  every verifier must check it.
- **In the published-config fold, `null` means unset — not falsiness.** `0`
  (`agent.maxConcurrentRuns` = unlimited, `turnDeadlineSeconds` = no deadline)
  and `false` (`rtc.video` = audio only) are real published values that a
  `published || fallback` check silently discards, restoring the deployment's
  value with nothing in any log. Strings keep empty-means-unset, so a cleared box
  hands the field back instead of naming a provider `""`.
- **A published field that nothing reads is worse than an absent one** — the
  operator edits it, saves, and cannot tell "no effect" from "failed save". A
  consumer reads `(await settings()).x`, never `config.x`; `rest-api/test/admin.mjs`
  reads the sources and fails if one regresses.
- **No route returns a supplier credential value.** `credentials.getRaw` exists
  and `admin.js` deliberately never calls it. A key is written from `/admin` and
  never read back, so a stolen admin session can break a deployment but not
  exfiltrate the keys it runs on. That application limit is what replaced the IAM
  attribute fence, which no longer binds now the Lambda holds `PutItem` on the
  `CRED#` partitions (docs 23 §5).
- Speaker is either an authenticated identity or an STT diarization label
  (`A`/`B`/`C`); both are treated identically downstream.
- **One `getUserMedia` per kelabo.** `spa/src/rtc/useMicStream.js` owns the
  device; `useCapture` and `useRtc` both consume its stream. Acquiring twice gives
  two captures and breaks echo cancellation. For the same reason nothing in the
  room turns echo cancellation off any more (the old **Raw mic** toggle): without
  it every remote voice returns through your mic and is posted as your caption.
- **Mute when tab is hidden** (`spa/src/capture/useHiddenMute.js`, opt-in,
  `kelabo-mute-hidden`) mutes on tab switch and unmutes on return — but only
  ever undoes *its own* mute, never one the participant set by hand.
- **One transcript reducer** (`spa/src/transcript/`, docs 13). Speech is composed
  into messages once (`composer.js`) and projected once (`transcriptStore.js`);
  the speaker's own events and everyone else's SSE events go through the *same*
  `apply()`. Never add a second path for "my" speech versus "their" speech —
  two implementations of that one concept is what made a speaker and a listener
  render different bubbles. `composer` and `transcriptStore` are pure (no React,
  no fetch, injected clock) so `spa/test/transcript.mjs` can run them under node.
- **Message boundaries belong to the speaker.** `messageId` is the only grouping
  key; nothing downstream re-derives boundaries from speaker, adjacency or time.
- **A kelabo's `rtcMode` never changes after creation**, and a full `mesh` room
  refuses joiners (`mesh_room_full`) instead of falling back to the SFU. The one
  exception is `rtcRoom.demote()` (docs 15 §1.1), `sfu` → `mesh` and never the
  other way: the rule guards against a participant being moved to a *weaker*
  promise, and mesh is the stronger one. It refuses rather than degrades when
  the room is larger than `meshMaxParticipants` — mesh is N−1 uplinks per
  person, not a cheaper SFU.
