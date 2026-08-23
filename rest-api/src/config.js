const DEFAULTS = {
  sessionTtlSeconds: 3600,
  refreshTtlDays: 60,
  participantTtlSeconds: 43200,
  // A developer's agent bridge token (docs 16). Longer than a browser refresh
  // token because re-pairing means re-running `kelabo login` at a terminal, and
  // it is revocable from Settings the moment it is not wanted.
  agentTokenTtlDays: 90,
  otp: {
    ttlSeconds: 600,
    maxAttempts: 5,
    resendSeconds: 30,
    perEmailWindowSeconds: 3600,
    perEmailMaxRequests: 5,
    perIpWindowSeconds: 3600,
    perIpMaxRequests: 30,
  },
  // Join codes (rest-api/src/joinCode.js). `redeemPerIp*` is the control that
  // actually bounds guessing, so it is the one to tighten if a deployment ever
  // sees fishing; `mintPerKelaboPerHour` bounds how many codes one room can
  // have live at once, which is the multiplier on that same guess surface.
  joinCode: {
    ttlSeconds: 120,
    mintPerKelaboPerHour: 20,
    redeemPerIpWindowSeconds: 3600,
    redeemPerIpMaxRequests: 20,
  },
  rtc: {
    defaultMode: "sfu",
    meshMaxParticipants: 6,
    video: false,
  },
  retentionDays: 30,
};

let cached;

export function getConfig() {
  if (cached) return cached;
  cached = fromEnv() || null;
  return cached;
}

export async function ensureConfig() {
  if (cached) return cached;
  cached = fromEnv();
  if (cached) return cached;
  const env = process.env.KELABO_ENV || "dev";
  const { loadConfig } = await import("../../config/loadConfig.mjs");
  cached = fromLoadConfig(loadConfig(env));
  return cached;
}

export function setConfig(cfg) {
  cached = cfg;
}

function num(v, d) {
  const n = Number(v);
  return Number.isFinite(n) && v !== undefined && v !== "" ? n : d;
}

// A structured env var. Falls back rather than throwing: an unparseable value
// should degrade one capability, not stop the Lambda from starting and take the
// whole control plane with it.
function parseJson(v, d) {
  if (!v) return d;
  try {
    const parsed = JSON.parse(v);
    return parsed && typeof parsed === "object" ? parsed : d;
  } catch {
    return d;
  }
}

function fromEnv() {
  if (!process.env.KELABO_TABLE_KELABOS && !process.env.KELABO_ALLOWED_EMAIL_DOMAIN) return null;
  const env = process.env;
  return {
    env: env.KELABO_ENV || "dev",
    region: env.AWS_REGION || "us-east-1",
    allowedEmailDomain: env.KELABO_ALLOWED_EMAIL_DOMAIN,
    cookieDomain: env.KELABO_COOKIE_DOMAIN,
    portalUrl: env.KELABO_PORTAL_URL,
    gatewayBaseUrl: env.KELABO_GATEWAY_BASE_URL,
    joinUrl: (kelaboId) => `${env.KELABO_PORTAL_URL}/join/${kelaboId}`,
    inviteUrl: (kelaboId) => `${env.KELABO_PORTAL_URL}/invite/${kelaboId}`,
    tableNames: {
      kelabos: env.KELABO_TABLE_KELABOS,
      users: env.KELABO_TABLE_USERS,
      otp: env.KELABO_TABLE_OTP,
      refresh: env.KELABO_TABLE_REFRESH,
      history: env.KELABO_TABLE_HISTORY,
      mcp: env.KELABO_TABLE_MCP,
      contacts: env.KELABO_TABLE_CONTACTS,
      journeys: env.KELABO_TABLE_JOURNEYS,
    },
    contacts: { external: env.KELABO_CONTACTS_EXTERNAL === "true" },
    archiveBucket: env.KELABO_ARCHIVE_BUCKET,
    archiveKeyPrefix: env.KELABO_ARCHIVE_KEY_PREFIX || "archives",
    secrets: {
      stt: env.KELABO_SECRET_STT,
      cookieSigningKey: env.KELABO_SECRET_COOKIE_KEY,
      oidcGoogle: env.KELABO_SECRET_OIDC_GOOGLE,
      oidcApple: env.KELABO_SECRET_OIDC_APPLE,
      mcpPrefix: env.KELABO_SECRET_MCP_PREFIX || "",
      mail: env.KELABO_SECRET_MAIL || "",
      // Existence-probed only, for the capability map (docs 19 §3). The API
      // holds no read grant on these values — they stay gateway-owned.
      llm: env.KELABO_SECRET_LLM,
      cloudflareRealtime: env.KELABO_SECRET_CLOUDFLARE_RTC,
      apiOrigin: env.KELABO_SECRET_API_ORIGIN,
    },
    api: {
      requireOriginSecret: env.KELABO_REQUIRE_ORIGIN_SECRET === "true",
    },
    auth: {
      sessionTtlSeconds: num(env.KELABO_SESSION_TTL_SECONDS, DEFAULTS.sessionTtlSeconds),
      refreshTtlDays: num(env.KELABO_REFRESH_TTL_DAYS, DEFAULTS.refreshTtlDays),
      participantTtlSeconds: num(env.KELABO_PARTICIPANT_TTL_SECONDS, DEFAULTS.participantTtlSeconds),
      agentTokenTtlDays: num(env.KELABO_AGENT_TOKEN_TTL_DAYS, DEFAULTS.agentTokenTtlDays),
      socialProviders: (env.KELABO_SOCIAL_PROVIDERS || "").split(",").map((s) => s.trim()).filter(Boolean),
    },
    // Speech-to-text. `providers` arrives as one JSON blob rather than a var per
    // provider per setting, because its keys belong to the providers and env
    // vars cannot be enumerated without knowing them: `KELABO_STT_<ID>_MODEL`
    // would mean adding a provider edits this file, `lambda-stack.js` and every
    // deployed task definition. It is opaque here and stays opaque until a
    // provider is handed its own block.
    stt: {
      provider: env.KELABO_STT_PROVIDER || "deepgram",
      language: env.KELABO_STT_LANGUAGE || "en",
      providers: parseJson(env.KELABO_STT_PROVIDERS, {}),
    },
    // Outbound mail. `provider` decides which transport in `src/mail/` carries
    // it; the SES `region` falls back to the Lambda's own, because an
    // environment that never moved its mail has no KELABO_SES_REGION and the
    // identity is where the rest of it lives.
    mail: {
      provider: env.KELABO_MAIL_PROVIDER || "ses",
      fromAddress: env.KELABO_MAIL_FROM_ADDRESS || env.KELABO_SES_FROM_ADDRESS || "",
      ses: {
        region: env.KELABO_SES_REGION || env.AWS_REGION || "us-east-1",
        configurationSet: env.KELABO_SES_CONFIG_SET || "",
      },
      mailersend: { apiBase: env.KELABO_MAILERSEND_API_BASE || undefined },
    },
    // The control plane only stamps the kelabo's transport and reports it back;
    // all Cloudflare credentials and signalling live in the Gateway (docs 15).
    rtc: {
      defaultMode: env.KELABO_RTC_DEFAULT_MODE || DEFAULTS.rtc.defaultMode,
      meshMaxParticipants: num(env.KELABO_RTC_MESH_MAX, DEFAULTS.rtc.meshMaxParticipants),
      video: env.KELABO_RTC_VIDEO === "true",
    },
    otp: {
      ttlSeconds: num(env.KELABO_OTP_TTL_SECONDS, DEFAULTS.otp.ttlSeconds),
      maxAttempts: num(env.KELABO_OTP_MAX_ATTEMPTS, DEFAULTS.otp.maxAttempts),
      resendSeconds: num(env.KELABO_OTP_RESEND_SECONDS, DEFAULTS.otp.resendSeconds),
      perEmailWindowSeconds: num(env.KELABO_OTP_PER_EMAIL_WINDOW_SECONDS, DEFAULTS.otp.perEmailWindowSeconds),
      perEmailMaxRequests: num(env.KELABO_OTP_PER_EMAIL_MAX_REQUESTS, DEFAULTS.otp.perEmailMaxRequests),
      perIpWindowSeconds: num(env.KELABO_OTP_PER_IP_WINDOW_SECONDS, DEFAULTS.otp.perIpWindowSeconds),
      perIpMaxRequests: num(env.KELABO_OTP_PER_IP_MAX_REQUESTS, DEFAULTS.otp.perIpMaxRequests),
    },
    joinCode: {
      ttlSeconds: num(env.KELABO_JOIN_CODE_TTL_SECONDS, DEFAULTS.joinCode.ttlSeconds),
      mintPerKelaboPerHour: num(env.KELABO_JOIN_CODE_MINT_PER_KELABO_PER_HOUR, DEFAULTS.joinCode.mintPerKelaboPerHour),
      redeemPerIpWindowSeconds: num(env.KELABO_JOIN_CODE_REDEEM_PER_IP_WINDOW_SECONDS, DEFAULTS.joinCode.redeemPerIpWindowSeconds),
      redeemPerIpMaxRequests: num(env.KELABO_JOIN_CODE_REDEEM_PER_IP_MAX_REQUESTS, DEFAULTS.joinCode.redeemPerIpMaxRequests),
    },
    retentionDays: num(env.KELABO_RETENTION_DAYS, DEFAULTS.retentionDays),
  };
}

function fromLoadConfig(c) {
  return {
    env: c.env,
    region: c.region,
    allowedEmailDomain: c.allowedEmailDomain,
    cookieDomain: c.cookieDomain,
    portalUrl: c.portalUrl,
    gatewayBaseUrl: c.gatewayBaseUrl,
    joinUrl: c.joinUrl,
    inviteUrl: c.inviteUrl,
    tableNames: c.tableNames,
    contacts: { external: !!c.contacts?.external },
    archiveBucket: c.archiveBucket,
    archiveKeyPrefix: c.archiveKeyPrefix,
    secrets: {
      stt: c.secrets.stt,
      cookieSigningKey: c.secrets.cookieSigningKey,
      oidcGoogle: c.secrets.oidcGoogle,
      oidcApple: c.secrets.oidcApple,
      mcpPrefix: c.secrets.mcpPrefix || "",
      mail: c.secrets.mail || "",
      llm: c.secrets.llm,
      cloudflareRealtime: c.secrets.cloudflareRealtime,
      apiOrigin: c.secrets.apiOrigin,
    },
    api: { requireOriginSecret: !!c.api?.requireOriginSecret },
    auth: {
      sessionTtlSeconds: c.auth?.sessionTtlSeconds ?? DEFAULTS.sessionTtlSeconds,
      refreshTtlDays: c.auth?.refreshTtlDays ?? DEFAULTS.refreshTtlDays,
      participantTtlSeconds: c.auth?.participantTtlSeconds ?? DEFAULTS.participantTtlSeconds,
      agentTokenTtlDays: c.auth?.agentTokenTtlDays ?? DEFAULTS.agentTokenTtlDays,
      socialProviders: c.auth?.socialProviders ?? [],
    },
    // Keep in step with `fromEnv` above — including the defaults. These two
    // loaders drifted before (`language` defaulted to "en" in one and "multi"
    // in the other), so a kelabo transcribed differently on ECS and on a laptop
    // for no reason anybody could see in the config.
    stt: {
      provider: c.stt?.provider ?? "deepgram",
      language: c.stt?.language ?? "en",
      providers: c.stt?.providers ?? {},
    },
    mail: {
      provider: c.mail?.provider || "ses",
      fromAddress: c.mail?.fromAddress || c.ses?.fromAddress || "",
      ses: {
        region: c.mail?.ses?.region || c.ses?.region || c.region,
        configurationSet: c.mail?.ses?.configurationSet || c.ses?.configurationSetName || "",
      },
      mailersend: { apiBase: c.mail?.mailersend?.apiBase || undefined },
    },
    rtc: { ...DEFAULTS.rtc, ...(c.rtc || {}) },
    otp: { ...DEFAULTS.otp, ...(c.otp || {}) },
    joinCode: { ...DEFAULTS.joinCode, ...(c.joinCode || {}) },
    retentionDays: c.retentionDays ?? DEFAULTS.retentionDays,
  };
}
