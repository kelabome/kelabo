import { Stack, CfnOutput } from "aws-cdk-lib";
import * as ses from "aws-cdk-lib/aws-ses";
import * as sns from "aws-cdk-lib/aws-sns";
import * as route53 from "aws-cdk-lib/aws-route53";

export class SesStack extends Stack {
  constructor(scope, id, props) {
    super(scope, id, props);
    const { cfg, zone } = props;

    // NOTE: SES starts in sandbox mode. Prod requires a sandbox-exit
    // (production access) request in the AWS console before OTP email flows.
    // The verified identity is the from-address domain; when it differs from
    // the env zone (e.g. dev sends from the apex domain), cfg.ses.hostedZone
    // points at the zone that owns it.
    const sesZone = cfg.ses.hostedZone
      ? route53.HostedZone.fromHostedZoneAttributes(this, "SesZone", {
          hostedZoneId: cfg.ses.hostedZone.id,
          zoneName: cfg.ses.hostedZone.name,
        })
      : zone;

    this.identity = new ses.EmailIdentity(this, "DomainIdentity", {
      identity: ses.Identity.publicHostedZone(sesZone),
      // Custom MAIL FROM (cfg.ses.mailFrom, derived in loadConfig): the
      // envelope sender becomes this subdomain instead of amazonses.com, so
      // SPF authenticates our own mail and aligns for DMARC. The CDK construct
      // publishes the two records the subdomain needs — the MX pointing at
      // feedback-smtp.<region>.amazonses.com and its own SPF TXT — because the
      // identity above is built from the hosted zone. Bounce handling is
      // unchanged: the MX keeps routing async bounces back into SES, which is
      // why USE_DEFAULT_VALUE (fall back to amazonses.com if the MX ever
      // disappears) is the right failure mode for transactional mail —
      // REJECT_MESSAGE would stop sending outright over a DNS mistake.
      ...(cfg.ses.mailFrom
        ? {
            mailFromDomain: cfg.ses.mailFrom,
            mailFromBehaviorOnMxFailure: ses.MailFromBehaviorOnMxFailure.USE_DEFAULT_VALUE,
          }
        : {}),
    });

    // DMARC tells a receiving mailbox what to do when a message claiming this
    // domain authenticates as neither SPF-aligned nor DKIM-aligned. Easy DKIM
    // above already signs every message with the domain, so the alignment that
    // makes DMARC pass is in place — publishing the policy is what lets a
    // recipient act on it, and its absence is one of the first things a
    // deliverability review looks for.
    //
    // `p=none` monitors without asking anyone to reject, which is the only safe
    // opening position: a stricter policy on a domain whose other senders are
    // not yet inventoried quarantines that domain's own legitimate mail.
    // SPF at the apex. This does not authenticate our own mail — SES's default
    // envelope sender is amazonses.com, so that is the domain an SPF check
    // actually reads — but it denies the domain to anyone else's envelope, and
    // its absence is conspicuous to a reviewer.
    if (cfg.ses.spf) {
      new route53.TxtRecord(this, "SpfRecord", {
        zone: sesZone,
        values: [cfg.ses.spf],
      });
      new CfnOutput(this, "SesSpf", { value: cfg.ses.spf });
    }

    // `sp` is stated even when it equals `p`, because inheritance is the part
    // people get wrong: a domain that later moves to `p=reject` silently moves
    // every subdomain with it, and `mail.<domain>` (the custom MAIL FROM
    // subdomain above) is one. Naming it makes the decision deliberate.
    //
    // `adkim=s` (strict DKIM alignment) is safe here and sharpens the reports:
    // Easy DKIM signs with `d=<identity domain>`, which is exactly the From
    // domain, so strict already passes. `aspf` stays relaxed by necessity —
    // the envelope sender is the `mail.` subdomain, which strict would fail.
    if (cfg.ses.dmarc) {
      const parts = [`v=DMARC1`, `p=${cfg.ses.dmarc.policy}`];
      if (cfg.ses.dmarc.subdomainPolicy) parts.push(`sp=${cfg.ses.dmarc.subdomainPolicy}`);
      if (cfg.ses.dmarc.adkim) parts.push(`adkim=${cfg.ses.dmarc.adkim}`);
      if (cfg.ses.dmarc.aspf) parts.push(`aspf=${cfg.ses.dmarc.aspf}`);
      if (cfg.ses.dmarc.rua) parts.push(`rua=${cfg.ses.dmarc.rua}`);
      new route53.TxtRecord(this, "DmarcRecord", {
        zone: sesZone,
        recordName: "_dmarc",
        values: [`${parts.join("; ")};`],
      });
      new CfnOutput(this, "SesDmarcPolicy", { value: `${parts.join("; ")};` });
    }

    // Bounce/complaint visibility. Without this the account suppression list
    // stops mailing a bounced address silently: the person keeps asking for a
    // sign-in code, we keep reporting a successful send, and nobody can tell
    // why they can no longer get in. The events go to SNS so something can act
    // on them; subscribing is left to the deployment, since where an operator
    // wants to be told is not ours to decide.
    //
    // The Lambda names this set on every send, and SES rejects a send naming a
    // set that does not exist — so this stack must exist before the Lambda
    // references it. It does: `infra/bin/kelabo.js` builds SES before Lambda.
    if (cfg.ses.events) {
      const topic = new sns.Topic(this, "MailEventsTopic", {
        topicName: `kelabo-${cfg.endpoint}-mail-events`,
        displayName: `Kelabo ${cfg.endpoint} mail events`,
      });
      // REQUIRE, not the SES default of OPTIONAL. Every message on this path is
      // a sign-in code or a meeting invitation, so OPTIONAL means a receiving
      // server that declines STARTTLS gets a one-time passcode in cleartext and
      // nothing anywhere records that it happened. REQUIRE bounces instead,
      // which is loud, and the bounce lands on the SNS topic below. The
      // deliverability cost is negligible — a mail server without STARTTLS is
      // an artefact at this point — and a bounce we can see beats a passcode we
      // cannot un-send.
      const configurationSet = new ses.ConfigurationSet(this, "ConfigurationSet", {
        configurationSetName: cfg.ses.configurationSetName,
        tlsPolicy: ses.ConfigurationSetTlsPolicy.REQUIRE,
      });
      new ses.ConfigurationSetEventDestination(this, "MailEventsToSns", {
        configurationSet,
        destination: ses.EventDestination.snsTopic(topic),
        // Delivery is included so a working address can be told apart from a
        // silent failure; opens and clicks are deliberately not, since this is
        // transactional mail and tracking pixels are neither wanted nor honest.
        events: [
          ses.EmailSendingEvent.BOUNCE,
          ses.EmailSendingEvent.COMPLAINT,
          ses.EmailSendingEvent.REJECT,
          ses.EmailSendingEvent.DELIVERY_DELAY,
          ses.EmailSendingEvent.DELIVERY,
        ],
      });
      new CfnOutput(this, "SesConfigurationSet", { value: cfg.ses.configurationSetName });
      new CfnOutput(this, "SesMailEventsTopicArn", { value: topic.topicArn });
    }

    new CfnOutput(this, "SesIdentityDomain", { value: sesZone.zoneName });
    new CfnOutput(this, "SesFromAddress", { value: cfg.ses.fromAddress });
    if (cfg.ses.mailFrom) {
      new CfnOutput(this, "SesMailFromDomain", { value: cfg.ses.mailFrom });
    }
  }
}
