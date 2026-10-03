import { err } from "./errors.js";
import { createTenancy } from "./tenancy.js";

/**
 * Contacts (docs 18 §4).
 *
 * Three kinds of contact, of which this module owns the first two:
 *   1. Colleagues — everyone at your email domain. Derived from the users
 *      table, never stored as a relationship. You cannot add or remove them,
 *      because there is no row to add or remove; the org boundary is the list.
 *   2. Favourites — a private, one-way, unmirrored marker pinning a colleague.
 *      The favourited person is never told. One row, owned solely by you.
 *   3. External contacts — mutual cross-org links. These require a multi-domain
 *      / open-signup deployment that self-host mode cannot support, so the
 *      routes that create them 501 until `config.contacts.external` is set. The
 *      storage (`PEER#` rows) and full state machine are designed in docs 18 but
 *      not implemented in this phase.
 *
 * A favourite is only valid for a same-organisation identity (tenancy.sameOrg:
 * an alias domain counts as the organisation; a public mailbox tenant has no
 * colleagues at all). Favouriting an outside address is `not_a_colleague` —
 * that is what external contacts are for.
 */
export function createContacts({ config, db, opConfig, people, tenancy = createTenancy({ config, opConfig }) }) {
  // Published operational config (contracts/src/opconfig.js). Async now, so
  // turning external contacts on or off takes effect on the next request
  // rather than the next deploy.
  const externalEnabled = async () =>
    !!(opConfig ? (await opConfig.effective()).contacts?.external : config.contacts?.external);

  /**
   * The Contacts screen's data: the caller's favourites, resolved to display
   * names, plus the external-contact sections (empty and flagged off until a
   * multi-domain deployment enables them).
   */
  async function listContacts({ identity }) {
    const favRows = await db.listFavourites(identity);
    // Resolve names from the users directory. One tenant query covers everyone;
    // favourites are same-tenant by construction, so a single lookup suffices.
    const tenantId = await tenancy.tenantOf(identity);
    // A public mailbox tenant has no colleagues, so there is nobody to name
    // from it — and reading it would mean reading strangers.
    const dir = tenancy.hasColleagues(tenantId) ? await db.listUsersByTenant(tenantId, "", 1000) : [];
    const nameByEmail = new Map(dir.map((u) => [u.email, u.displayName]));
    // The identicon re-roll lives in user settings, which the tenant index does
    // not project — one bounded parallel read per favourite. Best-effort: a
    // missing variant just draws the default avatar.
    const favourites = (
      await Promise.all(
        favRows.map(async (r) => ({
          email: r.peer,
          // The merged entry (people.js) when available: it prefers a name
          // the person chose, then the organisation directory's, over the
          // local part sign-in writes by default — and it names a favourited
          // colleague who has not signed in yet at all.
          displayName:
            (tenancy.hasColleagues(tenantId) && (await people?.lookup(tenantId, r.peer).catch(() => null))?.displayName) ||
            nameByEmail.get(r.peer) ||
            r.peer,
          avatarVariant: Number((await db.getUserSettings(r.peer).catch(() => null))?.settings?.avatar) || 0,
        }))
      )
    ).sort((a, b) => (a.displayName || a.email).localeCompare(b.displayName || b.email));

    return {
      favourites,
      externalEnabled: await externalEnabled(),
      // External sections are empty in self-host mode. Present so the SPA shape
      // never changes between deployments.
      external: [],
      incoming: [],
      outgoing: [],
    };
  }

  /** Favourite a colleague. Same-tenant only; idempotent. */
  async function favourite({ identity, email }) {
    const peer = String(email || "").trim().toLowerCase();
    if (!peer) throw err(400, "bad_request");
    if (peer === identity) throw err(400, "bad_request");
    if (!(await tenancy.sameOrg(identity, peer))) throw err(409, "not_a_colleague");
    await db.putFavourite({ owner: identity, peer, tenantId: await tenancy.tenantOf(identity) });
    return { email: peer, favourited: true };
  }

  /** Unfavourite. Silent and idempotent — a 204 whether or not it was set. */
  async function unfavourite({ identity, email }) {
    const peer = String(email || "").trim().toLowerCase();
    if (!peer) throw err(400, "bad_request");
    await db.deleteFavourite(identity, peer);
    return { email: peer, favourited: false };
  }

  return { listContacts, favourite, unfavourite };
}
