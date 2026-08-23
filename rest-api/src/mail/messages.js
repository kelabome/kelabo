/**
 * What each mail SAYS, with nothing about how it is sent.
 *
 * Every builder here returns the same provider-neutral shape:
 *
 *   { subject, text, html, inline: [{ cid, filename, contentType, base64 }] }
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

/** Somebody scheduled a kelabo and invited you (docs 18 §2). */
export function inviteMessage({ hostName, title, scheduledAt, durationMinutes, note, inviteUrl }) {
  const when = formatWhen(scheduledAt, durationMinutes);
  const text = [
    `${hostName} invited you to "${title}".`,
    "",
    when,
    note ? `\n${note}\n` : "",
    "Let them know if you can make it:",
    inviteUrl,
    "",
    "You do not need an account — you can reply as a guest.",
  ]
    .filter((l) => l !== "")
    .join("\n");
  const html = [
    `<p><strong>${esc(hostName)}</strong> invited you to &ldquo;${esc(title)}&rdquo;.</p>`,
    `<p>${esc(when)}</p>`,
    note ? `<p>${esc(note)}</p>` : "",
    `<p><a href="${esc(inviteUrl)}">Let them know if you can make it</a></p>`,
    `<p style="color:#666;font-size:13px">You do not need an account — you can reply as a guest.</p>`,
  ].join("");
  return { subject: `Invitation: ${title}`, text, html, inline: [] };
}

/** A scheduled kelabo was called off (docs 18 §2.5). */
export function cancellationMessage({ hostName, title, scheduledAt, reason }) {
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
  return { subject: `Cancelled: ${title}`, text, html, inline: [] };
}

/**
 * Removed from a scheduled kelabo that is otherwise still happening (docs 18
 * §3.5) — distinct from `cancellationMessage`, which is the whole kelabo
 * going away. Deliberately short: nothing is being asked of the recipient,
 * only told.
 */
export function uninviteMessage({ hostName, title, scheduledAt }) {
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
  return { subject: `Removed: ${title}`, text, html, inline: [] };
}

/** A scheduled kelabo moved to a new time (docs 18 §3.3). */
export function rescheduleMessage({ hostName, title, scheduledAt, previousScheduledAt, durationMinutes, inviteUrl }) {
  const nowWhen = formatWhen(scheduledAt, durationMinutes);
  const wasWhen = formatWhen(previousScheduledAt);
  const text = [
    `${hostName} moved "${title}" to a new time.`,
    "",
    `Was: ${wasWhen}`,
    `Now: ${nowWhen}`,
    "",
    "Please let them know again if you can make it:",
    inviteUrl,
  ]
    .filter((l) => l !== "")
    .join("\n");
  const html = [
    `<p><strong>${esc(hostName)}</strong> moved &ldquo;${esc(title)}&rdquo; to a new time.</p>`,
    `<p style="color:#666">Was: ${esc(wasWhen)}</p>`,
    `<p>Now: <strong>${esc(nowWhen)}</strong></p>`,
    `<p><a href="${esc(inviteUrl)}">Let them know again if you can make it</a></p>`,
  ].join("");
  return { subject: `Rescheduled: ${title}`, text, html, inline: [] };
}
