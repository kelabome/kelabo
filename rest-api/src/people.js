import { indexPerson, rankPeople } from "@kelabo/contracts/people-search";

/**
 * Who a signed-in person can find by name (docs 18 §4.8).
 *
 * Two sources, merged into one entry per address:
 *
 *   - **registered users** at the caller's tenant — the users table's
 *     `tenant-index`, i.e. everybody who has signed in here;
 *   - the **organisation directory** an administrator imported for that tenant
 *     (docs 18 §4.7), which is what makes a colleague findable before their
 *     first sign-in.
 *
 * The tenant is the partition key of both reads, so this cannot surface
 * another organisation's people however it is called.
 *
 * ## Names
 *
 * A registered user's own display name wins — it is the one they chose. The
 * exception is the name sign-in writes when it has none to go on (the address's
 * local part, sessions.js); a directory's "Daniel Okafor" is strictly better
 * than a generated "dokafor", and is what somebody will type.
 *
 * ## Cache
 *
 * Both lists are read whole and ranked in memory, so they are cached per tenant
 * for `ttlMs` in this container. An import invalidates this container's entry
 * at once; other warm containers see it within the TTL — the same bound, and
 * the same reasoning, as the op-config cache.
 */
export function createPeople({ db, now = () => Date.now(), ttlMs = 60_000 }) {
  const cache = new Map();

  const localPart = (email) => String(email).split("@")[0];

  async function load(tenantId) {
    const [users, directory] = await Promise.all([
      db.listAllUsersByTenant(tenantId),
      // Best-effort: a directory read failure must degrade search to what it
      // was before directories existed, not break it.
      db.listDirectory(tenantId).catch(() => []),
    ]);
    const byEmail = new Map();
    for (const d of directory) {
      if (!d.email) continue;
      byEmail.set(d.email, { email: d.email, displayName: d.name || "", registered: false, source: "directory" });
    }
    for (const u of users) {
      if (!u.email) continue;
      const listed = byEmail.get(u.email);
      const own = u.displayName && u.displayName !== localPart(u.email) ? u.displayName : "";
      byEmail.set(u.email, {
        email: u.email,
        displayName: own || listed?.displayName || u.displayName || "",
        registered: true,
        source: "user",
      });
    }
    const people = [...byEmail.values()];
    const index = new Map(people.map((p) => [p.email, indexPerson(p)]));
    return { people, index, byEmail };
  }

  async function candidates(tenantId) {
    const hit = cache.get(tenantId);
    if (hit && now() - hit.at < ttlMs) return hit.value;
    const value = await load(tenantId);
    cache.set(tenantId, { at: now(), value });
    return value;
  }

  function invalidate(tenantId) {
    if (tenantId) cache.delete(tenantId);
    else cache.clear();
  }

  /**
   * Ranked matches for `query` among the caller's tenant, never the caller.
   * Favourites and registered people get a small boost: between two equally
   * good matches, the one you pinned, or the one who can actually be rung, is
   * the likelier intent.
   */
  async function search({ tenantId, query, exclude = [], favourites = new Set(), limit = 8 }) {
    const { people, index } = await candidates(tenantId);
    const skip = new Set(exclude);
    return rankPeople(
      query,
      people.filter((p) => !skip.has(p.email)),
      {
        limit,
        index,
        boost: (p) => (favourites.has(p.email) ? 15 : 0) + (p.registered ? 5 : 0),
      }
    ).map(({ score, ...p }) => p);
  }

  /** One address's merged entry, or null. For resolving a name, not searching. */
  async function lookup(tenantId, email) {
    return (await candidates(tenantId)).byEmail.get(email) ?? null;
  }

  return { search, lookup, candidates, invalidate };
}
