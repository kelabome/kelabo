import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { S3Client } from "@aws-sdk/client-s3";
import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { loadGatewayConfig } from "./config.js";
import { createState, rebuildState } from "./state.js";
import { createCloudflareRtc } from "./rtc/cloudflare.js";
import { getCredential as readCredential } from "./db.js";
import { LLM_CONFIG, llmApiKeyFrom } from "@kelabo/contracts/credentials";
import { createLlmProvider } from "./agent/llm.js";
import { log, logError } from "./log.js";

export async function createContainer(overrides = {}) {
  const config = overrides.config ?? (await loadGatewayConfig());
  const region = config.region;
  const db = overrides.db ?? DynamoDBDocumentClient.from(new DynamoDBClient({ region }));
  const s3 = overrides.s3 ?? new S3Client({ region });
  const secrets = overrides.secrets ?? new SecretsManagerClient({ region });

  // Cached with a TTL, not forever: MCP bearer tokens are rotated by the user
  // from Settings while the task keeps running, and an immortal cache meant the
  // gateway kept presenting a stale credential until the next deploy.
  const SECRET_TTL_MS = 5 * 60_000;
  const secretCache = new Map();
  async function getSecret(name) {
    if (!name) return null;
    const hit = secretCache.get(name);
    if (hit && hit.expiresAt > Date.now()) return hit.value;
    const out = await secrets.send(new GetSecretValueCommand({ SecretId: name }));
    const raw = out.SecretString ?? Buffer.from(out.SecretBinary ?? []).toString("utf8");
    let value = raw;
    try {
      value = JSON.parse(raw);
    } catch {
      value = raw;
    }
    secretCache.set(name, { value, expiresAt: Date.now() + SECRET_TTL_MS });
    return value;
  }

  async function getCookieKey() {
    const v = await getSecret(config.secrets.cookieSigningKey);
    return typeof v === "string" ? v : v.key ?? v.signingKey ?? JSON.stringify(v);
  }

  /**
   * **Bootstrap for a deployment whose credentials table is empty.**
   *
   * The credentials table is written by a control plane — a console, or a
   * migration — and this repository ships neither. Without a fallback a fresh
   * self-host would come up with no LLM key, no way to put one anywhere the
   * gateway reads, and an assistant that silently never answers: the credential
   * lookup returns null exactly as it does for a capability that was
   * deliberately left unconfigured, so the two are indistinguishable.
   *
   * So `KELABO_LLM_API_KEY` in the task environment fills the `llm` slot when
   * the table does not. It is a **fallback, not a source**: a row in the table
   * always wins, so an operator who later fills the slot is not silently
   * overridden by an environment variable set months earlier, and the 5-minute
   * cache still bounds how long the old answer is used. The name is the one
   * `test/devAgent.mjs` already documents, so there is one env var for the key
   * across the harness and the service rather than two.
   */
  const bootstrapCredential = (slot) =>
    slot === "llm" && config.bootstrapLlmApiKey ? { apiKey: config.bootstrapLlmApiKey } : null;

  // Supplier credentials, by slot, with the same TTL cache the Secrets Manager
  // reads had and for the same reason: a rotation is meant to reach a running
  // task without a deploy, and an immortal cache made a rotation look like it
  // had not worked for an unpredictable number of hours.
  const credCache = new Map();
  async function getCredential(slot) {
    const hit = credCache.get(slot);
    if (hit && hit.expiresAt > Date.now()) return hit.value;
    const value = (await readCredential(c, slot)) ?? bootstrapCredential(slot);
    credCache.set(slot, { value, expiresAt: Date.now() + SECRET_TTL_MS });
    return value;
  }

  // { sfuAppId, sfuAppSecret, turnKeyId, turnKeyApiToken }. Absent until the
  // operator sets the Cloudflare values, in which case the RTC client reports
  // rtc_unavailable and kelabos run board+transcript only — the feature
  // degrades rather than breaking, which is why `make rtc-secrets` was ever
  // separate from `make secrets`.
  async function getCloudflareRtc() {
    const v = await getCredential("rtc");
    return v && typeof v === "object" ? v : null;
  }

  const c = {
    config,
    db,
    s3,
    secrets,
    getSecret,
    getCredential,
    getCookieKey,
    getCloudflareRtc,
    state: createState(),
    log: (event, fields) => log(event, fields),
    // Overridable so tests exercise the routes without reaching Cloudflare.
    rtc:
      overrides.rtc ??
      createCloudflareRtc({
        apiBase: config.rtcApiBase,
        getCreds: getCloudflareRtc,
        fetchImpl: overrides.fetchImpl,
      }),
    logError,
    shutdownHooks: [],
    async shutdown() {
      for (const fn of c.shutdownHooks.splice(0)) {
        try {
          await fn();
        } catch {}
      }
    },
  };

  /**
   * The LLM a journey question is answered with (`generateJourneyReport`).
   *
   * That path used to resolve its key from Secrets Manager, which stopped
   * existing when supplier credentials became rows in the credentials table:
   * `config.secrets.llm` is gone, so **every** journey question would fail
   * with `llm_not_configured` while kelabos ran fine. `c.llm` is the injection
   * point that file already checks first (it exists so tests can supply a
   * provider), so filling it here fixes it without forking the report pipeline
   * to change three lines.
   *
   * Two things this must not do:
   *
   *  - **Resolve the key at construction.** The credential cache has a 5-minute
   *    TTL precisely so a rotation reaches a running task; a key read once at
   *    boot would outlive it until the next deploy. So the lookup happens per
   *    call, behind that same cache.
   *  - **Take the model from anywhere but this deployment's config.**
   *    `config.llm`/`config.openaiBaseUrl` is the one place that answers "what
   *    is this deployment running?" on both the ECS path (`KELABO_LLM_*` in the
   *    task definition, which is also what `LLM_CONFIG` reads) and the local
   *    path (`config/kelabo.json`, which the environment does not carry).
   */
  c.llm = overrides.llm ?? {
    async completeRaw(req) {
      const apiKey = llmApiKeyFrom(await getCredential("llm"));
      if (!apiKey) {
        // Logged as its own event because the report the asker sees can only
        // say the generation failed: the operator needs the actual reason,
        // and it is one thing — the `llm` credential slot is empty.
        log("journey_llm_credential_missing", {});
        throw new Error("llm_not_configured");
      }
      return createLlmProvider(config.llm, {
        apiKey,
        openaiBaseUrl: config.openaiBaseUrl || LLM_CONFIG.baseUrl,
        log,
      }).completeRaw(req);
    },
  };

  if (!overrides.skipRebuild) {
    try {
      await rebuildState(c);
    } catch (err) {
      logError("state_rebuild_failed", err);
    }
  }
  return c;
}
