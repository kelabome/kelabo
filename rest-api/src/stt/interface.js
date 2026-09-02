import { deepgramProvider } from "./deepgram.js";
import { sonioxProvider } from "./soniox.js";
import { fakeProvider } from "./fake.js";

// The STT provider interface, server half — and the registry that resolves it.
//
// A provider's only job here is to turn a long-lived API key into a credential a
// browser may hold, and to say what that browser should send. It is handed
// everything it needs and reaches for nothing: no DynamoDB, no Secrets Manager,
// no `process.env`, no config object it could read another provider's settings
// out of. That is what makes each one testable offline and what keeps adding
// one from touching any of the others.
//
// The core (./index.js) owns everything that is the same whoever transcribes:
// the kelabo lookup, the participant check, reading the secret, and mapping any
// failure to `stt_unavailable`. It names no provider.
//
/**
 * @typedef {object} SttMintContext
 * @property {string} key       the provider's API key, already read from Secrets
 *   Manager by the core. A provider never learns the secret's name or how to
 *   fetch it.
 * @property {Object} settings  `config.stt.providers[id]` — this provider's own
 *   block, and only its own. Opaque to the core, which never reads a key of it.
 * @property {{kelaboId: string, language?: string, diarize?: boolean}} opts
 *   the neutral request. `language` is an ISO code or the deployment default;
 *   turning it into a model, a hint list or nothing at all is the provider's
 *   business.
 * @property {typeof fetch} fetchImpl  injected so the whole thing runs offline
 *   in `rest-api/test/smoke.mjs`.
 */
/**
 * @typedef {object} SttProvider
 * @property {string} id
 * @property {(ctx: SttMintContext) => Promise<Omit<SttSession, "provider">>} mint
 *   The `provider` field is stamped by the core from the registry key, so a
 *   provider cannot claim to be a different one than the one that was asked for.
 */
/** @typedef {import("@kelabo/contracts/typedefs").SttSession} SttSession */

/** @type {Record<string, SttProvider>} */
const PROVIDERS = {
  [deepgramProvider.id]: deepgramProvider,
  [sonioxProvider.id]: sonioxProvider,
  // Transcribes nothing; exists so `e2e/` can drive the capture pipeline in a
  // browser without a supplier account. Registered here rather than injected,
  // because a registry a test can extend is a registry the product does not
  // really have — see ./fake.js for why it cannot be selected by accident.
  [fakeProvider.id]: fakeProvider,
};

/**
 * Resolve a provider by id.
 *
 * An unknown id throws rather than falling back to a default, for the reason
 * `connector/src/runtimes.js` gives for runtimes: a default here would mint a
 * credential for a service the browser is not talking to, and the browser would
 * then open a socket that fails authentication for reasons nothing in the
 * config explains.
 *
 * @param {string} id
 * @returns {SttProvider}
 */
export function sttProvider(id) {
  const provider = PROVIDERS[id];
  if (!provider) {
    throw new Error(
      `unknown stt provider: ${JSON.stringify(id)} (have: ${sttProviderIds().join(", ")})`,
    );
  }
  return provider;
}

/** Every registered provider id. */
export function sttProviderIds() {
  return Object.keys(PROVIDERS);
}
