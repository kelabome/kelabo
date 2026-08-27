/**
 * A TTL cache over an append-only, versioned partition.
 *
 * Two things in the billing table are published this way — the rate card
 * (`PK = RATECARD`) and the operational config (`PK = OPCONFIG`) — and both
 * want exactly the same failure behaviour, which is the interesting part and
 * the reason this is shared rather than written twice.
 *
 * A read that fails keeps serving the **last known version** rather than
 * falling back to defaults. A card that quietly reverted to seeded values would
 * change every price at the worst possible moment; an op-config that reverted
 * would swap the payment account mid-day. Only a service that has never managed
 * to read one falls back, and `status()` says so. The ground rule throughout is
 * that nothing in here ever cuts a live call: approximately-right beats
 * refusing to answer.
 *
 * No IO of its own, so it runs under plain node in tests.
 *
 * @param {object} opts
 * @param {() => Promise<object[]>} opts.fetchItems - raw items from the table
 * @param {(item: object) => object} opts.parse - validate one stored item; may throw
 * @param {object} opts.fallback - what to serve before any successful read
 * @param {string} opts.label - what a malformed item is called in the error
 * @param {number} [opts.ttlMs] - how long a successful read is trusted
 * @param {() => number} [opts.now]
 * @param {(err: Error) => void} [opts.onError] - logging seam; never throws out
 */
export function createVersionedCache({
  fetchItems,
  parse,
  fallback,
  label = "item",
  ttlMs = 60_000,
  now = () => Date.now(),
  onError,
} = {}) {
  let all = null;
  let chosen = null;
  let checkedAt = 0;
  // Tracked apart from `checkedAt`, which is a clock value and may legitimately
  // be 0: without it, a service whose very first read failed would re-read on
  // every single call for as long as the table stayed unreadable.
  let attempted = false;
  let source = "default";
  let inflight = null;

  const report = (e) => {
    try {
      onError?.(e instanceof Error ? e : new Error(String(e)));
    } catch {}
  };

  async function refresh() {
    // One in-flight read per process: a cold gateway serving a burst of
    // captions must not turn one expired cache into N identical Queries.
    if (inflight) return inflight;
    inflight = (async () => {
      try {
        const items = (await fetchItems()) || [];
        const parsed = [];
        for (const it of items) {
          try {
            parsed.push(parse(it));
          } catch (e) {
            // One malformed version must not hide every other one.
            report(new Error(`${label} ${it?.SK ?? "?"} unreadable: ${e.message}`));
          }
        }
        // A partition with **nothing in it** is not a failure — it is a
        // deployment where nobody has published yet, and the seeded value is
        // the right answer. Reporting it turned every sweep on a fresh
        // environment into an error log, which is how a real unreadable table
        // would have been missed.
        if (!items.length) {
          all = [fallback];
          chosen = fallback;
          source = "default";
          return;
        }
        const picked = pickVersion(parsed, now());
        if (!picked) throw new Error(`no ${label} in effect`);
        all = parsed;
        chosen = picked;
        source = "table";
      } catch (e) {
        report(e);
        if (chosen) source = "stale";
      } finally {
        // Stamped on failure too, so an unreadable table is retried once per
        // TTL rather than on every single call.
        checkedAt = now();
        attempted = true;
        inflight = null;
      }
    })();
    return inflight;
  }

  const expired = () => !attempted || now() - checkedAt >= ttlMs;

  return {
    /** The version in effect now, reading through the cache when it has expired. */
    async current() {
      if (expired()) await refresh();
      return chosen ?? fallback;
    },
    /** Every published version, oldest first — the tracking record. */
    async history() {
      if (expired()) await refresh();
      return (all ?? [fallback]).slice().sort((a, b) => a.version - b.version);
    },
    /** Where the current value came from: table | stale | default. */
    status() {
      return { source, checkedAt, version: (chosen ?? fallback).version };
    },
    /** Force the next read to hit the table (used after publishing). */
    invalidate() {
      checkedAt = 0;
      attempted = false;
    },
  };
}

/**
 * The version in effect at an instant: the newest whose `effectiveFrom` has
 * passed.
 *
 * A call is priced by the card in effect **at episode start** (§4.1), so this
 * takes the instant rather than assuming now — re-pricing a finished episode
 * with a card published mid-call would make the receipt irreproducible.
 */
export function pickVersion(items, at = Date.now()) {
  let best = null;
  for (const c of items || []) {
    if (!c || c.effectiveFrom > at) continue;
    if (!best || c.version > best.version) best = c;
  }
  return best;
}

/** `V#000007` — zero-padded so the partition sorts by version. */
export const versionSk = (version, width) => `V#${String(version).padStart(width, "0")}`;

/** The version back out of a sort key, or NaN if it is not one. */
export const versionFromSk = (sk) => {
  const m = /^V#(\d+)$/.exec(String(sk ?? ""));
  return m ? Number(m[1]) : NaN;
};
