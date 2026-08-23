/**
 * Amazon SES, as a transport.
 *
 * Two content modes on purpose. `Simple` is what SESv2 wants for an ordinary
 * text+html mail, but it cannot carry a part, so a message with an inline
 * image has to be handed over as raw MIME instead. Which one a message needs
 * is decided here, from the message itself, rather than by the caller knowing
 * which mail happens to have a logo in it.
 */
import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import { err } from "../errors.js";
import { buildMimeMessage } from "./mime.js";

export function createSesTransport({ region, configurationSet, client: injectedClient } = {}) {
  const client = injectedClient || new SESv2Client({ region: region || process.env.AWS_REGION });
  // Spread into every command so bounces and complaints reach the
  // configuration set's destination. ABSENT, not empty, when unconfigured:
  // SES rejects a send that names a set which does not exist, so an empty
  // string here would take all mail down rather than merely lose the events.
  const configSet = configurationSet ? { ConfigurationSetName: configurationSet } : {};

  return {
    id: "ses",
    async send({ to, from, subject, text, html, inline = [] }) {
      const Content = inline.length
        ? { Raw: { Data: Buffer.from(buildMimeMessage({ to, from, subject, text, html, inline }), "utf8") } }
        : { Simple: { Subject: { Data: subject }, Body: { Text: { Data: text }, Html: { Data: html } } } };
      try {
        await client.send(
          new SendEmailCommand({
            ...configSet,
            // Named on the request even when the raw message carries the same
            // headers: these are the ENVELOPE, which is what SES checks the
            // sending identity against and what bounces return to.
            FromEmailAddress: from,
            Destination: { ToAddresses: [to] },
            Content,
          })
        );
      } catch (e) {
        // Far and away the commonest failure, and the one whose default
        // message explains nothing: an account still in the SES sandbox
        // rejects every recipient it has not been shown.
        if (e.name === "MessageRejected" && /not verified/i.test(e.message)) {
          throw err(
            502,
            "email_not_verified",
            "Recipient not verified — SES sandbox requires verifying this address (check inbox for the AWS verification email) or requesting production access."
          );
        }
        throw e;
      }
    },
  };
}
