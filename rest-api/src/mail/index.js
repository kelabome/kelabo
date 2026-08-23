/**
 * The one way this service sends mail.
 *
 * Callers ask for a KIND of mail — `sendOtp`, `sendInvite` — and never learn
 * which provider carried it. Underneath, `messages.js` says what the mail
 * contains and a transport says how it travels; this file is only the join,
 * plus the two decisions that do not belong in either:
 *
 *   - **which provider**, resolved per send rather than at construction, so a
 *     deployment that keeps its mail settings somewhere it can change them at
 *     run time needs no restart and no fork of this file. On a self-hosted
 *     deployment `resolve` returns the same object from config every time and
 *     the async costs nothing.
 *
 *   - **who it is from**, defaulted here. Every call site used to pass
 *     `from: config.ses.fromAddress` by hand, which is four chances to forget
 *     and a silent provider rejection when one does.
 *
 * Adding a provider is a file next to `ses.js`/`mailersend.js` exporting
 * `{ id, send(message) }`, plus a line in FACTORIES. Nothing above this layer
 * changes.
 */
import { createSesTransport } from "./ses.js";
import { createMailerSendTransport } from "./mailersend.js";
import { otpMessage, inviteMessage, cancellationMessage, rescheduleMessage, uninviteMessage } from "./messages.js";

export const MAIL_PROVIDERS = ["ses", "mailersend"];

const FACTORIES = {
  ses: ({ ses }) => createSesTransport(ses),
  mailersend: ({ apiKey, mailersend }) => createMailerSendTransport({ apiKey, ...mailersend }),
};

/**
 * The static resolver: a self-hosted deployment's mail settings, which are
 * fixed for the life of the container. `apiKey` is passed separately because
 * it comes from Secrets Manager, not from config — `config` never holds a
 * credential.
 */
export function mailSettingsFromConfig(config, apiKey = "") {
  return {
    provider: config.mail?.provider || "ses",
    fromAddress: config.mail?.fromAddress || "",
    apiKey,
    ses: {
      // Not config.region: mail can be sent from another region deliberately,
      // to give an environment its own SES sandbox status, quota and
      // reputation.
      region: config.mail?.ses?.region || config.region,
      configurationSet: config.mail?.ses?.configurationSet || "",
    },
    mailersend: { apiBase: config.mail?.mailersend?.apiBase || undefined },
  };
}

/** What identifies a transport, so a rotated key builds a new one and nothing else does. */
const transportKey = (s) =>
  [s.provider, s.apiKey, s.ses?.region, s.ses?.configurationSet, s.mailersend?.apiBase].join("\u0000");

export function createMailer({ resolve, sendEmail, factories = FACTORIES } = {}) {
  // The stub seam used by the tests: one function stands in for every kind of
  // mail, so a test can assert on what would have been sent without a client,
  // an API key or a network.
  if (sendEmail) {
    return {
      sendOtp: sendEmail,
      sendInvite: sendEmail,
      sendCancellation: sendEmail,
      sendReschedule: sendEmail,
      sendUninvite: sendEmail,
    };
  }
  if (typeof resolve !== "function") throw new Error("createMailer: needs `resolve` or `sendEmail`");

  let cached = null;

  async function transportFor() {
    const settings = await resolve();
    const factory = factories[settings.provider];
    // Throws rather than falling back to SES. A default here would send mail
    // from the wrong account with the wrong reputation and report success —
    // the failure would only ever be visible in someone else's inbox.
    if (!factory) {
      throw new Error(`mail: unknown provider "${settings.provider}" (known: ${Object.keys(factories).join(", ")})`);
    }
    const key = transportKey(settings);
    if (!cached || cached.key !== key) cached = { key, transport: factory(settings) };
    return { transport: cached.transport, settings };
  }

  /** Every kind of mail funnels through here, so the defaults hold for all of them. */
  async function deliver(to, from, message) {
    const { transport, settings } = await transportFor();
    return transport.send({ ...message, to, from: from || settings.fromAddress });
  }

  return {
    sendOtp: ({ to, code, from }) => deliver(to, from, otpMessage({ code })),
    sendInvite: ({ to, from, ...rest }) => deliver(to, from, inviteMessage(rest)),
    sendCancellation: ({ to, from, ...rest }) => deliver(to, from, cancellationMessage(rest)),
    sendReschedule: ({ to, from, ...rest }) => deliver(to, from, rescheduleMessage(rest)),
    sendUninvite: ({ to, from, ...rest }) => deliver(to, from, uninviteMessage(rest)),
  };
}
