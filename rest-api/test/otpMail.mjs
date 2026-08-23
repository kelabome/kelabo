// The sign-in mail, as it goes on the wire.
//
// The logo used to be `<img src="https://<portal>/favicon-192.png">`. That is
// fetched by Gmail's and Outlook's proxy servers, not by the reader, so any
// deployment that judges the caller — this project's own dev WAF allow-list,
// a self-hoster behind a VPN or basic auth — serves them a 403 and the reader
// gets a broken box. Nothing failed: the mail sent, the code worked, only the
// picture was missing, and the cause was three stacks away in infra.
//
// It is now a CID part, which means the SES transport hand-builds MIME, and
// hand-built MIME fails in ways SES will not tell you about either: a bare LF,
// a line over 998 characters, or the image nested as a third *alternative*
// rather than as a sibling of the alternative (which makes clients offer the
// logo INSTEAD of the text, and some then show the picture alone). None of that
// is visible from the send call, and the stub in smoke.mjs never renders a
// template, so this reads the bytes.
//
// The message and its encoding are now separate modules — MailerSend takes the
// same inline logo as a JSON attachment and needs no MIME at all — so this
// composes the two the way `mail/ses.js` does. `test/mail.mjs` covers the
// provider-neutral half; this file stays about the bytes SES receives.
import assert from "node:assert/strict";
import { buildMimeMessage } from "../src/mail/mime.js";
import { otpMessage } from "../src/mail/messages.js";

const buildOtpMessage = ({ to, code, from }) => buildMimeMessage({ to, from, ...otpMessage({ code }) });

const CRLF = "\r\n";
const raw = buildOtpMessage({ to: "someone@example.com", code: "482913", from: "otp@kelabo.me" });
const lines = raw.split(CRLF);

// --- Line discipline. SMTP, not JavaScript, sets these rules. ---------------
assert.ok(!/[^\r]\n/.test(raw), "a bare LF in a MIME body: some MTAs reject, others silently mangle the part");
assert.ok(!/\r(?!\n)/.test(raw), "a bare CR");
// 998 is the RFC 5322 limit. The HTML is assembled as one long line, which is
// exactly why both text parts are base64 rather than sent as-is.
const longest = Math.max(...lines.map((l) => l.length));
assert.ok(longest <= 998, `longest line is ${longest} characters, limit is 998`);

// --- Structure. The nesting is the part that is easy to get subtly wrong. ---
const relatedBoundary = raw.match(/Content-Type: multipart\/related;[^\r\n]*boundary="([^"]+)"/)[1];
const altBoundary = raw.match(/Content-Type: multipart\/alternative; boundary="([^"]+)"/)[1];
assert.notEqual(relatedBoundary, altBoundary, "one boundary for both levels ends the outer part at the inner delimiter");
assert.match(raw, /Content-Type: multipart\/related; type="multipart\/alternative"/);

const relatedParts = raw.split(`${CRLF}--${relatedBoundary}`);
// [preamble+headers, the alternative, the image, "--" closer]
assert.equal(relatedParts.length, 4, "related should hold exactly two parts");
assert.ok(relatedParts[3].startsWith("--"), "related part is not closed");
assert.match(relatedParts[1], /Content-Type: multipart\/alternative/);
assert.match(relatedParts[2], /Content-Type: image\//);
// The image is a SIBLING of the alternative, never a member of it.
assert.ok(!relatedParts[1].includes("Content-Type: image/"), "the image is nested inside the alternative");

const altParts = relatedParts[1].split(`${CRLF}--${altBoundary}`);
assert.equal(altParts.length, 4, "alternative should hold exactly text and html");
assert.match(altParts[1], /Content-Type: text\/plain; charset=UTF-8/);
assert.match(altParts[2], /Content-Type: text\/html; charset=UTF-8/);
assert.ok(altParts[3].startsWith("--"), "alternative part is not closed");

// --- The reference actually resolves. --------------------------------------
const cid = lines.find((l) => l.startsWith("Content-ID:")).match(/^Content-ID: <(.+)>$/)[1];
assert.ok(cid.length > 0);
assert.ok(!cid.includes("<") && !cid.includes(">"), "angle brackets belong to the header, not the id");
const html = Buffer.from(altParts[2].split(CRLF + CRLF)[1], "base64").toString("utf8");
assert.ok(html.includes(`src="cid:${cid}"`), "the markup cites a Content-ID no part declares");
// The regression itself: no part of this mail may depend on a server the
// reader's mail provider has to be allowed to reach.
assert.ok(!/<img[^>]+src="https?:/i.test(html), "the logo is remote again — mail image proxies will be blocked by any allow-list");

// --- The image survives the round trip. ------------------------------------
const image = Buffer.from(relatedParts[2].split(CRLF + CRLF)[1], "base64");
// PNG, and it must stay PNG. A smaller JPEG costs the alpha channel, which
// means flattening the tile's transparent corners onto an assumed background —
// and the assumption is wrong in Outlook and in every client's dark mode.
assert.ok(image.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")), "the attached bytes are not a PNG");
assert.match(relatedParts[2], /Content-Type: image\/png/);
assert.ok(image.length > 1000, `logo decoded to ${image.length} bytes`);
assert.match(relatedParts[2], /Content-Disposition: inline/);

// --- The code reaches the reader by all three routes. -----------------------
assert.ok(raw.includes("Subject: 482913 is your Kelabo sign-in code"), "the code must lead the subject");
assert.ok(html.includes("482913"));
const text = Buffer.from(altParts[1].split(CRLF + CRLF)[1], "base64").toString("utf8");
assert.ok(text.includes("482913"));
// UTF-8 really is carried, not mojibake — the copy has em dashes in it.
assert.ok(html.includes("—"), "non-ASCII did not survive the encoding");

// --- No header can be smuggled in. ------------------------------------------
// Neither field is attacker-controlled today (`to` is validated, `code` is six
// generated digits). This asserts that stays true if a caller changes.
const injected = buildOtpMessage({
  to: "victim@example.com\r\nBcc: attacker@example.com",
  code: "1\r\nX-Evil: yes",
  from: "otp@kelabo.me",
});
assert.ok(!/^Bcc:/im.test(injected), "CRLF in `to` opened a new header");
assert.ok(!/^X-Evil:/im.test(injected), "CRLF in `code` opened a new header");

// --- Two messages never share a Content-ID. ---------------------------------
// A constant id makes clients that cache by cid show a previous mail's image.
const second = buildOtpMessage({ to: "someone@example.com", code: "482913", from: "otp@kelabo.me" });
assert.notEqual(second.match(/^Content-ID: <(.+)>$/m)[1], cid, "Content-ID is not unique per message");

console.log(
  `rest-api/otpMail: ${Buffer.byteLength(raw)} bytes, ${lines.length} lines, longest ${longest}, logo ${image.length} bytes inline`
);
