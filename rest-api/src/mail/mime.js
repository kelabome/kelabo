/**
 * A message, as bytes on the wire. **SES only.**
 *
 * MailerSend takes structured JSON and needs none of this; MIME is here
 * because SESv2's `Simple` content cannot carry a part, and a part is the only
 * way to put the logo IN the message rather than on a server somewhere (see
 * `../mailLogo.js` for why a remote `<img src>` is not a real option).
 *
 * Structure, which is the part that is easy to get subtly wrong:
 *
 *   multipart/related            <- binds the image to the markup that cites it
 *     multipart/alternative      <- text and HTML are the SAME message
 *       text/plain
 *       text/html
 *     image/png (Content-ID)     <- the logo, referenced as cid:
 *
 * The image must be a sibling of the *alternative*, not a third alternative:
 * nested the other way round, clients offer the logo as a substitute for the
 * text and some show the picture alone.
 *
 * A message with no inline parts is written as the bare alternative, without
 * the `related` wrapper — a `multipart/related` holding one child is legal but
 * pointless, and it is one more level for a client to render oddly.
 *
 * Pure and exported so `test/otpMail.mjs` can assert the wire format without
 * an SES client — the send path is then only a call and error mapping.
 */
import { randomUUID } from "node:crypto";

const CRLF = "\r\n";

/**
 * Nothing reaching a header may start a new one. `to`/`from` are validated
 * addresses and the subject is built from a generated code or a kelabo title,
 * so this rarely fires — it is here so that stays true when a caller changes.
 */
const headerValue = (v) => String(v ?? "").replace(/[\r\n]+/g, " ").trim();

/**
 * SMTP allows 998 characters per line and the HTML is assembled as a single
 * one, so it cannot be sent as-is. Base64 in 76-column lines sidesteps the
 * limit and carries the em dashes as UTF-8 without needing a quoted-printable
 * encoder.
 */
const wrap76 = (s) => (String(s).match(/.{1,76}/g) || []).join(CRLF);
const b64Body = (s) => wrap76(Buffer.from(s, "utf8").toString("base64"));

/** The text/plain + text/html pair, which is one message in two renderings. */
function alternativePart({ text, html, boundary }) {
  return [
    `--${boundary}`,
    `Content-Type: text/plain; charset=UTF-8`,
    `Content-Transfer-Encoding: base64`,
    ``,
    b64Body(text),
    `--${boundary}`,
    `Content-Type: text/html; charset=UTF-8`,
    `Content-Transfer-Encoding: base64`,
    ``,
    b64Body(html),
    `--${boundary}--`,
    ``,
  ];
}

export function buildMimeMessage({ to, from, subject, text, html, inline = [] }) {
  const alternative = `alt_${randomUUID()}`;
  const head = [`From: ${headerValue(from)}`, `To: ${headerValue(to)}`, `Subject: ${headerValue(subject)}`, `MIME-Version: 1.0`];

  if (!inline.length) {
    return [
      ...head,
      `Content-Type: multipart/alternative; boundary="${alternative}"`,
      ``,
      ...alternativePart({ text, html, boundary: alternative }),
    ].join(CRLF);
  }

  const related = `rel_${randomUUID()}`;
  return [
    ...head,
    `Content-Type: multipart/related; type="multipart/alternative"; boundary="${related}"`,
    ``,
    `--${related}`,
    `Content-Type: multipart/alternative; boundary="${alternative}"`,
    ``,
    ...alternativePart({ text, html, boundary: alternative }),
    ...inline.flatMap((part) => [
      `--${related}`,
      `Content-Type: ${part.contentType}`,
      `Content-Transfer-Encoding: base64`,
      // Angle brackets in the header, none in the `cid:` URL that cites it.
      `Content-ID: <${headerValue(part.cid)}>`,
      // `inline`, so clients that also list attachments do not advertise the
      // logo as a file the reader is expected to do something with.
      `Content-Disposition: inline; filename="${headerValue(part.filename)}"`,
      ``,
      // The message carries flat base64 (that is what a JSON API wants); a
      // MIME body wants it wrapped, with CRLF rather than the LF a JS template
      // literal would leave behind.
      wrap76(part.base64),
    ]),
    `--${related}--`,
    ``,
  ].join(CRLF);
}
