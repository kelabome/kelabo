# 17 — Distributing the agent bridge (`@kelabome/agents`)

> Read [`16-agent-bridge.md`](./16-agent-bridge.md) first. That document defines
> *what* the bridge is — three contracts, a tool surface, an adapter per runtime.
> This one defines how a developer who has never seen this repository **gets** it,
> **wires** it, **uses** it and **removes** it, leaving no trace.

Today the bridge is reachable only by cloning the repo: `connector/README.md`
tells the reader to point their `opencode.json` at an absolute path inside a git
checkout and to hand-copy three files into `~/.config/opencode/`. That is fine
for the people who wrote it and impossible for anyone else. This document turns
`connector/` into a published npm package with a first-run wizard and a real
uninstaller.

**One package, one `kelabo`, every runtime.**

```
npm i -g @kelabome/agents
kelabo setup                      # asks which runtime, or --runtime <id> / --all
kelabo opencode                   # …or `kelabo claude` — starts it, correctly
kelabo status                     # doctor, per runtime
kelabo uninstall --runtime <id>   # or --all --purge
npm rm -g @kelabome/agents
```

`src/runtimes.js` is the registry the command dispatches on: config file, MCP
entry shape, how to detect the runtime, and the launch line that follows. Adding
a runtime is a row plus an adapter — no new package, binary, build target or
publish step.

| Runtime | `setup` writes | Then |
|---|---|---|
| opencode | 3 keys in `opencode.json` | `kelabo opencode`, then `/kstart` |
| Claude Code | 1 key in `~/.claude.json` | `kelabo claude` |

### Why not one package per runtime

It was built that way first, and reverted. Two packages meant two `bin` entries,
and npm does not merge global bins: with both named `kelabo`, the second
`npm i -g` **fails outright** —

```
npm error EEXIST: file already exists
npm error Remove the existing file and try again, or run npm
npm error with --force to overwrite files recklessly.
```

— so the two could not be installed side by side at all, which is the normal case
for anyone who uses both editors. Renaming them apart (`kelabo-opencode`,
`kelabo-claude`) fixed the install and left a worse problem: two commands that
each silently cover half the machine, and a `kelabo-claude uninstall` that says
nothing about the opencode wiring still sitting in a config file.

What the split bought was that each package shipped only its own adapter —
roughly 2 KB. The cost was in the wrong place. So the adapter is chosen when the
bridge *runs*, from `KELABO_RUNTIME`, which `setup` writes into the MCP entry it
creates: the runtime that spawned the bridge is the one that says what it is
(`src/adapters/index.js`). An unknown value throws rather than defaulting,
because a default would be the wrong injection path and injection failures are
silent on both runtimes.

---

## 1. The governing idea: setup must be exactly invertible

Everything below follows from one requirement. `kelabo uninstall` has to leave
the developer's coding-agent configuration **as it was before `kelabo setup`
ran**. Not "close enough". Not "we deleted the files we think we wrote".

Verified end to end: install from a tarball, `setup`, `uninstall`, `diff` — byte
identical, including a config indented with four spaces. The one thing not
preserved is a compact object written on a single line, which `JSON.stringify`
has no setting for and which expands the first time we write. Indentation is
detected and reused (`detectIndent`), because for anyone keeping their config in
git the alternative turns `kelabo setup` into a hundred-line diff with three real
changes hidden inside it.

That requirement is what rules out the current approach. Copying
`kelabo-bridge.js` into `~/.config/opencode/plugins/` and two `.md` files into
`~/.config/opencode/commands/` creates three pieces of state that an uninstaller
must find again, must distinguish from a file the user has since edited, and
must not delete if the user renamed it. Every one of those is a way to either
leave litter behind or destroy someone's work.

So `setup` **writes no files into the runtime's configuration directory at all**.
It adds keys to one JSON file — three on opencode, one on Claude Code — and
records what it added. `uninstall` removes exactly those keys if — and only if —
they still hold the values that were written.

This is also why the install manifest exists (§6) even though the design is
"JSON-only". Uninstall needs to know *which* config file to clean, and it needs
to be able to tell "unchanged, safe to remove" from "the user edited this".

---

## 2. What opencode actually does (verified against 1.18.6)

The published documentation at `opencode.ai/docs/plugins` describes an older
plugin API. The shipped binary does something different, and the difference
decides the packaging. Verified empirically by loading a probe package into
`opencode serve` and reading `--log-level DEBUG`:

| Question | Answer |
|---|---|
| Can a plugin be an npm package? | Yes — `"plugin": ["@scope/name@1.2.3"]` in `opencode.json`. Installed with bun into `~/.cache/opencode/node_modules/`. |
| Which entry is imported? | `exports["./server"]` first, falling back to `main`. The probe's `main` was **never evaluated** once `exports["./server"]` existed. |
| What shape must it export? | `export default { id, server(ctx) }` — verified positively: with that shape, `server()` was **called**. The binary carries `Plugin <spec> must default export an object with server()` and `… either server() or tui(), not both`. |
| Is a wrong shape rejected? | **Not always.** A deliberately malformed plugin loaded from a `file:` spec produced no error at all — there is a lenient "detect" mode. So a clean opencode log proves nothing about the plugin, and `test/pack.mjs` asserts the shape by importing the built bundle instead. |
| What is in `ctx`? | `client, project, worktree, directory, experimental_workspace, serverUrl, $` — **`serverUrl` is present**, which is the one thing `/kstart` cannot get anywhere else. |
| Does that shape also load from a plugins *directory*? | **Yes.** A directory-scanned file may use either the legacy named-export form or the new default-export object. |
| Which directories are scanned? | `{plugin,plugins}/*.{ts,js}` — both spellings work. |
| Commands? | `commands/*.md` (plural — singular `command/` is **not** scanned), or inline in `opencode.json` under the `command` key as `{template, description}`. |
| Is `engines.opencode` enforced? | Yes, semver-checked against the running opencode, and it **throws** on mismatch. We therefore omit it rather than guess a floor. |
| Are duplicate plugin specs deduplicated? | Yes, on parsed package name — which is what made a re-pinned registry spec replace its predecessor cleanly, back when the spec carried a version. Today the spec is a `file:` URL (§3), so there is nothing to re-pin and the dedup just keeps `setup` idempotent. |

Two consequences:

- **The plugin must be restructured** from `export const KelaboBridge = async (plugin) => …` to
  `export default { id: "kelabo", server: async (ctx) => hooks }`.
- **One file then serves both distribution paths** — the npm package and the
  rig's directory copy — which is what finally kills the duplication in §7.

---

## 3. The keys

### 3.1 opencode — three keys

`kelabo setup` writes exactly this into the resolved config file:

```jsonc
{
  "plugin": ["file:///usr/local/lib/node_modules/@kelabome/agents"],
  "mcp": {
    "kelabo": {
      "type": "local",
      "command": ["/abs/path/to/node", "/abs/path/to/dist/cli.js", "run"],
      "environment": { "KELABO_RUNTIME": "opencode" }
    }
  },
  "command": {
    "kstart": { "description": "…", "template": "…" },
    "kend":   { "description": "…", "template": "…" }
  }
}
```

**The plugin spec is a `file:` URL of the copy already on disk**, not
`@kelabome/agents@x.y.z`. This was the other way round first, and it was a bug that
cost a real debugging session, so the reasoning is worth keeping.

A registry spec makes opencode fetch the package from npm into its own bun cache.
When that fetch produces nothing — because the package is not published, or the
machine is offline, or the name is wrong — **opencode says nothing at all.** It
creates `~/.cache/opencode/packages/@kelabome/agents@0.3.0/`, leaves it empty, logs
no error at any level, and runs without the plugin. There is then no
`command.execute.before` hook, so `/kstart` does nothing, so no session id ever
reaches the bridge — and `kelabo_join` answers:

    No opencode session is bound. Run /kstart in your opencode session first

which is advice to repeat the thing that just silently did nothing. Everything
else looks perfect: the tools are there and the kelabo list is correct, because
those travel the tunnel. Only the handover is missing.

Measured against 1.18.6, with the built plugin instrumented to record being
called:

| `plugin[0]` | Result |
|---|---|
| `file:///…/lib/node_modules/@kelabome/agents` | `server()` called, `serverUrl` populated, **no cache entry created** — loaded straight from the path |
| `@kelabome/agents@0.3.0` (unpublished) | never called, empty cache directory, nothing logged |

A `file:` spec is also better on its own terms, and retires two things this
document used to argue for:

- **The version pin is gone, because there is nothing to keep in lockstep.** It
  existed because the plugin and the MCP server were two copies of this package
  on disk sharing a private contract (the loopback port in
  `~/.kelabo/bridge-<pid>.json`). With a `file:` spec they are the *same* copy, so
  they cannot drift and an upgrade is picked up with no re-pin.
- **The first `opencode` start after `setup` no longer needs the network** (§12).

From a checkout there is no sibling package, so `setup` points at
`connector/dist/agent` — the same files the published package carries. If neither
exists it **refuses** rather than falling back to a registry spec, because that
fallback is precisely the silent no-plugin install described above.
`--plugin-spec` overrides either way.

Because the spec can therefore legitimately change — a different install prefix,
a checkout instead of a global install — `applyInstall` takes the
previously-written spec from the manifest. Matching only on package name leaves
both behind, and opencode then loads the plugin twice: two handovers, two toasts,
one confused developer.

**Why the MCP command is an absolute interpreter + absolute script.** An MCP
server is spawned by opencode, which does not necessarily inherit the shell PATH
that had the npm global bin on it. `["kelabo-mcp"]` is a coin flip;
`[process.execPath, resolvedCliPath, "run"]` is not. Setup refuses to write a
path that resolves inside an npx cache (`_npx`), because that path is evicted
without warning and the failure — an MCP server that silently stops existing —
is not one a developer can be expected to diagnose.

**Why commands are inline rather than `.md` files.** Files are state; keys are
not. The `.md` files remain the authoring format in the repo and ship inside the
package (the rig still copies them as files); `setup` parses their front matter
into `{description, template}` and inlines the result.

### 3.2 Claude Code — one key

```jsonc
{
  "mcpServers": {
    "kelabo": {
      "type": "stdio",
      "command": "/abs/path/to/node",
      "args": ["/abs/path/to/cli.js", "run"],
      "env": { "KELABO_RUNTIME": "claude-code" }
    }
  }
}
```

No plugin, because there is nothing for one to do: the channel targets the
session that spawned the MCP server, so there is no second process that knows
something the bridge does not (docs 16 §4.2). No commands, because Claude Code
has no inline-command config key and writing files into its commands directory is
exactly the state §1 exists to avoid — and there is no handover for a `/kstart`
to perform anyway. Joining is `kelabo_join`, which the agent calls.

**The entry shape is different, and getting it wrong is silent.** opencode takes
one argv array under `command` and an `environment` key; Claude Code splits the
interpreter from its arguments and calls the env `env`. Verified by running
`claude mcp add` at each scope under a scratch `HOME` and reading back what it
wrote, not from documentation. `mcpEntryFor()` in `install.js` is the one place
that knows the difference, and `test/install.mjs` pins both against the recorded
shapes.

**Config discovery**, also verified the same way:

| Scope | File | Container |
|---|---|---|
| user | `~/.claude.json` (or `$CLAUDE_CONFIG_DIR/.claude.json`) | `mcpServers` |
| project (`--project`) | `./.mcp.json` | `mcpServers` |
| local | `~/.claude.json` → `projects[cwd].mcpServers` | *not offered* |

`local` is deliberately not offered: it keys the server off an absolute working
directory, so the bridge would exist in one checkout and silently not exist in
another.

**`~/.claude.json` is live state, unlike `opencode.json`.** Claude Code rewrites
it on its own schedule — first-run migrations, machine id, per-project settings —
and it is mode `0600` because it holds an OAuth account record. Two consequences
for `writeConfigFile`:

- The existing mode is copied, and a file we create is `0600`. A plain write
  creates `0644`, so a `setup` run before the first `claude` start would have
  handed the world a file Claude Code then fills with a credential.
- The write is tmp-then-rename. It cannot make the read-modify-write atomic — a
  `claude` running during `setup` can still overwrite our key with its own
  snapshot, which is why setup says to restart it — but it means a lost race
  cannot leave a half-written config that neither side can parse.

Byte-for-byte invertibility still holds and is still tested; it can only be
*observed* end-to-end when Claude Code is not running, because otherwise the
diff is full of its own writes.

---

## 4. Package layout and the build

`connector/package.json` becomes `"private": true`. It is the development
manifest: it keeps `"@kelabo/contracts": "file:../contracts"`, it keeps the test
scripts, and it is **never published**. What gets published is generated.

`connector/build/pack.mjs` runs esbuild and emits one self-contained, publishable
directory, `dist/agent/` (a single package descriptor in the script; today's one
target):

| Emitted | Built from | Notes |
|---|---|---|
| `dist/agent/cli.js` | `src/cli.js` | bundle; shebang preserved; `bin` target |
| `dist/agent/server.js` | `src/plugin/opencode.js` | bundle; the `exports["./server"]` entry |
| `dist/agent/commands/*.md` | `connector/commands/` | copied verbatim |
| `dist/agent/package.json` | generated | no `file:` dependency; `bin`, `exports`, `files`, `engines.node`, `license`, `repository`, `publishConfig.access: "public"` |
| `dist/agent/README.md` | `connector/README.npm.md` | the npm front page |

`server.js` and `commands/` are opencode's and Claude Code ignores them: its
channel targets the session that spawned the MCP server, so there is no plugin to
load and no handover for a slash command to perform.

**`@kelabo/contracts` is inlined, not published.** The bridge imports six symbols
from it — `parseDownFrame`, `ASSISTANT_NAME`, `ADDRESSED_NOTE`,
`NOISY_TRANSCRIPT_NOTE`, `AGENT_DEVICE_POLL_SECONDS`,
`AGENT_DEVICE_CODE_TTL_SECONDS`. esbuild inlines those and `zod` into the
bundles; `ws` and `@modelcontextprotocol/sdk` stay external and remain real
dependencies. This keeps one source of truth for the wire protocol without
publishing the server-side schemas, and without a second package to version in
lockstep. Copying `parseDownFrame` into the connector instead would recreate
exactly the drift described in §7.

**Every adapter ships, and `KELABO_RUNTIME` chooses at run time.** `setup`
writes that variable into the MCP entry it creates, so the runtime that spawns
the bridge is the one that tells it which injection path to use
(`src/adapters/index.js`). An id with no adapter throws — a default would be the
wrong injection path, and that failure is silent on every runtime.

`test/pack.mjs` asserts *both* injection paths survive bundling: if either were
tree-shaken out, the runtime that needed it would get an MCP server that dies on
start, and `test/runtimes.mjs` asserts the registry and the adapter table have
exactly the same ids, so a row can never be offered by `--runtime` without
something behind it.

**The bridge version stops being a literal.** `tunnel.js` hard-codes
`VERSION = "1.0.0"` and announces it to the Gateway in the `register` frame. The
build injects the real package version via an esbuild `define`, with a fallback
to reading `connector/package.json` when running from source.

---

## 5. The CLI

`src/cli.js` replaces the `main()` switch currently at the bottom of
`src/index.js`. `index.js` goes back to being only `startBridge()`.

| Command | Behaviour |
|---|---|
| `setup` | resolve config → back up → apply this runtime's keys → write manifest → pair if not paired → print next steps |
| `login` | device-code pairing only; re-pairing overwrites the credential. **Asks for the API base URL with the stored one as the default** — Enter keeps it, a new value moves the machine to another deployment. `--api`/`KELABO_API_BASE_URL` still skip the prompt. The stored endpoint is deliberately not a silent fallback: inheriting it is exactly wrong for the case that sends anyone back to `login`, and re-pairing is not a *de*-registration — the old token stays valid until it expires, because `DELETE /agent/tokens/:jti` authenticates with a session cookie and a terminal has neither. `login` prints the revoke URL instead, as `uninstall --purge` does. |
| `status` | the doctor, §8 |
| `uninstall [--purge]` | remove the three keys → delete every `~/.kelabo/bridge-*.json` → with `--purge`, delete the credential and print the revoke URL → print `npm rm -g …` |
| `reset` | `uninstall --purge` followed by `setup` |
| `run` | the MCP server. The default, because this is how a runtime spawns it |
| `opencode` / `claude` | **start the coding agent with the flags that make it work** — see below |
| `runtimes` | list the runtimes this build knows |

Flags: `--runtime <id>` (comma-separated for several), `--all`, `--api URL`,
`--config PATH`, `--project`, `--no-pair`, `--dry-run`, `--plugin-spec`.

**Which runtime, resolved in this order:** `--runtime`/`--all` → `--config`
(one file means one runtime, and guessing which would write an opencode-shaped
entry into `~/.claude.json`, which Claude Code declines to start without saying
why) → what is already wired, for `uninstall` and `status` → what is detected on
the machine, when there is only one → an interactive pick → refuse, naming the
flag. Never a silent default: choosing for someone who has both means editing a
config they were not thinking about.

A prompt is only offered where one can be answered. Without a TTY it errors
instead — `readline.question()` against a closed stdin never resolves, node then
drains its event loop and **exits 0**, which made a non-interactive `setup` print
half its output, pair nothing, say nothing, and report success.

### `kelabo opencode` and `kelabo claude` — the launcher

Both runtimes need a launch argument that is easy to forget, tedious to type and
**silent when omitted** — the failure is always the same shape: every tool keeps
working, because tools travel the tunnel, so the agent joins, posts and reads the
board perfectly and never hears a word of the kelabo.

| Runtime | What the launcher supplies | Without it |
|---|---|---|
| opencode | `--port <free>` | `--port` defaults to `0`, which is "serve nothing over HTTP", and HTTP is how transcript arrives |
| opencode | `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true` | the `background` parameter is absent from the task tool's schema, so `background: true` is dropped with no error and every subagent blocks the session |
| opencode | `OPENCODE_BASE_URL` | nothing breaks — the plugin reports the real URL at `/kstart` — but the bridge then has it *before* the handover |
| Claude Code | `--dangerously-load-development-channels server:kelabo` | the channel listener is never registered, and notifications are dropped at both ends |

Asking a developer to reproduce that from memory, every time, on a flag whose own
name tells them not to use it, is asking for the silent failure. So the table in
`src/runtimes.js` composes it and `src/launch.js` runs it.

Three decisions worth keeping:

- **A free port, not a fixed one.** `freePort()` binds `0`, reads the number and
  closes. There is a window between that close and opencode's bind — unavoidable,
  since opencode takes a number and cannot inherit a descriptor — and it is worth
  it, because a fixed port collides *deterministically* the moment somebody opens
  a second session. A lost race fails loudly at startup with the port in the
  message.
- **Extra arguments are forwarded, and `--` makes the boundary explicit.**

  ```
  kelabo opencode -- ~/src/thing --model anthropic/claude-sonnet-4-5
  kelabo claude   -- --resume --model opus
  kelabo opencode --dry-run          # print the composed command, start nothing
  kelabo opencode -- --dry-run       # opencode's --dry-run, not ours
  ```

  Everything after the first `--` is handed over **verbatim and uninspected**,
  including tokens that look like ours — which is the point, and which keeps this
  correct if either CLI grows a flag tomorrow that collides with the other's.
  Without a `--`, unrecognised tokens still forward, because `kelabo claude -p hi`
  is what people type. Only `--dry-run` is ours.

- **When the developer supplies the same flag, the launcher stands aside — it
  does not merely lose.** This was originally documented as "ours first, theirs
  last, theirs wins", which is **false for opencode's `--port`**: verified against
  1.18.6, `--port A --port B` binds *neither*, it binds a random port, because
  yargs collects the repeats into an array and opencode falls back. Measured
  twice: 39897, then 39983.

  Appending both would therefore have been worse than losing the argument —
  `OPENCODE_BASE_URL` would name a port nothing is listening on, and `probe()`
  would fail against it and blame the developer's setup. So a user-supplied
  `--port` suppresses ours entirely, no free port is allocated, and the exported
  base URL follows theirs (including `--hostname`). If their value is not a
  literal number — `--port $MYPORT` reaching us unexpanded — the variable is
  omitted rather than guessed, because the plugin reports the real URL at
  `/kstart` anyway and a wrong one is worse than none.
- **The composed command is always echoed**, shell-quoted so it is pasteable.
  This command types arguments the developer did not, and hiding them is what
  turns "it cannot hear me" into a question nobody can answer.

Preflight is advisory, not blocking: an unwired or unpaired runtime gets a
printed warning and still starts, because their editor is still their editor and
refusing to launch it over a Kelabo problem takes away something that has nothing
to do with Kelabo. A missing binary is the one hard error.

`test/launch.mjs` pins the flags themselves, which is the part that can be wrong
with nothing to show for it — plus the `--` split, the stand-aside behaviour, and
exit-code propagation, so `kelabo opencode && …` behaves like `opencode && …`.

**Config discovery**, in order: `--config` → `$OPENCODE_CONFIG` →
`$XDG_CONFIG_HOME/opencode/opencode.{json,jsonc}` →
`~/.config/opencode/opencode.{json,jsonc}`. opencode loads **both** `.json` and
`.jsonc` if both exist, so when both are present setup picks the one that already
carries `mcp` or `plugin`, and `.json` otherwise.

**The JSONC hazard is refused, not papered over.** `.jsonc` is a supported
opencode config format and people put comments in it. Rewriting such a file
through `JSON.parse`/`JSON.stringify` silently destroys those comments. When
setup detects comments or trailing commas it **does not write**: it prints the
exact JSON block to paste and exits non-zero. Destroying someone's annotated
configuration to save them one copy-paste is not a trade worth making.

Every write is preceded by a sibling backup, `opencode.json.kelabo-backup-<ts>`.

---

## 6. `install.js` — pure, and therefore testable

The dangerous code here is not the network or the MCP protocol; it is mutating a
file the user owns. So it follows the same doctrine as `envelope.js`,
`transcriptQueue.js` and `rtc/reconcile.js`: no `fs`, no `process`, everything
injected, plain data in and out.

```js
applyInstall(config, { pkg, version, mcpCommand, environment, commands })
                    -> { config, created[], warnings[], wrote }
removeInstall(config, manifest)   -> { config, kept[], removed[], warnings[] }
inspectInstall(config, manifest)  -> { plugin, mcpCommand, commands[], complete }
parseCommandMd(text)              -> { description, template }
hasNonJsonSyntax(text)            -> "comments" | "trailing commas" | null
```

`~/.kelabo/install-<runtime>.json` (mode 0600) records
`{ configPath, runtime, pkg, version, cliPath, created, wrote, backup, installedAt }`.

**Per runtime, and that is not cosmetic.** It was one shared `install.json`, and
the second `setup` overwrote the first's record — so `uninstall` for opencode
read a manifest describing the Claude Code install, followed its `configPath`,
and removed `mcpServers.kelabo` from `~/.claude.json` while leaving opencode
fully wired. Uninstalling one runtime uninstalled the other and reported
success. `wrote.mcpContainer` is the discriminator, and a manifest is refused
for any runtime it does not describe; the pre-split path is still read for
opencode, since every manifest that predates the field was one.

`wrote` holds the **values written, verbatim**, not checksums of them. It is the
baseline that later distinguishes an untouched key from an edited one, and
storing the value rather than a hash costs nothing at this size, makes the
manifest readable by the person whose config it describes, and means a mismatch
can say what changed.

`created` is the list of top-level containers that did not exist before setup.
It is the difference between *restoring* the file and *tidying* it: a `plugin:
[]` that was already there must still be there afterwards, and one we introduced
must not be.

Two things this shape has already caught, before any of it ran on a real
machine:

- `wrote` originally shared object identity with the config it described, so
  editing the config edited its own baseline and "has the user changed this?"
  could never answer yes.
- `readConfigFile` parsed before checking for comments, so a `.jsonc` config
  died on `JSON.parse` with `Expected property name at position 4` — useless,
  and wrong: the file is fine, the parser was too narrow.

`connector/test/install.mjs` pins the invariants:

- **the round trip**: `removeInstall(applyInstall(x))` deep-equals `x` — for an
  empty config, one with only `$schema`, one that already has other `plugin[]`
  entries, other `mcp` servers and other `command` entries, and one whose
  containers exist but are empty
- `applyInstall` does not mutate its input
- `applyInstall` is idempotent; re-running `setup` does not append a second
  plugin spec, and re-running at a new version re-pins rather than accumulating
- `removeInstall` leaves a user-edited `command.kstart` **alone** and reports it
  in `kept[]`; the untouched `command.kend` still goes
- containers we created and emptied are pruned; containers that were already
  there are not
- uninstalling twice is not an error
- an npx-cache `mcpCommand` is rejected
- `hasNonJsonSyntax` does not mistake the `//` in `"$schema": "https://…"` for a
  comment — getting that wrong refuses every config in existence

`connector/test/pack.mjs` runs the build and asserts the emitted manifest has no
`file:` dependency and the bundles contain no unresolved `@kelabo/contracts`
import — the one class of mistake that would otherwise surface as a broken
package on the public registry.

---

## 7. What this fixes in the rig

`rig/templates/` carries its own copy of `kelabo-bridge.js`, `kstart.md` and
`kend.md`. The plugin copy has already drifted: it is missing the
`AbortSignal.timeout(5000)` on the handover fetch, which is precisely the guard
whose absence turns `/kstart` into silence with no error anywhere — the failure
the connector copy's own comment describes. A third copy shipped to npm would
make this worse.

- `rig/templates/plugins/` and `rig/templates/commands/` are deleted.
- `rig/bootstrap.js` installs the plugin from
  `/opt/kelabo/connector/src/plugin/opencode.js` and the commands from
  `/opt/kelabo/connector/commands/`. The image already copies `connector/`.
- `rig/templates/agent/kelabo-bot.md` stays; it is genuinely rig-only.
- **`bootstrap.js` installs commands into `<configDir>/command/` (singular),
  which opencode does not scan.** Verified against 1.18.6: the scan glob is
  `{plugin,plugins}/*.{ts,js}` for plugins and `commands/` for commands. If that
  is right, `/kstart` and `/kend` have never existed inside the rig. Fixed to
  `commands/`.

The default-export plugin shape (§2) loads from a directory as well as from npm,
so the single file at `connector/src/plugin/opencode.js` serves the rig and the
package alike.

---

## 8. `kelabo status` — the doctor

Ordered by how often each thing is what is actually wrong:

1. **Paired?** identity, `expiresAt`, and a live `GET /agent/kelabos`.
2. **Wired?** this runtime's keys are present in the config, the script they name
   exists, and — on opencode — the **plugin spec resolves to something on disk**.
   That last one is checked rather than printed because an unresolvable spec has
   no symptom of its own: opencode loads no plugin, logs nothing, `/kstart` does
   nothing, and `kelabo_join` then blames the developer for not running it (§3).
   `describePluginSpec` is pure and tested; only the file check touches `fs`.
3. **Can transcript actually be delivered?** The invisible failure on both
   runtimes, because every tool travels the tunnel and keeps working — the agent
   joins, posts and reads the board perfectly and simply never hears a word.
   - opencode: `GET /global/health` on `OPENCODE_BASE_URL` or `:4096`. `--port`
     defaults to `0`, meaning no server at all.
   - Claude Code: the provider check — six environment variables that turn
     channels off entirely — and then an honest `----` for the launch flag,
     which cannot be probed from outside a running session. It prints the exact
     command rather than implying the flag is fine. The bridge itself reads its
     own parent's command line at startup and reports through `kelabo_join`
     (docs 16 §4.2), which is the only vantage point that can see it.
4. **Which bridges are up?** Plural: one per opencode instance, each publishing
   `~/.kelabo/bridge-<its opencode pid>.json` with a port, a pid and a working
   directory. That makes "did `/kstart` land, and on which bridge?" answerable
   from outside the TUI, and it names a stale lock left by a crashed bridge
   instead of quietly trusting it.

---

## 9. Uninstall, and what it honestly cannot do

`kelabo uninstall` removes the keys it wrote and every `~/.kelabo/bridge-*.json`.
`--purge` additionally deletes `~/.kelabo/agent.json`.

It **cannot revoke the agent token**. `DELETE /agent/tokens/:jti` requires a
browser session, not an agent token, so a process holding only the token cannot
revoke itself. `--purge` therefore deletes the local credential and prints the
Settings URL, and the token remains valid until the developer revokes it there or
its TTL expires. Adding a self-revoke endpoint is a rest-api change and a deploy;
it is deliberately out of scope here rather than faked.

---

## 10. Release

There is no CI in this repository, so releasing is a documented manual sequence
rather than a pipeline:

```
cd connector && npm version <patch|minor|major>
npm run pack                       # build/pack.mjs -> dist/agent/
npm test                           # includes install.mjs, channel.mjs and pack.mjs
npm publish ./dist/agent --access public   # "./" matters: a bare dist/agent is read as a GitHub repo
```

Or `make agent-pack && make agent-publish`, which does both: `agent-pack` builds
`dist/agent/` and runs the connector tests, `agent-publish` publishes it. And
`make agent-release level=patch|minor|major` is the whole sequence in one verb —
bump, pack, test, publish, commit, tag — reverting the version bump if the
publish fails.

---

## 11. Migration

Migrating an existing hand-copied install (the old `connector/README.md`
instructions) means deleting `~/.config/opencode/plugins/kelabo-bridge.js` and
`commands/{kstart,kend}.md` after running `setup`. They are still loaded from
those directories, so leaving them in place double-registers the plugin.
`kelabo setup` does not delete them: it does not create files anywhere, and a
tool that starts removing files it did not write is the thing this design exists
to avoid.

---

## 12. Known costs

- ~~The package exists twice on disk~~ — no longer true either, and for the same
  reason: the `file:` spec means the plugin opencode loads and the `cli.js` it
  spawns as an MCP server are the same files.
- ~~First `opencode` start after `setup` needs network~~ — no longer true. The
  plugin is a `file:` spec pointing at the installed package, which opencode
  loads directly from disk with no fetch and no cache entry (§3).
- **`exports["."]` is the plugin, not a library API.** Anyone wanting to embed
  the bridge programmatically imports the bin or the repo, not the package root.
