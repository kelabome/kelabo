import { z } from "zod";
import { createVersionedCache, pickVersion, versionSk, versionFromSk } from "./versioned.js";

/**
 * Operational configuration: every setting a running deployment may need to
 * change, held in a table and published from `/admin` rather than baked into a
 * task definition.
 *
 * ## Why this exists
 *
 * Every value in here used to be a key in `config/kelabo.json`, turned into a
 * `KELABO_*` environment variable by CDK and frozen into a task definition.
 * Changing which model the assistant runs, which transport carries outbound
 * mail, or how sensitive the trigger gate is was therefore a **code deploy** —
 * a docker build, a CloudFormation update and a service rollout, for a value
 * nobody would call code. Worse, `make restart` does *not* pick a config change
 * up (it re-deploys the same task-definition revision), so the obvious thing to
 * try silently kept the old value.
 *
 * The split between "config" and "deployment" was historical, not principled.
 * The principle is one question:
 *
 *   **Does CloudFormation need this value to build the stack?**
 *   Yes → it stays in `config/kelabo.json`. No → it belongs here.
 *
 * By that test an account id, a region, a domain, a hosted zone, a subdomain, a
 * WAF address list, the gateway's CPU and memory, a log retention period and a
 * Secrets Manager *name* all stay where they are: CDK reads them at synth, and
 * a value read at synth cannot follow a row in a table. Everything else — the
 * model, the transcription engine, the mail transport, every rate limit, every
 * TTL — is read by application code at request time and is therefore publishable.
 *
 * ## What is deliberately NOT here
 *
 * **Key material. Not one byte of it.** This is an ordinary DynamoDB item with
 * no customer-managed key over it, in a table that admin tooling scans and PITR
 * copies. Supplier credentials live in their own table under their own key,
 * addressed by slot — see `credentials.js`, which also explains why the cookie
 * signing key and the origin secret stayed in Secrets Manager. The slot is the
 * address, so there is not even a secret *name* to point at from here.
 *
 * **Who may publish.** `rootAdminEmail` is deployment config
 * (`config/loadConfig.mjs`) and must stay there. Everything in this file is
 * changeable from a web page, so the answer to "who may change it" cannot also
 * be — an administrator who could edit the roster from the console could lock
 * the operator out of their own deployment with one request. The roster grows
 * by `ADMIN#` rows that only root may write; root itself takes a deploy.
 *
 * ## Versioning
 *
 * Append-only: `PK = OPCONFIG`, `SK = V#000001`. A change is a new version with
 * a note and an author, never an edit. Pointing a deployment at a different
 * model, or widening who may sign in, is exactly the kind of act that should
 * leave a record naming who did it and why — and the previous version is still
 * sitting there to roll back to.
 *
 * ## The fold, and why the sentinel is `null`
 *
 * `resolveOpConfig(cfg, op)` folds a published version over the service's own
 * environment config: **published wins where it is set, the environment is the
 * bootstrap.** That order is what makes this safe to deploy — a deployment that
 * has published nothing behaves exactly as it did before, and the first
 * published version takes over field by field rather than all at once.
 *
 * "Set" means **not `null`**, not "truthy". This is the one place where copying
 * the obvious pattern would be a bug: `0` and `false` are meaningful published
 * values here. `agent.maxConcurrentRuns: 0` means *unlimited*,
 * `agent.turnDeadlineSeconds: 0` means *no deadline*, and `rtc.video: false`
 * means *audio only* — all three would be silently discarded by a falsiness
 * check and replaced with the deployment's default, which is the opposite of
 * what the operator just asked for. Strings keep the familiar rule as well
 * (empty string is "not set", never "set to empty") because a cleared text box
 * in a form must not point the deployment at a provider named "".
 */

/** Op-config versions share one partition so history is a single Query. */
export const OPCONFIG_PK = "OPCONFIG";

/** Zero-padded so the partition sorts by version; six digits is defensive. */
export const OPCONFIG_VERSION_WIDTH = 6;
export const opConfigSk = (version) =>
  versionSk(Math.max(0, Math.floor(Number(version) || 0)), OPCONFIG_VERSION_WIDTH);
export const opConfigVersionFromSk = (sk) => versionFromSk(sk);

/**
 * The admin roster, in the same table.
 *
 * One partition, one row per granted administrator, `SK` = the lower-cased
 * email. Here rather than in a module of its own because the roster and the
 * config are a single concern — the roster exists only to say who may publish
 * the config — and a reader and a writer that disagreed about a prefix would be
 * an access-control bug rather than a lookup miss.
 */
export const ADMIN_PK = "ADMIN";
export const adminSk = (email) => String(email ?? "").trim().toLowerCase();

/** Published numbers: absent means "not set", and `0` is a real value. */
const optionalInt = (min = 0) => z.number().int().min(min).nullable().default(null);
const optionalBool = () => z.boolean().nullable().default(null);
const optionalStr = (max = 200) => z.string().trim().max(max).default("");

export const opConfigSchema = z.object({
  version: z.number().int().positive(),
  effectiveFrom: z.number().int().nonnegative(),
  publishedBy: z.string().default(""),
  /**
   * Required by the publish route, not by the schema — the seeded version has
   * nobody to attribute and no change to explain, and a schema that demanded
   * one would make the fallback unconstructable.
   */
  note: z.string().default(""),

  /**
   * The assistant.
   *
   * All four fields, not just the model: a deployment that changes provider
   * almost always changes the endpoint in the same breath, and splitting them
   * across two mechanisms is how one ends up posting a DeepSeek key to
   * api.openai.com. The API key is **not** here — it is the `llm` credential
   * slot, and always was.
   *
   * `smallModel` empty means "use `model`", which is what the gateway's
   * resolution already does; a deployment whose provider has no cheap tier
   * simply leaves it blank rather than repeating itself.
   */
  llm: z
    .object({
      provider: optionalStr(60),
      model: optionalStr(120),
      smallModel: optionalStr(120),
      baseUrl: optionalStr(300),
    })
    .default({}),

  /**
   * Transcription.
   *
   * `settings` is opaque on purpose: the keys belong to the providers, and
   * enumerating them here would mean adding a provider edits this file, the
   * console and every deployed task definition. It was `KELABO_STT_PROVIDERS`,
   * a JSON blob in an environment variable, for exactly the same reason.
   */
  stt: z
    .object({
      provider: optionalStr(60),
      /** A language code, or "multi" for auto-detection. */
      language: optionalStr(20),
      settings: z.record(z.string(), z.record(z.string(), z.any())).default({}),
    })
    .default({}),

  /**
   * Outbound mail.
   *
   * The reason this one cannot wait for a deploy arrives from outside: SES
   * production access is granted case by case and is regularly refused, and a
   * permanently sandboxed account can mail only addresses verified one at a
   * time — which is not a service. Switching provider becomes a publish plus a
   * key in the `mail` credential slot.
   *
   * `fromAddress` moves with it, because the address has to be one the
   * *provider* has verified. That is also why the Lambda's `ses:SendEmail`
   * grant is fenced by sending domain rather than by exact address — see
   * `infra/lib/lambda-stack.js`.
   */
  mail: z
    .object({
      provider: optionalStr(40),
      fromAddress: optionalStr(200),
    })
    .default({}),

  /**
   * The trigger gate and the orchestrator (`gateway/src/agent/`).
   *
   * The knobs an operator actually turns while watching a deployment behave:
   * how eager the assistant is, how often it may speak, how long research runs.
   * Tuning these against a live room and waiting for a docker build between
   * attempts is what made them the first thing anyone asked for here.
   */
  agent: z
    .object({
      /** 0 = unlimited. Bounded per kelabo regardless; this protects a low-quota key. */
      maxConcurrentRuns: optionalInt(0),
      maxDispatchPerTurn: optionalInt(0),
      sensitivity: optionalStr(20),
      maxContributionsPerMinute: optionalInt(0),
      cooldownSeconds: optionalInt(0),
      rollingWindowSize: optionalInt(1),
      turnTimeoutSeconds: optionalInt(0),
      /** Wall-clock research budget per turn; 0 disables. */
      turnDeadlineSeconds: optionalInt(0),
    })
    .default({}),

  /**
   * Conference audio defaults.
   *
   * These set what a **new** kelabo is created with. An existing one keeps the
   * `rtcMode` stamped on its META — a kelabo's transport never changes after
   * creation (see AGENTS.md), and publishing a new default must not be a way
   * around that rule for a call already in progress.
   */
  rtc: z
    .object({
      defaultMode: optionalStr(10),
      meshMaxParticipants: optionalInt(1),
      iceTtlSeconds: optionalInt(60),
      disconnectGraceSeconds: optionalInt(0),
      video: optionalBool(),
    })
    .default({}),

  /** Sign-in code lifetimes and the rate limits around them. */
  otp: z
    .object({
      ttlSeconds: optionalInt(30),
      maxAttempts: optionalInt(1),
      resendSeconds: optionalInt(0),
      perEmailWindowSeconds: optionalInt(1),
      perEmailMaxRequests: optionalInt(1),
      perIpWindowSeconds: optionalInt(1),
      perIpMaxRequests: optionalInt(1),
    })
    .default({}),

  /**
   * The spoken join code. `redeemPerIp*` is the control that actually bounds
   * guessing, so it is the one to tighten if a deployment sees fishing.
   */
  joinCode: z
    .object({
      ttlSeconds: optionalInt(10),
      mintPerKelaboPerHour: optionalInt(1),
      redeemPerIpWindowSeconds: optionalInt(1),
      redeemPerIpMaxRequests: optionalInt(1),
    })
    .default({}),

  /**
   * Session and token lifetimes.
   *
   * Shortening one takes effect on the next token minted, never on tokens
   * already issued — nothing here can revoke a live session, and an operator
   * tightening a TTL after an incident should know that. Revocation is its own
   * act.
   *
   * `socialProviders` is nullable rather than defaulting to `[]` because an
   * empty list is a meaningful published value ("turn social sign-in off"),
   * and it must be distinguishable from "not published".
   */
  auth: z
    .object({
      sessionTtlSeconds: optionalInt(60),
      refreshTtlDays: optionalInt(1),
      participantTtlSeconds: optionalInt(60),
      agentTokenTtlDays: optionalInt(1),
      socialProviders: z.array(z.string().trim()).nullable().default(null),
    })
    .default({}),

  /**
   * Who this deployment is, and who may sign in to it.
   *
   * `allowedEmailDomain` is the tenancy boundary — the single check in
   * `otp.js` and `oidc.js` that decides whether an address may hold an account
   * at all. It is publishable because the alternative is worse in practice (a
   * deployment that acquires a second domain, or corrects a typo in its first,
   * should not need a rollout to let its own staff in), but it is the most
   * consequential value in this file and the console says so.
   *
   * Two things bound it. Publishing empty falls back to the deployment's
   * configured domain rather than opening the deployment to everyone — the
   * dangerous direction is not reachable by clearing a field. And every publish
   * is an append-only version naming who did it, so widening the gate is a
   * recorded act with the previous value still in the table.
   *
   * `organizationName` is deliberately **not** here beside it, even though it
   * sits next to it in `kelabo.json` and reads like the same kind of value. It
   * is compiled into the SPA bundle as `VITE_ORG_NAME` at build time
   * (`scripts/deploy-frontend.sh`) and no server-side code reads it at all, so
   * publishing it would change nothing anyone could see. A knob that appears to
   * work and does not is worse than an absent one: the operator edits it, saves,
   * reloads, sees the old name, and has no way to tell that from a broken save.
   * It becomes publishable when the SPA fetches its bootstrap at run time, and
   * that is a separate change.
   */
  org: z.object({ allowedEmailDomain: optionalStr(200) }).default({}),

  /** May a kelabo link a contact outside the tenant (docs 18)? */
  contacts: z.object({ external: optionalBool() }).default({}),

  /**
   * How long kelabo material is kept.
   *
   * Publishable, with one asymmetry worth knowing: this stamps a `ttl` on items
   * as they are written, so a change reaches **new** material only. Lengthening
   * it does not resurrect what has already expired, and shortening it does not
   * reach back to shorten what is already stored.
   */
  retentionDays: optionalInt(1),
});

/**
 * The seeded configuration: nothing published, everything falling back.
 *
 * Deliberately empty rather than a copy of some environment's values. A
 * deployment that has published nothing has, by definition, not stated a
 * preference, and guessing on its behalf is how an environment ends up quietly
 * running settings nobody chose. Every consumer falls back to its own config
 * when a field here is unset (see `resolveOpConfig`), so an existing deployment
 * upgrading into this changes nothing at all until someone publishes.
 */
export const DEFAULT_OPCONFIG = Object.freeze(
  opConfigSchema.parse({
    version: 1,
    effectiveFrom: 0,
    publishedBy: "",
    note: "seeded default — nothing published",
  }),
);

/** Strip the DynamoDB keys off a stored version and validate what is left. */
export function parseOpConfig(item) {
  if (!item || typeof item !== "object") throw new Error("op-config: not an object");
  const { PK, SK, ...rest } = item;
  // The version is authoritative in the sort key — that is what makes the
  // partition ordered — so a row whose attribute drifted from its key is read
  // by its key rather than trusted.
  const fromKey = SK ? opConfigVersionFromSk(SK) : undefined;
  return opConfigSchema.parse(Number.isFinite(fromKey) && fromKey > 0 ? { ...rest, version: fromKey } : rest);
}

/** The stored item: keys plus the validated config. */
export function opConfigItem(cfg) {
  const parsed = opConfigSchema.parse(cfg);
  return { PK: OPCONFIG_PK, SK: opConfigSk(parsed.version), ...parsed };
}

/** The version in effect at an instant. */
export const pickOpConfig = pickVersion;

/**
 * Both services' op-config reader — same TTL, same failure behaviour, same
 * machinery. See `versioned.js`: a read that fails keeps serving the last known
 * version rather than reverting to the seeded defaults, because a deployment
 * that silently fell back to bootstrap values mid-day would be far harder to
 * diagnose than one running slightly stale settings.
 */
export function createOpConfigCache({ fetchItems, ttlMs = 60_000, now = () => Date.now(), onError } = {}) {
  const cache = createVersionedCache({
    fetchItems,
    parse: parseOpConfig,
    fallback: DEFAULT_OPCONFIG,
    label: "op-config",
    ttlMs,
    now,
    onError,
  });
  return {
    current: () => cache.current(),
    history: () => cache.history(),
    status: () => cache.status(),
    invalidate: () => cache.invalidate(),
  };
}

/**
 * Fold a published op-config over a service's own environment config.
 *
 * See the header for why the sentinel is `null` and not falsiness. The two
 * helpers are separate for exactly that reason and must not be merged:
 * `str` keeps the "empty means unset" rule that a text input needs, `val`
 * accepts `0` and `false` as the published values they are.
 *
 * @param {object} cfg - the service's own config (env / kelabo.json): the bootstrap
 * @param {object} op  - a parsed op-config version
 */
export function resolveOpConfig(cfg, op) {
  const str = (published, fallback) => (published ? published : fallback);
  const val = (published, fallback) => (published === null || published === undefined ? fallback : published);
  const o = op ?? DEFAULT_OPCONFIG;
  const agent = cfg?.gateway?.agent ?? cfg?.agent ?? {};
  return {
    llm: {
      provider: str(o.llm.provider, cfg?.llm?.provider ?? ""),
      model: str(o.llm.model, cfg?.llm?.model ?? ""),
      smallModel: str(o.llm.smallModel, cfg?.llm?.smallModel ?? ""),
      // `openaiBaseUrl` is what the gateway calls its own copy of this; both
      // are checked so neither service has to rename its config to adopt this.
      baseUrl: str(o.llm.baseUrl, cfg?.llm?.baseUrl ?? cfg?.openaiBaseUrl ?? ""),
    },
    stt: {
      provider: str(o.stt.provider, cfg?.stt?.provider ?? ""),
      language: str(o.stt.language, cfg?.stt?.language ?? "en"),
      // Merged, not replaced: a published block that configures one provider
      // must not silently drop the settings of another the deployment still
      // dispatches to.
      settings: { ...(cfg?.stt?.providers ?? {}), ...o.stt.settings },
    },
    mail: {
      // `ses` last rather than `""`: unlike a payment provider, mail has no
      // "off" state — a deployment that cannot send a sign-in code cannot sign
      // anyone in — so the floor is the transport that needs no key.
      provider: str(o.mail.provider, cfg?.mail?.provider || "ses"),
      fromAddress: str(o.mail.fromAddress, cfg?.mail?.fromAddress ?? ""),
    },
    agent: {
      maxConcurrentRuns: val(o.agent.maxConcurrentRuns, agent.maxConcurrentRuns ?? 0),
      maxDispatchPerTurn: val(o.agent.maxDispatchPerTurn, agent.maxDispatchPerTurn ?? 3),
      sensitivity: str(o.agent.sensitivity, agent.sensitivity ?? "medium"),
      maxContributionsPerMinute: val(o.agent.maxContributionsPerMinute, agent.maxContributionsPerMinute ?? 3),
      cooldownSeconds: val(o.agent.cooldownSeconds, agent.cooldownSeconds ?? 45),
      rollingWindowSize: val(o.agent.rollingWindowSize, agent.rollingWindowSize ?? 60),
      turnTimeoutSeconds: val(o.agent.turnTimeoutSeconds, agent.turnTimeoutSeconds ?? 1),
      turnDeadlineSeconds: val(o.agent.turnDeadlineSeconds, agent.turnDeadlineSeconds ?? 180),
    },
    rtc: {
      defaultMode: str(o.rtc.defaultMode, cfg?.rtc?.defaultMode ?? "sfu"),
      meshMaxParticipants: val(o.rtc.meshMaxParticipants, cfg?.rtc?.meshMaxParticipants ?? 5),
      iceTtlSeconds: val(o.rtc.iceTtlSeconds, cfg?.rtc?.iceTtlSeconds ?? 3600),
      disconnectGraceSeconds: val(o.rtc.disconnectGraceSeconds, cfg?.rtc?.disconnectGraceSeconds ?? 20),
      video: val(o.rtc.video, cfg?.rtc?.video ?? false),
    },
    otp: {
      ttlSeconds: val(o.otp.ttlSeconds, cfg?.otp?.ttlSeconds ?? 600),
      maxAttempts: val(o.otp.maxAttempts, cfg?.otp?.maxAttempts ?? 5),
      resendSeconds: val(o.otp.resendSeconds, cfg?.otp?.resendSeconds ?? 30),
      perEmailWindowSeconds: val(o.otp.perEmailWindowSeconds, cfg?.otp?.perEmailWindowSeconds ?? 3600),
      perEmailMaxRequests: val(o.otp.perEmailMaxRequests, cfg?.otp?.perEmailMaxRequests ?? 5),
      perIpWindowSeconds: val(o.otp.perIpWindowSeconds, cfg?.otp?.perIpWindowSeconds ?? 3600),
      perIpMaxRequests: val(o.otp.perIpMaxRequests, cfg?.otp?.perIpMaxRequests ?? 30),
    },
    joinCode: {
      ttlSeconds: val(o.joinCode.ttlSeconds, cfg?.joinCode?.ttlSeconds ?? 120),
      mintPerKelaboPerHour: val(o.joinCode.mintPerKelaboPerHour, cfg?.joinCode?.mintPerKelaboPerHour ?? 20),
      redeemPerIpWindowSeconds: val(
        o.joinCode.redeemPerIpWindowSeconds,
        cfg?.joinCode?.redeemPerIpWindowSeconds ?? 3600,
      ),
      redeemPerIpMaxRequests: val(o.joinCode.redeemPerIpMaxRequests, cfg?.joinCode?.redeemPerIpMaxRequests ?? 20),
    },
    auth: {
      sessionTtlSeconds: val(o.auth.sessionTtlSeconds, cfg?.auth?.sessionTtlSeconds ?? 3600),
      refreshTtlDays: val(o.auth.refreshTtlDays, cfg?.auth?.refreshTtlDays ?? 60),
      participantTtlSeconds: val(o.auth.participantTtlSeconds, cfg?.auth?.participantTtlSeconds ?? 43200),
      agentTokenTtlDays: val(o.auth.agentTokenTtlDays, cfg?.auth?.agentTokenTtlDays ?? 90),
      socialProviders: val(o.auth.socialProviders, cfg?.auth?.socialProviders ?? []),
    },
    org: { allowedEmailDomain: str(o.org.allowedEmailDomain, cfg?.allowedEmailDomain ?? "") },
    contacts: { external: val(o.contacts.external, cfg?.contacts?.external ?? false) },
    retentionDays: val(o.retentionDays, cfg?.retentionDays ?? 30),
  };
}

/**
 * The same fold, written back into the **service's own config shape**.
 *
 * `resolveOpConfig` groups values the way the console shows them (`agent`,
 * `org`); the services hold them the way `config/kelabo.json` does
 * (`gateway.agent`, a top-level `allowedEmailDomain`). Consumers want the
 * second, and this exists so adopting published config is a one-line change at
 * each call site — `config.otp.maxAttempts` becomes
 * `(await settings()).otp.maxAttempts` and nothing else moves.
 *
 * That matters more than the convenience. The alternative was every consumer
 * learning a second shape, and a consumer that reads the wrong one does not
 * fail: it silently keeps the deployment's value and the published setting has
 * no effect, which is the exact failure mode this whole mechanism exists to
 * remove. One translation, here, and the call sites cannot get it wrong.
 *
 * Spread over the original rather than replacing it, so fields nothing
 * publishes — `stt.providers`' per-provider blocks the schema does not know
 * about, `mail.ses.region`, `auth.socialProviders` on a service that does not
 * publish it — survive untouched.
 */
export function applyOpConfig(cfg, op) {
  const r = resolveOpConfig(cfg, op);
  return {
    ...cfg,
    llm: { ...(cfg?.llm ?? {}), ...r.llm },
    // The gateway's own name for `llm.baseUrl`. Kept in step so a service that
    // reads either one gets the published value.
    openaiBaseUrl: r.llm.baseUrl,
    stt: { ...(cfg?.stt ?? {}), provider: r.stt.provider, language: r.stt.language, providers: r.stt.settings },
    mail: { ...(cfg?.mail ?? {}), provider: r.mail.provider, fromAddress: r.mail.fromAddress },
    gateway: { ...(cfg?.gateway ?? {}), agent: { ...(cfg?.gateway?.agent ?? {}), ...r.agent } },
    agent: { ...(cfg?.agent ?? {}), ...r.agent },
    rtc: { ...(cfg?.rtc ?? {}), ...r.rtc },
    otp: { ...(cfg?.otp ?? {}), ...r.otp },
    joinCode: { ...(cfg?.joinCode ?? {}), ...r.joinCode },
    auth: { ...(cfg?.auth ?? {}), ...r.auth },
    allowedEmailDomain: r.org.allowedEmailDomain,
    contacts: { ...(cfg?.contacts ?? {}), external: r.contacts.external },
    retentionDays: r.retentionDays,
  };
}
