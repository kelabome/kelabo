import { Stack, Duration, CfnOutput, RemovalPolicy } from "aws-cdk-lib";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { NodejsFunction, OutputFormat } from "aws-cdk-lib/aws-lambda-nodejs";
import * as iam from "aws-cdk-lib/aws-iam";
import * as logs from "aws-cdk-lib/aws-logs";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
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
        KELABO_TABLE_JOURNEYS: names.journeys,
        KELABO_ARCHIVE_BUCKET: cfg.archiveBucket,
        KELABO_ARCHIVE_KEY_PREFIX: cfg.archiveKeyPrefix,
        KELABO_SECRET_STT: cfg.secrets.stt,
        // Existence-probed only (capability map, docs 19 §3) — the API never
        // reads these values; see the DescribeSecret-only policy below.
        KELABO_SECRET_LLM: cfg.secrets.llm,
        KELABO_SECRET_CLOUDFLARE_RTC: cfg.secrets.cloudflareRealtime,
        KELABO_SECRET_COOKIE_KEY: cfg.secrets.cookieSigningKey,
        KELABO_SECRET_OIDC_GOOGLE: cfg.secrets.oidcGoogle,
        KELABO_SECRET_OIDC_APPLE: cfg.secrets.oidcApple,
        KELABO_SECRET_MCP_PREFIX: cfg.secrets.mcpPrefix,
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
        KELABO_MAIL_PROVIDER: cfg.mail.provider,
        KELABO_MAIL_FROM_ADDRESS: cfg.mail.fromAddress,
        // Only read when the provider needs a key. SES does not — it
        // authenticates with this function's own role — so an SES deployment
        // never touches it and the secret need not exist.
        KELABO_SECRET_MAIL: cfg.secrets.mail,
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

    // Host-managed MCP tokens: the API creates/updates/deletes secrets under
    // kelabo/<env>/mcp/<identity>/<server> on behalf of the signed-in user.
    this.fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          "secretsmanager:CreateSecret",
          "secretsmanager:PutSecretValue",
          "secretsmanager:GetSecretValue",
          "secretsmanager:DeleteSecret",
          "secretsmanager:DescribeSecret",
        ],
        resources: [`arn:aws:secretsmanager:${cfg.region}:${cfg.account}:secret:${cfg.secrets.mcpPrefix}*`],
      }),
    );

    // Only what this deployment's mail provider actually needs. SES gets an
    // identity-independent send permission fenced by the from-address; every
    // other provider gets nothing here and reads its API key below instead.
    // Granting both would leave a function that can still send from the SES
    // identity long after the deployment stopped meaning to.
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
      Stt: cfg.secrets.stt,
      CookieKey: cfg.secrets.cookieSigningKey,
      OidcGoogle: cfg.secrets.oidcGoogle,
      OidcApple: cfg.secrets.oidcApple,
      // Read, not describe: the Lambda compares the presented header against
      // this value on every request that reaches a cold container.
      ApiOrigin: cfg.secrets.apiOrigin,
      ...(cfg.mail.provider === "ses" ? {} : { Mail: cfg.secrets.mail }),
    })) {
      secretsmanager.Secret.fromSecretNameV2(this, `Secret${id}`, secretName).grantRead(this.fn);
    }

    // The capability map (docs 19 §3) answers "is the assistant / conference
    // audio configured at all?" from secret EXISTENCE. Describe-only on
    // purpose: the API can state that the LLM key exists without being able
    // to read it — those values stay gateway-owned.
    this.fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["secretsmanager:DescribeSecret"],
        resources: [
          `arn:aws:secretsmanager:${cfg.region}:${cfg.account}:secret:${cfg.secrets.llm}*`,
          `arn:aws:secretsmanager:${cfg.region}:${cfg.account}:secret:${cfg.secrets.cloudflareRealtime}*`,
        ],
      }),
    );

    new CfnOutput(this, "RestApiFnName", { value: this.fn.functionName });
    new CfnOutput(this, "RestApiFnArn", { value: this.fn.functionArn });
  }
}
