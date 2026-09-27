// The organisation directory: the people an organisation says it has, imported
// from a file an administrator already owns (docs 18 §4.7).
//
// Kelabo's own list of colleagues is the users table, and a row appears there
// only when somebody signs in. In a company that means the person you want to
// invite is invisible until they have used the product, which is exactly
// backwards. The directory closes that gap: an administrator uploads the
// company's own export, and everyone at that tenant can then find those people
// by name when inviting.
//
// This module is the pure half — reading the file and the keys the rows live
// under — so the rest-api, its stub and the tests agree on one definition.
//
// ## Which files
//
// Whatever an administrator can actually produce, without a script:
//
//   - Microsoft Entra admin centre → Users → Download users
//     (`displayName`, `userPrincipalName`, `mail`, `givenName`, `surname`, …)
//   - Microsoft 365 admin centre → Active users → Export users
//     (`Display name`, `First name`, `Last name`, `User principal name`, …)
//   - Outlook → People → Export contacts
//     (`First Name`, `Last Name`, `E-mail Address`, …)
//   - Google Workspace Admin → Users → Download users
//     (`First Name [Required]`, `Last Name [Required]`, `Email Address [Required]`)
//   - Google Contacts export (`Name`, `E-mail 1 - Value`, …)
//   - a hand-made `Name,Email` sheet saved as CSV, with or without a header
//   - a pasted recipient list: `Ann Lee <ann@example.com>; bob@example.com`
//
// None of these is special-cased by product. Columns are matched by header
// name against one alias table, so a new export format that calls its column
// "Email" or "Mail" works without a change here.
//
// ## Separators and encodings
//
// Excel writes a UTF-8 byte-order mark, CRLF line endings and — in locales
// whose decimal separator is a comma — semicolons instead of commas. All three
// are handled; the delimiter is chosen from the header line.

import { domainOf, normaliseDomain, PUBLIC_EMAIL_DOMAINS, PUBLIC_EMAIL_SUFFIXES } from "./orgDomains.js";

/** Hard ceiling on one directory. Keeps one import inside one request. */
export const MAX_DIRECTORY_ENTRIES = 20000;
/** The same ceilings an invitee address has (schemas.js). */
export const MAX_EMAIL_LENGTH = 160;
export const MAX_NAME_LENGTH = 120;
/** Ceiling on the uploaded text itself, well under API Gateway's 10 MB. */
export const MAX_DIRECTORY_BYTES = 4 * 1024 * 1024;

// --- keys --------------------------------------------------------------------
//
// Directory rows live in the contacts table, which already exists and which
// the Lambda can already read and write — so shipping this needs no new table
// and no `cdk deploy` ordering (AGENTS.md, "A new DynamoDB table…").

/** One tenant's entries: `PK = DIR#<tenant>`, `SK = EMAIL#<email>`. */
export const directoryPk = (tenantId) => `DIR#${normaliseDomain(tenantId)}`;
export const DIRECTORY_ENTRY_PREFIX = "EMAIL#";
export const directorySk = (email) => `${DIRECTORY_ENTRY_PREFIX}${String(email).toLowerCase()}`;

/**
 * The register of which tenants have a directory, one row each:
 * `PK = DIRECTORY`, `SK = TENANT#<tenant>`, carrying the last import's summary.
 * A fixed partition rather than a scan, so `/admin` can list directories with
 * one query however large the table grows.
 */
export const DIRECTORY_INDEX_PK = "DIRECTORY";
export const directoryIndexSk = (tenantId) => `TENANT#${normaliseDomain(tenantId)}`;

// --- tenants -------------------------------------------------------------------

/**
 * Whether a domain may own a directory. A directory is shown to everybody
 * signed in at its tenant, so one keyed on gmail.com would publish a company's
 * staff list to every stranger with a Gmail address. Same refusal, same list,
 * as an organisation (orgDomains.js).
 */
export function isPublicEmailDomain(domain) {
  const d = normaliseDomain(domain);
  return PUBLIC_EMAIL_DOMAINS.has(d) || PUBLIC_EMAIL_SUFFIXES.some((s) => d.endsWith(s));
}

const DOMAIN = /^(?=.{3,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** A tenant id as the import will store it, or "" if it is not a usable one. */
export function directoryTenant(value) {
  const d = normaliseDomain(value);
  return DOMAIN.test(d) && !isPublicEmailDomain(d) ? d : "";
}

// --- addresses ---------------------------------------------------------------

// The SPA's own test (EmailPicker), so a directory entry is never an address
// the invite field would then refuse.
const VALID_EMAIL = /^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]+$/;

/** Lowercased and stripped of the wrappers exports and clipboards add. */
export function cleanEmail(value) {
  return String(value ?? "")
    .trim()
    .replace(/^mailto:/i, "")
    .replace(/^<(.*)>$/, "$1")
    .trim()
    .toLowerCase();
}

export function isValidEmail(email) {
  return email.length <= MAX_EMAIL_LENGTH && VALID_EMAIL.test(email);
}

/** One line of whitespace, trimmed, capped. Quotes a clipboard left are removed. */
export function cleanName(value) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^["'](.*)["']$/, "$1")
    .trim()
    .slice(0, MAX_NAME_LENGTH);
}

// --- CSV -----------------------------------------------------------------------

/**
 * RFC 4180, as spreadsheets actually write it: quoted fields may hold the
 * delimiter, newlines and doubled quotes; any of `\r\n`, `\n`, `\r` ends a
 * record. Returns `{ line, cells }` per record so a skipped row can be reported
 * by the line number the administrator sees in their editor. Blank records are
 * dropped.
 */
export function parseCsv(text, delimiter = ",") {
  const src = String(text ?? "").replace(/^\uFEFF/, "");
  const records = [];
  let cells = [];
  let cell = "";
  let quoted = false;
  let line = 1;
  let startLine = 1;
  const endRecord = () => {
    cells.push(cell);
    if (cells.some((c) => c.trim() !== "")) records.push({ line: startLine, cells });
    cells = [];
    cell = "";
  };
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else {
        if (ch === "\n" || (ch === "\r" && src[i + 1] !== "\n")) line++;
        cell += ch;
      }
      continue;
    }
    if (ch === '"' && cell.trim() === "") {
      cell = "";
      quoted = true;
    } else if (ch === delimiter) {
      cells.push(cell);
      cell = "";
    } else if (ch === "\r" || ch === "\n") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      endRecord();
      line++;
      startLine = line;
    } else {
      cell += ch;
    }
  }
  if (cell !== "" || cells.length) endRecord();
  return records;
}

/** The delimiter the first line uses most, outside quotes: `,`, `;` or tab. */
export function detectDelimiter(text) {
  const first = String(text ?? "").replace(/^\uFEFF/, "").split(/\r\n|\n|\r/, 1)[0] || "";
  const outside = first.replace(/"[^"]*"/g, "");
  const count = (c) => outside.split(c).length - 1;
  const ranked = [",", ";", "\t"].map((c) => [c, count(c)]).sort((a, b) => b[1] - a[1]);
  return ranked[0][1] > 0 ? ranked[0][0] : ",";
}

// --- column mapping ----------------------------------------------------------

/**
 * A header as compared: lowercased, "[Required]"-style annotations dropped,
 * every non-alphanumeric removed — so `E-mail Address`, `email_address` and
 * `Email Address [Required]` are all `emailaddress`.
 */
export const headerKey = (h) =>
  String(h ?? "")
    .toLowerCase()
    .replace(/\[[^\]]*\]|\([^)]*\)/g, "")
    .replace(/[^a-z0-9]/g, "");

// In priority order. A row takes the first non-empty column in its list, so
// an Entra export whose `mail` is blank for one person falls back to that
// person's `userPrincipalName` — which is their sign-in address and almost
// always their mail address too.
const EMAIL_HEADERS = [
  "email", "emailaddress", "mail", "primaryemail", "workemail", "businessemail",
  "email1value", "email1", "emailaddress1", "smtpaddress", "primarysmtpaddress",
  "userprincipalname", "upn", "username", "login",
];
const NAME_HEADERS = ["displayname", "fullname", "name", "contactname", "preferredname"];
const FIRST_HEADERS = ["firstname", "givenname", "first", "forename"];
const MIDDLE_HEADERS = ["middlename"];
const LAST_HEADERS = ["lastname", "surname", "familyname", "last"];

function columnsFor(header) {
  const keys = header.map(headerKey);
  const find = (aliases) =>
    aliases.flatMap((a) => keys.flatMap((k, i) => (k === a ? [i] : [])));
  return {
    email: find(EMAIL_HEADERS),
    name: find(NAME_HEADERS),
    first: find(FIRST_HEADERS)[0] ?? -1,
    middle: find(MIDDLE_HEADERS)[0] ?? -1,
    last: find(LAST_HEADERS)[0] ?? -1,
  };
}

const NAME_AND_ADDRESS = /^\s*(?:"?([^"<]*?)"?\s*)?<\s*([^<>\s]+@[^<>\s]+)\s*>\s*$/;

/** `Ann Lee <ann@example.com>` → `{ name, email }`; a bare address → `{ email }`. */
export function splitAddress(value) {
  const m = NAME_AND_ADDRESS.exec(String(value ?? ""));
  if (m) return { name: cleanName(m[1] || ""), email: cleanEmail(m[2]) };
  return { name: "", email: cleanEmail(value) };
}

// --- the whole file ------------------------------------------------------------

/**
 * @typedef {{ email: string, name: string }} DirectoryEntry
 * @typedef {{ line: number, reason: "invalid_email"|"missing_email"|"too_many", text: string }} SkippedRow
 * @typedef {{
 *   format: "csv"|"addresses",
 *   columns: { email: string[], name: string[] },
 *   entries: DirectoryEntry[],
 *   skipped: SkippedRow[],
 *   duplicates: number,
 *   domains: Record<string, number>,
 * }} ParsedDirectory
 */

/**
 * Read an uploaded file into directory entries.
 *
 * Never throws for a bad *row* — a row is skipped and reported with its line
 * number, because a 3,000-line export with one broken line should import 2,999
 * people and say which one it could not. It throws (`code: "no_email_column"`)
 * only when no row could ever produce an address, since that is the wrong
 * file rather than a bad line in the right one.
 *
 * Addresses are lowercased and de-duplicated; the first spelling of a person
 * wins, except that a later row supplies a name the first one lacked.
 *
 * @returns {ParsedDirectory}
 */
export function parseDirectoryFile(text) {
  const src = String(text ?? "").replace(/^\uFEFF/, "");
  const skipped = [];
  const byEmail = new Map();
  let duplicates = 0;
  let format = "csv";
  let columns = { email: [], name: [] };

  const take = (line, email, name, raw) => {
    if (!email) {
      skipped.push({ line, reason: "missing_email", text: raw.slice(0, 200) });
      return;
    }
    if (!isValidEmail(email)) {
      skipped.push({ line, reason: "invalid_email", text: raw.slice(0, 200) });
      return;
    }
    const seen = byEmail.get(email);
    if (seen) {
      duplicates++;
      if (!seen.name && name) seen.name = name;
      return;
    }
    if (byEmail.size >= MAX_DIRECTORY_ENTRIES) {
      skipped.push({ line, reason: "too_many", text: raw.slice(0, 200) });
      return;
    }
    byEmail.set(email, { email, name });
  };

  const delimiter = detectDelimiter(src);
  const records = parseCsv(src, delimiter);
  const header = records[0]?.cells ?? [];
  const cols = columnsFor(header);
  const hasHeader = cols.email.length > 0;

  // A recipient list pasted from a mail client: `Name <addr>; Name <addr>`, one
  // or many per line. Recognised by the angle brackets, before CSV, because a
  // "Last, First <addr>" item contains the very comma a CSV reader splits on.
  const looksLikeAddresses = !hasHeader && /<[^<>\s]+@[^<>\s]+>/.test(src);

  if (looksLikeAddresses) {
    format = "addresses";
    const lines = src.split(/\r\n|\n|\r/);
    lines.forEach((l, i) => {
      for (const item of l.split(";")) {
        if (!item.trim()) continue;
        // "Ann <a@x>, Bob <b@x>" — commas separate items only BETWEEN
        // addresses, never inside "Lee, Ann <a@x>", so split after a `>`.
        for (const part of item.split(/(?<=>)\s*,/)) {
          if (!part.trim()) continue;
          const { name, email } = splitAddress(part);
          take(i + 1, email, name, part.trim());
        }
      }
    });
  } else if (hasHeader) {
    columns = {
      email: cols.email.map((i) => header[i].trim()),
      name: cols.name.length
        ? cols.name.map((i) => header[i].trim())
        : [cols.first, cols.middle, cols.last].filter((i) => i >= 0).map((i) => header[i].trim()),
    };
    for (const { line, cells } of records.slice(1)) {
      const at = (i) => (i >= 0 ? String(cells[i] ?? "") : "");
      const rawEmail = cols.email.map(at).find((v) => v.trim()) ?? "";
      const { name: inlineName, email } = splitAddress(rawEmail);
      let name = cleanName(cols.name.map(at).find((v) => v.trim()) ?? "");
      if (!name) name = cleanName([at(cols.first), at(cols.middle), at(cols.last)].filter((v) => v.trim()).join(" "));
      take(line, email, name || inlineName, cells.join(delimiter));
    }
  } else {
    // No header we recognise. If some cell in the first record is an address
    // the file is headerless data — `Ann Lee,ann@example.com` or one address
    // per line — and each row's address is whichever cell holds one.
    const firstHasAddress = header.some((c) => isValidEmail(splitAddress(c).email));
    if (!firstHasAddress) {
      const e = new Error(`no column holds an email address (headers: ${header.map((h) => h.trim()).filter(Boolean).join(", ") || "none"})`);
      e.code = "no_email_column";
      throw e;
    }
    for (const { line, cells } of records) {
      const idx = cells.findIndex((c) => isValidEmail(splitAddress(c).email));
      if (idx < 0) {
        take(line, cleanEmail(cells.find((c) => c.includes("@")) ?? ""), "", cells.join(delimiter));
        continue;
      }
      const { name: inlineName, email } = splitAddress(cells[idx]);
      const other = cells.find((c, i) => i !== idx && c.trim() && !c.includes("@")) ?? "";
      take(line, email, cleanName(other) || inlineName, cells.join(delimiter));
    }
  }

  const entries = [...byEmail.values()];
  const domains = {};
  for (const e of entries) {
    const d = domainOf(e.email);
    domains[d] = (domains[d] || 0) + 1;
  }
  return { format, columns, entries, skipped, duplicates, domains };
}
