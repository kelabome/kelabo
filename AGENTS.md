# AGENTS.md — Kelabo

Kelabo assistant: browser SPA captures audio → Deepgram (direct, never through our
infra) → captions POSTed to a single ECS Gateway → LLM agent → contributions fanned
to a live SSE "board". The SPA also hosts the **conference call** over Cloudflare
Realtime (`sfu` or peer-to-peer `mesh`), signalled by the same Gateway. Design docs:
`ARCHITECTURE.md` first, then `docs/README.md` (component docs in `docs/components/`).

## Layout (not an npm workspace)

Independently-installed packages, each with its own `package.json` and
`node_modules`. There is **no** root workspace config; `npm install` at the root
installs nothing but esbuild.

| Dir | What | Runtime |
|---|---|---|
| `config/` | `loadConfig.mjs` — single source of truth for every env-specific value | build/deploy time |
| `contracts/` | `@kelabo/contracts`: constants, zod schemas, WSS frames, `[LLM_CON]` parsing | shared |
| `rest-api/` | control plane (auth/OTP/OIDC, kelabos, records, deepgram token) | Lambda + API GW |
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
- Target runtimes are **Node 20** (Lambda) and **Node 22** (containers) even though
  local Node may be newer.
- Every AWS resource is tagged `app=kelabo` + `endpoint=<env>` at the CDK app root.
- `tenantId` = verified email domain; stamped on every persisted item.

## Setup

`config/kelabo.json` is **gitignored**. Copy `config/template.json` to
`config/kelabo.json` and fill in account/region/domains — nothing (including
`make check`/`make test`/`cdk synth`) works without it.

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
cd contracts && npm test         # node test/frames.mjs (the agent wire protocol) && node test/mention.mjs
cd gateway  && npm test          # node test/agent.mjs && node test/rtc.mjs && node test/presence.mjs && node test/smoke.mjs
cd rest-api && npm test          # node test/smoke.mjs && node test/reserved.mjs && node test/otpMail.mjs
cd connector && npm test         # queue + envelope + persona + cards + install + runtimes + launch + channel + control (pure), smoke, pack
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
make secrets env=dev STT_PROVIDER=... STT_API_KEY=... LLM_API_KEY=...
make mail-secret env=dev provider=mailersend key=...   # only if not sending via SES
make rtc-secrets env=dev CF_SFU_APP_ID=... CF_SFU_APP_SECRET=... CF_TURN_KEY_ID=... CF_TURN_KEY_TOKEN=...
```

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
- **`make restart` rolls the image, never the config.** On ECS the gateway never
  reads `config/` at all: `loadGatewayConfig()` returns `fromEnv()` the moment
  `KELABO_TABLE_KELABOS` is set, and CDK sets it. Every `config/kelabo.json`
  value reaches the task as a `KELABO_*` environment variable written into the
  **task definition** by `infra/lib/gateway-ecs-stack.js`. `make restart` forces
  a new deployment of the *same* task-definition revision, so changing a config
  value and restarting silently keeps the old one. Config changes need
  `make gateway` (docker + `cdk deploy <prefix>-gateway`) or `make deploy`.
  The same applies to the Lambda via `infra/lib/lambda-stack.js`.
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
  and `fromBase()`, and to the task env in `infra/lib/gateway-ecs-stack.js`.
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
  `make rtc-secrets` is separate from `make secrets` because the feature degrades
  cleanly (`rtc_unavailable`) without it.
- **Outbound mail** (`rest-api/src/mail/`): `messages.js` says what a mail
  contains, a transport (`ses.js`, `mailersend.js`) says how it travels, and
  `index.js` picks one per send. `mail.provider` in config selects it — SES is
  the default and needs no key (IAM role), everything else reads
  `kelabo/<env>/mail`. The boundary between the two halves is a *message
  object*, never a MIME string: MIME is an SES workaround for `Simple` content
  not carrying a part, and MailerSend takes the same inline logo as a JSON
  attachment. `mime.js` is therefore SES-only. Adding a provider is one file
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
- Speaker is either an authenticated identity or a Deepgram diarization label
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
