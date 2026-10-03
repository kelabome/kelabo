// Which organisation an identity belongs to (issue #14) — the Gateway's half of
// rest-api/src/tenancy.js, over the same pure rules (contracts/src/orgDomains.js).
//
// Most Gateway requests carry a tenant minted by the control plane (session
// cookie, internal JWT), which already folds alias domains into the primary.
// This is for the two places that must not trust a carried value — an agent
// token lives for months, longer than any alias list — and the ones that turn
// an address into a tenant themselves.
import { hasColleagues, orgDomains, tenantOf } from "@kelabo/contracts/org-domains";
import { effectiveConfig } from "./opconfig.js";

export async function orgOf(c) {
  return orgDomains((await effectiveConfig(c)).org);
}

/** The tenant `identity` belongs to now: an alias domain maps to the primary. */
export async function tenantOfIdentity(c, identity) {
  return tenantOf(identity, await orgOf(c));
}

export { hasColleagues };
