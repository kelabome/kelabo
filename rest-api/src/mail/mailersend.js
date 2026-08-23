/**
 * MailerSend, as a transport.
 *
 * Plain `fetch` against `POST /v1/email` rather than the `mailersend` npm
 * package: the package is a thin wrapper over one JSON call, and the Lambda is
 * bundled by CDK from source, so a dependency here is bytes in every cold
 * start for no behaviour we do not already have.
 *
 * The inline logo needs no MIME. MailerSend takes it as an attachment with
 * `disposition: "inline"` and an `id` the markup cites as `cid:<id>`, which is
 * exactly the shape `messages.js` already produces.
 *
 * What this file is mostly about is that **MailerSend answers 202 for mail it
 * did not send.** A recipient on the account suppression list, or an account
 * with sending paused, comes back as `202 Accepted` with a warning in the
 * body and no `x-message-id`. Taken at face value that is the worst failure
 * this system can have: the person is told a code was sent, the log records a
 * successful send, and no code ever arrives. So the body is read on every
 * response, not only on the failures.
 */
import { err } from "../errors.js";

const DEFAULT_API_BASE = "https://api.mailersend.com/v1";

/** MailerSend's validation errors are `{ "from.email": ["…"], … }`. */
function firstValidationMessage(body) {
  const errors = body?.errors;
  if (!errors || typeof errors !== "object") return String(body?.message || "");
  for (const messages of Object.values(errors)) {
    if (Array.isArray(messages) && messages.length) return String(messages[0]);
  }
  return String(body?.message || "");
}

function parseBody(raw) {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function createMailerSendTransport({
  apiKey,
  apiBase = DEFAULT_API_BASE,
  fetch: injectedFetch,
  timeoutMs = 10_000,
} = {}) {
  const doFetch = injectedFetch || globalThis.fetch;

  return {
    id: "mailersend",
    async send({ to, from, subject, text, html, inline = [] }) {
      if (!apiKey) throw err(502, "mail_not_configured", "No MailerSend API key is configured for this deployment.");

      const payload = {
        from: { email: from },
        to: [{ email: to }],
        subject,
        text,
        html,
        ...(inline.length
          ? {
              attachments: inline.map((part) => ({
                // Flat base64. The asset is stored wrapped for MIME's sake and
                // `messages.js` unwraps it; newlines here are rejected.
                content: part.base64,
                filename: part.filename,
                disposition: "inline",
                // What `<img src="cid:…">` in the HTML resolves against.
                id: part.cid,
              })),
            }
          : {}),
      };

      let res;
      try {
        res = await doFetch(`${apiBase}/email`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (e) {
        // A timeout or a DNS failure. Deliberately not retried here: the OTP
        // route is already rate-limited per email and per IP, and a retry loop
        // inside a Lambda invocation only turns one slow send into a timeout.
        throw err(502, "mail_failed", `Could not reach the email provider: ${e?.message || e}`);
      }

      const raw = await res.text().catch(() => "");
      const body = parseBody(raw);

      if (res.status === 401 || res.status === 403) {
        throw err(502, "mail_not_configured", "The email provider rejected this deployment's API key.");
      }
      if (res.status === 422) {
        const message = firstValidationMessage(body);
        // The sending domain, not the recipient — a deployment that has not
        // finished adding its DNS records. Worth its own code because the
        // person typing their address can do nothing about it.
        if (/verif/i.test(message)) {
          throw err(502, "mail_not_configured", `The sending domain is not verified with the email provider: ${message}`);
        }
        throw err(502, "mail_failed", message || "The email provider rejected the message.");
      }
      if (res.status === 429) {
        throw err(502, "mail_failed", "The email provider is rate-limiting this deployment — try again shortly.");
      }
      if (!res.ok) {
        throw err(502, "mail_failed", `The email provider answered ${res.status}.`);
      }

      // Sending paused at the account or domain. The call succeeded and the
      // mail is held, which for a sign-in code is the same as lost.
      if (res.headers?.get?.("x-send-paused") === "true") {
        throw err(502, "mail_not_configured", "Sending is paused at the email provider, so the message was not delivered.");
      }

      // Suppression. Every mail this service sends goes to exactly one
      // recipient, so ANY suppression warning means this message was not
      // delivered — `SOME_SUPPRESSED` and `ALL_SUPPRESSED` are the same event
      // at a list of one.
      const suppressed = (body?.warnings || []).some((w) => /SUPPRESSED/i.test(String(w?.type || "")));
      if (suppressed) {
        throw err(
          502,
          "email_suppressed",
          "The email provider is blocking this address because earlier mail to it bounced or was reported as spam."
        );
      }
    },
  };
}
