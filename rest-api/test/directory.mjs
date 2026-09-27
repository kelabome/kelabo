// The organisation directory (docs 18 §4.7) and name search over it (§4.8).
//
// Through createApp, so the routes in index.js are proven wired, with the real
// admin roster (root from config) deciding who may import. Properties that
// carry the design, each with a test that fails loudly if it stops holding:
//
//   1. Only an administrator can read or change a directory.
//   2. A preview writes nothing; an import replaces — people missing from the
//      file are removed — and refuses to remove most of a directory unless
//      told to.
//   3. A directory is visible to its tenant and nobody else, and never to a
//      public mailbox domain.
//   4. Search finds directory people by name, merged with registered users,
//      and a registered user's generated name gives way to the directory's.
import assert from "node:assert/strict";
import { createApp } from "../src/index.js";
import { createDb } from "./stubDb.js";
import { createSessions } from "../src/sessions.js";
import { createAdmin } from "../src/admin.js";
import { createDirectoryAdmin } from "../src/directory.js";
import { createPeople } from "../src/people.js";
import { createScheduling } from "../src/scheduling.js";
import { createContacts } from "../src/contacts.js";

const config = {
  env: "test",
  region: "us-east-1",
  rootAdminEmail: "root@example.com",
  allowedEmailDomain: "",
  cookieDomain: ".test.example.com",
  portalUrl: "https://test.example.com",
  tableNames: { kelabos: "m", users: "u", otp: "o", refresh: "r", history: "h", mcp: "mc", contacts: "co", journeys: "j" },
  contacts: { external: false },
  secrets: { cookieSigningKey: "cookie" },
  auth: { sessionTtlSeconds: 3600, refreshTtlDays: 60, participantTtlSeconds: 43200, agentTokenTtlDays: 90, socialProviders: [] },
  retentionDays: 30,
};

const secrets = { getCookieKey: async () => "test-signing-key" };
const db = createDb();
db.listAdmins = async () => [];
const logs = [];
const log = (level, msg, data) => logs.push({ level, msg, ...data });
const sessions = createSessions({ config, db, secrets });
const admin = createAdmin({ config, db, log });
const people = createPeople({ db });
const directory = createDirectoryAdmin({ config, db, admin, people, log });
const scheduling = createScheduling({ config, db, people });
const contacts = createContacts({ config, db, people });
const app = createApp({ config, db, secrets, sessions, admin, directory, scheduling, contacts, version: "test" });

function cookieValue(cookies, name) {
  const c = (cookies || []).find((s) => s.startsWith(`${name}=`));
  return c ? decodeURIComponent(c.split(";")[0].slice(name.length + 1)) : null;
}
async function sessionFor(email) {
  const session = await sessions.establishSession(email);
  return { kelabo_session: cookieValue(session.cookies, "kelabo_session") };
}
async function call(method, path, { body, cookies = {} } = {}) {
  const [rawPath, qs] = path.split("?");
  const res = await app({
    requestContext: { http: { method, sourceIp: "1.2.3.4" } },
    rawPath,
    rawQueryString: qs || "",
    headers: {
      "content-type": "application/json",
      ...(Object.keys(cookies).length
        ? { cookie: Object.entries(cookies).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("; ") }
        : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { ...res, json: res.body && res.headers["Content-Type"]?.includes("json") ? JSON.parse(res.body) : null };
}

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`ok - ${name}`);
  } catch (e) {
    console.error(`FAIL - ${name}`);
    console.error(e);
    process.exitCode = 1;
  }
}

const root = await sessionFor("root@example.com");
const ann = await sessionFor("ann@example.com");
const outsider = await sessionFor("olga@other.example.org");

// The shape of a real company export: BOM, CRLF, a case-variant duplicate, a
// stray space, a second regional domain and a contractor elsewhere.
const FILE =
  "\uFEFFName,Email\r\n" +
  "Daniel Okafor,dokafor@example.com\r\n" +
  "Marianne De Vries,mdevries@example.com \r\n" +
  "DANIEL OKAFOR,DOkafor@Example.com\r\n" +
  "Kiri Ngata,kngata@example.co.nz\r\n" +
  "Pat Partner,pat@partner.example.net\r\n" +
  "Ann Lee,ann@example.com\r\n" +
  "Broken,not-an-address\r\n";

await test("only an administrator can see or change a directory", async () => {
  for (const [m, p, body] of [
    ["GET", "/admin/directory"],
    ["POST", "/admin/directory/preview", { tenantId: "example.com", csv: FILE }],
    ["POST", "/admin/directory/import", { tenantId: "example.com", csv: FILE }],
    ["GET", "/admin/directory/example.com"],
    ["DELETE", "/admin/directory/example.com"],
  ]) {
    const res = await call(m, p, { body, cookies: ann });
    assert.equal(res.statusCode, 403, `${m} ${p} as a non-admin`);
    assert.equal((await call(m, p, { body })).statusCode, 401, `${m} ${p} signed out`);
  }
});

await test("a preview reports what an import would do, and writes nothing", async () => {
  const res = await call("POST", "/admin/directory/preview", { body: { tenantId: "Example.COM", csv: FILE }, cookies: root });
  assert.equal(res.statusCode, 200);
  const p = res.json;
  assert.equal(p.tenantId, "example.com");
  assert.deepEqual(p.columns, { email: ["Email"], name: ["Name"] });
  assert.deepEqual(p.counts, { entries: 5, existing: 0, added: 5, updated: 0, unchanged: 0, removed: 0, skipped: 1, duplicates: 1 });
  assert.deepEqual(p.skipped.map((s) => [s.line, s.reason]), [[8, "invalid_email"]]);
  assert.deepEqual(p.domains, [
    { domain: "example.com", count: 3, sameAsTenant: true },
    { domain: "example.co.nz", count: 1, sameAsTenant: false },
    { domain: "partner.example.net", count: 1, sameAsTenant: false },
  ]);
  assert.equal(p.needsForce, false);
  assert.equal(p._writes, undefined, "internal plan never leaves the server");
  assert.deepEqual(await db.listDirectory("example.com"), []);
});

await test("a public mailbox domain, or not a domain at all, cannot own a directory", async () => {
  const pub = await call("POST", "/admin/directory/preview", { body: { tenantId: "gmail.com", csv: FILE }, cookies: root });
  assert.equal(pub.statusCode, 400);
  assert.equal(pub.json.error, "public_domain");
  const bad = await call("POST", "/admin/directory/preview", { body: { tenantId: "nope", csv: FILE }, cookies: root });
  assert.equal(bad.json.error, "bad_tenant");
});

await test("the wrong file is refused with its headers named", async () => {
  const res = await call("POST", "/admin/directory/preview", { body: { tenantId: "example.com", csv: "Name,Phone\nAnn,1\n" }, cookies: root });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json.error, "no_email_column");
  const empty = await call("POST", "/admin/directory/preview", { body: { tenantId: "example.com", csv: "  " }, cookies: root });
  assert.equal(empty.json.error, "empty_file");
});

await test("an import stores the entries and registers the tenant", async () => {
  const res = await call("POST", "/admin/directory/import", {
    body: { tenantId: "example.com", csv: FILE, fileName: "users.csv" },
    cookies: root,
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json.applied, true);
  const rows = await db.listDirectory("example.com");
  assert.deepEqual(rows.map((r) => [r.email, r.name]), [
    ["ann@example.com", "Ann Lee"],
    ["dokafor@example.com", "Daniel Okafor"],
    ["kngata@example.co.nz", "Kiri Ngata"],
    ["mdevries@example.com", "Marianne De Vries"],
    ["pat@partner.example.net", "Pat Partner"],
  ]);
  const list = await call("GET", "/admin/directory", { cookies: root });
  assert.equal(list.json.defaultTenant, "example.com");
  assert.equal(list.json.directories.length, 1);
  assert.deepEqual(
    (({ tenantId, count, importedBy, fileName }) => ({ tenantId, count, importedBy, fileName }))(list.json.directories[0]),
    { tenantId: "example.com", count: 5, importedBy: "root@example.com", fileName: "users.csv" }
  );
  assert.ok(logs.some((l) => l.msg === "directory_imported" && l.by === "root@example.com"));

  const entries = await call("GET", "/admin/directory/example.com", { cookies: root });
  assert.equal(entries.json.entries.length, 5);
});

await test("search finds directory people by name, before they have ever signed in", async () => {
  const res = await call("GET", "/people/search?q=dan", { cookies: ann });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json.suggestions, [
    { email: "dokafor@example.com", displayName: "Daniel Okafor", favourited: false, registered: false, source: "directory", avatarVariant: 0 },
  ]);
  // Misspelt, half-typed, inside the address, and the contractor elsewhere.
  for (const [q, want] of [["okafr", "dokafor@example.com"], ["mari de", "mdevries@example.com"], ["devries", "mdevries@example.com"], ["pat", "pat@partner.example.net"], ["kiri", "kngata@example.co.nz"]]) {
    const r = await call("GET", `/people/search?q=${encodeURIComponent(q)}`, { cookies: ann });
    assert.equal(r.json.suggestions[0]?.email, want, q);
  }
});

await test("a favourited colleague who has not signed in is named from the directory", async () => {
  const fav = await call("POST", "/contacts/favourites", { body: { email: "mdevries@example.com" }, cookies: ann });
  assert.equal(fav.statusCode, 200);
  const list = await call("GET", "/contacts", { cookies: ann });
  assert.deepEqual(list.json.favourites.map((f) => [f.email, f.displayName]), [["mdevries@example.com", "Marianne De Vries"]]);
  const search = await call("GET", "/people/search?q=marianne", { cookies: ann });
  assert.equal(search.json.suggestions[0].favourited, true);
  await call("DELETE", "/contacts/favourites/mdevries%40example.com", { cookies: ann });
});

await test("the searcher is never suggested to themselves", async () => {
  const res = await call("GET", "/people/search?q=ann", { cookies: ann });
  assert.ok(!res.json.suggestions.some((s) => s.email === "ann@example.com"));
});

await test("once somebody signs in they are a user, and keep the directory's name over a generated one", async () => {
  // Sign-in with no name to go on writes the local part (sessions.js).
  await sessions.establishSession("dokafor@example.com");
  people.invalidate();
  const res = await call("GET", "/people/search?q=daniel", { cookies: ann });
  assert.deepEqual(
    res.json.suggestions.map((s) => [s.email, s.displayName, s.registered, s.source]),
    [["dokafor@example.com", "Daniel Okafor", true, "user"]]
  );
  // A name the person chose themselves wins over the directory's.
  // (upsertUser only ever sets a name once, so start the row again.)
  await db.deleteUser("dokafor@example.com");
  await db.upsertUser({ email: "dokafor@example.com", displayName: "Dan T", tenantId: "example.com" });
  people.invalidate();
  const own = await call("GET", "/people/search?q=dan", { cookies: ann });
  assert.equal(own.json.suggestions[0].displayName, "Dan T");
});

await test("another tenant never sees the directory", async () => {
  const res = await call("GET", "/people/search?q=daniel", { cookies: outsider });
  assert.deepEqual(res.json.suggestions, []);
});

await test("re-importing replaces: missing people are removed, renamed ones updated", async () => {
  const next = "Name,Email\nDaniel Okafor,dokafor@example.com\nMarianne De Vries-Smith,mdevries@example.com\nAnn Lee,ann@example.com\nNew Person,newp@example.com\n";
  const pre = await call("POST", "/admin/directory/preview", { body: { tenantId: "example.com", csv: next }, cookies: root });
  assert.deepEqual(pre.json.counts, { entries: 4, existing: 5, added: 1, updated: 1, unchanged: 2, removed: 2, skipped: 0, duplicates: 0 });
  assert.deepEqual(pre.json.sample.removed, ["kngata@example.co.nz", "pat@partner.example.net"]);
  assert.deepEqual(pre.json.sample.updated, [{ email: "mdevries@example.com", name: "Marianne De Vries-Smith", was: "Marianne De Vries" }]);

  const res = await call("POST", "/admin/directory/import", { body: { tenantId: "example.com", csv: next }, cookies: root });
  assert.equal(res.statusCode, 200);
  const rows = await db.listDirectory("example.com");
  assert.deepEqual(rows.map((r) => r.email), ["ann@example.com", "dokafor@example.com", "mdevries@example.com", "newp@example.com"]);
  // The importing container sees it at once, with no wait for the cache.
  const gone = await call("GET", "/people/search?q=kiri", { cookies: ann });
  assert.deepEqual(gone.json.suggestions, []);
});

await test("an import that would remove most of a directory needs force", async () => {
  const tiny = "Name,Email\nAnn Lee,ann@example.com\n";
  const pre = await call("POST", "/admin/directory/preview", { body: { tenantId: "example.com", csv: tiny }, cookies: root });
  assert.equal(pre.json.needsForce, true);
  const refused = await call("POST", "/admin/directory/import", { body: { tenantId: "example.com", csv: tiny }, cookies: root });
  assert.equal(refused.statusCode, 409);
  assert.equal(refused.json.error, "directory_shrink");
  assert.equal((await db.listDirectory("example.com")).length, 4, "nothing was written");
  const forced = await call("POST", "/admin/directory/import", { body: { tenantId: "example.com", csv: tiny, force: true }, cookies: root });
  assert.equal(forced.statusCode, 200);
  assert.equal((await db.listDirectory("example.com")).length, 1);
});

await test("a file with no usable address cannot empty a directory", async () => {
  const res = await call("POST", "/admin/directory/import", { body: { tenantId: "example.com", csv: "Email\nnope\n", force: true }, cookies: root });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json.error, "no_entries");
});

await test("a tenant nobody can sign in at is imported with a warning", async () => {
  const locked = createDirectoryAdmin({ config: { ...config, allowedEmailDomain: "example.com" }, db, admin, people, log });
  const p = await locked.preview({ identity: "root@example.com", body: { tenantId: "example.co.nz", csv: FILE } });
  assert.deepEqual(p.warnings, ["tenant_cannot_sign_in"]);
});

await test("removing a directory deletes its rows and its register entry", async () => {
  const res = await call("DELETE", "/admin/directory/example.com", { cookies: root });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json.removed, 1);
  assert.deepEqual(await db.listDirectory("example.com"), []);
  assert.deepEqual((await call("GET", "/admin/directory", { cookies: root })).json.directories, []);
});

await test("a granted administrator can import too", async () => {
  db.listAdmins = async () => [{ SK: "ops@example.com" }];
  const ops = await sessionFor("ops@example.com");
  const res = await call("POST", "/admin/directory/import", { body: { tenantId: "example.com", csv: FILE }, cookies: ops });
  assert.equal(res.statusCode, 200);
});

await test("the candidate cache expires on its own", async () => {
  let t = 0;
  const cached = createPeople({ db, now: () => t, ttlMs: 1000 });
  const before = (await cached.candidates("example.com")).people.length;
  await db.putDirectoryEntries("example.com", [{ email: "late@example.com", name: "Late Arrival" }]);
  assert.equal((await cached.candidates("example.com")).people.length, before, "still cached");
  t = 1001;
  assert.equal((await cached.candidates("example.com")).people.length, before + 1, "refreshed after the TTL");
});

await test("a directory read failure degrades search to registered users", async () => {
  const broken = { ...db, listDirectory: async () => { throw new Error("dynamo is down"); } };
  const p = createPeople({ db: broken });
  const r = await p.search({ tenantId: "example.com", query: "dan" });
  assert.deepEqual(r.map((x) => x.source), ["user"]);
});

console.log(`rest-api/directory: ${passed} passed`);
