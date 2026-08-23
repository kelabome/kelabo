// Outbound mail, above the wire format.
//
// `otpMail.mjs` reads the bytes SES receives. This reads everything that is
// now provider-neutral: which transport a deployment gets, who the mail claims
// to be from, and what each provider is handed.
//
// The reason it exists at all is that email fails quietly. SES answers
// `MessageRejected` for a sandboxed account and MailerSend answers **202
// Accepted for mail it did not send** — a suppressed recipient or a paused
// account comes back as a success with a warning in the body. Left unread,
// that is the worst outcome this system has: the person is told a code was
// sent, the log records a successful send, and no code ever arrives. Every
// branch below that throws is a case where a real provider would otherwise
// have reported success.
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createMailer, mailSettingsFromConfig, MAIL_PROVIDERS } from "../src/mail/index.js";
import { createMailerSendTransport } from "../src/mail/mailersend.js";
import { createSesTransport } from "../src/mail/ses.js";
import { otpMessage, inviteMessage, cancellationMessage, rescheduleMessage, uninviteMessage } from "../src/mail/messages.js";
import { loadConfig } from "../../config/loadConfig.mjs";

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
  } catch (e) {
    console.error(`FAIL: ${name}\n  ${e?.message || e}`);
    process.exit(1);
  }
}

const rejects = async (fn, code, what) => {
  try {
    await fn();
  } catch (e) {
    assert.equal(e.code, code, `${what}: expected code ${code}, got ${e.code} (${e.message})`);
    return e;
  }
  assert.fail(`${what}: expected a rejection with code ${code}, but it resolved`);
};

// --- The messages themselves ------------------------------------------------

await test("the sign-in code leads the subject, and appears in both renderings", async () => {
  const m = otpMessage({ code: "482913" });
  // Copyable from the inbox row and the OS notification without opening it.
  assert.ok(m.subject.startsWith("482913"), `subject was "${m.subject}"`);
  assert.ok(m.text.includes("482913"));
  assert.ok(m.html.includes("482913"));
});

await test("the logo travels with the message, and the markup cites the part that carries it", async () => {
  const m = otpMessage({ code: "000000" });
  assert.equal(m.inline.length, 1);
  const [logo] = m.inline;
  assert.ok(m.html.includes(`src="cid:${logo.cid}"`), "the markup cites a Content-ID no part declares");
  // The original regression: nothing in this mail may depend on a server the
  // reader's mail provider has to be allowed to reach.
  assert.ok(!/<img[^>]+src="https?:/i.test(m.html), "the logo is remote again");
});

await test("inline base64 is flat, because a JSON API rejects the wrapping MIME wants", async () => {
  // The asset is stored pre-wrapped at 76 columns for MIME's sake. Handed to
  // MailerSend with the newlines still in it, the call succeeds and the reader
  // sees a broken image — a failure that reaches nobody's logs.
  const [logo] = otpMessage({ code: "111111" }).inline;
  assert.ok(!/\s/.test(logo.base64), "inline content carries whitespace");
  assert.ok(logo.base64.length > 1000);
  assert.ok(Buffer.from(logo.base64, "base64").subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")), "not a PNG");
});

await test("two sign-in mails never share a Content-ID", async () => {
  // A constant id makes clients that cache by cid show a previous mail's image.
  assert.notEqual(otpMessage({ code: "1" }).inline[0].cid, otpMessage({ code: "1" }).inline[0].cid);
});

await test("the scheduling mails carry the time, the link, and no inline part", async () => {
  const at = Date.UTC(2026, 0, 15, 14, 30);
  const invite = inviteMessage({
    hostName: "Rico",
    title: "Roadmap",
    scheduledAt: at,
    durationMinutes: 45,
    note: "bring numbers",
    inviteUrl: "https://portal.example/invite/k1",
  });
  assert.equal(invite.subject, "Invitation: Roadmap");
  assert.deepEqual(invite.inline, []);
  // The offset is spelled out — an invitation that says "2:00 PM" without
  // saying whose is how people miss kelabos.
  assert.ok(invite.text.includes("UTC"), invite.text);
  assert.ok(invite.text.includes("45 min"));
  assert.ok(invite.text.includes("https://portal.example/invite/k1"));
  assert.ok(invite.html.includes("bring numbers"));

  assert.equal(cancellationMessage({ hostName: "R", title: "Roadmap", scheduledAt: at }).subject, "Cancelled: Roadmap");

  const moved = rescheduleMessage({
    hostName: "R",
    title: "Roadmap",
    scheduledAt: at + 3600_000,
    previousScheduledAt: at,
    inviteUrl: "https://portal.example/invite/k1",
  });
  assert.equal(moved.subject, "Rescheduled: Roadmap");
  // Both times, because "moved to 3pm" is unreadable without knowing from what.
  assert.ok(moved.text.includes("Was:") && moved.text.includes("Now:"), moved.text);

  const removed = uninviteMessage({ hostName: "R", title: "Roadmap", scheduledAt: at });
  assert.equal(removed.subject, "Removed: Roadmap");
  // Distinct from cancellationMessage: the kelabo itself is still happening.
  assert.ok(removed.text.includes("still happening"), removed.text);
  assert.deepEqual(removed.inline, []);
});

await test("a title from a participant cannot inject markup into the HTML body", async () => {
  const m = inviteMessage({ hostName: "<script>x</script>", title: "a\"b", inviteUrl: "https://x/1", scheduledAt: 0 });
  assert.ok(!m.html.includes("<script>"), m.html);
});

// --- Choosing a transport ---------------------------------------------------

const settings = (over = {}) => ({
  provider: "ses",
  fromAddress: "otp@example.com",
  apiKey: "",
  ses: { region: "us-east-1", configurationSet: "" },
  mailersend: {},
  ...over,
});

await test("an unknown provider throws rather than falling back to SES", async () => {
  // A default here would send from the wrong account with the wrong
  // reputation and report success — visible only in someone else's inbox.
  const mailer = createMailer({ resolve: async () => settings({ provider: "postmark" }) });
  await assert.rejects(() => mailer.sendOtp({ to: "a@example.com", code: "1" }), /unknown provider "postmark"/);
});

await test("MAIL_PROVIDERS matches what can actually be built", async () => {
  // The list config/loadConfig.mjs validates against is restated there; if
  // these drift, a valid provider fails at load or an invalid one fails at the
  // first send instead.
  for (const provider of MAIL_PROVIDERS) {
    const sends = [];
    const mailer = createMailer({
      resolve: async () => settings({ provider }),
      factories: Object.fromEntries(MAIL_PROVIDERS.map((p) => [p, () => ({ id: p, send: async (m) => sends.push(m) })])),
    });
    await mailer.sendOtp({ to: "a@example.com", code: "1" });
    assert.equal(sends.length, 1);
  }
});

await test("the mailer supplies the from address, so no call site has to remember it", async () => {
  // Every caller used to pass `from: config.ses.fromAddress` by hand. That is
  // four chances to forget, and a provider rejects the send when one does.
  const sends = [];
  const factories = { ses: () => ({ id: "ses", send: async (m) => sends.push(m) }) };
  const mailer = createMailer({ resolve: async () => settings(), factories });

  await mailer.sendOtp({ to: "a@example.com", code: "1" });
  await mailer.sendInvite({ to: "b@example.com", hostName: "R", title: "T", scheduledAt: 0, inviteUrl: "u" });
  await mailer.sendCancellation({ to: "c@example.com", hostName: "R", title: "T", scheduledAt: 0 });
  await mailer.sendReschedule({ to: "d@example.com", hostName: "R", title: "T", scheduledAt: 1, previousScheduledAt: 0, inviteUrl: "u" });
  await mailer.sendUninvite({ to: "f@example.com", hostName: "R", title: "T", scheduledAt: 0 });
  assert.deepEqual(sends.map((s) => s.from), Array(5).fill("otp@example.com"));
  assert.deepEqual(sends.map((s) => s.to), ["a@example.com", "b@example.com", "c@example.com", "d@example.com", "f@example.com"]);

  // An explicit one still wins, so a caller that needs a different sender can.
  await mailer.sendOtp({ to: "e@example.com", code: "1", from: "other@example.com" });
  assert.equal(sends.at(-1).from, "other@example.com");
});

await test("a rotated key builds a new transport; an unchanged one does not", async () => {
  // The settings are resolved per send precisely so a deployment that keeps
  // them somewhere mutable can rotate a key without a restart. That only works
  // if the cached transport is keyed on the value.
  let apiKey = "key-1";
  let built = 0;
  const mailer = createMailer({
    resolve: async () => settings({ provider: "mailersend", apiKey }),
    factories: { mailersend: () => (built++, { id: "mailersend", send: async () => {} }) },
  });
  await mailer.sendOtp({ to: "a@example.com", code: "1" });
  await mailer.sendOtp({ to: "a@example.com", code: "2" });
  assert.equal(built, 1, "a transport was rebuilt for identical settings");
  apiKey = "key-2";
  await mailer.sendOtp({ to: "a@example.com", code: "3" });
  assert.equal(built, 2, "a rotated key kept using the old transport");
});

await test("the stub seam still stands in for every kind of mail", async () => {
  const seen = [];
  const mailer = createMailer({ sendEmail: async (m) => seen.push(m) });
  await mailer.sendOtp({ to: "a@example.com", code: "1" });
  await mailer.sendInvite({ to: "b@example.com" });
  await mailer.sendCancellation({ to: "c@example.com" });
  await mailer.sendReschedule({ to: "d@example.com" });
  await mailer.sendUninvite({ to: "f@example.com" });
  assert.equal(seen.length, 5);
});

// --- SES --------------------------------------------------------------------

// The configuration set name is spread into every SendEmailCommand, and SES
// rejects a send naming a set that does not exist — so "unconfigured" must mean
// the key is ABSENT, not empty. Getting this wrong loses no events; it stops
// all mail, including every sign-in code.
await test("SES configuration set: named when set, absent when not", async () => {
  const sent = [];
  const client = { send: async (cmd) => (sent.push(cmd.input), {}) };

  const withSet = createSesTransport({ client, configurationSet: "kelabo-test-mail" });
  await withSet.send({ to: "a@example.com", from: "otp@example.com", ...otpMessage({ code: "123456" }) });
  assert.equal(sent.at(-1).ConfigurationSetName, "kelabo-test-mail");

  for (const unset of [undefined, "", null]) {
    const without = createSesTransport({ client, configurationSet: unset });
    await without.send({ to: "b@example.com", from: "otp@example.com", ...inviteMessage({ hostName: "R", title: "T", scheduledAt: 0, inviteUrl: "u" }) });
    assert.ok(!("ConfigurationSetName" in sent.at(-1)), `must be absent, not empty, for ${JSON.stringify(unset)}`);
  }
});

await test("SES sends raw MIME only for a message that carries a part", async () => {
  // `Simple` content cannot carry a part, so using it for the sign-in mail
  // silently drops the inline logo and nothing else notices (see otpMail.mjs).
  // Using `Raw` for everything else would mean hand-encoding mail that does
  // not need it.
  const sent = [];
  const t = createSesTransport({ client: { send: async (cmd) => (sent.push(cmd.input), {}) } });

  await t.send({ to: "a@example.com", from: "otp@example.com", ...otpMessage({ code: "1" }) });
  assert.ok(sent.at(-1).Content?.Raw?.Data, "the sign-in mail must be sent as raw MIME");
  assert.ok(!sent.at(-1).Content?.Simple, "raw and simple content are mutually exclusive");

  await t.send({ to: "b@example.com", from: "otp@example.com", ...inviteMessage({ hostName: "R", title: "T", scheduledAt: 0, inviteUrl: "u" }) });
  assert.ok(sent.at(-1).Content?.Simple?.Body?.Html?.Data, "an invitation needs no MIME");
  assert.ok(!sent.at(-1).Content?.Raw);
});

await test("the SES sandbox rejection is translated, not passed through", async () => {
  // By far the commonest failure, and the one whose own message explains
  // nothing to the person who typed their address.
  const t = createSesTransport({
    client: {
      send: async () => {
        const e = new Error("Email address is not verified. The following identities failed…");
        e.name = "MessageRejected";
        throw e;
      },
    },
  });
  const e = await rejects(
    () => t.send({ to: "a@example.com", from: "otp@example.com", ...otpMessage({ code: "1" }) }),
    "email_not_verified",
    "SES sandbox",
  );
  assert.equal(e.status, 502);
});

await test("any other SES failure is re-thrown untouched", async () => {
  const t = createSesTransport({ client: { send: async () => { throw new Error("Throttling"); } } });
  await assert.rejects(
    () => t.send({ to: "a@example.com", from: "otp@example.com", ...inviteMessage({ hostName: "R", title: "T", scheduledAt: 0, inviteUrl: "u" }) }),
    /Throttling/,
  );
});

// --- MailerSend -------------------------------------------------------------

/** A stub `fetch` that records the request and answers with what the test wants. */
function stubFetch(response) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    const r = typeof response === "function" ? response(calls.length) : response;
    return {
      status: r.status ?? 202,
      ok: (r.status ?? 202) < 400,
      headers: { get: (k) => (r.headers || {})[k.toLowerCase()] ?? null },
      text: async () => r.body ?? "",
    };
  };
  return { fetch, calls };
}

await test("MailerSend gets the message as JSON, with the logo as an inline attachment", async () => {
  const { fetch, calls } = stubFetch({ status: 202, headers: { "x-message-id": "abc" } });
  const t = createMailerSendTransport({ apiKey: "ms-key", fetch });
  const msg = otpMessage({ code: "482913" });
  await t.send({ to: "a@example.com", from: "otp@example.com", ...msg });

  const [call] = calls;
  assert.ok(call.url.endsWith("/email"), call.url);
  assert.equal(call.init.headers.Authorization, "Bearer ms-key");
  assert.deepEqual(call.body.from, { email: "otp@example.com" });
  assert.deepEqual(call.body.to, [{ email: "a@example.com" }]);
  assert.ok(call.body.subject.startsWith("482913"));
  assert.ok(call.body.text && call.body.html);

  const [attachment] = call.body.attachments;
  assert.equal(attachment.disposition, "inline", "without this the logo is offered as a file, not rendered");
  // `id` is what `<img src="cid:…">` resolves against — the same value MIME
  // puts in Content-ID. If these ever disagree the mail sends with a hole in it.
  assert.equal(attachment.id, msg.inline[0].cid);
  assert.ok(call.body.html.includes(`src="cid:${attachment.id}"`));
  assert.ok(!/\s/.test(attachment.content), "base64 with newlines is rejected by the API");
});

await test("a message with no part is sent without an attachments key at all", async () => {
  const { fetch, calls } = stubFetch({ status: 202 });
  const t = createMailerSendTransport({ apiKey: "k", fetch });
  await t.send({ to: "a@example.com", from: "o@example.com", ...inviteMessage({ hostName: "R", title: "T", scheduledAt: 0, inviteUrl: "u" }) });
  assert.ok(!("attachments" in calls[0].body));
});

await test("202 with no warnings is a send", async () => {
  const { fetch } = stubFetch({ status: 202, headers: { "x-message-id": "abc" } });
  const t = createMailerSendTransport({ apiKey: "k", fetch });
  await t.send({ to: "a@example.com", from: "o@example.com", ...otpMessage({ code: "1" }) });
});

await test("202 ALL_SUPPRESSED is a failure, because the mail was not sent", async () => {
  // The whole reason the body is read on success. MailerSend accepts the call,
  // returns no x-message-id, and delivers nothing.
  const { fetch } = stubFetch({
    status: 202,
    body: JSON.stringify({
      message: "There are some warnings for your request.",
      warnings: [{ type: "ALL_SUPPRESSED", recipients: [{ email: "a@example.com", reasons: ["blocklisted"] }] }],
    }),
  });
  const t = createMailerSendTransport({ apiKey: "k", fetch });
  await rejects(() => t.send({ to: "a@example.com", from: "o@example.com", ...otpMessage({ code: "1" }) }), "email_suppressed", "all suppressed");
});

await test("202 SOME_SUPPRESSED is the same event, because every mail has one recipient", async () => {
  const { fetch } = stubFetch({
    status: 202,
    body: JSON.stringify({ warnings: [{ type: "SOME_SUPPRESSED", recipients: [{ email: "a@example.com" }] }] }),
  });
  const t = createMailerSendTransport({ apiKey: "k", fetch });
  await rejects(() => t.send({ to: "a@example.com", from: "o@example.com", ...otpMessage({ code: "1" }) }), "email_suppressed", "some suppressed");
});

await test("202 with sending paused is a failure, because a held sign-in code is a lost one", async () => {
  const { fetch } = stubFetch({ status: 202, headers: { "x-send-paused": "true" } });
  const t = createMailerSendTransport({ apiKey: "k", fetch });
  await rejects(() => t.send({ to: "a@example.com", from: "o@example.com", ...otpMessage({ code: "1" }) }), "mail_not_configured", "paused");
});

await test("an unverified sending domain is a deployment fault, and says so", async () => {
  // Not `email_not_verified`: nothing is wrong with the recipient, and the
  // person typing their address can do nothing about it.
  const { fetch } = stubFetch({
    status: 422,
    body: JSON.stringify({
      message: "The given data was invalid.",
      errors: { "from.email": ["The from.email domain must be verified in your account to send emails. #MS42207"] },
    }),
  });
  const t = createMailerSendTransport({ apiKey: "k", fetch });
  const e = await rejects(() => t.send({ to: "a@example.com", from: "o@example.com", ...otpMessage({ code: "1" }) }), "mail_not_configured", "422 verify");
  assert.ok(/MS42207/.test(e.message), "the provider's own diagnosis is worth keeping");
});

await test("other validation errors carry the provider's message through", async () => {
  const { fetch } = stubFetch({ status: 422, body: JSON.stringify({ errors: { subject: ["The subject is too long."] } }) });
  const t = createMailerSendTransport({ apiKey: "k", fetch });
  const e = await rejects(() => t.send({ to: "a@example.com", from: "o@example.com", ...otpMessage({ code: "1" }) }), "mail_failed", "422 other");
  assert.ok(/subject is too long/.test(e.message), e.message);
});

await test("a rejected API key reads as misconfiguration, not as a bad address", async () => {
  for (const status of [401, 403]) {
    const { fetch } = stubFetch({ status, body: "" });
    const t = createMailerSendTransport({ apiKey: "wrong", fetch });
    await rejects(() => t.send({ to: "a@example.com", from: "o@example.com", ...otpMessage({ code: "1" }) }), "mail_not_configured", `status ${status}`);
  }
});

await test("rate limiting and server errors fail loudly rather than silently", async () => {
  for (const status of [429, 500, 502]) {
    const { fetch } = stubFetch({ status, body: "" });
    const t = createMailerSendTransport({ apiKey: "k", fetch });
    await rejects(() => t.send({ to: "a@example.com", from: "o@example.com", ...otpMessage({ code: "1" }) }), "mail_failed", `status ${status}`);
  }
});

await test("an unreachable provider is a mail failure, not an unhandled throw", async () => {
  const t = createMailerSendTransport({
    apiKey: "k",
    fetch: async () => {
      throw new Error("getaddrinfo ENOTFOUND");
    },
  });
  await rejects(() => t.send({ to: "a@example.com", from: "o@example.com", ...otpMessage({ code: "1" }) }), "mail_failed", "network");
});

await test("no API key fails before any network call", async () => {
  let called = false;
  const t = createMailerSendTransport({ apiKey: "", fetch: async () => ((called = true), {}) });
  await rejects(() => t.send({ to: "a@example.com", from: "o@example.com", ...otpMessage({ code: "1" }) }), "mail_not_configured", "no key");
  assert.equal(called, false);
});

// --- Config -----------------------------------------------------------------

const template = join(dirname(fileURLToPath(import.meta.url)), "../../config/template.json");

await test("a deployment that names no mail block still sends, through SES", async () => {
  // Every kelabo.json written before mail became a choice says only
  // `ses.fromAddress`. Those deployments must keep working untouched.
  const c = loadConfig("staging", template);
  assert.equal(c.mail.provider, "ses");
  assert.equal(c.mail.fromAddress, "otp@example.com");
  assert.equal(c.ses.createIdentity, true);
});

await test("the SES and mail from-addresses cannot drift apart", async () => {
  // Two names for one value: the Lambda's IAM condition is built from one and
  // the sender from the other. A mismatch is an AccessDenied on every send.
  for (const env of ["dev", "staging", "prod"]) {
    const c = loadConfig(env, template);
    assert.equal(c.ses.fromAddress, c.mail.fromAddress, env);
  }
});

await test("choosing another provider turns off the SES identity stack", async () => {
  // That stack publishes `v=spf1 include:amazonses.com -all`, which names the
  // WRONG sender for any other provider and would fail its mail.
  const c = loadConfig("prod", template);
  assert.equal(c.mail.provider, "mailersend");
  assert.equal(c.ses.createIdentity, false);
});

await test("every environment names a mail secret, whether or not it needs one", async () => {
  for (const env of ["dev", "staging", "prod"]) {
    assert.equal(loadConfig(env, template).secrets.mail, `kelabo/${loadConfig(env, template).endpoint}/mail`);
  }
});

await test("a typo in mail.provider fails at config load, where it can be read", async () => {
  // Rather than at the first send, which is a 500 on somebody's sign-in.
  const { readFileSync, writeFileSync, mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const raw = JSON.parse(readFileSync(template, "utf8"));
  raw.environments.dev.mail = { provider: "mailsend", fromAddress: "otp@example.com" };
  const path = join(mkdtempSync(join(tmpdir(), "kelabo-mail-")), "kelabo.json");
  writeFileSync(path, JSON.stringify(raw));
  assert.throws(() => loadConfig("dev", path), /mail\.provider "mailsend"/);
});

await test("mailSettingsFromConfig keeps the key out of config and the region out of guesswork", async () => {
  const s = mailSettingsFromConfig(
    { region: "ap-southeast-2", mail: { provider: "mailersend", fromAddress: "otp@x", ses: {}, mailersend: {} } },
    "the-key",
  );
  assert.equal(s.apiKey, "the-key", "the key arrives separately — config never holds a credential");
  // Mail can be sent from another region deliberately, to give an environment
  // its own SES sandbox status, quota and reputation.
  assert.equal(s.ses.region, "ap-southeast-2");
  assert.equal(mailSettingsFromConfig({ region: "r", mail: { ses: { region: "us-east-1" } } }, "").ses.region, "us-east-1");
  // No provider named anywhere still means SES, which is what an untouched
  // deployment has always done.
  assert.equal(mailSettingsFromConfig({ region: "r" }, "").provider, "ses");
});

console.log(`rest-api/mail: ${passed} passed`);
