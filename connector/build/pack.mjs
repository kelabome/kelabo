// Build the publishable package out of connector/ (docs 17 §4).
//
// connector/package.json is `private` and stays that way: it carries
// `"@kelabo/contracts": "file:../contracts"`, which npm cannot resolve for
// anybody outside this repository. What is published is generated here — one
// complete, self-contained directory with contracts and zod inlined by esbuild
// and a manifest that mentions neither.
//
// **One package, one `kelabo` command, every runtime.** Which coding agent the
// bridge talks to is decided when it runs, from `KELABO_RUNTIME` (see
// `src/adapters/index.js`), so adding a runtime does not add a package, a
// binary, a build target or a publish step.
//
// It was briefly built the other way — one package per runtime, the adapter
// resolved at build time. That produced `kelabo-opencode` and `kelabo-claude`
// binaries which **could not be installed side by side at all**: both declared
// the same `bin`, and npm fails the second global install with EEXIST. Renaming
// them apart fixed the install and left a worse problem, two commands that each
// silently ignore half the machine. Shipping ~2 KB of an adapter the developer
// is not currently using is the cheaper trade by a wide margin.
//
//   node build/pack.mjs [--version x.y.z]
//
// Output: connector/dist/agent/, ready for `npm publish`.
import { build } from "esbuild";
import { readFile, writeFile, mkdir, rm, cp, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const CONNECTOR = join(HERE, "..");
const DIST = join(CONNECTOR, "dist");

// Left external, and therefore real dependencies of the published package.
// Everything else — contracts, zod — is inlined. `ws` has an optional native
// accelerator and the MCP SDK is the protocol implementation itself; bundling
// either buys nothing and breaks the first time they use a dynamic import.
const EXTERNAL = ["ws", "@modelcontextprotocol/sdk"];

const PKG = {
  dir: "agent",
  name: "@kelabome/agents",
  bin: "kelabo",
  description:
    "Bring your own coding agent (Claude Code or opencode) into a Kelabo meeting: an MCP server that streams the live transcript into the session you already have open, posts answers to the meeting's board, and leaves the whole discussion in context when the meeting ends.",
  keywords: [
    "kelabo",
    "mcp",
    "mcp-server",
    "model-context-protocol",
    "opencode",
    "opencode-plugin",
    "claude",
    "claude-code",
    "coding-agent",
    "ai-agent",
    "meeting",
    "meeting-assistant",
    "ai-meeting-assistant",
    "meeting-minutes",
    "transcript",
    "live-transcription",
    "channel",
  ],
  // The opencode plugin. `exports["./server"]` is what opencode imports for an
  // npm plugin — verified against 1.18.6; `main` is only the fallback. Claude
  // Code needs no equivalent: its channel targets the session that spawned the
  // MCP server, so there is nothing for a second process to hand over.
  plugin: "src/plugin/opencode.js",
};

async function bundle(entry, outfile, version) {
  await build({
    entryPoints: [join(CONNECTOR, entry)],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    external: EXTERNAL,
    legalComments: "none",
    // Turns version.js's fallback into dead code and drops the fs import with
    // it, so the published bundle never reads a file to learn its own version.
    define: { __KELABO_VERSION__: JSON.stringify(version) },
  });
}

function manifest(version, deps) {
  return {
    name: PKG.name,
    version,
    description: PKG.description,
    type: "module",
    license: "MIT",
    homepage: "https://github.com/kelabome/kelabo#readme",
    repository: { type: "git", url: "git+https://github.com/kelabome/kelabo.git" },
    keywords: PKG.keywords,
    // The package root is the opencode plugin, not a library API: opencode
    // imports `exports["./server"]`, and the CLI is reached through `bin`.
    main: "server.js",
    exports: { "./server": "./server.js", "./package.json": "./package.json" },
    // Exactly one binary, for every runtime. Two would collide in npm's global
    // bin directory and, worse, would each quietly cover half the machine.
    bin: { [PKG.bin]: "cli.js" },
    files: ["cli.js", "server.js", "commands/", "README.md"],
    // Deliberately no `engines.opencode`: opencode semver-checks that field
    // against itself and *throws* when it does not match, so guessing a floor
    // turns a working install into a hard failure on the next opencode release.
    engines: { node: ">=20" },
    dependencies: deps,
    publishConfig: { access: "public" },
  };
}

export async function pack({ version } = {}) {
  const dev = JSON.parse(await readFile(join(CONNECTOR, "package.json"), "utf8"));
  const resolved = version || dev.version;
  const out = join(DIST, PKG.dir);
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });

  await bundle("src/cli.js", join(out, "cli.js"), resolved);
  await bundle(PKG.plugin, join(out, "server.js"), resolved);

  // The .md files stay the authoring format: `kelabo setup` parses their front
  // matter into inline `command` entries for opencode, and the Rig copies them
  // as files. Claude Code takes neither, and ignores them.
  await cp(join(CONNECTOR, "commands"), join(out, "commands"), { recursive: true });

  const deps = Object.fromEntries(
    EXTERNAL.filter((d) => dev.dependencies?.[d]).map((d) => [d, dev.dependencies[d]])
  );
  await writeFile(join(out, "package.json"), JSON.stringify(manifest(resolved, deps), null, 2) + "\n");
  await cp(join(CONNECTOR, "README.npm.md"), join(out, "README.md"));
  // npm includes LICENSE* from the package root in every tarball, so the
  // published package carries the repo's license without naming it in `files`.
  await cp(join(CONNECTOR, "..", "LICENSE"), join(out, "LICENSE"));

  return { name: PKG.name, version: resolved, out };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const flag = (name) => {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 ? process.argv[i + 1] : undefined;
  };
  const r = await pack({ version: flag("version") });
  const files = (await readdir(r.out)).join(" ");
  process.stdout.write(`${r.name}@${r.version} -> ${r.out}\n  ${files}\n`);
}
