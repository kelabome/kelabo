import { Stack, Duration, CfnOutput, RemovalPolicy } from "aws-cdk-lib";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { NodejsFunction, OutputFormat } from "aws-cdk-lib/aws-lambda-nodejs";
import * as iam from "aws-cdk-lib/aws-iam";
import * as logs from "aws-cdk-lib/aws-logs";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import { CREDENTIAL_STATUS_ATTRS } from "@kelabo/contracts/credentials";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { logRetention } from "./log-retention.js";

const here = dirname(fileURLToPath(import.meta.url));

export class LambdaStack extends Stack {
  constructor(scope, id, props) {
    super(scope, id, props);
    const { cfg, tables, archiveBucket } = props;
    const names = cfg.tableNames;

    // Declared rather than left to Lambda, which creates the group on first
    // invocation with **no expiry**. These logs name the identity performing
    // each action — an email address for a signed-in person — so an unset
    // retention is an unbounded record of who used the service and when,
    // outliving the kelabos it describes by any margin.
    //
    // **Deliberately not `/aws/lambda/<function>`.** That is where Lambda puts
    // logs by itself, so on any environment that has ever served a request the
    // group already exists and is not owned by CloudFormation — and declaring
    // it fails the whole changeset with `already exists`, before anything is
    // deployed. A change made for hygiene must not break every existing
    // deployment's next deploy, so it takes a name of ours instead.
    //
    // Consequence worth knowing: after this ships, the old `/aws/lambda/…`
    // group stops receiving anything, because the function's logging config
    // points here. It keeps whatever it already had and can be deleted whenever
    // convenient — there is no race, because Lambda only auto-creates the group
    // it is configured to use.
    //
    // `RETAIN` on destroy: losing the stack must not also lose the log of what
    // happened to it, which is exactly when it is wanted.
    const logGroup = new logs.LogGroup(this, "RestApiLogs", {
      logGroupName: `/${cfg.app}/${cfg.endpoint}/rest-api`,
      retention: logRetention(cfg.logRetentionDays),
      removalPolicy: RemovalPolicy.RETAIN,
    });

    this.fn = new NodejsFunction(this, "RestApiFn", {
      logGroup,
      functionName: `${cfg.app}-${cfg.endpoint}-rest-api`,
      entry: join(here, "../../rest-api/src/index.js"),
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_20_X,
      memorySize: 512,
      timeout: Duration.seconds(30),
      projectRoot: join(here, "../.."),
      depsLockFilePath: join(here, "../../package-lock.json"),
      bundling: {
        forceDockerBundling: false,
        minify: true,
        sourceMap: false,
        // The rest-api and config/loadConfig.mjs are ESM and use import.meta.url;
        // bundle to ESM so import.meta resolves (default cjs leaves it empty).
        format: OutputFormat.ESM,
      },
      environment: {
        KELABO_ENV: cfg.endpoint,
        KELABO_REGION: cfg.region,
        KELABO_PORTAL_URL: cfg.portalUrl,
        KELABO_API_BASE_URL: cfg.apiBaseUrl,
        KELABO_GATEWAY_BASE_URL: cfg.gatewayBaseUrl,
        KELABO_COOKIE_DOMAIN: cfg.cookieDomain,
        KELABO_ALLOWED_EMAIL_DOMAIN: cfg.allowedEmailDomain,
        KELABO_TABLE_KELABOS: names.kelabos,
        KELABO_TABLE_HISTORY: names.history,
        KELABO_TABLE_USERS: names.users,
        KELABO_TABLE_OTP: names.otp,
        KELABO_TABLE_REFRESH: names.refresh,
        KELABO_TABLE_MCP: names.mcp,
        KELABO_TABLE_CONTACTS: names.contacts,
        // Supplier credentials. Each key used to arrive here as its own secret
        // NAME; they are now rows in this table, addressed by slot, so one
        // table name replaces the lot — and adding a supplier (mail was the
        // most recent) is no longer a change to this stack.
        KELABO_TABLE_CREDENTIALS: names.credentials,
        KELABO_TABLE_JOURNEYS: names.journeys,
        KELABO_ARCHIVE_BUCKET: cfg.archiveBucket,
        KELABO_ARCHIVE_KEY_PREFIX: cfg.archiveKeyPrefix,
        KELABO_SECRET_COOKIE_KEY: cfg.secrets.cookieSigningKey,
        KELABO_SECRET_OIDC_GOOGLE: cfg.secrets.oidcGoogle,
        KELABO_SECRET_OIDC_APPLE: cfg.secrets.oidcApple,
        // The shared secret CloudFront sends, and whether to insist on it.
        // Only the NAME travels here; the value is read at runtime.
        // Empty unless the env made a configuration set. Naming one that does
        // not exist makes SES reject every send, so this is derived, never typed.
        KELABO_SES_CONFIG_SET: cfg.ses.configurationSetName,
        KELABO_SECRET_API_ORIGIN: cfg.secrets.apiOrigin,
        KELABO_REQUIRE_ORIGIN_SECRET: cfg.api.requireOriginSecret ? "true" : "false",
        // Which transport in rest-api/src/mail/ carries outbound mail, and the
        // address it sends from. `fromAddress` is provider-neutral; the
        // KELABO_SES_* pair below configures the SES transport specifically.
        // No mail secret name travels with them: the key is the `mail`
        // credential slot, like every other supplier's.
        KELABO_MAIL_PROVIDER: cfg.mail.provider,
        KELABO_MAIL_FROM_ADDRESS: cfg.mail.fromAddress,
        // Usually this stack's own region. It differs only when a deployment
        // moved an environment's mail to another region to give it its own
        // sandbox status and reputation, so the SES client cannot just take
        // AWS_REGION from the Lambda it happens to run in.
        KELABO_SES_REGION: cfg.ses.region,
        KELABO_SOCIAL_PROVIDERS: (cfg.auth?.socialProviders ?? []).join(","),
        KELABO_SESSION_TTL_SECONDS: String(cfg.auth.sessionTtlSeconds),
        KELABO_REFRESH_TTL_DAYS: String(cfg.auth.refreshTtlDays),
        KELABO_PARTICIPANT_TTL_SECONDS: String(cfg.auth.participantTtlSeconds),
        KELABO_OTP_TTL_SECONDS: String(cfg.otp.ttlSeconds),
        KELABO_OTP_MAX_ATTEMPTS: String(cfg.otp.maxAttempts),
        KELABO_OTP_RESEND_SECONDS: String(cfg.otp.resendSeconds),
        KELABO_OTP_PER_EMAIL_WINDOW_SECONDS: String(cfg.otp.perEmailWindowSeconds),
        KELABO_OTP_PER_EMAIL_MAX_REQUESTS: String(cfg.otp.perEmailMaxRequests),
        KELABO_OTP_PER_IP_WINDOW_SECONDS: String(cfg.otp.perIpWindowSeconds),
        KELABO_OTP_PER_IP_MAX_REQUESTS: String(cfg.otp.perIpMaxRequests),
        KELABO_JOIN_CODE_TTL_SECONDS: String(cfg.joinCode.ttlSeconds),
        KELABO_JOIN_CODE_MINT_PER_KELABO_PER_HOUR: String(cfg.joinCode.mintPerKelaboPerHour),
        KELABO_JOIN_CODE_REDEEM_PER_IP_WINDOW_SECONDS: String(cfg.joinCode.redeemPerIpWindowSeconds),
        KELABO_JOIN_CODE_REDEEM_PER_IP_MAX_REQUESTS: String(cfg.joinCode.redeemPerIpMaxRequests),
        KELABO_STT_PROVIDER: cfg.stt.provider,
        KELABO_STT_LANGUAGE: cfg.stt.language,
        // One var, not one per provider per setting: the keys inside belong to
        // the providers, so naming them here would mean adding a provider edits
        // this stack and rolls every deployed task definition.
        KELABO_STT_PROVIDERS: JSON.stringify(cfg.stt.providers || {}),
        // The control plane only stamps a new kelabo's transport and reports it
        // back; it holds no Cloudflare credentials and does no signalling.
        KELABO_RTC_DEFAULT_MODE: cfg.rtc.defaultMode,
        KELABO_RTC_MESH_MAX: String(cfg.rtc.meshMaxParticipants),
        KELABO_RTC_VIDEO: String(cfg.rtc.video),
        KELABO_CONTACTS_EXTERNAL: String(cfg.contacts.external),
        KELABO_RETENTION_DAYS: String(cfg.retentionDays),
      },
    });

    tables.kelabos.grantReadWriteData(this.fn);
    tables.users.grantReadWriteData(this.fn);
    tables.otp.grantReadWriteData(this.fn);
    tables.refresh.grantReadWriteData(this.fn);
    tables.history.grantReadData(this.fn);
    tables.mcp.grantReadWriteData(this.fn);
    tables.contacts.grantReadWriteData(this.fn);
    // Supplier credentials, in two statements, because this component's
    // relationship with the four slots is not one relationship.
    //
    // ## What broke, and what these two statements put back
    //
    // Under Secrets Manager this role held `secretsmanager:DescribeSecret` on
    // the supplier secrets and *never* `GetSecretValue`. That asymmetry was
    // load-bearing: it let the control plane answer "is the assistant
    // configured at all?" for the capability map (docs 19 §3) while being
    // structurally unable to read the LLM key — which is the decisive reason
    // journey report synthesis runs in the Gateway and not here (docs 20 §6.1,
    // `gateway/src/journeys.js`). The move to DynamoDB lost it silently,
    // because "does the item exist" and "what is in it" are the same `GetItem`,
    // and a single `CRED#*` statement therefore handed this role the LLM key.
    //
    // `dynamodb:Attributes` + `dynamodb:Select` is the DynamoDB equivalent of
    // the split. An `Attributes`-scoped `GetItem` is `DescribeSecret`; an
    // unscoped one is `GetSecretValue`; IAM can grant the first without the
    // second. It only works because there is a **non-secret attribute that
    // answers the question** — `configured`, written beside the value by
    // `credentialItem` — since a projection that had to include `value` to
    // learn anything would be no projection at all.
    //
    // ## Rules that survive from the single statement this replaces
    //
    //   - **No `Scan`.** Four `GetItem`s by known key is the whole access
    //     pattern. A `Scan` is the one call that returns every credential in
    //     the deployment in a single response, which is exactly the shape of
    //     the accident this design exists to prevent. (It would also bypass the
    //     attribute fence: `dynamodb:Attributes` restricts the attributes a
    //     request *names*, so a call that names none is unrestricted.)
    //   - **No `DeleteItem`.** A credential is replaced, never removed.
    //   - **No `PutItem` any more, either.** Master has no credential-write
    //     route: nothing under `rest-api/src/` calls `credentials.put()`. The
    //     operator scripts that do (`rest-api/scripts/put-credential.mjs`,
    //     `migrate-credentials.mjs`) run on a laptop under the operator's own
    //     AWS credentials, not under this role. A `PutItem` here would be a
    //     permission with no caller — and `PutItem` replaces the whole item, so
    //     holding it would let this role overwrite `CRED#llm` with a key of its
    //     choosing, which is a different way of ending up in possession of the
    //     one it is not allowed to read.
    //
    // **The private SaaS branch will widen this, and that split is deliberate.**
    // It has a root-only credential reveal console, so its Lambda genuinely
    // needs whole-item reads and a write path, and it will add them on its own
    // side. Master does not have that console, so master does not carry the
    // grant for it: the open-core deployment's control plane cannot read the
    // LLM key, full stop, and that is the property four documents describe.

    // 1. The two slots whose VALUES this component legitimately uses: `stt`
    //    (minting a short-lived browser transcription credential,
    //    `rest-api/src/stt/`) and `mail` (the outbound transport's API token,
    //    `rest-api/src/mail/`). Both are read whole, by name, and no attribute
    //    condition applies — reading the key *is* the job.
    this.fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["dynamodb:GetItem"],
        resources: [tables.credentials.tableArn],
        conditions: {
          "ForAllValues:StringEquals": { "dynamodb:LeadingKeys": ["CRED#stt", "CRED#mail"] },
        },
      }),
    );

    // 2. The two slots this component may only ask *about*. `llm` is the
    //    assistant's key (gateway-owned, docs 20 §6.1) and `rtc` is the
    //    Cloudflare Realtime app credential (gateway-owned, docs 15) — this
    //    role needs neither value and needs both answers, for the capability
    //    map. `rest-api/src/db.js` `getCredentialStatus` sends exactly the
    //    matching `ProjectionExpression`; both sides are built from the same
    //    frozen list so they cannot drift.
    //
    //    `StringEquals` rather than `StringEqualsIfExists` on `Select`, and the
    //    difference matters: `IfExists` is what AWS's own example uses because
    //    it mixes read and write actions, and a write has no `Select`. This
    //    statement grants `GetItem` alone, where `Select` always has a value
    //    (`ALL_ATTRIBUTES` unless a projection says otherwise) — so the plain
    //    form is both correct and the strict one. It closes the hole that makes
    //    `Attributes` alone useless: a `GetItem` naming no attributes returns
    //    the whole item and satisfies `ForAllValues` vacuously.
    //
    //    `CREDENTIAL_STATUS_ATTRS` includes `PK`/`SK` because DynamoDB requires
    //    an `Attributes` condition to name a table's key attributes — the
    //    request's `Key` counts as attributes accessed — and omitting them
    //    denies the call outright rather than narrowing it.
    this.fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["dynamodb:GetItem"],
        resources: [tables.credentials.tableArn],
        conditions: {
          "ForAllValues:StringEquals": {
            "dynamodb:LeadingKeys": ["CRED#llm", "CRED#rtc"],
            "dynamodb:Attributes": [...CREDENTIAL_STATUS_ATTRS],
          },
          StringEquals: { "dynamodb:Select": "SPECIFIC_ATTRIBUTES" },
        },
      }),
    );

    // The table's customer-managed key: decrypt only. This component no longer
    // writes a credential (see above), and an encrypt grant it cannot use is
    // the same kind of leftover the `CRED#*` statement was.
    tables.credentials.encryptionKey?.grantDecrypt(this.fn);
    tables.journeys.grantReadWriteData(this.fn);
    archiveBucket.grantRead(this.fn);

    // Retention purge (POST /records/purge). Deliberately DeleteItem/DeleteObject
    // only, on top of the read grants above — the API still cannot write history
    // rows or archive objects, which remain gateway-owned.
    this.fn.addToRolePolicy(
      new iam.PolicyStatement({ actions: ["dynamodb:DeleteItem"], resources: [tables.history.tableArn] }),
    );
    this.fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["s3:DeleteObject"],
        resources: [archiveBucket.arnForObjects("*")],
      }),
    );

    // Host-managed MCP bearer tokens used to be one Secrets Manager secret per
    // user per server, at kelabo/<env>/mcp/<identity>/<server>. They are now
    // `SECRET#<server>` rows in the mcp table, beside the `TOKEN#<server>` rows
    // that already held the OAuth access and refresh tokens for the same
    // servers under the same customer-managed key — so the grant they need is
    // the `tables.mcp.grantReadWriteData` above, and this statement is gone.
    //
    // Two things followed from the old shape and are worth recording: the two
    // halves of "authenticate to an MCP server" lived in two different stores,
    // and the Secrets Manager half was the only thing in this system that
    // scaled with users × servers rather than with environments.

    // Only what this deployment's mail provider actually needs. SES gets an
    // identity-independent send permission fenced by the from-address; every
    // other provider gets nothing here and reads its API key from the `mail`
    // credential slot instead. Granting both would leave a function that can
    // still send from the SES identity long after the deployment stopped
    // meaning to.
    if (cfg.mail.provider === "ses") {
      this.fn.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ["ses:SendEmail", "ses:SendRawEmail"],
          resources: ["*"],
          conditions: { StringEquals: { "ses:FromAddress": cfg.mail.fromAddress } },
        }),
      );
    }

    for (const [id, secretName] of Object.entries({
      CookieKey: cfg.secrets.cookieSigningKey,
      OidcGoogle: cfg.secrets.oidcGoogle,
      OidcApple: cfg.secrets.oidcApple,
      // Read, not describe: the Lambda compares the presented header against
      // this value on every request that reaches a cold container.
      ApiOrigin: cfg.secrets.apiOrigin,
      // No mail entry, and no STT one. Both used to name a Secrets Manager
      // secret; they are the `mail` and `stt` credential slots now, covered by
      // the first of the two credentials-table statements above — the one that
      // grants whole-item reads, because those two are the slots whose values
      // this component actually uses.
    })) {
      secretsmanager.Secret.fromSecretNameV2(this, `Secret${id}`, secretName).grantRead(this.fn);
    }

    // The supplier slots — llm, stt, rtc, mail — needed five Secrets Manager
    // statements between them: read to use a key, describe to answer "is this
    // configured at all?" for the capability map (docs 19 §3), all by prefix so
    // that pointing a deployment at a second account did not need a deploy.
    //
    // All five are gone. The credentials table replaces them, and the
    // properties they were buying survive in a different form: a rotation is a
    // PutItem (by an operator, not by this role), "is it configured?" is a
    // `configured` marker read through an attribute-scoped GetItem, and the
    // second-account case never needed a new *address* at all — it needed a new
    // *value*.
    //
    // The read/describe split is the one that needed rebuilding by hand rather
    // than surviving the move: see the two statements above. It was briefly
    // lost, between the migration to this table and the pair of statements that
    // replaced the single `CRED#*` one.

    new CfnOutput(this, "RestApiFnName", { value: this.fn.functionName });
    new CfnOutput(this, "RestApiFnArn", { value: this.fn.functionArn });
  }
}
