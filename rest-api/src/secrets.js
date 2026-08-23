import {
  SecretsManagerClient,
  GetSecretValueCommand,
  CreateSecretCommand,
  PutSecretValueCommand,
  DeleteSecretCommand,
  DescribeSecretCommand,
} from "@aws-sdk/client-secrets-manager";

export function createSecrets({ region } = {}) {
  const client = new SecretsManagerClient({ region: region || process.env.AWS_REGION });
  const cache = new Map();

  // Capability probes (docs 19 §3): does a provider's secret exist at all?
  // DescribeSecret, not GetSecretValue — the API can state that the LLM key
  // exists without holding a grant to read it. Only a definitive
  // ResourceNotFoundException means "off"; any other failure (throttle, an
  // IAM gap on an older deployment) reads as "on", because a probe hiccup
  // must never switch a working feature off — permissive default (docs 19 §4).
  // `true` is cached for the process lifetime; `false` expires, so a key
  // added to a running deployment is noticed without a redeploy.
  const existsCache = new Map();
  const EXISTS_NEGATIVE_TTL_MS = 5 * 60 * 1000;
  async function secretExists(name) {
    if (!name) return false;
    const hit = existsCache.get(name);
    if (hit && (hit.value || Date.now() - hit.at < EXISTS_NEGATIVE_TTL_MS)) return hit.value;
    let value = true;
    try {
      await client.send(new DescribeSecretCommand({ SecretId: name }));
    } catch (e) {
      value = e?.name !== "ResourceNotFoundException";
    }
    existsCache.set(name, { value, at: Date.now() });
    return value;
  }

  async function getSecretRaw(name) {
    if (cache.has(name)) return cache.get(name);
    const res = await client.send(new GetSecretValueCommand({ SecretId: name }));
    const value = res.SecretString ?? Buffer.from(res.SecretBinary).toString("utf8");
    cache.set(name, value);
    return value;
  }

  async function getSecretJson(name) {
    const raw = await getSecretRaw(name);
    try {
      return JSON.parse(raw);
    } catch {
      return { value: raw };
    }
  }

  // MCP server auth tokens live at <mcpPrefix><identity>/<serverName> as
  // {token}. DynamoDB only stores the secretRef (`<identity>/<serverName>`).
  async function putMcpSecret(config, identity, serverName, token) {
    const name = `${config.secrets.mcpPrefix}${identity}/${serverName}`;
    const SecretString = JSON.stringify({ token });
    try {
      await client.send(new CreateSecretCommand({ Name: name, SecretString }));
    } catch (e) {
      if (e.name !== "ResourceExistsException") throw e;
      await client.send(new PutSecretValueCommand({ SecretId: name, SecretString }));
    }
    cache.set(name, SecretString);
  }

  async function deleteMcpSecret(config, identity, serverName) {
    const name = `${config.secrets.mcpPrefix}${identity}/${serverName}`;
    cache.delete(name);
    await client
      .send(new DeleteSecretCommand({ SecretId: name, ForceDeleteWithoutRecovery: true }))
      .catch(() => {});
  }

  return {
    getSecretRaw,
    getSecretJson,
    secretExists,
    putMcpSecret,
    deleteMcpSecret,
    getCookieKey: (config) => getSecretRaw(config.secrets.cookieSigningKey),
    // The value CloudFront sends as x-kelabo-origin. Cached like the rest, so
    // the gate costs one Secrets Manager call per cold container, not one per
    // request.
    getApiOriginSecret: (config) => getSecretRaw(config.secrets.apiOrigin),
    // One secret holds a key per provider, so switching provider — or rolling
    // back after a switch — is a config change and a redeploy, never a trip to
    // Secrets Manager. `apiKey`/`key`/`value` remain accepted so a secret
    // written for a single-provider deployment keeps working.
    //
    //   { "soniox": "…", "deepgram": "…" }   or   { "apiKey": "…" }
    getSttKey: async (config) => {
      const s = await getSecretJson(config.secrets.stt);
      const key = s[config.stt?.provider] || s.apiKey || s.key || s.value;
      if (!key) throw new Error(`no key for stt provider ${config.stt?.provider} in secret`);
      return key;
    },
    // The outbound-mail key, when the deployment sends through an HTTP
    // provider. SES needs none of this — it authenticates with the Lambda's
    // own IAM role — so on an SES deployment this secret does not have to
    // exist and is never read.
    //
    // Shaped like the STT secret above, for the same reason: one secret holds
    // a key per provider, so switching provider (or rolling back after a
    // switch) is a config change and a redeploy, never a trip to Secrets
    // Manager to re-enter a credential that is still perfectly good.
    //
    //   { "mailersend": "…" }   or   { "apiKey": "…" }
    getMailApiKey: async (config) => {
      const name = config.secrets?.mail;
      if (!name) throw new Error("no mail secret configured (config.secrets.mail)");
      const s = await getSecretJson(name);
      const key = s[config.mail?.provider] || s.apiKey || s.key || s.value;
      if (!key) throw new Error(`no key for mail provider ${config.mail?.provider} in secret ${name}`);
      return key;
    },
    getOidcSecret: (config, provider) =>
      getSecretJson(provider === "google" ? config.secrets.oidcGoogle : config.secrets.oidcApple),
  };
}
