// The MCP resolver's credential half: which token a server reaches a kelabo
// with, and from where.
//
// Its own file rather than a section of agent.mjs because what is under test is
// a *second read* against a second sort key in the same partition, and it is
// invisible in a live kelabo — a bearer server that silently fails to
// authenticate looks exactly like an agent that chose not to use it.
//
// Offline: a stub table, no network, and `tools/list` stubbed out with a fetch
// that answers every server the same way.
import assert from "node:assert/strict";
import { loadEffectiveMcp } from "../src/agent/mcp.js";

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`ok - ${name}`);
  } catch (err) {
    console.error(`FAIL - ${name}`);
    console.error(err);
    process.exitCode = 1;
  }
}

const HOST = "ada@acme.example";
const HOST_PK = `MCP#host#${HOST}`;

/**
 * A stub of the mcp table, keyed exactly as the real one is. A key-value store
 * rather than a call recorder: the whole question here is which row a
 * credential was read from, and a recorder would answer it by construction.
 */
function stubTable(items = []) {
  const store = new Map();
  for (const i of items) store.set(`${i.PK}|${i.SK}`, i);
  const logs = [];
  return {
    store,
    logs,
    c: {
      config: { tableNames: { mcp: "t-mcp" } },
      db: {
        async send(cmd) {
          const i = cmd.input;
          if (i.KeyConditionExpression) {
            const pk = i.ExpressionAttributeValues[":pk"];
            const sk = i.ExpressionAttributeValues[":sk"] ?? "";
            return {
              Items: [...store.values()].filter((v) => v.PK === pk && String(v.SK).startsWith(sk)),
            };
          }
          if (i.Item) {
            store.set(`${i.Item.PK}|${i.Item.SK}`, i.Item);
            return {};
          }
          return { Item: store.get(`${i.Key.PK}|${i.Key.SK}`) ?? null };
        },
      },
      getSecret: async () => null,
      log: (event, fields) => logs.push({ event, ...fields }),
      logError: (event, err, fields) => logs.push({ event, error: err?.message, ...fields }),
    },
  };
}

const server = (PK, name, extra = {}) => ({
  PK,
  SK: `SERVER#${name}`,
  name,
  transport: "http",
  url: `https://${name}.example/mcp`,
  enabled: true,
  ...extra,
});
const secret = (PK, name, token) => ({ PK, SK: `SECRET#${name}`, token });

// Every server answers `tools/list` the same way; the catalogue is agent.mjs's
// subject, not this file's.
const realFetch = globalThis.fetch;
globalThis.fetch = async () => ({
  ok: true,
  status: 200,
  headers: { get: () => null },
  text: async () => JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools: [] } }),
});

await test("a bearer server gets the host's token, from the SECRET# row beside it", async () => {
  // The pasted-bearer path, which had no test at all while the token lived in
  // Secrets Manager. Keep the assertion on the header itself rather than on
  // the server's presence: presence alone passes while the token is missing
  // entirely, which is exactly how a lost `getMcpSecret` import would read.
  const { c } = stubTable([
    server(HOST_PK, "notes", { hasSecret: true, authType: "bearer" }),
    secret(HOST_PK, "notes", "my-token"),
  ]);
  const { servers } = await loadEffectiveMcp(c, { hostIdentity: HOST });
  assert.equal(servers.length, 1);
  assert.equal(servers[0].headers.Authorization, "Bearer my-token");
});

await test("a bearer server whose SECRET# row is missing still reaches the kelabo, unauthenticated", async () => {
  // Deliberately not the OAuth rule. An OAuth server with no token can only
  // ever 401, so it is dropped; a bearer server with no row may simply be one
  // whose `hasSecret` flag outlived the row, and the server itself is the only
  // thing that can say whether it needed a header. Dropping it here would make
  // "the token was deleted" indistinguishable from "the server is gone".
  const { c } = stubTable([server(HOST_PK, "notes", { hasSecret: true, authType: "bearer" })]);
  const { servers } = await loadEffectiveMcp(c, { hostIdentity: HOST });
  assert.equal(servers.length, 1);
  assert.equal(servers[0].headers.Authorization, undefined);
});

await test("a legacy secretRef row is still read as bearer, from the SECRET# row", async () => {
  // Rows written before the migration carry `secretRef` and no `hasSecret`.
  // The pointer is dead — there is no Secrets Manager entry behind it any more
  // — but it must still classify the server as bearer, or a host who has not
  // re-saved their settings loses the server with no message.
  const { c } = stubTable([
    server(HOST_PK, "notes", { secretRef: "notes-abc123" }),
    secret(HOST_PK, "notes", "my-token"),
  ]);
  const { servers } = await loadEffectiveMcp(c, { hostIdentity: HOST });
  assert.equal(servers.length, 1);
  assert.equal(servers[0].headers.Authorization, "Bearer my-token");
});

await test("a server with no auth at all is untouched", async () => {
  const { c } = stubTable([server(HOST_PK, "notes")]);
  const { servers } = await loadEffectiveMcp(c, { hostIdentity: HOST });
  assert.equal(servers.length, 1);
  assert.deepEqual(servers[0].headers, {});
});

await test("an unreadable credential row leaves the server unauthenticated, never with a stale header", async () => {
  // Pinned because it is the one thing that must not happen: a failed read
  // resolving to *something*. `getMcpSecret` swallows its own read errors and
  // answers `null`, so the resolver's `continue` is unreachable from here and
  // the server arrives bare — which the server itself will reject, loudly, at
  // the first call. Silently attaching a previous kelabo's token instead would
  // be the failure nobody could see.
  const t = stubTable([
    server(HOST_PK, "notes", { hasSecret: true, authType: "bearer" }),
    secret(HOST_PK, "notes", "my-token"),
  ]);
  const real = t.c.db.send;
  t.c.db.send = async (cmd) => {
    if (String(cmd.input.Key?.SK ?? "").startsWith("SECRET#")) throw new Error("dynamo blinked");
    return real(cmd);
  };
  const { servers } = await loadEffectiveMcp(t.c, { hostIdentity: HOST });
  assert.equal(servers.length, 1);
  assert.equal(servers[0].headers.Authorization, undefined);
});

globalThis.fetch = realFetch;
console.log(`\ngateway/mcp: ${passed} passed${process.exitCode ? " (with failures)" : ""}`);
