import { err } from "./errors.js";
import { sha256 } from "./jwt.js";

/**
 * Close an account: delete everything the deployment holds about one person.
 *
 * This is the mechanism behind the published promise that an account can be
 * closed on request. It is deliberately an operator-side capability, not a
 * route — deleting a person is rare, irreversible, and worth a human in the
 * loop; a deployment that wants a button can wire one to `close()`.
 *
 * Ordering is the design. Everything that hangs OFF the identity goes first,
 * the `USER#` row goes last — so a closure that dies halfway leaves an
 * account that still exists, still lists what remains, and can simply be
 * closed again. Every step is idempotent for that reason: deletes of absent
 * rows succeed, and a re-run finishes what the first run started.
 *
 * What it deletes:
 *   1. refuses while the person hosts a LIVE kelabo (end it first — closure
 *      must not yank a meeting out from under its participants),
 *   2. cancels scheduled kelabos they host and deletes those invite rows
 *      (silently — no cancellation emails: the account is being erased, not
 *      the meeting moved),
 *   3. every record they host — S3 archive, kelabos partition, history row,
 *      every participant's index row — after unlinking it from any journey
 *      (the host may always unlink; see unlinkKelabo's host authority), and
 *      their own index row on records they merely attended,
 *   4. `INVITE#` rows naming them on other hosts' kelabos (invitee-index),
 *   5. their contacts partition and the mirror rows on peers' partitions,
 *   6. their MCP servers: the bearer token stored beside each, cached
 *      OAuth tokens, then the server rows,
 *   7. every refresh-table row (RT# chains and AGT# agent tokens — deleted,
 *      not revoked: the rows carry the email),
 *   8. any pending OTP,
 *   9. the `USER#` row, settings and all.
 *
 * What it deliberately does NOT touch:
 *   - records OTHER hosts keep in which this person appears: those are the
 *     hosts' records of their own meetings, exactly like minutes naming an
 *     attendee, and the transcript lines already carry a display label, never
 *     the address (speakerLabel's rule),
 *   - other people's private FAV# rows naming them (their owners' address
 *     books; no index reaches them),
 *   - journeys they own: a journey is shared work, so closure refuses instead
 *     when they own any — transfer or delete those first (`journey_owner`).
 *
 * `dryRun` walks the same lists and returns the same report without deleting
 * anything.
 */
export function createCloseAccount({ config, db, records, secrets, log }) {
  const warn = (msg, fields) =>
    (log || ((m, f) => console.warn(JSON.stringify({ level: "warn", msg: m, ...f }))))(msg, fields);

  async function close({ identity: rawIdentity, dryRun = false, now = Date.now() }) {
    const identity = String(rawIdentity || "").trim().toLowerCase();
    if (!identity.includes("@")) throw err(400, "bad_request", "identity must be an email address");
    const tenantId = identity.split("@")[1];

    const report = {
      identity,
      dryRun,
      scheduledCancelled: [],
      recordsPurged: 0,
      recordsLeftLists: 0,
      journeysUnlinked: 0,
      invitesRemoved: 0,
      contactRowsRemoved: 0,
      mcpServersRemoved: 0,
      credentialRowsRemoved: 0,
      userDeleted: false,
      warnings: [],
    };

    // 0a. A live kelabo they host blocks closure outright.
    const active = await db.listKelabosByStatusForIdentity(identity, "active");
    const hostingActive = [...active.sameTenant, ...active.crossTenant].filter(
      (m) => m.hostIdentity === identity
    );
    if (hostingActive.length) {
      throw err(409, "kelabo_active", `hosting ${hostingActive.length} live kelabo(s) — end them first`);
    }

    // 0b. So does a journey they own: it is shared work other people rely on,
    // and silently deleting it with the account would take their material too.
    const ownedJourneys = (await db.listJourneysByTenantStatus(tenantId, "active").catch(() => []))
      .concat(await db.listJourneysByTenantStatus(tenantId, "completed").catch(() => []))
      .filter((j) => j.ownerIdentity === identity);
    if (ownedJourneys.length) {
      throw err(409, "journey_owner", `owns ${ownedJourneys.length} journey(s) — delete or transfer them first`);
    }

    // 1. Scheduled kelabos they host: cancel, then delete the invite rows.
    const scheduled = await db.listKelabosByStatusForIdentity(identity, "scheduled");
    const hostedScheduled = [...scheduled.sameTenant, ...scheduled.crossTenant].filter(
      (m) => m.hostIdentity === identity
    );
    for (const meta of hostedScheduled) {
      report.scheduledCancelled.push(meta.kelaboId);
      if (dryRun) continue;
      const ttl = Math.floor(now / 1000) + config.retentionDays * 86400;
      try {
        await db.cancelScheduledKelabo({
          kelaboId: meta.kelaboId,
          tenantId: meta.tenantId,
          cancelledAt: now,
          reason: "account_closed",
          ttl,
        });
      } catch (e) {
        // Raced a start/cancel — re-read; an already-cancelled one still needs
        // its invite rows swept below, an active one now blocks the closure.
        const fresh = await db.getKelaboMeta(meta.kelaboId).catch(() => null);
        if (fresh?.status === "active") throw err(409, "kelabo_active", "a scheduled kelabo went live mid-closure");
        if (fresh && fresh.status !== "cancelled") throw e;
      }
      const invites = await db.listInvites(meta.kelaboId).catch(() => []);
      for (const inv of invites) {
        await db.removeInvite(meta.kelaboId, inv.inviteKey).catch((e) =>
          warn("close_account_invite_delete_failed", { identity, kelaboId: meta.kelaboId, error: String(e) })
        );
      }
    }

    // 2. Records. deleteRecord applies the ownership rule this module must
    // not restate: hosted -> full purge, attended -> own index row only.
    // Hosted records are unlinked from journeys first, or purgeOne refuses.
    const indexRows = await db.listRecordsByParticipant(identity);
    const seen = new Set();
    for (const it of indexRows) {
      const archiveId = it.kelaboId || it.meetingId || it.archiveId;
      if (!archiveId || seen.has(archiveId)) continue;
      seen.add(archiveId);
      const row = await db.getHistory(archiveId).catch(() => null);
      const isHost = row?.host === identity;
      if (isHost) report.recordsPurged++;
      else report.recordsLeftLists++;
      if (dryRun) continue;
      if (isHost) {
        const kelaboId = row.kelaboId || archiveId;
        const links = await db.listKelaboJourneyLinks(kelaboId).catch(() => []);
        for (const link of links) {
          await db
            .unlinkKelaboFromJourney({ journeyId: link.journeyId, kelaboId, now })
            .then(() => report.journeysUnlinked++)
            .catch((e) =>
              warn("close_account_unlink_failed", { identity, kelaboId, journeyId: link.journeyId, error: String(e) })
            );
        }
      }
      try {
        await records.deleteRecord({ identity, archiveId });
      } catch (e) {
        report.warnings.push(`record ${archiveId}: ${String(e?.message || e)}`);
        warn("close_account_record_failed", { identity, archiveId, error: String(e) });
      }
    }

    // 3. Invitations naming them on kelabos they do not host.
    const invites = await db.listInvitesByIdentity(identity).catch(() => []);
    for (const inv of invites) {
      const kelaboId = typeof inv.PK === "string" ? inv.PK.slice("KELABO#".length) : null;
      if (!kelaboId) continue;
      report.invitesRemoved++;
      if (dryRun) continue;
      await db.removeInvite(kelaboId, identity).catch((e) =>
        warn("close_account_invite_delete_failed", { identity, kelaboId, error: String(e) })
      );
    }

    // 4. Contacts, both sides.
    if (dryRun) {
      report.contactRowsRemoved = (await db.listFavourites(identity).catch(() => [])).length;
    } else {
      report.contactRowsRemoved = await db.deleteContactsForIdentity(identity).catch((e) => {
        report.warnings.push(`contacts: ${String(e?.message || e)}`);
        return 0;
      });
    }

    // 5. MCP servers, their secrets, their cached tokens.
    const scope = `host#${identity}`;
    const servers = await db.getMcpServers(scope).catch(() => []);
    for (const server of servers) {
      const name = server.name || (typeof server.SK === "string" ? server.SK.slice("SERVER#".length) : "");
      if (!name) continue;
      report.mcpServersRemoved++;
      if (dryRun) continue;
      // Unconditional, and no longer a Secrets Manager call: the bearer token
      // is a `SECRET#<name>` row in the same partition as the server, so this
      // is the same shape of idempotent delete as the OAuth token below and a
      // delete of an absent row succeeds. Gating it on `server.secretRef` —
      // which is the *old* pointer, absent on every row written since the move
      // — would leave the new rows behind on exactly the accounts this
      // function exists to erase.
      await db.deleteMcpSecret(scope, name).catch((e) =>
        warn("close_account_mcp_secret_failed", { identity, name, error: String(e) })
      );
      await db.deleteMcpToken(scope, name).catch(() => {});
      await db.deleteMcpServer(scope, name).catch((e) =>
        warn("close_account_mcp_server_failed", { identity, name, error: String(e) })
      );
    }

    // 6. Credentials: refresh chains and agent tokens, deleted whole.
    if (dryRun) {
      report.credentialRowsRemoved = (await db.listRefreshTokensByIdentity(sha256(identity)).catch(() => [])).length;
    } else {
      report.credentialRowsRemoved = await db.deleteRefreshRowsByIdentity(sha256(identity)).catch((e) => {
        report.warnings.push(`credentials: ${String(e?.message || e)}`);
        return 0;
      });
    }

    // 7. A sign-in code in flight, and finally the account row itself.
    if (!dryRun) {
      await db.deleteOtp(identity).catch(() => {});
      await db.deleteUser(identity);
      report.userDeleted = true;
    }

    return report;
  }

  return { close };
}
