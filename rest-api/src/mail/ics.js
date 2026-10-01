/**
 * An iCalendar (RFC 5545) event, as text — what makes a scheduled kelabo land
 * in somebody's Outlook / Google / Apple calendar instead of only their inbox.
 *
 * A mail that merely *describes* a meeting is just a mail: no client puts it on
 * a calendar. A client does that only for a `text/calendar` part carrying an
 * iTIP method (RFC 5546) — `REQUEST` to add or update, `CANCEL` to remove — and
 * matches every later message to the first by `UID`, keeping whichever has the
 * highest `SEQUENCE`. So:
 *
 *   - `UID` is derived from the kelaboId and never changes for a kelabo.
 *   - `SEQUENCE` must only ever grow. The caller passes the send time in
 *     seconds, which grows without any stored counter (an update with a lower
 *     or equal SEQUENCE is silently ignored by Outlook — the reschedule that
 *     "did not move" anything).
 *   - Times are UTC (`...Z`), as everything here is stored, so no VTIMEZONE.
 *
 * Pure — no clock, no config — so `test/mail.mjs` can assert the bytes.
 */

const CRLF = "\r\n";

/** RFC 5545 §3.3.11 TEXT escaping. */
const text = (v) =>
  String(v ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");

/** A CN parameter value: quoted, and a quote cannot appear inside one. */
const param = (v) => `"${String(v ?? "").replace(/["\r\n]/g, "")}"`;

/** 20260115T143000Z */
const utc = (ms) => new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

/**
 * RFC 5545 §3.1: lines longer than 75 OCTETS are folded with CRLF + space.
 * Octets, not characters — a title in Chinese or with an em dash is counted in
 * UTF-8 bytes, and a fold must never split a multi-byte character.
 */
function fold(line) {
  const out = [];
  let cur = "";
  let bytes = 0;
  for (const ch of line) {
    const n = Buffer.byteLength(ch, "utf8");
    const limit = out.length ? 74 : 75; // continuation lines start with a space
    if (bytes + n > limit) {
      out.push(cur);
      cur = "";
      bytes = 0;
    }
    cur += ch;
    bytes += n;
  }
  out.push(cur);
  return out.join(`${CRLF} `);
}

export const icsUid = (kelaboId) => `kelabo-${kelaboId}@kelabo`;

/**
 * @param {object} e
 * @param {"REQUEST"|"CANCEL"} e.method
 * @param {string} e.kelaboId
 * @param {number} e.sequence     only ever increases for one kelabo
 * @param {number} e.stamp        epoch ms the message was made (DTSTAMP)
 * @param {number} e.start        epoch ms
 * @param {number} [e.durationMinutes]
 * @param {string} e.title
 * @param {string} [e.description]
 * @param {string} [e.url]
 * @param {{ email: string, name?: string }} e.organizer
 * @param {{ email: string, name?: string }} e.attendee
 */
export function buildIcs(e) {
  const cancel = e.method === "CANCEL";
  const end = e.start + (e.durationMinutes || 30) * 60_000;
  const org = e.organizer;
  const att = e.attendee;
  const lines = [
    "BEGIN:VCALENDAR",
    "PRODID:-//Kelabo//Kelabo//EN",
    "VERSION:2.0",
    "CALSCALE:GREGORIAN",
    `METHOD:${e.method}`,
    "BEGIN:VEVENT",
    `UID:${icsUid(e.kelaboId)}`,
    `SEQUENCE:${Math.max(0, Math.floor(e.sequence || 0))}`,
    `DTSTAMP:${utc(e.stamp)}`,
    `DTSTART:${utc(e.start)}`,
    `DTEND:${utc(end)}`,
    `SUMMARY:${text(e.title)}`,
    e.description ? `DESCRIPTION:${text(e.description)}` : null,
    // LOCATION as the link: it is where the meeting *is*, and it is the field
    // every calendar shows on the event without opening it.
    e.url ? `LOCATION:${text(e.url)}` : null,
    e.url ? `URL:${e.url.replace(/[\r\n]/g, "")}` : null,
    `ORGANIZER${org.name ? `;CN=${param(org.name)}` : ""}:mailto:${org.email}`,
    // RSVP=FALSE: replies are collected on the invitation page (guests have no
    // account and no calendar we can hear from). Outlook still offers
    // Accept/Decline, which adds it to the calendar and mails the organizer.
    `ATTENDEE${att.name ? `;CN=${param(att.name)}` : ""};ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=FALSE:mailto:${att.email}`,
    `STATUS:${cancel ? "CANCELLED" : "CONFIRMED"}`,
    "TRANSP:OPAQUE",
    "END:VEVENT",
    "END:VCALENDAR",
  ].filter((l) => l !== null);
  return lines.map(fold).join(CRLF) + CRLF;
}
