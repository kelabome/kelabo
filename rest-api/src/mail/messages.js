/**
 * What each mail SAYS, with nothing about how it is sent.
 *
 * Every builder here returns the same provider-neutral shape:
 *
 *   { subject, text, html, inline: [{ cid, filename, contentType, base64 }],
 *     calendar?: { method, content } }
 *
 * `calendar` is an iCalendar object (see `ics.js`). Without it a scheduling
 * mail is only a description of a meeting and lands in no calendar — the
 * "it never shows up in Outlook" bug. It is attached only when the caller
 * passes `event` (who organises it, who it is for, and a SEQUENCE).
 *
 * That shape, rather than a raw MIME string, is the whole reason this file
 * exists. The sign-in mail used to be assembled as MIME inside the SES sender,
 * because SESv2's `Simple` content cannot carry a part and the logo has to
 * travel with the message (see `../mailLogo.js`). MIME is an *SES* answer to
 * that problem: MailerSend takes the same inline image as a JSON attachment
 * with `disposition: "inline"`. Had the boundary stayed at "a string of MIME",
 * every new provider would have had to parse one back apart.
 *
 * Pure — no clock, no client, no config — so `test/mail.mjs` can assert on the
 * words and `test/otpMail.mjs` on the bytes they turn into.
 */
import { randomUUID } from "node:crypto";
import { MAIL_LOGO_BASE64, MAIL_LOGO_FILENAME, MAIL_LOGO_TYPE } from "../mailLogo.js";
import { buildIcs } from "./ics.js";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * The calendar half of a scheduling mail, or nothing. `event` is
 * `{ kelaboId, organizerEmail, organizerName?, to, sequence, stamp }`. An
 * organizer that is not an address (a guest identity) gets no calendar part:
 * iTIP REQUEST without a real ORGANIZER is rejected or mis-shown by Outlook.
 */
function calendarFor(method, event, fields) {
  if (!event || !EMAIL.test(event.organizerEmail || "") || !EMAIL.test(event.to || "")) return undefined;
  const content = buildIcs({
    method,
    kelaboId: event.kelaboId,
    sequence: event.sequence,
    stamp: event.stamp,
    organizer: { email: event.organizerEmail, name: event.organizerName },
    attendee: { email: event.to },
    ...fields,
  });
  return { method, content };
}

/**
 * Formats a scheduled time for someone who may be anywhere. The offset is
 * spelled out rather than assumed: an invitation that says "2:00 PM" without
 * saying whose 2:00 PM is how people miss kelabos.
 */
export function formatWhen(scheduledAt, durationMinutes) {
  const d = new Date(scheduledAt);
  const date = d.toUTCString().replace(" GMT", " UTC");
  return durationMinutes ? `${date} (${durationMinutes} min)` : date;
}

export const esc = (v) =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/**
 * The asset is stored pre-wrapped at 76 columns because that is what a MIME
 * body wants. A JSON API wants the opposite — MailerSend rejects base64 with
 * newlines in it — so the wrapping is re-applied by the MIME writer and the
 * message carries the flat form. Getting this backwards produces a mail that
 * sends successfully and shows a broken image, which is the failure mode this
 * whole area keeps producing.
 */
const flatBase64 = (s) => String(s ?? "").replace(/\s+/g, "");

/**
 * The sign-in mail.
 *
 * Email clients run no JavaScript, so a copy BUTTON is impossible in mail.
 * What replaces it: the code leads the subject line (copyable straight from
 * the notification), and the body sets it huge, spaced and monospaced — the
 * shape Gmail and Apple Mail recognise and offer as a one-tap copy chip.
 */
export function otpMessage({ code, logoBase64 = MAIL_LOGO_BASE64 } = {}) {
  // Per message, not a constant: a fixed Content-ID has been observed to make
  // clients that cache by cid show an older mail's image, and it costs nothing
  // to be unambiguous. MailerSend uses the same id as the attachment's `id`,
  // so one value serves both providers.
  const cid = `logo.${randomUUID()}@kelabo`;

  const html = [
    `<div style="background:#faf9f7;padding:40px 16px;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">`,
    `<table role="presentation" cellpadding="0" cellspacing="0" align="center" style="width:100%;max-width:420px;margin:0 auto">`,
    `<tr><td style="text-align:center;padding-bottom:20px">`,
    `<img src="cid:${esc(cid)}" width="112" height="112" alt="Kelabo" style="border-radius:28px;display:inline-block">`,
    `<div style="font-size:20px;font-weight:600;color:#1a1917;padding-top:10px">kelabo</div>`,
    `</td></tr>`,
    `<tr><td style="background:#ffffff;border:1px solid #e6e3dc;border-radius:12px;padding:28px 24px;text-align:center">`,
    `<div style="font-size:15px;color:#56524b;padding-bottom:16px">Your sign-in code — it expires in 10 minutes.</div>`,
    `<div style="font-family:'SF Mono',Consolas,monospace;font-size:40px;font-weight:700;letter-spacing:12px;color:#1a1917;padding:14px 0 14px 12px;background:#f3f1ed;border-radius:10px">${esc(code)}</div>`,
    `</td></tr>`,
    `<tr><td style="text-align:center;color:#8a857c;font-size:13px;padding-top:16px">`,
    `Didn't try to sign in? You can ignore this email — nobody gets in without it.`,
    `</td></tr>`,
    `</table></div>`,
  ].join("");

  return {
    // The code up front: visible and copyable from the inbox row and the OS
    // notification without opening the mail at all.
    subject: `${code} is your Kelabo sign-in code`,
    text: `Your Kelabo sign-in code is ${code}. It expires in 10 minutes.`,
    html,
    inline: [
      {
        cid,
        filename: MAIL_LOGO_FILENAME,
        contentType: MAIL_LOGO_TYPE,
        base64: flatBase64(logoBase64),
      },
    ],
  };
}

/**
 * A button that survives Outlook's HTML renderer: a padded table cell, not a
 * styled <a> alone — Outlook drops padding on inline elements and the
 * "button" collapses to underlined text.
 */
const button = (url, label, { bg, fg, border }) =>
  `<td style="background:${bg};border:1px solid ${border};border-radius:8px;padding:11px 22px">` +
  `<a href="${esc(url)}" style="color:${fg};text-decoration:none;font-weight:600;font-size:15px;display:inline-block">${esc(label)}</a>` +
  `</td>`;

const ACCEPT = { bg: "#1f7a4d", fg: "#ffffff", border: "#1f7a4d" };
const DECLINE = { bg: "#ffffff", fg: "#a1302a", border: "#d9b3b0" };

/** Accept and Decline side by side, with a gap Outlook will not collapse. */
const rsvpButtons = (acceptUrl, declineUrl) =>
  `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:18px 0 8px"><tr>` +
  button(acceptUrl, "Accept", ACCEPT) +
  `<td style="width:12px">&nbsp;</td>` +
  button(declineUrl, "Decline", DECLINE) +
  `</tr></table>`;

/** The join link, under the answer buttons, as a link someone can also copy. */
const joinBlock = (joinUrl) =>
  `<p style="margin:18px 0 4px;font-weight:600">Join the meeting</p>` +
  `<p style="margin:0 0 16px"><a href="${esc(joinUrl)}">${esc(joinUrl)}</a></p>`;

/**
 * The calendar event's description: the join link first, because it is what
 * someone opening the event at meeting time is looking for.
 */
const eventDescription = (joinUrl, inviteUrl, note) =>
  [joinUrl ? `Join: ${joinUrl}` : null, note || null, `Reply: ${inviteUrl}`].filter(Boolean).join("\n\n");

/**
 * The answer half of an invitation, in both renderings. With per-invitee
 * `acceptUrl`/`declineUrl` (signed links, scheduling.js `rsvpLinks`) it is two
 * buttons that record the answer in one click; without them, the plain RSVP
 * page link it always was.
 */
function answerParts({ acceptUrl, declineUrl, inviteUrl, prompt }) {
  if (acceptUrl && declineUrl) {
    return {
      text: [prompt, `Accept:  ${acceptUrl}`, `Decline: ${declineUrl}`],
      html: `<p style="margin:16px 0 0">${esc(prompt)}</p>` + rsvpButtons(acceptUrl, declineUrl),
    };
  }
  return { text: [prompt, inviteUrl], html: `<p><a href="${esc(inviteUrl)}">${esc(prompt)}</a></p>` };
}

/**
 * Somebody scheduled a kelabo and invited you (docs 18 §2).
 *
 * Layout, top to bottom: what and when; **Accept / Decline** (one click each,
 * recorded against this invitee); then the **join link** — the way into the
 * room at meeting time, also the calendar event's LOCATION. `/join/<id>` waits
 * by itself if clicked before the host starts.
 */
export function inviteMessage({ hostName, title, scheduledAt, durationMinutes, note, inviteUrl, joinUrl, acceptUrl, declineUrl, event }) {
  const when = formatWhen(scheduledAt, durationMinutes);
  const answer = answerParts({ acceptUrl, declineUrl, inviteUrl, prompt: "Can you make it?" });
  const text = [
    `${hostName} invited you to "${title}".`,
    "",
    when,
    note ? `\n${note}\n` : "",
    ...answer.text,
    joinUrl ? "Join the meeting:" : "",
    joinUrl || "",
    "",
    "You do not need an account — you can reply and join as a guest.",
  ]
    .filter((l) => l !== "")
    .join("\n");
  const html = [
    `<p><strong>${esc(hostName)}</strong> invited you to &ldquo;${esc(title)}&rdquo;.</p>`,
    `<p>${esc(when)}</p>`,
    note ? `<p>${esc(note)}</p>` : "",
    answer.html,
    joinUrl ? joinBlock(joinUrl) : "",
    `<p style="color:#666;font-size:13px">You do not need an account — you can reply and join as a guest.</p>`,
  ].join("");
  const calendar = calendarFor("REQUEST", event, {
    start: scheduledAt,
    durationMinutes,
    title,
    description: eventDescription(joinUrl, inviteUrl, note),
    url: joinUrl || inviteUrl,
  });
  return { subject: `Invitation: ${title}`, text, html, inline: [], ...(calendar ? { calendar } : {}) };
}

/** A scheduled kelabo was called off (docs 18 §2.5). */
export function cancellationMessage({ hostName, title, scheduledAt, durationMinutes, reason, event }) {
  const when = formatWhen(scheduledAt);
  const text = [
    `${hostName} cancelled "${title}".`,
    "",
    `It was scheduled for ${when}.`,
    reason ? `\nReason: ${reason}\n` : "",
    "No action is needed.",
  ]
    .filter((l) => l !== "")
    .join("\n");
  const html = [
    `<p><strong>${esc(hostName)}</strong> cancelled &ldquo;${esc(title)}&rdquo;.</p>`,
    `<p>It was scheduled for ${esc(when)}.</p>`,
    reason ? `<p>Reason: ${esc(reason)}</p>` : "",
    `<p style="color:#666;font-size:13px">No action is needed.</p>`,
  ].join("");
  const calendar = calendarFor("CANCEL", event, {
    start: scheduledAt,
    durationMinutes,
    title,
    description: reason ? `Cancelled: ${reason}` : "Cancelled",
  });
  return { subject: `Cancelled: ${title}`, text, html, inline: [], ...(calendar ? { calendar } : {}) };
}

/**
 * Removed from a scheduled kelabo that is otherwise still happening (docs 18
 * §3.5) — distinct from `cancellationMessage`, which is the whole kelabo
 * going away. Deliberately short: nothing is being asked of the recipient,
 * only told.
 */
export function uninviteMessage({ hostName, title, scheduledAt, durationMinutes, event }) {
  const when = formatWhen(scheduledAt);
  const text = [
    `${hostName} removed you from "${title}".`,
    "",
    `It is still happening, at ${when} — just without you.`,
    "No action is needed.",
  ].join("\n");
  const html = [
    `<p><strong>${esc(hostName)}</strong> removed you from &ldquo;${esc(title)}&rdquo;.</p>`,
    `<p>It is still happening, at ${esc(when)} — just without you.</p>`,
    `<p style="color:#666;font-size:13px">No action is needed.</p>`,
  ].join("");
  // CANCEL addressed to one attendee removes it from *their* calendar only
  // (RFC 5546 §3.2.5) — the kelabo goes on for everybody else.
  const calendar = calendarFor("CANCEL", event, { start: scheduledAt, durationMinutes, title });
  return { subject: `Removed: ${title}`, text, html, inline: [], ...(calendar ? { calendar } : {}) };
}

/** A scheduled kelabo moved to a new time (docs 18 §3.3). */
export function rescheduleMessage({ hostName, title, scheduledAt, previousScheduledAt, durationMinutes, inviteUrl, joinUrl, acceptUrl, declineUrl, event }) {
  const nowWhen = formatWhen(scheduledAt, durationMinutes);
  const wasWhen = formatWhen(previousScheduledAt);
  const answer = answerParts({ acceptUrl, declineUrl, inviteUrl, prompt: "Can you still make it?" });
  const text = [
    `${hostName} moved "${title}" to a new time.`,
    "",
    `Was: ${wasWhen}`,
    `Now: ${nowWhen}`,
    "",
    ...answer.text,
    joinUrl ? "Join the meeting:" : "",
    joinUrl || "",
  ]
    .filter((l) => l !== "")
    .join("\n");
  const html = [
    `<p><strong>${esc(hostName)}</strong> moved &ldquo;${esc(title)}&rdquo; to a new time.</p>`,
    `<p style="color:#666">Was: ${esc(wasWhen)}</p>`,
    `<p>Now: <strong>${esc(nowWhen)}</strong></p>`,
    answer.html,
    joinUrl ? joinBlock(joinUrl) : "",
  ].join("");
  // Same UID, higher SEQUENCE: the calendar MOVES the existing event rather
  // than adding a second one.
  const calendar = calendarFor("REQUEST", event, {
    start: scheduledAt,
    durationMinutes,
    title,
    description: eventDescription(joinUrl, inviteUrl),
    url: joinUrl || inviteUrl,
  });
  return { subject: `Rescheduled: ${title}`, text, html, inline: [], ...(calendar ? { calendar } : {}) };
}
