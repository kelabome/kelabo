const num = (v, d) => (v !== undefined && v !== "" ? Number(v) : d);

export async function loadGatewayConfig() {
  if (process.env.KELABO_TABLE_KELABOS) return fromEnv();
  const { loadConfig } = await import("../../config/loadConfig.mjs");
  const base = loadConfig(process.env.KELABO_ENV || "dev");
  return fromBase(base);
}

function fromEnv() {
  const e = process.env;
  return {
    env: e.KELABO_ENV || "dev",
    region: e.KELABO_REGION || e.AWS_REGION || "us-east-1",
    tenantId: e.KELABO_TENANT_ID || "",
    allowedEmailDomain: e.KELABO_TENANT_ID || "",
    portalUrl: e.KELABO_PORTAL_URL || "http://localhost:5173",
    tableNames: {
      kelabos: e.KELABO_TABLE_KELABOS,
      history: e.KELABO_TABLE_HISTORY,
      mcp: e.KELABO_TABLE_MCP,
      refresh: e.KELABO_TABLE_REFRESH,
      contacts: e.KELABO_TABLE_CONTACTS,
      // Read: context for a journey report (docs 20 §6). Write: the report
      // itself, and the contributor rollup counters — both land here because
      // the Gateway is the one place the LLM credential is readable at all.
      journeys: e.KELABO_TABLE_JOURNEYS,
    },
    contacts: { external: e.KELABO_CONTACTS_EXTERNAL === "true" },
    // May a link-joined guest receive the spoken transcript? Default yes: on a
    // self-hosted deployment a guest is a trusted colleague without an account.
    // A hosted/SaaS deployment sets this false, and guests then receive only
    // typed messages — enforced at the SSE fan-out and the history endpoint,
    // never by the client.
    guestTranscriptAccess: e.KELABO_GUEST_TRANSCRIPT_ACCESS !== "false",
    archiveBucket: e.KELABO_ARCHIVE_BUCKET,
    archiveKeyPrefix: e.KELABO_ARCHIVE_KEY_PREFIX || "archives",
    secrets: {
      llm: e.KELABO_SECRET_LLM,
      cookieSigningKey: e.KELABO_SECRET_COOKIE_KEY,
      mcpPrefix: e.KELABO_SECRET_MCP_PREFIX || "",
      cloudflareRealtime: e.KELABO_SECRET_CLOUDFLARE_RTC || "",
    },
    rtcApiBase: e.KELABO_RTC_API_BASE || "https://rtc.live.cloudflare.com/v1",
    rtc: {
      defaultMode: e.KELABO_RTC_DEFAULT_MODE || "sfu",
      meshMaxParticipants: num(e.KELABO_RTC_MESH_MAX, 5),
      iceTtlSeconds: num(e.KELABO_RTC_ICE_TTL, 3600),
      disconnectGraceSeconds: num(e.KELABO_RTC_DISCONNECT_GRACE, 20),
      video: e.KELABO_RTC_VIDEO === "true",
    },
    llm: {
      provider: e.KELABO_LLM_PROVIDER || "anthropic",
      model: e.KELABO_LLM_MODEL || "",
      smallModel: e.KELABO_LLM_SMALL_MODEL || "",
    },
    openaiBaseUrl: e.KELABO_OPENAI_BASE_URL || "https://api.openai.com/v1",
    gateway: {
      agent: {
        maxConcurrentRuns: num(e.KELABO_AGENT_MAX_CONCURRENT_RUNS, 4),
        // How many research tasks one trigger may fan out in parallel. The
        // orchestrator dispatches them together and each gets its own board
        // card; this is the ceiling on that fan-out, not on total concurrency.
        maxDispatchPerTurn: num(e.KELABO_AGENT_MAX_DISPATCH_PER_TURN, 3),
        sensitivity: e.KELABO_AGENT_SENSITIVITY || "medium",
        maxContributionsPerMinute: num(e.KELABO_AGENT_MAX_CONTRIB_PER_MIN, 3),
        cooldownSeconds: num(e.KELABO_AGENT_COOLDOWN_SECONDS, 45),
        rollingWindowSize: num(e.KELABO_AGENT_ROLLING_WINDOW, 60),
        turnTimeoutSeconds: num(e.KELABO_AGENT_TURN_TIMEOUT_SECONDS, 1),
      },
    },
    retentionDays: num(e.KELABO_RETENTION_DAYS, 30),
  };
}

function fromBase(base) {
  return {
    env: base.env,
    region: base.region,
    tenantId: base.allowedEmailDomain || "",
    allowedEmailDomain: base.allowedEmailDomain || "",
    portalUrl: base.portalUrl,
    tableNames: {
      kelabos: base.tableNames.kelabos,
      history: base.tableNames.history,
      mcp: base.tableNames.mcp,
      refresh: base.tableNames.refresh,
      contacts: base.tableNames.contacts,
      journeys: base.tableNames.journeys,
    },
    contacts: { external: !!base.contacts?.external },
    guestTranscriptAccess: base.guestTranscriptAccess !== false,
    archiveBucket: base.archiveBucket,
    archiveKeyPrefix: base.archiveKeyPrefix || "archives",
    secrets: {
      llm: base.secrets.llm,
      cookieSigningKey: base.secrets.cookieSigningKey,
      mcpPrefix: base.secrets.mcpPrefix || "",
      cloudflareRealtime: base.secrets.cloudflareRealtime || "",
    },
    rtcApiBase: base.rtcApiBase,
    rtc: { ...base.rtc },
    llm: {
      provider: base.llm.provider,
      model: base.llm.model,
      smallModel: base.llm.smallModel,
    },
    // Honor the provider base URL from config (e.g. deepseek's endpoint); env
    // override still wins for local experiments. deepseek/other providers route
    // through the OpenAI-compatible client, so this is the endpoint it hits.
    openaiBaseUrl: process.env.KELABO_OPENAI_BASE_URL || base.llm.baseUrl || "https://api.openai.com/v1",
    gateway: { agent: { ...base.gateway.agent } },
    retentionDays: base.retentionDays,
  };
}
