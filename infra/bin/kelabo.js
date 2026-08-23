#!/usr/bin/env node
import { App, Tags, DefaultStackSynthesizer } from "aws-cdk-lib";
import { loadConfig } from "../../config/loadConfig.mjs";
import { DnsStack } from "../lib/dns-stack.js";
import { CertStack, CertStackUsEast1 } from "../lib/cert-stacks.js";
import { DynamoDbStack } from "../lib/dynamodb-stack.js";
import { SesStack } from "../lib/ses-stack.js";
import { LambdaStack } from "../lib/lambda-stack.js";
import { ApiGatewayStack } from "../lib/apigateway-stack.js";
import { GatewayEcsStack } from "../lib/gateway-ecs-stack.js";
import { PortalCloudFrontStack } from "../lib/portal-cloudfront-stack.js";
import { WafStack } from "../lib/waf-stack.js";

const app = new App();
const envName = app.node.tryGetContext("env") ?? "dev";
const cfg = loadConfig(envName);

Tags.of(app).add("app", cfg.app);
Tags.of(app).add("endpoint", cfg.endpoint);

const homeEnv = { account: cfg.account, region: cfg.region };
const usEast1Env = { account: cfg.account, region: "us-east-1" };
// Usually homeEnv. An environment that moved its mail elsewhere puts the
// identity there instead, because an identity only exists in its own region.
const sesEnv = { account: cfg.account, region: cfg.ses.region };
const prefix = `${cfg.app}-${cfg.endpoint}`;

let synthProps = {};
if (!/^\d{12}$/.test(cfg.account)) {
  const stub = cfg.account.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 12) || "placeholder";
  console.log(`[kelabo] config account "${cfg.account}" is a placeholder; using synth-only asset bucket names`);
  synthProps = {
    synthesizer: new DefaultStackSynthesizer({
      fileAssetsBucketName: `cdk-hnb659fds-assets-${stub}-${cfg.region}`,
    }),
  };
}

const dns = new DnsStack(app, `${prefix}-dns`, { ...synthProps, env: homeEnv, cfg });

const cert = new CertStack(app, `${prefix}-cert`, { ...synthProps, env: homeEnv, cfg, zone: dns.zone });
cert.addDependency(dns);

const certUse1 = new CertStackUsEast1(app, `${prefix}-cert-use1`, {
  ...synthProps,
  env: usEast1Env,
  crossRegionReferences: true,
  cfg,
  zone: dns.zone,
});
certUse1.addDependency(dns);

const ddb = new DynamoDbStack(app, `${prefix}-ddb`, { ...synthProps, env: homeEnv, cfg });

// SES email identities are account+region scoped. When several envs send from
// the same domain, exactly one of them owns the identity; the others set
// ses.createIdentity: false and just use it (the send permission in the lambda
// stack is identity-independent).
//
// That same scoping is why the stack goes in `sesEnv` rather than `homeEnv`:
// sandbox status, sending quota, reputation and the bounce/complaint
// suppression list are all per region, so moving an environment's mail to
// another region is the only way to keep it from affecting another
// environment's — and the identity has to be verified where the mail is sent
// from, not where the rest of the environment lives.
//
// `cfg.ses.createIdentity` is also false whenever `mail.provider` is not SES:
// this stack publishes an SPF record naming amazonses.com as the only
// permitted sender, which would fail every message another provider sends.
// Switching an existing deployment away from SES therefore stops synthesizing
// this stack but does not delete the deployed one — `cdk destroy
// kelabo-<env>-ses` is a deliberate step, because it takes the DNS records
// with it.
if (cfg.ses.createIdentity) {
  const ses = new SesStack(app, `${prefix}-ses`, {
    ...synthProps,
    env: sesEnv,
    crossRegionReferences: true,
    cfg,
    zone: dns.zone,
  });
  ses.addDependency(dns);
}

const lambda = new LambdaStack(app, `${prefix}-lambda`, {
  ...synthProps,
  env: homeEnv,
  cfg,
  tables: ddb.tables,
  archiveBucket: ddb.archiveBucket,
});
lambda.addDependency(ddb);

const api = new ApiGatewayStack(app, `${prefix}-api`, { ...synthProps, env: homeEnv, cfg, fn: lambda.fn });
api.addDependency(lambda);

const gateway = new GatewayEcsStack(app, `${prefix}-gateway`, {
  ...synthProps,
  env: homeEnv,
  cfg,
  zone: dns.zone,
  certificate: cert.gatewayCert,
  tables: ddb.tables,
  archiveBucket: ddb.archiveBucket,
});
gateway.addDependency(ddb);
gateway.addDependency(cert);

// `allowIps` closes the deployment to a list of source addresses. Only the
// CloudFront half needs a stack of its own, and only in us-east-1, because that
// is the one region a CLOUDFRONT-scope WebACL exists in. Empty list, no stack,
// no charge — an open deployment synthesizes exactly what it did before.
let waf;
if (cfg.allowIps.length) {
  waf = new WafStack(app, `${prefix}-waf`, { ...synthProps, env: usEast1Env, cfg });
}

const portal = new PortalCloudFrontStack(app, `${prefix}-portal`, {
  ...synthProps,
  env: homeEnv,
  crossRegionReferences: true,
  cfg,
  zone: dns.zone,
  portalCert: certUse1.portalCert,
  httpApi: api.httpApi,
  webAclArn: waf?.webAclArn,
});
if (waf) portal.addDependency(waf);
portal.addDependency(api);
portal.addDependency(certUse1);
