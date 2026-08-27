import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";

/**
 * What is left in Secrets Manager: **identity and perimeter**.
 *
 * The cookie signing key, the CloudFront origin secret, the two OIDC client
 * secrets and the Turnstile key. Every one of them is read at a cold start,
 * compared against something, and never edited by an operator — so there is no
 * rotation story a console improves and nothing to gain from moving them.
 *
 * The four **supplier** credentials that used to live here — llm, stt, rtc,
 * payments — are rows in the credentials table now (`credentials.js`), and the
 * per-user MCP bearer tokens are rows in the mcp table beside the OAuth tokens
 * for the same servers. This module lost `putSecret`, `describeSecret`,
 * `secretExists`, `getSttKey`, `getPaymentSecret` and the MCP pair with them:
 * it can no longer write anything at all, which is the correct capability for
 * what it now holds.
 *
 * The line is worth stating once, because it is the whole security argument:
 * a supplier key that leaks costs money and is rotated at the supplier. A
 * cookie key that leaks is every account in the deployment, and no rotation
 * undoes the sessions already minted with it.
 */
export function createSecrets({ region } = {}) {
  const client = new SecretsManagerClient({ region: region || process.env.AWS_REGION });
  // Cached with a TTL, not for the container's life. Rotating a supplier key is
  // meant to take effect without a deploy (§4.6), and an immortal cache meant a
  // warm Lambda kept presenting the old credential until AWS happened to recycle
  // it — which is minutes or hours, unpredictably, and looks exactly like the
  // rotation not having worked. Five minutes matches the gateway's own secret
  // cache, so the two halves of a rotation land together.
  const SECRET_TTL_MS = 5 * 60_000;
  const cache = new Map();

  async function getSecretRaw(name) {
    const hit = cache.get(name);
    if (hit && hit.expiresAt > Date.now()) return hit.value;
    const res = await client.send(new GetSecretValueCommand({ SecretId: name }));
    const value = res.SecretString ?? Buffer.from(res.SecretBinary).toString("utf8");
    cache.set(name, { value, expiresAt: Date.now() + SECRET_TTL_MS });
    return value;
  }

  /** Drop a cached value, so a rotation this process performed is visible at once. */
  function forget(name) {
    cache.delete(name);
  }

  async function getSecretJson(name) {
    const raw = await getSecretRaw(name);
    try {
      return JSON.parse(raw);
    } catch {
      return { value: raw };
    }
  }

  return {
    getSecretRaw,
    forget,
    getSecretJson,
    getCookieKey: (config) => getSecretRaw(config.secrets.cookieSigningKey),
    // The value CloudFront sends as x-kelabo-origin. Cached like the rest, so
    // the gate costs one Secrets Manager call per cold container, not one per
    // request.
    getApiOriginSecret: (config) => getSecretRaw(config.secrets.apiOrigin),
    getOidcSecret: (config, provider) =>
      getSecretJson(provider === "google" ? config.secrets.oidcGoogle : config.secrets.oidcApple),
  };
}
