import { applyOpConfig, createOpConfigCache, DEFAULT_OPCONFIG, resolveOpConfig } from "@kelabo/contracts/opconfig";

/**
 * The control plane's view of the operational config (contracts/src/opconfig.js).
 *
 * A TTL cache over one Query, invalidated after a publish. Both services hold
 * one of these; the machinery is shared so a reader in the Lambda and a reader
 * in the gateway cannot disagree about what is in effect.
 *
 * **`resolved()` is the only thing request handlers should call.** It returns
 * the published version folded over this deployment's own config, which is what
 * a consumer actually wants — asking for `current()` and picking a field off it
 * gets you `""` or `null` on every unpublished field and quietly disables
 * whatever you were reading. `current()` and `history()` exist for the console,
 * which has to render published-versus-effective side by side.
 *
 * Resolve **per request**, never once at construction. A Lambda container is
 * reused for minutes; a handler that captured the resolved config when it was
 * built would keep serving whatever was published when that container started
 * and would never see a publish, which is the entire failure this replaced.
 *
 * @param {object} deps
 * @param {object} deps.config - the service's own config; the bootstrap fallback
 * @param {object} deps.db
 * @param {number} [deps.ttlMs]
 */
export function createOpConfig({ config, db, ttlMs = 60_000, now = () => Date.now() }) {
  const cache = createOpConfigCache({
    fetchItems: () => db.listOpConfigs(),
    ttlMs,
    now,
    onError: (e) =>
      // Logged, never thrown: the cache serves the last good version and the
      // Lambda must keep answering. Named loudly because an unreadable
      // op-config means the deployment is running on whatever it last read,
      // which is safe but is not necessarily what the console is showing.
      console.error(
        JSON.stringify({ level: "error", msg: "opconfig_unreadable", ts: new Date().toISOString(), error: String(e) })
      ),
  });

  return {
    /** The published version in effect now — for the console, not for handlers. */
    current: () => cache.current(),
    /** Every published version, oldest first: the tracking record. */
    history: () => cache.history(),
    /** The published config folded over the environment's, grouped as the console shows it. */
    async resolved() {
      return resolveOpConfig(config, await cache.current());
    },
    /**
     * The same thing in this service's **own config shape** — what handlers
     * read. `(await settings()).otp.maxAttempts` is the same expression as
     * `config.otp.maxAttempts` was, which is the point: a call site cannot
     * quietly keep reading the unpublished value by getting the shape wrong.
     */
    async effective() {
      return applyOpConfig(config, await cache.current());
    },
    /** Where the served version came from: table | stale | default. */
    status: () => cache.status(),
    /** Called after publishing, so the operator sees their own change at once. */
    invalidate: () => cache.invalidate(),
    defaults: DEFAULT_OPCONFIG,
  };
}
