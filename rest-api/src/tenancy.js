// Which organisation an identity belongs to (issue #14).
//
// `tenantId` used to be the raw domain of the verified email, derived inline
// in a dozen places with `identity.split("@")[1]`. An organisation with more
// than one domain (acme.com + acme.io) was therefore several tenants whose
// people were strangers to each other. Every derivation now comes here, and
// this folds the deployment's alias domains into its primary
// (`contracts/src/orgDomains.js`), so `tenantId` stays one string and every
// boundary keyed on it is unchanged.
//
// Resolved per call, never at construction: the alias list is published
// op-config (`org.emailDomainAliases`), and a warm Lambda container must see a
// publish within the op-config cache, not on its next cold start.
import { domainAllowed, hasColleagues, orgDomains, tenantOf } from "@kelabo/contracts/org-domains";

/**
 * @param {{ config: any, opConfig?: { effective: () => Promise<any> } }} deps
 */
export function createTenancy({ config, opConfig } = {}) {
  const settings = async () => (opConfig ? await opConfig.effective() : config);
  const org = async () => orgDomains(await settings());

  return {
    /** The deployment's organisation: `{ primary, aliases }`; empty primary = open registration. */
    org,
    /** The tenant this identity belongs to — an alias domain maps to the primary. */
    async tenantOf(identity) {
      return tenantOf(identity, await org());
    },
    /** May this address sign in at all? Open registration admits every domain. */
    async allows(email) {
      return domainAllowed(email, await org());
    },
    /**
     * Same organisation? Both sides are mapped, so `a@acme.io` and `b@acme.com`
     * are colleagues when acme.io is an alias — and nobody is a colleague under
     * a public mailbox tenant (`hasColleagues`).
     */
    async sameOrg(a, b) {
      const o = await org();
      const ta = tenantOf(a, o);
      return !!ta && hasColleagues(ta) && ta === tenantOf(b, o);
    },
    /**
     * `{ tenantId, colleagues }` for a tenant-index read
     * (`db.listKelabosByStatusForIdentity`): which partition, and whether the
     * rest of it is this identity's organisation or a crowd of strangers.
     */
    async scope(identity) {
      const tenantId = tenantOf(identity, await org());
      return { tenantId, colleagues: hasColleagues(tenantId) };
    },
    /** Pure: does this tenant have colleagues at all? (No for gmail.com and friends.) */
    hasColleagues,
  };
}
