import { Stack, CfnOutput, RemovalPolicy } from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as iam from "aws-cdk-lib/aws-iam";
import * as logs from "aws-cdk-lib/aws-logs";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as targets from "aws-cdk-lib/aws-route53-targets";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import { ApplicationLoadBalancedFargateService } from "aws-cdk-lib/aws-ecs-patterns";
import { execSync } from "node:child_process";
import { logRetention } from "./log-retention.js";

function credentialsAccount() {
  try {
    return execSync("aws sts get-caller-identity --query Account --output text", {
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 8000,
    })
      .toString()
      .trim();
  } catch {
    return undefined;
  }
}

export class GatewayEcsStack extends Stack {
  constructor(scope, id, props) {
    super(scope, id, props);
    const { cfg, zone, certificate, tables, archiveBucket } = props;
    const names = cfg.tableNames;

    let vpc;
    let vpcMode;
    const forced = this.node.tryGetContext("vpcMode");
    const credAccount = credentialsAccount();
    if (forced === "new" || credAccount !== cfg.account) {
      vpcMode = `fallback-synth-only-vpc (credential account ${credAccount ?? "none"} != config account ${cfg.account})`;
      vpc = ec2.Vpc.fromVpcAttributes(this, "Vpc", {
        vpcId: "vpc-00000000000000000",
        availabilityZones: [`${cfg.region}a`, `${cfg.region}b`],
        publicSubnetIds: ["subnet-00000000000000000", "subnet-00000000000000001"],
      });
    } else {
      try {
        vpcMode = "default-vpc-lookup";
        vpc = ec2.Vpc.fromLookup(this, "Vpc", { isDefault: true });
      } catch (err) {
        vpcMode = "fallback-synth-only-vpc (lookup failed)";
        vpc = ec2.Vpc.fromVpcAttributes(this, "Vpc", {
          vpcId: "vpc-00000000000000000",
          availabilityZones: [`${cfg.region}a`, `${cfg.region}b`],
          publicSubnetIds: ["subnet-00000000000000000", "subnet-00000000000000001"],
        });
      }
    }
    console.log(`[GatewayEcsStack] VPC source: ${vpcMode}`);

    this.repo = ecr.Repository.fromRepositoryName(this, "GatewayRepo", cfg.ecrRepoName);

    const cluster = new ecs.Cluster(this, "Cluster", {
      vpc,
      clusterName: `${cfg.app}-${cfg.endpoint}`,
    });

    // Same reason as the Lambda's: the pattern would otherwise create this group
    // with a generated name and no expiry. The Gateway logs every join, caption
    // append and agent attach, each carrying the participant's identity, so
    // leaving it unset keeps a permanent index of who was in which room.
    //
    // Named to match the Lambda's, so both halves of the service are in one
    // place under `/kelabo/<env>/` rather than one under `/aws/lambda` and one
    // under a random construct id. The pattern's own generated group is
    // abandoned by this change and can be deleted once nothing needs its
    // history.
    const logGroup = new logs.LogGroup(this, "GatewayLogs", {
      logGroupName: `/${cfg.app}/${cfg.endpoint}/gateway`,
      retention: logRetention(cfg.logRetentionDays),
      removalPolicy: RemovalPolicy.RETAIN,
    });

    this.service = new ApplicationLoadBalancedFargateService(this, "GatewayService", {
      cluster,
      serviceName: `${cfg.app}-${cfg.endpoint}-gateway`,
      cpu: cfg.gateway.cpu,
      memoryLimitMiB: cfg.gateway.memoryMiB,
      // Graviton when the config says so — the image must be built for the
      // same architecture (scripts/build-push-gateway.sh reads the same knob).
      runtimePlatform: {
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
        cpuArchitecture:
          cfg.gateway.arch === "arm64" ? ecs.CpuArchitecture.ARM64 : ecs.CpuArchitecture.X86_64,
      },
      desiredCount: cfg.gateway.desiredCount,
      taskSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      assignPublicIp: true,
      publicLoadBalancer: true,
      certificate,
      redirectHTTP: true,
      // Always 0.0.0.0/0 at layer 4. `allowIps` is enforced one layer up, in
      // listener rules, because it has to admit one caller that has no address
      // to allow: the control plane. See the block below.
      openListener: true,
      circuitBreaker: { rollback: true },
      taskImageOptions: {
        image: ecs.ContainerImage.fromEcrRepository(this.repo, cfg.gateway.imageTag),
        containerPort: 8080,
        logDriver: ecs.LogDrivers.awsLogs({ streamPrefix: "gateway", logGroup }),
        environment: {
          KELABO_ENV: cfg.endpoint,
          KELABO_REGION: cfg.region,
          KELABO_PORTAL_URL: cfg.portalUrl,
          KELABO_GATEWAY_BASE_URL: cfg.gatewayBaseUrl,
          KELABO_COOKIE_DOMAIN: cfg.cookieDomain,
          KELABO_TENANT_ID: cfg.allowedEmailDomain,
          KELABO_TABLE_KELABOS: names.kelabos,
          KELABO_TABLE_HISTORY: names.history,
          KELABO_TABLE_MCP: names.mcp,
          // Agent bridge tokens are revocable rows in the refresh table
          // (docs 16); the Gateway reads one per tunnel connection.
          KELABO_TABLE_REFRESH: names.refresh,
          // Read-only: the Gateway reads a subscriber's accepted external peers
          // to scope presence fan-out (docs 18 §5). It must never mutate a link.
          KELABO_TABLE_CONTACTS: names.contacts,
          KELABO_CONTACTS_EXTERNAL: String(cfg.contacts.external),
          // Read: journey context for a report. Write: the report result and
          // (docs 20 §10) the contributor rollup counters — the only table
          // besides its own kelabos/history the Gateway needs read+write on.
          KELABO_TABLE_JOURNEYS: names.journeys,
          KELABO_ARCHIVE_BUCKET: cfg.archiveBucket,
          KELABO_ARCHIVE_KEY_PREFIX: cfg.archiveKeyPrefix,
          KELABO_SECRET_COOKIE_KEY: cfg.secrets.cookieSigningKey,
          KELABO_SECRET_LLM: cfg.secrets.llm,
          KELABO_SECRET_MCP_PREFIX: cfg.secrets.mcpPrefix,
          KELABO_SECRET_CLOUDFLARE_RTC: cfg.secrets.cloudflareRealtime,
          KELABO_RTC_API_BASE: cfg.rtcApiBase,
          KELABO_RTC_DEFAULT_MODE: cfg.rtc.defaultMode,
          KELABO_RTC_MESH_MAX: String(cfg.rtc.meshMaxParticipants),
          KELABO_RTC_ICE_TTL: String(cfg.rtc.iceTtlSeconds),
          KELABO_RTC_DISCONNECT_GRACE: String(cfg.rtc.disconnectGraceSeconds),
          KELABO_RTC_VIDEO: String(cfg.rtc.video),
          KELABO_LLM_PROVIDER: cfg.llm.provider,
          KELABO_LLM_MODEL: cfg.llm.model,
          KELABO_LLM_SMALL_MODEL: cfg.llm.smallModel,
          ...(cfg.llm.baseUrl ? { KELABO_OPENAI_BASE_URL: cfg.llm.baseUrl } : {}),
          // (No STT settings here. The gateway never speaks to a transcription
          // provider — it only ever sees text captions — and the two vars that
          // used to be set were read by nothing.)
          KELABO_RETENTION_DAYS: String(cfg.retentionDays),
          KELABO_AGENT_MAX_CONCURRENT_RUNS: String(cfg.gateway.agent.maxConcurrentRuns),
          KELABO_AGENT_MAX_DISPATCH_PER_TURN: String(cfg.gateway.agent.maxDispatchPerTurn ?? 3),
          KELABO_AGENT_SENSITIVITY: cfg.gateway.agent.sensitivity,
          KELABO_AGENT_MAX_CONTRIB_PER_MIN: String(cfg.gateway.agent.maxContributionsPerMinute),
          KELABO_AGENT_COOLDOWN_SECONDS: String(cfg.gateway.agent.cooldownSeconds),
          KELABO_AGENT_ROLLING_WINDOW: String(cfg.gateway.agent.rollingWindowSize),
        },
      },
    });

    this.service.targetGroup.configureHealthCheck({ path: "/health" });
    this.service.loadBalancer.setAttribute("idle_timeout.timeout_seconds", "240");

    // `allowIps` — the Gateway's half of it (the portal's is a WAF WebACL, see
    // waf-stack.js).
    //
    // This used to be a security group, which is the stronger mechanism and
    // costs nothing — and which silently broke the product. `/internal/*` is
    // the REST API calling the Gateway server to server: ending a kelabo
    // (archive + record + minutes), ringing a contact, cancelling a scheduled
    // one. The Lambda is not in the VPC, so it arrives over the public internet
    // from an AWS-owned address that changes per invocation and cannot be
    // allowlisted. A closed security group therefore dropped every one of those
    // calls at layer 4, and `rest-api` logged a warning and carried on: kelabos
    // ended with no record, no minutes and no error. Nothing else was affected,
    // because the browser's own traffic comes from an allowlisted address —
    // which is exactly why it survived so long.
    //
    // Listener rules instead, because they can make the one exemption a
    // security group cannot express: a path. `/internal/*` is already
    // authenticated by the internal JWT, which is signed with the cookie key
    // and carries its own `aud` (INTERNAL_JWT_AUD) — filtering it by source
    // address as well bought nothing and cost the archive.
    //
    // The default action becomes a 403 and each allowed thing gets a rule. An
    // ALB rule holds at most five condition values, so the addresses are
    // chunked; the rule ARNs are output because `make allow-ip` rewrites them
    // live, the way it rewrites the WAF IPSets.
    if (cfg.allowIps.length) {
      const listener = this.service.listener;
      const forward = elbv2.ListenerAction.forward([this.service.targetGroup]);

      new elbv2.ApplicationListenerRule(this, "InternalBypass", {
        listener,
        priority: 10,
        conditions: [elbv2.ListenerCondition.pathPatterns(["/internal/*"])],
        action: forward,
      });

      const chunks = [];
      for (let i = 0; i < cfg.allowIps.length; i += 5) chunks.push(cfg.allowIps.slice(i, i + 5));
      const ruleArns = chunks.map((chunk, i) => {
        const rule = new elbv2.ApplicationListenerRule(this, `AllowIps${i}`, {
          listener,
          priority: 20 + i,
          // Source-ip matches the connection's address and ignores
          // X-Forwarded-For, which is what we want: nothing sits in front of
          // this ALB, so a header here would be the caller's to forge.
          conditions: [elbv2.ListenerCondition.sourceIps(chunk)],
          action: forward,
        });
        return rule.listenerRuleArn;
      });

      // The pattern set the default action to "forward"; replace it, or every
      // rule above is decoration. No L2 for this — `addAction` without a
      // priority refuses to set a second default.
      listener.node.defaultChild.addPropertyOverride("DefaultActions", [
        {
          Type: "fixed-response",
          FixedResponseConfig: {
            StatusCode: "403",
            ContentType: "application/json",
            MessageBody: JSON.stringify({ error: "forbidden" }),
          },
        },
      ]);

      new CfnOutput(this, "GatewayAllowIpRuleArns", { value: ruleArns.join(",") });
    }

    const taskRole = this.service.taskDefinition.taskRole;
    tables.kelabos.grantReadWriteData(taskRole);
    // Write, because ending a kelabo archives it here. Read as well, because
    // the assistant's optional memory of earlier kelabos (notes #3) queries
    // `participant-index` for the host's own past kelabos. `grantReadWriteData`
    // covers the index too — a plain table grant does not, and the failure mode
    // is an AccessDenied on the GSI only, which looks exactly like "this host
    // has no history".
    tables.history.grantReadWriteData(taskRole);
    tables.mcp.grantReadData(taskRole);
    // Presence fan-out reads a subscriber's accepted external peers (docs 18
    // §5). Read only — links are created and destroyed by the REST API alone.
    tables.contacts.grantReadData(taskRole);
    // Journey reports (docs 20 §6): reads a journey's description/board/
    // documents/linked-kelabo-minutes to build the prompt, writes the
    // finished report back onto the same item rest-api created.
    tables.journeys.grantReadWriteData(taskRole);
    // The gateway is the only component that sees a 401 from an MCP server, so
    // it owns the OAuth refresh grant and must persist the rotated tokens.
    // Deliberately PutItem only — not grantReadWriteData — so a compromised
    // gateway still cannot delete a user's MCP configuration.
    taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({ actions: ["dynamodb:PutItem"], resources: [tables.mcp.tableArn] }),
    );
    // grantReadData already added kms:Decrypt for the table's CMK; writing needs
    // the encrypt half as well.
    tables.mcp.encryptionKey?.grantEncryptDecrypt(taskRole);
    // Agent bridge tokens live in the refresh table (docs 16 §6). Read only: the
    // Gateway checks whether one was revoked, and must never be able to mint,
    // revoke or delete a credential — nor to read the browser refresh tokens
    // that share the table, which is why this is GetItem on the table alone and
    // not a grant over its identity-index.
    taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({ actions: ["dynamodb:GetItem"], resources: [tables.refresh.tableArn] }),
    );
    archiveBucket.grantWrite(taskRole);

    secretsmanager.Secret.fromSecretNameV2(this, "SecretCookieKey", cfg.secrets.cookieSigningKey).grantRead(taskRole);
    secretsmanager.Secret.fromSecretNameV2(this, "SecretLlm", cfg.secrets.llm).grantRead(taskRole);
    // Cloudflare Realtime SFU app credentials + TURN key. The Gateway is the
    // only component that holds them: the browser never sees more than an SDP
    // answer and short-lived ICE credentials (docs 15).
    secretsmanager.Secret.fromSecretNameV2(this, "SecretCloudflareRtc", cfg.secrets.cloudflareRealtime).grantRead(taskRole);
    taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ["secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret"],
        resources: [`arn:aws:secretsmanager:${cfg.region}:${cfg.account}:secret:${cfg.secrets.mcpPrefix}*`],
      }),
    );

    new route53.ARecord(this, "GatewayARecord", {
      zone,
      recordName: cfg.gatewayDomain,
      target: route53.RecordTarget.fromAlias(new targets.LoadBalancerTarget(this.service.loadBalancer)),
    });
    new route53.AaaaRecord(this, "GatewayAaaaRecord", {
      zone,
      recordName: cfg.gatewayDomain,
      target: route53.RecordTarget.fromAlias(new targets.LoadBalancerTarget(this.service.loadBalancer)),
    });

    new CfnOutput(this, "GatewayAlbDns", { value: this.service.loadBalancer.loadBalancerDnsName });
    new CfnOutput(this, "GatewayUrl", { value: cfg.gatewayBaseUrl });
    new CfnOutput(this, "EcrRepoUri", { value: this.repo.repositoryUri });
  }
}
