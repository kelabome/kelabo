import {
  directoryTenant,
  isPublicEmailDomain,
  MAX_DIRECTORY_BYTES,
  parseDirectoryFile,
} from "@kelabo/contracts/directory";
import { domainOf, normaliseDomain, orgDomains } from "@kelabo/contracts/org-domains";
import { err } from "./errors.js";

/**
 * The organisation directory, administered from `/admin` → Directory
 * (docs 18 §4.7).
 *
 * An administrator uploads the export their mail system already produces
 * (contracts/src/directory.js lists which), for one **tenant** — an email
 * domain. Everybody signed in at that tenant can then find those people by
 * name wherever an address is typed. Entries may be at any domain: a company's
 * list routinely includes contractors and a second regional domain, and the
 * tenant is who may *see* the list, not what its addresses end in.
 *
 * ## Replace, never append
 *
 * An import is the new truth for that tenant: people missing from the file are
 * removed. That is what keeps a copy from drifting — the reason docs 18 gave
 * for not having one — and it is how a leaver drops out: export again, import
 * again. The cost is that importing the wrong file (one department's, say)
 * would silently delete everybody else, so an import that removes more than
 * half of an existing directory is refused unless the administrator confirms
 * it (`force`), having seen the preview's counts.
 *
 * ## Preview, then apply
 *
 * The same file goes to both, and both parse it here, server-side, with the
 * one reader. The preview writes nothing; it says what the apply would do,
 * including per-domain counts, which is where a typo like `example.com.ay`
 * shows up before it is stored. Apply re-reads the directory rather than
 * trusting the preview's numbers, so an import made in between is not undone
 * blindly.
 *
 * Every route re-checks that the caller is an administrator.
 */
export function createDirectoryAdmin({ config, db, admin, people, opConfig, log = () => {}, now = () => Date.now() }) {
  const settings = async () => (opConfig ? await opConfig.effective() : config);

  // An alias domain is the organisation's primary (orgDomains.js): a directory
  // "for acme.io" is acme.com's directory, the one its people search.
  async function tenantFrom(value) {
    const org = orgDomains(await settings());
    const given = normaliseDomain(value);
    const raw = org.primary && org.aliases.includes(given) ? org.primary : given;
    if (!raw) throw err(400, "bad_tenant", "a tenant (email domain) is required");
    // "Not a domain" before "a public one": a predicate that fails closed on
    // anything unparseable (and so calls `nope` public) must not turn a typo
    // into a misleading refusal.
    if (!raw.includes(".") || raw.startsWith(".") || raw.includes("..")) {
      throw err(400, "bad_tenant", `${raw} is not a domain`);
    }
    if (isPublicEmailDomain(raw)) {
      throw err(400, "public_domain", `${raw} is a public mailbox provider; a directory there would be visible to strangers`);
    }
    const tenant = directoryTenant(raw);
    if (!tenant) throw err(400, "bad_tenant", `${raw} is not a domain`);
    return tenant;
  }

  function fileFrom(body) {
    const csv = body?.csv;
    if (typeof csv !== "string" || !csv.trim()) throw err(400, "empty_file");
    if (Buffer.byteLength(csv, "utf8") > MAX_DIRECTORY_BYTES) {
      throw err(413, "file_too_large", `the limit is ${MAX_DIRECTORY_BYTES / 1024 / 1024} MB`);
    }
    try {
      return parseDirectoryFile(csv);
    } catch (e) {
      if (e?.code === "no_email_column") throw err(400, "no_email_column", e.message);
      throw e;
    }
  }

  const fileName = (body) => String(body?.fileName || "").replace(/[\u0000-\u001f]/g, "").slice(0, 200);

  /** What an import of `parsed` would do to `tenant`'s directory as it stands. */
  async function plan(tenant, parsed) {
    const existing = new Map((await db.listDirectory(tenant)).map((r) => [r.email, r.name || ""]));
    const incoming = new Set();
    const added = [];
    const updated = [];
    let unchanged = 0;
    for (const e of parsed.entries) {
      incoming.add(e.email);
      if (!existing.has(e.email)) added.push(e);
      else if (existing.get(e.email) !== e.name) updated.push(e);
      else unchanged++;
    }
    const removed = [...existing.keys()].filter((email) => !incoming.has(email)).sort();
    // More than half of a directory disappearing is far likelier to be the
    // wrong file than a real reorganisation.
    const needsForce = existing.size > 0 && removed.length * 2 > existing.size;

    const allowed = normaliseDomain((await settings())?.allowedEmailDomain);
    const warnings = [];
    // Nobody could sign in at this tenant, so nobody would ever see the list.
    if (allowed && allowed !== tenant) warnings.push("tenant_cannot_sign_in");
    if (!parsed.entries.length) warnings.push("no_entries");

    return {
      tenantId: tenant,
      format: parsed.format,
      columns: parsed.columns,
      counts: {
        entries: parsed.entries.length,
        existing: existing.size,
        added: added.length,
        updated: updated.length,
        unchanged,
        removed: removed.length,
        skipped: parsed.skipped.length,
        duplicates: parsed.duplicates,
      },
      domains: Object.entries(parsed.domains)
        .map(([domain, count]) => ({ domain, count, sameAsTenant: domain === tenant }))
        .sort((a, b) => b.count - a.count || a.domain.localeCompare(b.domain)),
      skipped: parsed.skipped.slice(0, 50),
      sample: {
        added: added.slice(0, 10),
        updated: updated.slice(0, 10).map((e) => ({ ...e, was: existing.get(e.email) })),
        removed: removed.slice(0, 10),
      },
      needsForce,
      warnings,
      // Not returned to the client; apply needs them.
      _writes: { put: [...added, ...updated], remove: removed },
    };
  }

  const publicPlan = ({ _writes, ...rest }) => rest;

  async function preview({ identity, body }) {
    await admin.requireAdmin(identity);
    const tenant = await tenantFrom(body?.tenantId);
    return publicPlan(await plan(tenant, fileFrom(body)));
  }

  async function apply({ identity, body }) {
    const by = await admin.requireAdmin(identity);
    const tenant = await tenantFrom(body?.tenantId);
    const p = await plan(tenant, fileFrom(body));
    if (!p.counts.entries) throw err(400, "no_entries", "the file has no usable addresses; to empty a directory, remove it");
    if (p.needsForce && body?.force !== true) {
      throw err(409, "directory_shrink", `this import would remove ${p.counts.removed} of ${p.counts.existing} people`);
    }

    const at = now();
    // Writes before deletes: a failure part-way leaves extra people findable
    // rather than real people missing, and re-running the import converges.
    await db.putDirectoryEntries(
      tenant,
      p._writes.put.map((e) => ({ email: e.email, name: e.name, importedAt: at }))
    );
    await db.deleteDirectoryEntries(tenant, p._writes.remove);
    await db.putDirectoryIndex(tenant, {
      count: p.counts.entries,
      importedAt: at,
      importedBy: by,
      fileName: fileName(body),
      added: p.counts.added,
      updated: p.counts.updated,
      removed: p.counts.removed,
    });
    people?.invalidate(tenant);
    log("warn", "directory_imported", { by, tenantId: tenant, ...p.counts });
    return { ...publicPlan(p), applied: true, importedAt: at };
  }

  /**
   * Every tenant with a directory, and the tenant the console should offer by
   * default: the deployment's sign-in domain if it has one, else the
   * administrator's own.
   */
  async function list({ identity }) {
    const who = await admin.requireAdmin(identity);
    const rows = await db.listDirectoryTenants();
    const allowed = normaliseDomain((await settings())?.allowedEmailDomain);
    return {
      defaultTenant: allowed || domainOf(who),
      directories: rows
        .map((r) => ({
          tenantId: r.tenantId,
          count: r.count ?? 0,
          importedAt: r.importedAt ?? 0,
          importedBy: r.importedBy ?? "",
          fileName: r.fileName ?? "",
        }))
        .sort((a, b) => a.tenantId.localeCompare(b.tenantId)),
    };
  }

  /** One directory's entries, for the console to show or download back. */
  async function entries({ identity, tenantId }) {
    await admin.requireAdmin(identity);
    const tenant = await tenantFrom(tenantId);
    const rows = await db.listDirectory(tenant);
    return {
      tenantId: tenant,
      entries: rows
        .map((r) => ({ email: r.email, name: r.name || "" }))
        .sort((a, b) => (a.name || a.email).localeCompare(b.name || b.email)),
    };
  }

  /** Remove a tenant's directory entirely. Registered users are untouched. */
  async function remove({ identity, tenantId }) {
    const by = await admin.requireAdmin(identity);
    const tenant = await tenantFrom(tenantId);
    const rows = await db.listDirectory(tenant);
    await db.deleteDirectoryEntries(tenant, rows.map((r) => r.email));
    await db.deleteDirectoryIndex(tenant);
    people?.invalidate(tenant);
    log("warn", "directory_removed", { by, tenantId: tenant, count: rows.length });
    return { tenantId: tenant, removed: rows.length };
  }

  return { preview, apply, list, entries, remove };
}
