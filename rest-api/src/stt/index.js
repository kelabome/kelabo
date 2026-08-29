import { sttSessionSchema } from "@kelabo/contracts/schemas";
import { sttKeyFrom } from "@kelabo/contracts/credentials";
import { err } from "../errors.js";
import { sttProvider } from "./interface.js";

// Minting a transcription session: everything that is the same whoever
// transcribes. Nothing in this file names a provider.
//
// The browser streams audio *directly* to the provider and never through
// Kelabo, so the only thing standing between a kelabo's audio and somebody
// else's bill is this endpoint. Hence the order: prove the kelabo is live and
// the caller is in it BEFORE the long-lived key is even read, so a stranger
// asking for a credential never reaches the credential store, let alone the provider.

export function createSttToken({ config, db, credentials, opConfig, fetchImpl = fetch }) {
  // Engine, language and the per-provider block are published operational
  // config (contracts/src/opconfig.js), resolved per mint. Falls back to this
  // deployment's own config where nothing is published — and to `config`
  // entirely when no `opConfig` was injected, which is what keeps the existing
  // tests and a table-less local run working unchanged.
  const settings = async () => (opConfig ? await opConfig.resolved() : { stt: config.stt });

  /**
   * @param {{kelaboId: string, participant: {identity: string},
   *          opts?: {language?: string, diarize?: boolean}}} args
   * @returns {Promise<import("@kelabo/contracts/typedefs").SttSession>}
   */
  async function mint({ kelaboId, participant, opts = {} }) {
    const meta = await db.getKelaboMeta(kelaboId);
    if (!meta) throw err(404, "kelabo_not_found");
    if (meta.status !== "active") throw err(410, "kelabo_ended");
    const isParticipant = (meta.participants || []).some((p) => p.identity === participant.identity);
    if (!isParticipant && meta.hostIdentity !== participant.identity) throw err(403, "forbidden");

    // Resolved after the participant check, deliberately: a stranger asking for
    // a credential should not even cause a config read.
    const stt = (await settings()).stt ?? {};
    const id = stt.provider;
    let provider;
    try {
      provider = sttProvider(id);
    } catch (e) {
      // A deployment configured for a provider this build does not carry. That
      // is an operator mistake, not a caller's, but it degrades the same way
      // every other missing capability does (docs 19): captions stop, the board
      // and the call do not.
      throw err(502, "stt_unavailable", String(e));
    }

    let key;
    try {
      // One credential holding a key per engine, so switching engines is a
      // config change and never a credential rotation. The slot is the
      // address now — there is no published secret name to resolve first.
      key = sttKeyFrom(await credentials.get("stt"), id);
    } catch (e) {
      // Refused, never silently switched. Falling back to whichever key the
      // credential happens to hold would put us back where this started:
      // capturing on one supplier and billing at another's rate, with nothing
      // to show that it had happened.
      throw err(502, "stt_unavailable", String(e));
    }

    let session;
    try {
      session = await provider.mint({
        key,
        // The provider's own block, and nothing else. The core knows no key of
        // it — not even a credential lifetime, which sounds shared and is not:
        // a Deepgram grant is spent on one socket and wants seconds, a Soniox
        // temporary key opens many streams and wants minutes so it can be
        // refreshed between them rather than on the critical path of one.
        // `settings` on a resolved op-config is the published per-provider map
        // merged over the deployment's `stt.providers`, so a published block
        // for one engine never silently drops another's.
        settings: (stt.settings ?? stt.providers)?.[id] || {},
        opts: {
          kelaboId,
          language: typeof opts.language === "string" && opts.language.trim()
            ? opts.language.trim()
            : stt.language,
          diarize: opts.diarize === true,
        },
        fetchImpl,
      });
    } catch (e) {
      // A provider may throw a shaped error (an expired key, a quota) or a bare
      // one. Either way the caller learns the same thing, because there is
      // nothing useful or safe a browser can do with a provider's internals.
      if (e && e.status) throw e;
      throw err(502, "stt_unavailable", String(e));
    }

    // Validated on the way out: the failure this catches is a provider module
    // returning the wrong shape, and its symptom in the browser is a socket
    // that opens and transcribes nothing, with no error anywhere. `provider` is
    // stamped here from the registry key rather than taken from the provider,
    // so what the client resolves is always what the server dispatched to.
    try {
      return sttSessionSchema.parse({ ...session, provider: id });
    } catch (e) {
      throw err(502, "stt_unavailable", `provider ${id} returned an unusable session: ${e}`);
    }
  }

  return { mint };
}
