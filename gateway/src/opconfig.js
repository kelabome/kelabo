import { createOpConfigCache, DEFAULT_OPCONFIG, resolveOpConfig } from "@kelabo/contracts/opconfig";
import { listOpConfigs } from "./db.js";

/**
 * The gateway's view of the operational config (contracts/src/opconfig.js).
 *
 * Deliberately the same shape as the control plane's `rest-api/src/opconfig.js`,
 * over the same shared cache, because a setting that meant one thing in the
 * Lambda and another here would be undiagnosable from either side.
 *
 * One of these per task, held on the container, so a burst of captions is one
 * Query per minute rather than one per caption.
 *
 * **`resolved()`, not `current()`.** `current()` is the published document, in
 * which every unpublished field is `""` or `null`; reading a field off it
 * directly is how a deployment that has published only its model ends up
 * running with no cooldown and no deadline. `resolved()` folds it over this
 * task's own environment config, which is what every consumer wants.
 */
export function createOpConfig(c, { ttlMs = 60_000, now = () => Date.now() } = {}) {
  const cache = createOpConfigCache({
    fetchItems: () => listOpConfigs(c),
    ttlMs,
    now,
    // Logged, never thrown. The cache serves the last version it read
    // successfully — never the seeded defaults — so an unreadable table means
    // slightly stale settings, not a deployment that silently reverted to
    // bootstrap values in the middle of a call.
    onError: (e) => c.logError?.("opconfig_unreadable", e),
  });

  // The last fold this task computed, for the few call sites that cannot
  // await (`resolvedNow` below). Seeded with the pure bootstrap fold so it is
  // correct before the first read ever completes.
  let lastResolved = resolveOpConfig(c.config, null);

  return {
    current: () => cache.current(),
    history: () => cache.history(),
    async resolved() {
      lastResolved = resolveOpConfig(c.config, await cache.current());
      return lastResolved;
    },
    /**
     * The last resolved fold, synchronously — for call sites that live inside
     * a callback and cannot await: an SSE stream's `close` handler scheduling
     * an eviction, a synchronous roster mutation. It kicks the cache so the
     * snapshot converges on its own TTL, and serves what the task last knew,
     * which is exactly the trade the async reader already makes on a failed
     * read. Everything that CAN await should call `resolved()` instead.
     */
    resolvedNow() {
      cache
        .current()
        .then((op) => {
          lastResolved = resolveOpConfig(c.config, op);
        })
        .catch(() => {});
      return lastResolved;
    },
    status: () => cache.status(),
    /**
     * Force the next read to hit the table.
     *
     * Called by `POST /internal/config/reload` when an administrator publishes,
     * so a change is live in seconds rather than at the end of the cache
     * window. The TTL is still the backstop — the reload is an optimisation of
     * the wait, never the mechanism.
     */
    invalidate: () => cache.invalidate(),
    defaults: DEFAULT_OPCONFIG,
  };
}

/**
 * The resolved configuration for any container — the one expression every
 * gateway consumer of a publishable value goes through.
 *
 * Falls back to the pure bootstrap fold when the container carries no
 * `opConfig` at all (tests that hand-build a container, a table-less local
 * run), which is what keeps every existing test and deployment behaving
 * exactly as before. A consumer that read `c.config.rtc.x` directly instead of
 * this would silently pin the bootstrap value forever — the exact "published
 * knob that does nothing" failure docs 23 exists to remove, and
 * `gateway/test/opconfig.mjs` reads the sources to keep it removed.
 */
export async function effectiveConfig(c) {
  return c.opConfig?.resolved ? c.opConfig.resolved() : resolveOpConfig(c.config, null);
}

/** The same, synchronously, from the last-known fold — see `resolvedNow`. */
export function effectiveConfigNow(c) {
  return c.opConfig?.resolvedNow ? c.opConfig.resolvedNow() : resolveOpConfig(c.config, null);
}
