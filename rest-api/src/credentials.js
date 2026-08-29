import {
  CREDENTIAL_SLOTS,
  credentialItem,
  credentialStatus,
  isCredentialSlot,
  parseCredential,
} from "@kelabo/contracts/credentials";

/**
 * The control plane's read/write of supplier credentials.
 *
 * This is the whole of what replaced six Secrets Manager IAM statements and two
 * layers of "which name holds this slot" indirection. A slot is an address; the
 * item at that address is the credential.
 *
 * Cached with a TTL, not for the container's life, for the same reason the
 * Secrets Manager cache was: rotating a supplier key is meant to take effect
 * without a deploy, and an immortal cache meant a warm Lambda kept presenting
 * the old credential until AWS happened to recycle it — minutes or hours,
 * unpredictably, looking exactly like the rotation not having worked. Five
 * minutes, matching the gateway's, so the two halves of a rotation land
 * together.
 *
 * Takes `db` rather than a document client so the whole thing is reachable
 * through the same seam every other module uses — `createApp(deps)` with a stub
 * — and so there is exactly one place that knows the table's name and keys.
 *
 * ## Two reads, two caches
 *
 * There are two ways to read a slot here and they are **not** interchangeable.
 * `getItem` reads the whole row, credential included; `getStatusItem` reads it
 * through the `CREDENTIAL_STATUS_ATTRS` projection, which has no `value`
 * attribute in it at all. That is an IAM boundary, not a preference: the
 * deployed role may read `stt` and `mail` whole (it mints STT tokens and sends
 * mail with them) and may read `llm` and `rtc` **only** through the projection
 * (`infra/lib/lambda-stack.js`). A whole-item read of `llm` is AccessDenied.
 *
 * They therefore get **separate caches**, keyed the same way but never shared.
 * One cache would defeat the whole thing in the ordinary direction — a cheap
 * `exists("stt")` populating the entry that `get("stt")` later serves would
 * hand a caller a row with no `value` in it and it would read as unconfigured
 * — and would defeat it in the interesting direction too, by letting a
 * whole-row read of a slot satisfy a status read of it, so the code would
 * quietly stop exercising the projected path that IAM actually permits and the
 * boundary would only be discovered in production, on the slot that matters.
 *
 * `forget` drops both, because a rotation invalidates both.
 *
 * @param {object} deps
 * @param {{ getCredential: Function, getCredentialStatus: Function, putCredential: Function }} deps.db
 * @param {() => number} [deps.now]
 */
export function createCredentials({ db, now = () => Date.now(), ttlMs = 5 * 60_000 } = {}) {
  const cache = new Map();
  const statusCache = new Map();

  function forget(slot) {
    if (slot) {
      cache.delete(slot);
      statusCache.delete(slot);
    } else {
      cache.clear();
      statusCache.clear();
    }
  }

  async function getItem(slot) {
    if (!isCredentialSlot(slot)) throw new Error(`credential: unknown slot "${slot}"`);
    const hit = cache.get(slot);
    if (hit && hit.expiresAt > now()) return hit.item;
    // A deployment with no credentials table configured is not an error: it is
    // an older environment, or a test. Every consumer treats a missing
    // credential as "this capability is off", which is the same answer a
    // missing secret used to give.
    const item = (await db.getCredential(slot)) ?? null;
    cache.set(slot, { item, expiresAt: now() + ttlMs });
    return item;
  }

  /**
   * The row without the credential in it, from its own cache.
   *
   * Deliberately does not fall back to `getItem` when the projected read fails.
   * A fallback would work on `stt` and `mail` and be denied on `llm` and `rtc`,
   * which is the worst of both: the boundary would hold only where it did not
   * matter, and the two slots it exists for would take an extra AccessDenied
   * round trip on every capability probe.
   */
  async function getStatusItem(slot) {
    if (!isCredentialSlot(slot)) throw new Error(`credential: unknown slot "${slot}"`);
    const hit = statusCache.get(slot);
    if (hit && hit.expiresAt > now()) return hit.item;
    const item = (await db.getCredentialStatus(slot)) ?? null;
    statusCache.set(slot, { item, expiresAt: now() + ttlMs });
    return item;
  }

  /** The credential as an object — JSON where it parses, `{ value }` where not. */
  async function get(slot) {
    const item = await getItem(slot);
    return item ? parseCredential(item.value) : null;
  }

  /** The credential exactly as stored. Used only by the root-only reveal route. */
  async function getRaw(slot) {
    const item = await getItem(slot);
    return item?.value ?? null;
  }

  /**
   * Is this capability configured at all? (docs 19 §3.)
   *
   * Existence, not readability — the same question `DescribeSecret` answered,
   * and, through the projected read, still a question this component can ask
   * about a credential it is not allowed to read. It goes through
   * `getStatusItem` for exactly that reason: on `llm` and `rtc` the whole-item
   * read this used to do is now denied by IAM, and on `stt` and `mail` it would
   * work but would read a live key to answer a yes/no.
   *
   * A read failure reads as **configured**, because a probe hiccup must never
   * switch a working feature off; only a definitive "no item" means off. That
   * is the permissive default the capability map has always had, kept
   * deliberately — and note that an AccessDenied from a drifted policy lands
   * here as "configured", so a mistake in the grant degrades to a feature that
   * looks on and fails at use, never to one that silently disappears.
   */
  async function exists(slot) {
    if (!isCredentialSlot(slot)) return false;
    try {
      return credentialStatus(slot, await getStatusItem(slot)).configured;
    } catch {
      return true;
    }
  }

  /**
   * What the console may know: configured, when, by whom. Never the value.
   *
   * Also the projected read, so this is answerable for every slot rather than
   * only the two whose values this component may read. The cost is that
   * `fields`/`unknown` — which are derived from the value — come back empty:
   * per-field detail is information about the credential, so a component that
   * may not read the credential does not get it. A component that may (the
   * gateway, `scripts/put-credential.mjs` under an operator's own credentials)
   * passes a whole row to `credentialStatus` directly and gets the full
   * picture; `put()` below does exactly that with the row it just wrote.
   */
  async function describe(slot) {
    try {
      return credentialStatus(slot, await getStatusItem(slot));
    } catch {
      return credentialStatus(slot, null);
    }
  }

  async function describeAll() {
    return Promise.all(CREDENTIAL_SLOTS.map((slot) => describe(slot)));
  }

  /**
   * The same status, derived from the **whole** row — so `fields` and `unknown`
   * are populated.
   *
   * This exists because of the cost `describe()` documents above: read through
   * the projection and `fields` comes back all-false, so the Suppliers console
   * would render "soniox: not set, deepgram: not set" over a slot that is
   * correctly filled. That is worse than showing nothing — it is the exact
   * misreading per-field detail was added to prevent, and an operator acting on
   * it would paste a key over a working one.
   *
   * It is only answerable because this deployment has a credential-write
   * console, and the grant that serves it (`infra/lib/lambda-stack.js`, the
   * third statement) gives this role whole-item `GetItem` on every slot. On a
   * build with no such console the attribute fence binds and this read is
   * AccessDenied on `llm` and `rtc` — which is why it degrades to the blank
   * status rather than throwing, and why `exists()` and `describe()` stay on
   * the projected path regardless: the capability map must not read a live key
   * to answer a yes/no, and keeping them there is what keeps that path
   * exercised.
   *
   * **Still never returns the value.** `credentialStatus` derives booleans from
   * it and discards it; there is no path from here to key material.
   */
  async function describeFull(slot) {
    try {
      return credentialStatus(slot, await getItem(slot));
    } catch {
      return credentialStatus(slot, null);
    }
  }

  async function describeAllFull() {
    return Promise.all(CREDENTIAL_SLOTS.map((slot) => describeFull(slot)));
  }

  /**
   * Write a credential.
   *
   * A plain overwrite, and the version is read-then-incremented rather than
   * `ADD`ed: this is the one item in the system where a lost update is
   * *harmless* (two operators pasting two keys — one wins, and the console
   * shows which) and where a conditional retry loop would only add a way for a
   * rotation to fail while the supplier is already refusing the old key.
   *
   * The cache is dropped rather than seeded, so this process reads the new
   * value back like everyone else and a failure to persist cannot be masked.
   */
  async function put(slot, value, { by = "" } = {}) {
    if (!isCredentialSlot(slot)) throw new Error(`credential: unknown slot "${slot}"`);
    const text = typeof value === "string" ? value : JSON.stringify(value);
    const prev = await getItem(slot).catch(() => null);
    const item = credentialItem({
      slot,
      value: text,
      version: (Number(prev?.version) || 0) + 1,
      rotatedBy: by,
      at: now(),
    });
    // `createdAt` belongs to the first write of a slot, not to the latest
    // rotation — an operator asking "when did this deployment get a payment
    // key?" is asking a different question from "when was it last changed?".
    if (prev?.createdAt) item.createdAt = prev.createdAt;
    await db.putCredential(item);
    forget(slot);
    return credentialStatus(slot, item);
  }

  return { get, getRaw, exists, describe, describeAll, describeFull, describeAllFull, put, forget };
}
