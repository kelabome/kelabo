import { z } from "zod";

/**
 * Supplier credentials, in DynamoDB.
 *
 * ## What moved, and what did not
 *
 * The **supplier** credentials — the LLM key, the transcription keys, the
 * Cloudflare Realtime app credentials and the mail provider's token — live
 * here now, in their own table, encrypted with a customer-managed key. They used
 * to be Secrets Manager secrets whose *names* were carried in the deployment
 * config, which is why nothing needs to publish a `secret` name for a slot any
 * more: the slot **is** the address.
 *
 * Two credentials deliberately did **not** move, and the distinction is the
 * whole safety argument for this file:
 *
 *   - the **cookie signing key**, which signs all three token families (browser
 *     sessions, the internal REST→Gateway JWT, agent tokens). Anyone holding it
 *     can mint a session for any user in any tenant. It is read once per cold
 *     start, is never edited by an operator, and has no rotation story that a
 *     console improves — so there is nothing to gain here and a great deal to
 *     lose.
 *   - the **CloudFront origin secret**, which is the perimeter check. Same
 *     shape of argument: read at cold start, rotated by redeploying two stacks
 *     together, never touched from a console.
 *
 * The line is *identity and perimeter stay in Secrets Manager; suppliers come
 * here.* A supplier key that leaks costs money and is rotated at
 * the supplier. A cookie key that leaks is every account in the deployment, and
 * no rotation undoes the sessions already minted with it.
 *
 * ## Why this is a separate table
 *
 * Not a table anything else reads. Every other table in the deployment is
 * scanned by admin tooling, exported by bulk scripts and encrypted with the
 * AWS-owned default key. This one:
 *
 *   - has its **own customer-managed key**, so the material can be made
 *     unreadable by revoking a key rather than by unpicking table grants;
 *   - is **keyed per slot** (`PK = CRED#<slot>`), so IAM can be written as a
 *     `dynamodb:LeadingKeys` condition naming exactly the slots a component may
 *     read — the gateway gets `CRED#llm` and `CRED#rtc` and nothing else, which
 *     is the same shape the Secrets Manager prefix grants had;
 *   - is **excluded from every reset and export script**, because the one thing
 *     that made the old design safe was that no bulk tool could ever emit a
 *     credential.
 *
 * A single `PK = CRED` partition with the slot in the sort key would have made
 * "list every slot" one Query, and was rejected for that reason: it would make
 * every slot readable by anything that could read one.
 *
 * ## What is stored
 *
 * The value verbatim, as a string, exactly as it went into Secrets Manager —
 * JSON for the multi-field slots, a bare string for a single key. It is not
 * parsed on write and not re-encoded, so a credential round-trips byte for
 * byte and a supplier whose key happens to look like JSON is not mangled.
 */

/**
 * The slots a deployment can hold a supplier credential in.
 *
 * Named rather than free-form, so the console renders a fixed set of rows and
 * the write route can refuse a slot it does not know. A free-form key would let
 * a typo create a credential nothing ever reads, which looks identical to one
 * that was never set.
 *
 * `mail` is the odd one, and only because it may legitimately be **empty**:
 * sending through SES needs no key at all — the Lambda authenticates with its
 * own IAM role — so an unset `mail` slot is a working configuration rather than
 * a missing one. It is a slot regardless, since the day SES refuses production
 * access is the day that stops being true, and a supplier key belongs in the
 * credentials table whatever the supplier.
 */
export const CREDENTIAL_SLOTS = Object.freeze(["llm", "stt", "rtc", "mail"]);
export const isCredentialSlot = (slot) => CREDENTIAL_SLOTS.includes(slot);

/**
 * **The fields each slot may hold, and nothing else.**
 *
 * This is the part that was missing, and the omission was not theoretical. A
 * credential used to be a free-form JSON blob pasted into a textarea, so the
 * `stt` secret in one deployment accumulated four keys —
 * `deepgram`, `soniox`, and the typos **`oniox`** and **`onionx`** — over
 * however many attempts it took to spell it right. Nothing rejected them,
 * nothing reported them, and the lookup accepted
 * `s[provider] || s.apiKey || s.key || s.value`, so a deployment could sit on a
 * key stored under a misspelling and behave identically until the day the
 * fallback chain picked a different one.
 *
 * A closed field list per slot fixes the class, not the instance: an unknown
 * key is refused at the write route, and the console renders one input per
 * field instead of a blob, so "which of these is actually set?" is a thing you
 * can see rather than a thing you infer.
 *
 * `required` means the capability does not work without it. Optional fields are
 * genuinely optional — see `rtc` below, where TURN degrades rather than breaks.
 */
export const CREDENTIAL_FIELDS = Object.freeze({
  llm: Object.freeze([
    {
      key: "apiKey",
      label: "LLM API key",
      hint: "The only assistant setting that is a credential. Provider, model and endpoint come from the deployment's environment — see LLM_CONFIG below.",
      required: true,
    },
  ]),
  stt: Object.freeze([
    // One key per engine, and exactly these two. Which one runs is the rate
    // card's `sttEngine`, so both may legitimately be set at once — that is
    // what makes switching engines a publish rather than a credential change.
    { key: "soniox", label: "Soniox API key", hint: "Used when the rate card names soniox.", required: false },
    { key: "deepgram", label: "Deepgram API key", hint: "Used when the rate card names deepgram.", required: false },
  ]),
  rtc: Object.freeze([
    { key: "sfuAppId", label: "SFU app ID", hint: "Cloudflare Realtime application.", required: true },
    { key: "sfuAppSecret", label: "SFU app secret", required: true },
    /**
     * TURN is **optional but not unused**, and the distinction matters.
     *
     * Without these two, `iceServers()` returns Cloudflare's public STUN and
     * `relay: false`, and calls still connect — for most people. What stops
     * working is the case STUN cannot solve: a symmetric NAT, or a corporate
     * network that blocks direct UDP between peers. Mesh needs a relay to
     * traverse those at all, and the SFU falls back to one when the direct
     * path fails.
     *
     * So leaving them empty is a supported configuration that degrades on
     * restrictive networks, not a tidy-up.
     */
    { key: "turnKeyId", label: "TURN key ID", hint: "Optional. Without it, calls fall back to STUN only and fail behind symmetric NAT or a corporate firewall.", required: false },
    { key: "turnKeyApiToken", label: "TURN API token", hint: "Optional, and only meaningful with the key ID.", required: false },
  ]),
  mail: Object.freeze([
    // One key per provider, exactly like `stt`, and for the same reason: which
    // one is used is op-config's `mail.provider`, so switching provider is a
    // publish rather than a scramble to re-enter a credential that is still
    // perfectly good. Nothing is required — the SES transport takes no key.
    {
      key: "mailersend",
      label: "MailerSend API token",
      hint: "Only needed when mail.provider is mailersend. Sending through SES uses this deployment's IAM role and needs no key.",
      required: false,
    },
  ]),
});

/** The field keys a slot accepts, as a plain array. */
export const credentialFieldKeys = (slot) => (CREDENTIAL_FIELDS[slot] ?? []).map((f) => f.key);

/**
 * Validate a credential against its slot's field list.
 *
 * Returns what was kept, what was refused and what a working capability is
 * still missing. It does **not** throw on an unknown key: the caller decides,
 * and the write route refuses while the migration reports and drops — which is
 * how the `oniox`/`onionx` pair gets cleaned up rather than carried forward.
 */
export function validateCredentialFields(slot, input) {
  if (!isCredentialSlot(slot)) throw new Error(`credential: unknown slot "${slot}"`);
  const allowed = credentialFieldKeys(slot);
  const obj = input && typeof input === "object" ? input : {};
  const fields = {};
  const unknown = [];
  for (const [key, value] of Object.entries(obj)) {
    const text = String(value ?? "").trim();
    if (!allowed.includes(key)) {
      unknown.push(key);
      continue;
    }
    // An empty string is "not set" rather than "set to empty" — the same rule
    // the published config uses, and it lets a form submit every field it
    // renders without blanking the ones nobody typed into.
    if (text) fields[key] = text;
  }
  const missing = (CREDENTIAL_FIELDS[slot] ?? [])
    .filter((f) => f.required && !fields[f.key])
    .map((f) => f.key);
  return { fields, unknown, missing };
}

/** One partition per slot, so IAM can name them individually. */
export const credentialPk = (slot) => `CRED#${slot}`;
export const CREDENTIAL_SK = "META";

/**
 * **The item's non-secret attributes — the ones a component may read without
 * being allowed to read the credential.**
 *
 * This list is the single source of truth for two things that must never
 * disagree: the `ProjectionExpression` of the status read
 * (`rest-api/src/db.js` `getCredentialStatus`) and the `dynamodb:Attributes`
 * condition on the REST API's IAM grant (`infra/lib/lambda-stack.js`). If they
 * drifted, one of two failures follows — a projection naming an attribute the
 * policy does not allow is denied outright, and a policy allowing an attribute
 * the projection does not name is a boundary that is not actually there.
 *
 * **Why this exists at all.** Under Secrets Manager the control plane held
 * `secretsmanager:DescribeSecret` on the supplier secrets and never
 * `GetSecretValue`: it could answer "is the assistant configured?" for the
 * capability map (docs 19 §3) without being able to read the key. Moving to
 * DynamoDB lost that for free, because "does the item exist" and "what is in
 * it" are the same `GetItem`. `dynamodb:Attributes` + `dynamodb:Select` is the
 * equivalent: an attribute-scoped `GetItem` is `DescribeSecret`, a whole-item
 * one is `GetSecretValue`, and IAM can grant the first without the second — but
 * only if there is a non-secret attribute that answers the question, which is
 * what `configured` below is for.
 *
 * `PK` and `SK` are in the list for IAM's sake rather than the status's. A
 * `dynamodb:Attributes` condition that omits a table's key attributes denies
 * the request: the `Key` of a `GetItem` counts as attributes the request
 * accesses, and DynamoDB says so explicitly ("you must specify the names of all
 * of the primary key and index key attributes"). They carry nothing secret —
 * `CRED#llm` / `META` is the address, which the caller already had.
 */
export const CREDENTIAL_STATUS_ATTRS = Object.freeze([
  "PK",
  "SK",
  "slot",
  "configured",
  "version",
  "rotatedAt",
  "rotatedBy",
  "createdAt",
]);

/** The slot back out of a partition key, or `""` if it is not one. */
export const credentialSlotFromPk = (pk) => {
  const m = /^CRED#(.+)$/.exec(String(pk ?? ""));
  return m && isCredentialSlot(m[1]) ? m[1] : "";
};

/**
 * What a console is allowed to learn about a credential without reading it:
 * that it is there, when it last moved, and who moved it. Never the value, and
 * never a prefix of it — a "last four" affordance is how a key ends up in a
 * screenshot in a support thread.
 */
export const credentialStatusSchema = z.object({
  // Built from the list above rather than repeated. Restated, it silently
  // stopped validating the moment a fifth slot was added — the console would
  // have rendered `mail` and this schema would have rejected its status, in a
  // place nothing tests.
  slot: z.enum(CREDENTIAL_SLOTS),
  configured: z.boolean(),
  version: z.number().int().nonnegative().default(0),
  rotatedAt: z.number().int().nullable().default(null),
  rotatedBy: z.string().default(""),
  /**
   * Which fields are set, as booleans. Never the values.
   *
   * "The blob is set" was all the console could say, which is exactly how a key
   * stored under a misspelling looked identical to one stored correctly. Per
   * field, "soniox: set, deepgram: not set" is a sentence an operator can act
   * on.
   */
  fields: z.record(z.string(), z.boolean()).default({}),
  /** Field names present in storage that the slot does not define — the typos. */
  unknown: z.array(z.string()).default([]),
});

/**
 * The stored item.
 *
 * `version` counts rotations. It is not a history — there is exactly one item
 * per slot and a rotation overwrites it. That is deliberate: a credential's
 * previous value is not an audit record, it is a live key that somebody could
 * still use, and keeping every one a deployment ever held in a table would be
 * strictly worse than keeping none. What *is* kept is the count, the time and
 * the author, which is what an operator actually asks ("has this been changed
 * since Tuesday, and by whom?").
 *
 * No `ttl`. A credential that expired itself would take a live capability down
 * with nothing to say why.
 *
 * `configured` is a **marker, not data**: it is always `true`, because
 * `credentialItem` refuses an empty value, so writing the row at all is what it
 * records. It exists so that "is this capability configured?" can be answered
 * by reading an attribute that is not the credential — see
 * `CREDENTIAL_STATUS_ATTRS`. Deriving it from `value` was free and is exactly
 * what cost the boundary: the only way to ask the question was to read the
 * answer.
 */
export function credentialItem({ slot, value, version = 1, rotatedBy = "", at = Date.now() }) {
  if (!isCredentialSlot(slot)) throw new Error(`credential: unknown slot "${slot}"`);
  if (typeof value !== "string" || !value) throw new Error("credential: value must be a non-empty string");
  return {
    PK: credentialPk(slot),
    SK: CREDENTIAL_SK,
    slot,
    value,
    configured: true,
    version: Math.max(1, Math.floor(Number(version) || 1)),
    rotatedBy: String(rotatedBy ?? ""),
    rotatedAt: at,
    createdAt: at,
  };
}

/**
 * The status projection of a stored item — everything except the value.
 *
 * Written as an explicit pick rather than a destructured rest, so that adding
 * an attribute to the item cannot leak it to the console by default.
 *
 * **Takes either shape of item.** A whole row, or a row read through the
 * `CREDENTIAL_STATUS_ATTRS` projection, which has no `value` attribute at all —
 * that projection is the point of the whole arrangement, so this has to work
 * without one. `configured` is therefore decided in three steps:
 *
 *   1. the `configured` marker, if the row carries it. Every row written since
 *      the marker was added does.
 *   2. otherwise, if the row carries `value`, the old value-derived check. This
 *      is the **legacy path**: rows written before the marker existed, read
 *      whole by a component that may read them.
 *   3. otherwise — no marker *and* no `value` attribute — `true`. That is a
 *      legacy row seen through the projection, where there is by construction
 *      nothing left to check, and the row existing is the signal (docs 19 §3),
 *      which is exactly what "configured" meant before the marker. `false` here
 *      would be worse than wrong: it would report a working deployment's
 *      capability as off, silently, until the slot was next written.
 *
 * `fields` and `unknown` are derived from the value and so are empty for a
 * projected row: per-field detail is information about the credential, and a
 * component that may not read it does not get it. A component that may (the
 * gateway, an operator script) passes a whole row and gets the full picture.
 */
export function credentialStatus(slot, item) {
  const blank = { slot, configured: false, version: 0, rotatedAt: null, rotatedBy: "", fields: {}, unknown: [] };
  if (!item) return { ...blank, fields: Object.fromEntries(credentialFieldKeys(slot).map((k) => [k, false])) };
  const parsed = parseCredential(item.value) ?? {};
  const present = new Set(Object.keys(parsed).filter((k) => String(parsed[k] ?? "").trim()));
  return {
    slot,
    configured:
      typeof item.configured === "boolean"
        ? item.configured
        : "value" in item
          ? typeof item.value === "string" && item.value.length > 0
          : true,
    version: Number(item.version) || 0,
    rotatedAt: Number(item.rotatedAt) || null,
    rotatedBy: String(item.rotatedBy ?? ""),
    // Booleans only. Built from the slot's field list rather than from what
    // storage happens to hold, so a field nobody has set still appears (as
    // false) and a stray one cannot masquerade as a real field.
    fields: Object.fromEntries(credentialFieldKeys(slot).map((k) => [k, present.has(k)])),
    unknown: [...present].filter((k) => !credentialFieldKeys(slot).includes(k)),
  };
}

/**
 * Parse a stored credential into whatever the caller needs.
 *
 * JSON where it parses, `{ value }` where it does not — the same shape
 * `getSecretJson` had, so every consumer of a supplier credential is unchanged
 * by the move.
 */
export function parseCredential(raw) {
  if (typeof raw !== "string" || !raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : { value: raw };
  } catch {
    return { value: raw };
  }
}

/**
 * Pull the key for one STT engine out of the `stt` credential.
 *
 * `{ "soniox": "…", "deepgram": "…" }` — one credential holding a key per
 * engine, so switching engines is a rate-card publish rather than a credential
 * rotation.
 *
 * The provider is passed in rather than read from config, because which engine
 * runs is the rate card's decision — and a key looked up under a different name
 * than the one that was dispatched to is how capture and pricing came apart
 * before.
 *
 * **The name is exact.** There used to be an `|| s.apiKey || s.key || s.value`
 * fallback chain "so a credential written for a single-provider deployment
 * keeps working", and what it actually did was make a key stored under a
 * misspelling indistinguishable from a correct one until the chain happened to
 * pick differently. The field list is closed now; a missing key is an error,
 * loudly, at mint time.
 */
export function sttKeyFrom(credential, provider) {
  const key = (credential ?? {})[provider];
  if (!key) throw new Error(`no key for stt provider ${provider} in credential`);
  return key;
}

/**
 * Pull the key for one mail provider out of the `mail` credential.
 *
 * Same shape and same exactness as `sttKeyFrom`, with one difference that is
 * the whole point: **an empty answer is legal here.** SES takes no key — it
 * authenticates with the deployment's own IAM role — so an absent credential is
 * a working configuration rather than a fault, and it is the transport, not
 * this function, that decides whether it needed one. Throwing on a missing key
 * would make an SES deployment unable to send a single sign-in code.
 */
export function mailKeyFrom(credential, provider) {
  return (credential ?? {})[provider] || "";
}

// --- MCP bearer tokens ------------------------------------------------------

/**
 * A host's pasted bearer token for one MCP server.
 *
 * These moved out of Secrets Manager for a different and much simpler reason
 * than the supplier keys: **the table they now live in already held the
 * equivalent material.** An MCP server authenticated with OAuth has its access
 * *and refresh* tokens stored as a `TOKEN#<name>` row in the mcp table, under a
 * customer-managed key. A server authenticated with a pasted bearer token had
 * that token in Secrets Manager and only a `secretRef` pointer in the row
 * beside it. Same sensitivity, same server, same user, two stores — and the
 * Secrets Manager half also cost one secret per user per server, which is the
 * only part of this system that would have scaled into real money.
 *
 * So a bearer token is now a `SECRET#<name>` row in the same partition as the
 * `SERVER#<name>` it belongs to and the `TOKEN#<name>` it is an alternative to.
 * No route returns it, exactly as before: `GET /me/mcp` reports `hasSecret`.
 */
export const mcpSecretSk = (serverName) => `SECRET#${serverName}`;

export const MCP_SECRET_SK_PREFIX = "SECRET#";

export const mcpSecretSchema = z.object({
  token: z.string().min(1),
  updatedAt: z.number().int().nonnegative(),
});

// --- the assistant -----------------------------------------------------------

/**
 * **Which model the assistant runs, as one object.**
 *
 * Provider, model, small model and endpoint used to be spread across three
 * places at once: `KELABO_LLM_*` in the task definition, an `llm` block in the
 * deployment config, and the base URL again under a different name — with a
 * resolution order that meant the value in force could not be read off any
 * single one of them. This is the one place that answers "what is this
 * deployment running?", and every consumer takes the whole object rather than
 * re-deriving three of its four fields.
 *
 * **This is the deliberate seam between self-hosted and hosted.** Here the four
 * values come from the environment the gateway is already given
 * (`KELABO_LLM_PROVIDER`, `KELABO_LLM_MODEL`, `KELABO_LLM_SMALL_MODEL`,
 * `KELABO_OPENAI_BASE_URL` — set from `config/kelabo.json` by
 * `infra/lib/gateway-ecs-stack.js`), with the same defaults `gateway/src/config.js`
 * already applies, because a self-hosted operator brings their own provider. A
 * deployment that pins a single vendor replaces these four constants and
 * nothing else: the exported names and the shape of `LLM_CONFIG` are the
 * contract, and every consumer is identical either way.
 *
 * The **API key is never here** whichever way it is sourced — it is the `llm`
 * credential slot.
 */
const llmEnv = globalThis.process?.env ?? {};

export const LLM_PROVIDER = llmEnv.KELABO_LLM_PROVIDER || "anthropic";
export const LLM_MODEL = llmEnv.KELABO_LLM_MODEL || "";
export const LLM_SMALL_MODEL = llmEnv.KELABO_LLM_SMALL_MODEL || "";
export const LLM_BASE_URL = llmEnv.KELABO_OPENAI_BASE_URL || "https://api.openai.com/v1";

/** The whole assistant configuration, as the gateway's worker expects it. */
export const LLM_CONFIG = Object.freeze({
  provider: LLM_PROVIDER,
  model: LLM_MODEL,
  smallModel: LLM_SMALL_MODEL,
  baseUrl: LLM_BASE_URL,
});

/**
 * The API key out of an `llm` credential row, in either shape it can take.
 *
 * A slot filled from `/superadmin` parses to `{ apiKey }`; one that was ever
 * stored as a bare string parses to `{ value }` (see `parseCredential`).
 * Both are live, so both are read — and *here*, once, because there is now
 * more than one caller (the agent's own worker and the journey-question
 * path) and two copies of this would drift the moment a third shape existed.
 */
export function llmApiKeyFrom(cred) {
  if (!cred || typeof cred !== "object") return null;
  if (typeof cred.value === "string" && Object.keys(cred).length === 1) return cred.value;
  return cred.apiKey ?? null;
}
