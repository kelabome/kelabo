import { adminSk, opConfigItem, opConfigSchema } from "@kelabo/contracts/opconfig";
import { CREDENTIAL_FIELDS, isCredentialSlot, validateCredentialFields } from "@kelabo/contracts/credentials";
import { err } from "./errors.js";

/**
 * Deployment administration: who may change the operational config, and the
 * publishing of it.
 *
 * ## The roster
 *
 * Two tiers, and the distinction is the whole access-control argument.
 *
 * **Root** is one address, named in `config/kelabo.json` and reaching the Lambda
 * as `KELABO_ROOT_ADMIN_EMAIL`. It cannot be changed by any request, only by a
 * deploy. That is deliberate: everything else in this file is editable from a
 * web page, so the answer to *who may edit* must not be, or the boundary is
 * circular — an administrator who could rewrite the roster could remove the
 * operator from their own deployment with a single call and there would be no
 * way back that did not involve the AWS console.
 *
 * **Granted admins** are `ADMIN#` rows that only root may write or remove. They
 * may publish configuration; they may not change who else can. A granted admin
 * who could grant would be root by another name after one hop.
 *
 * Empty root fails **closed**: nobody is root, `requireRoot` refuses everyone,
 * and the roster is whatever rows already exist — on a fresh deployment, none,
 * so `/admin` refuses every caller. A misconfigured deployment must fail toward
 * a locked console, never toward an open one.
 *
 * ## Publishing
 *
 * Append-only. A change is a new version with an author and a note; the
 * previous one stays in the table, which is both the audit record and the way
 * back. There is no edit and no delete — rolling a setting back is publishing
 * the old value again, so the fact that it was rolled back is itself recorded.
 *
 * The version number is read-then-incremented and the write is conditional on
 * the key not existing (`db.putOpConfig`), so two administrators publishing at
 * the same instant cannot silently overwrite one another.
 */
export function createAdmin({ config, db, opConfig, credentials, internal, log = () => {} }) {
  const ROOT = String(config?.rootAdminEmail || "").trim().toLowerCase();
  const lower = (s) => String(s || "").trim().toLowerCase();

  const isRoot = (identity) => !!ROOT && lower(identity) === ROOT;

  /**
   * Root, or a granted row. Fails closed on a read error rather than open: if
   * the roster cannot be read we do not know that the caller is an admin, and
   * "we could not check" must resolve to "no".
   */
  async function isAdmin(identity) {
    const who = lower(identity);
    if (!who) return false;
    if (isRoot(who)) return true;
    try {
      const rows = await db.listAdmins();
      return rows.some((r) => lower(r.SK) === who);
    } catch {
      return false;
    }
  }

  async function requireAdmin(identity) {
    if (!(await isAdmin(identity))) throw err(403, "forbidden");
    return lower(identity);
  }

  function requireRoot(identity) {
    if (!isRoot(identity)) throw err(403, "forbidden");
    return ROOT;
  }

  /**
   * What the console asks on load. Never throws — a non-admin gets
   * `{ admin: false }` rather than a 403, because this is the call that decides
   * whether to render the menu entry at all and a 403 in the console on every
   * page load for every ordinary user is noise, not security. Every route that
   * does something re-checks server-side.
   */
  async function whoami(identity) {
    const admin = await isAdmin(identity);
    return { admin, root: isRoot(identity), rootConfigured: !!ROOT };
  }

  // --- roster ---------------------------------------------------------------

  async function listAdmins({ identity }) {
    requireRoot(identity);
    const rows = await db.listAdmins();
    return {
      root: ROOT,
      admins: rows
        .map((r) => ({ email: r.SK, grantedBy: r.grantedBy ?? "", at: r.at ?? 0 }))
        .sort((a, b) => a.email.localeCompare(b.email)),
    };
  }

  async function grantAdmin({ identity, body }) {
    const by = requireRoot(identity);
    const email = adminSk(body?.email);
    if (!email || !email.includes("@")) throw err(400, "bad_email");
    // Root is root by deployment and needs no row. Writing one would create a
    // second, removable record of an identity that cannot be removed, and a
    // console that offered to revoke it would be lying.
    if (email === ROOT) throw err(400, "already_root");
    await db.putAdmin({ email, grantedBy: by, at: Date.now() });
    return { email, grantedBy: by };
  }

  async function revokeAdmin({ identity, email }) {
    requireRoot(identity);
    const target = adminSk(email);
    if (target === ROOT) throw err(400, "cannot_revoke_root");
    await db.deleteAdmin(target);
    return { email: target };
  }

  // --- configuration --------------------------------------------------------

  /**
   * Everything the console needs to render one screen: what is published, what
   * this deployment falls back to, and what is therefore in effect.
   *
   * All three, not just the effective values, because "effective" alone cannot
   * be edited safely — an operator who sees `sfu` has no way to tell whether
   * they published it or whether it is the deployment's default showing
   * through, and clearing a field they thought they had set would change
   * nothing while looking like it should.
   */
  async function getConfig({ identity }) {
    await requireAdmin(identity);
    const [published, effective, history] = await Promise.all([
      opConfig.current(),
      opConfig.resolved(),
      opConfig.history(),
    ]);
    return {
      published,
      effective,
      status: opConfig.status(),
      versions: history
        .map((v) => ({
          version: v.version,
          effectiveFrom: v.effectiveFrom,
          publishedBy: v.publishedBy,
          note: v.note,
        }))
        .sort((a, b) => b.version - a.version),
    };
  }

  /**
   * Publish a new version.
   *
   * The body is the **whole** config, not a patch. A patch would need a way to
   * say "unset this field", which is exactly the `null`-versus-absent
   * distinction that makes the fold subtle (see `resolveOpConfig`); sending the
   * complete document means the console's form state is the version, and a
   * field the operator cleared is a field that is `null` in the item.
   */
  async function publishConfig({ identity, body }) {
    const by = await requireAdmin(identity);
    const note = String(body?.note || "").trim();
    // Required here rather than in the schema: the seeded default has no change
    // to explain, but a human publishing one always does, and a version chain
    // of blank notes is an audit record that answers nothing.
    if (!note) throw err(400, "note_required");

    let candidate;
    try {
      // Validate before touching the table. A rejected publish must leave the
      // deployment exactly as it was, and a half-written version chain is not
      // something an append-only design can repair.
      candidate = opConfigSchema.parse({
        ...(body?.config ?? {}),
        version: 1,
        effectiveFrom: 0,
        publishedBy: by,
        note,
      });
    } catch (e) {
      throw err(400, "invalid_config", e?.message);
    }

    const history = await opConfig.history();
    const head = history.reduce((m, v) => Math.max(m, v.version || 0), 0);
    const version = head + 1;
    const item = opConfigItem({ ...candidate, version, effectiveFrom: Date.now() });

    try {
      await db.putOpConfig(item);
    } catch (e) {
      // The conditional write lost a race with another administrator. Told
      // apart from a real failure because the remedy is different: reload and
      // publish again on top of what they wrote, rather than retry blindly and
      // overwrite it.
      //
      // Invalidated BEFORE the 409 goes out, because the remedy depends on it:
      // this container lost the race precisely because its cached head was
      // stale, so the console's reload would re-read the same stale history,
      // compute the same version, and land the same 409 — for up to a full
      // cache window, while showing the operator the old document to "review".
      if (e?.name === "ConditionalCheckFailedException") {
        opConfig.invalidate();
        throw err(409, "version_conflict");
      }
      throw e;
    }

    log("warn", "opconfig_published", { by, version, note });

    // Two reloads, and both matter.
    //
    // This container's own cache first, so the operator's very next request —
    // the console re-reading what it just saved — shows the new version rather
    // than up to a minute of the old one, which is indistinguishable from a
    // failed save.
    opConfig.invalidate();

    // Then the gateway, which is the singleton that actually runs kelabos and
    // holds the agent worker. Best-effort on purpose: the publish has already
    // succeeded and is durable, so a gateway that is rolling, unreachable or
    // briefly down must not turn a saved change into an error on the operator's
    // screen. It picks the change up on its own within the cache TTL either
    // way; this call only removes the wait.
    //
    // Tested for explicitly rather than optional-chained into the `try`: with
    // no gateway wired at all, `internal?.reloadConfig(...)` returns undefined
    // and throws nothing, so the happy path would report a reload that never
    // happened — and the console would tell the operator their change was live
    // everywhere on a deployment where nothing had been asked to re-read it.
    let reloaded = false;
    if (internal?.reloadConfig) {
      try {
        await internal.reloadConfig(by);
        reloaded = true;
      } catch (e) {
        log("warn", "opconfig_gateway_reload_failed", { by, version, error: String(e?.message || e) });
      }
    }

    // Reported rather than swallowed, so the console can say "saved, gateway
    // will pick this up within a minute" instead of implying it is already live
    // everywhere. Other warm Lambda containers are in the same position and are
    // bounded by the same TTL.
    return { version, publishedBy: by, note, gatewayReloaded: reloaded };
  }

  // --- supplier credentials -------------------------------------------------
  //
  // Configuration says *which* supplier; this says *how to authenticate to it*.
  // They are deliberately different things in different tables — the credentials
  // table has its own customer-managed key, and nothing here is versioned or
  // published, because a key is not a decision anyone needs the history of.
  //
  // **This is the widest capability in the deployment**, and the IAM grant that
  // serves it (`infra/lib/lambda-stack.js`) says so at length: giving this role
  // `PutItem` on `CRED#*` means the attribute fence on `CRED#llm`/`CRED#rtc` no
  // longer binds, because IAM unions `Allow`. That was a deliberate trade — a
  // self-hoster with no shell cannot run `make credential-set`, and a console
  // that can configure everything except the four keys that make the product
  // work is not a console.
  //
  // What is NOT conceded here: there is **no reveal route**. Nothing in this
  // module returns key material to a browser. `credentials.getRaw` exists and
  // is deliberately not called — a key can be replaced from the console but
  // never read out of it, so a stolen admin session can break a deployment and
  // cannot exfiltrate the supplier keys it runs on. Rotating at the supplier is
  // the recovery for the first; there is no recovery for the second.

  /**
   * Every slot, what it takes, and whether it is filled. Never a value.
   *
   * The field *descriptors* come from contracts rather than the client, so the
   * console renders whatever a build actually supports — adding a supplier is
   * one entry in `CREDENTIAL_FIELDS` and the form grows on its own.
   */
  async function listCredentials({ identity }) {
    await requireAdmin(identity);
    const status = await credentials.describeAllFull();
    return {
      slots: status.map((s) => ({
        ...s,
        // What to type, and why. Without this the console would have to carry
        // its own copy of every supplier's field list and the two would drift
        // the first time a slot changed.
        spec: (CREDENTIAL_FIELDS[s.slot] ?? []).map((f) => ({
          key: f.key,
          label: f.label,
          hint: f.hint,
          required: !!f.required,
        })),
      })),
    };
  }

  /**
   * Set or rotate one slot.
   *
   * **Merge, not replace**, and this is the important part. A slot like `stt`
   * holds one key per engine and `rtc` holds four fields of which two are
   * optional; a console form only ever submits what someone typed into it. A
   * replacing write would therefore delete the Deepgram key the moment anyone
   * updated the Soniox one — silently, with the console showing success and
   * transcription failing on the next kelabo that used the other engine.
   *
   * The same rule makes an empty box mean "leave this alone" rather than "blank
   * this", which is what lets the form render every field without the operator
   * having to re-paste keys they are not changing. Clearing a field is
   * therefore deliberately not expressible here — that is what the CLI is for,
   * and "I cannot remove a key from a browser" is the safer gap of the two.
   */
  async function saveCredential({ identity, slot, body }) {
    const by = await requireAdmin(identity);
    if (!isCredentialSlot(slot)) throw err(404, "unknown_slot");

    // Rejects a field name the slot does not define rather than storing it.
    // A typo'd key that silently persisted would read as configured, and the
    // supplier would refuse the call with nothing on this page to explain it.
    const { fields, unknown } = validateCredentialFields(slot, body?.fields);
    if (unknown.length) throw err(400, "unknown_field", unknown.join(", "));
    if (!Object.keys(fields).length) throw err(400, "no_fields");

    const existing = (await credentials.get(slot).catch(() => null)) ?? {};
    const merged = { ...existing, ...fields };

    // `missing` is computed against the MERGED object, not the submitted one:
    // an operator rotating the optional half of a slot has not failed to
    // provide the required half, they provided it last week.
    const required = (CREDENTIAL_FIELDS[slot] ?? []).filter((f) => f.required && !merged[f.key]);
    if (required.length) throw err(400, "missing_field", required.map((f) => f.key).join(", "));

    const status = await credentials.put(slot, merged, { by });
    // The field NAMES that were written, never their values — enough for an
    // operator to see which half of a slot someone rotated, and useless to
    // anyone reading the log.
    log("warn", "credential_rotated", { by, slot, fields: Object.keys(fields), version: status.version });
    return status;
  }

  return {
    isAdmin,
    isRoot,
    requireAdmin,
    requireRoot,
    whoami,
    listAdmins,
    grantAdmin,
    revokeAdmin,
    getConfig,
    publishConfig,
    listCredentials,
    saveCredential,
  };
}
