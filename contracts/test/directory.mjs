// The organisation directory's file reader (docs 18 §4.7).
//
// Each fixture is the column layout of an export an administrator can actually
// produce, with invented people at example.com. The Name,Email shape (with a
// byte-order mark, CRLF, case-variant duplicates, a stray space and a
// contractor at another domain) is copied from a real company export; the
// others follow the vendors' published column names and are marked where they
// have not been checked against a live file.
import assert from "node:assert/strict";
import {
  cleanEmail,
  detectDelimiter,
  directoryIndexSk,
  directoryPk,
  directorySk,
  directoryTenant,
  headerKey,
  isPublicEmailDomain,
  MAX_DIRECTORY_ENTRIES,
  parseCsv,
  parseDirectoryFile,
  splitAddress,
} from "../src/directory.js";

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
  } catch (err) {
    console.error(`FAIL ${name}`);
    throw err;
  }
}

const BOM = "\uFEFF";
const crlf = (lines) => lines.join("\r\n") + "\r\n";

// --- CSV ---------------------------------------------------------------------

await test("quoted fields keep delimiters, newlines and doubled quotes", () => {
  const rows = parseCsv('a,b\r\n"Lee, Ann","say ""hi""\nthere"\r\n\r\nx,y');
  assert.deepEqual(rows.map((r) => r.cells), [["a", "b"], ["Lee, Ann", 'say "hi"\nthere'], ["x", "y"]]);
  // Line numbers are the editor's, counting the newline inside the quote.
  assert.deepEqual(rows.map((r) => r.line), [1, 2, 5]);
});

await test("the delimiter is read from the header line", () => {
  assert.equal(detectDelimiter("Name;Email\nA;a@x.com"), ";");
  assert.equal(detectDelimiter("Name\tEmail"), "\t");
  assert.equal(detectDelimiter('"Last, First",Email'), ",");
  assert.equal(detectDelimiter("just-one-column"), ",");
});

await test("headers compare without case, punctuation or [Required]", () => {
  assert.equal(headerKey("E-mail Address"), "emailaddress");
  assert.equal(headerKey("Email Address [Required]"), "emailaddress");
  assert.equal(headerKey("userPrincipalName"), "userprincipalname");
  assert.equal(headerKey("E-mail 1 - Value"), "email1value");
});

// --- exports -----------------------------------------------------------------

await test("Name,Email saved from Excel: BOM, CRLF, duplicates, stray space, other domains", () => {
  const text =
    BOM +
    crlf([
      "Name,Email",
      "Ann Lee,alee@example.com",
      "Bob Stone,bstone@example.com ",
      "ANN LEE,ALee@Example.com",
      "Cara Diaz,cdiaz@example.co.nz",
      "Dev Contractor,dev@partner.example.net",
      "Typo Domain,typo@example.com.ay",
    ]);
  const r = parseDirectoryFile(text);
  assert.equal(r.format, "csv");
  assert.deepEqual(r.columns, { email: ["Email"], name: ["Name"] });
  assert.deepEqual(r.entries.map((e) => e.email), [
    "alee@example.com",
    "bstone@example.com",
    "cdiaz@example.co.nz",
    "dev@partner.example.net",
    "typo@example.com.ay",
  ]);
  assert.equal(r.entries[0].name, "Ann Lee", "the first spelling wins");
  assert.equal(r.duplicates, 1);
  assert.deepEqual(r.skipped, []);
  // Per-domain counts are what make a typo like `.com.ay` visible in a preview.
  assert.deepEqual(r.domains, {
    "example.com": 2,
    "example.co.nz": 1,
    "partner.example.net": 1,
    "example.com.ay": 1,
  });
});

await test("Entra 'Download users': mail preferred, userPrincipalName when mail is blank", () => {
  // Column names per Microsoft's documented bulk download; not checked live.
  const text = crlf([
    "userPrincipalName,displayName,surname,mail,givenName,objectId,userType",
    "ann@example.com,Ann Lee,Lee,ann.lee@example.com,Ann,1,Member",
    "svc@example.onmicrosoft.com,Scanner,,,,2,Member",
    "bob@example.com,,Stone,,Bob,3,Member",
  ]);
  const r = parseDirectoryFile(text);
  assert.deepEqual(r.columns.email, ["mail", "userPrincipalName"]);
  assert.deepEqual(r.entries, [
    { email: "ann.lee@example.com", name: "Ann Lee" },
    { email: "svc@example.onmicrosoft.com", name: "Scanner" },
    // No displayName: given + family name.
    { email: "bob@example.com", name: "Bob Stone" },
  ]);
});

await test("Microsoft 365 'Export users'", () => {
  // Not checked live.
  const text = crlf([
    "Block credential,City,Country/Region,Department,Display name,First name,Last name,User principal name",
    "False,Perth,Australia,Ops,Ann Lee,Ann,Lee,ann@example.com",
  ]);
  assert.deepEqual(parseDirectoryFile(text).entries, [{ email: "ann@example.com", name: "Ann Lee" }]);
});

await test("Outlook contacts export: first/middle/last, E-mail Address", () => {
  const text = crlf([
    '"First Name","Middle Name","Last Name","Title","E-mail Address","E-mail 2 Address"',
    '"Ann","May","Lee","","ann@example.com",""',
    '"Bob","","Stone","","","bob@home.example"',
  ]);
  const r = parseDirectoryFile(text);
  assert.deepEqual(r.entries, [{ email: "ann@example.com", name: "Ann May Lee" }]);
  // No primary address: skipped with its line, not guessed from the second.
  assert.deepEqual(r.skipped.map((s) => [s.line, s.reason]), [[3, "missing_email"]]);
});

await test("Google Workspace user download: [Required] headers", () => {
  const text = crlf(["First Name [Required],Last Name [Required],Email Address [Required],Org Unit Path [Required]", "Ann,Lee,ann@example.com,/"]);
  assert.deepEqual(parseDirectoryFile(text).entries, [{ email: "ann@example.com", name: "Ann Lee" }]);
});

await test("Google Contacts export: Name and E-mail 1 - Value", () => {
  const text = crlf(["Name,Given Name,E-mail 1 - Type,E-mail 1 - Value", "Ann Lee,Ann,* Work,ann@example.com"]);
  assert.deepEqual(parseDirectoryFile(text).entries, [{ email: "ann@example.com", name: "Ann Lee" }]);
});

await test("semicolon-separated CSV from a comma-decimal locale", () => {
  const text = "Name;Email\nAnn Lee;ann@example.com\n";
  assert.deepEqual(parseDirectoryFile(text).entries, [{ email: "ann@example.com", name: "Ann Lee" }]);
});

await test("headerless: name,email rows and one address per line", () => {
  assert.deepEqual(parseDirectoryFile("Ann Lee,ann@example.com\nbob@example.com,Bob Stone\n").entries, [
    { email: "ann@example.com", name: "Ann Lee" },
    { email: "bob@example.com", name: "Bob Stone" },
  ]);
  assert.deepEqual(parseDirectoryFile("ann@example.com\nbob@example.com").entries, [
    { email: "ann@example.com", name: "" },
    { email: "bob@example.com", name: "" },
  ]);
});

await test("a pasted recipient list: Name <address>; …, including Last, First", () => {
  const text = 'Ann Lee <ann@example.com>; "Stone, Bob" <BOB@example.com>; cara@example.com\nLee, Dee <dee@example.com>, Eve <eve@example.com>';
  const r = parseDirectoryFile(text);
  assert.equal(r.format, "addresses");
  assert.deepEqual(r.entries, [
    { email: "ann@example.com", name: "Ann Lee" },
    { email: "bob@example.com", name: "Stone, Bob" },
    { email: "cara@example.com", name: "" },
    { email: "dee@example.com", name: "Lee, Dee" },
    { email: "eve@example.com", name: "Eve" },
  ]);
});

await test("bad rows are skipped with their line, the rest still import", () => {
  const r = parseDirectoryFile(crlf(["Name,Email", "Ann,ann@example.com", "Nobody,", "Broken,not-an-address", "Bob,bob@example.com"]));
  assert.deepEqual(r.entries.map((e) => e.email), ["ann@example.com", "bob@example.com"]);
  assert.deepEqual(r.skipped.map((s) => [s.line, s.reason]), [
    [3, "missing_email"],
    [4, "invalid_email"],
  ]);
});

await test("a later row supplies a name the first one lacked", () => {
  const r = parseDirectoryFile("Name,Email\n,ann@example.com\nAnn Lee,ann@example.com\n");
  assert.deepEqual(r.entries, [{ email: "ann@example.com", name: "Ann Lee" }]);
});

await test("a file with no address column is the wrong file, and says so", () => {
  assert.throws(() => parseDirectoryFile("Name,Phone\nAnn,123\n"), (e) => e.code === "no_email_column" && /Name, Phone/.test(e.message));
});

await test("the entry ceiling is enforced and reported", () => {
  const lines = ["Email"];
  for (let i = 0; i <= MAX_DIRECTORY_ENTRIES; i++) lines.push(`p${i}@example.com`);
  const r = parseDirectoryFile(lines.join("\n"));
  assert.equal(r.entries.length, MAX_DIRECTORY_ENTRIES);
  assert.deepEqual(r.skipped.map((s) => s.reason), ["too_many"]);
});

// --- addresses and tenants ---------------------------------------------------

await test("addresses are cleaned of the wrappers clipboards add", () => {
  assert.equal(cleanEmail(" mailto:Ann@Example.COM "), "ann@example.com");
  assert.equal(cleanEmail("<ann@example.com>"), "ann@example.com");
  assert.deepEqual(splitAddress("  Ann Lee  <ann@example.com> "), { name: "Ann Lee", email: "ann@example.com" });
});

await test("a directory cannot belong to a public mailbox domain", () => {
  assert.equal(isPublicEmailDomain("gmail.com"), true);
  assert.equal(isPublicEmailDomain("contoso.onmicrosoft.com"), true);
  assert.equal(directoryTenant(" Example.COM. "), "example.com");
  assert.equal(directoryTenant("gmail.com"), "");
  assert.equal(directoryTenant("not a domain"), "");
  assert.equal(directoryTenant("localhost"), "");
});

await test("keys", () => {
  assert.equal(directoryPk("Example.com"), "DIR#example.com");
  assert.equal(directorySk("Ann@Example.com"), "EMAIL#ann@example.com");
  assert.equal(directoryIndexSk("example.com"), "TENANT#example.com");
});

console.log(`directory: ${passed} passed`);
