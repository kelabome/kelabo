// Account closure (src/closeAccount.js).
//
// The properties worth pinning are not "it calls delete" but the ones that
// make closure safe to run against a live deployment:
//   * it REFUSES rather than yanks: a live hosted kelabo or an owned journey
//     blocks the whole closure before anything is touched,
//   * the USER# row goes LAST — a run that dies halfway leaves an account
//     that can be found and closed again,
//   * hosted records are journey-unlinked before deletion (purgeOne refuses
//     linked kelabos; the host authority exists precisely for this),
//   * dryRun walks every list and deletes nothing.
import assert from "node:assert/strict";
import { createCloseAccount } from "../src/closeAccount.js";
import { sha256 } from "../src/jwt.js";

let passed = 0;
function ok(msg) {
  console.log(`ok - ${msg}`);
  passed++;
}

const IDENTITY = "kim@example.com";

function makeWorld(overrides = {}) {
  const ops = []; // every mutation, in order — the ordering property lives here
  const world = {
    active: [],
    scheduled: [],
    journeysOwned: [],
    indexRows: [],
    history: {},
    journeyLinks: {},
    invitesByKelabo: {},
    invitesNamingMe: [],
    favourites: [],
    mcpServers: [],
    refreshRows: [],
    ...overrides,
  };
  const db = {
    listKelabosByStatusForIdentity: async (identity, status) => ({
      sameTenant: (status === "active" ? world.active : world.scheduled).filter(() => true),
      crossTenant: [],
    }),
    listJourneysByTenantStatus: async (tenant, status) =>
      status === "active" ? world.journeysOwned : [],
    getKelaboMeta: async (id) => world.history[id]?.meta ?? null,
    cancelScheduledKelabo: async ({ kelaboId }) => ops.push(["cancel", kelaboId]),
    listInvites: async (kelaboId) => world.invitesByKelabo[kelaboId] || [],
    removeInvite: async (kelaboId, inviteKey) => ops.push(["removeInvite", kelaboId, inviteKey]),
    listRecordsByParticipant: async () => world.indexRows,
    getHistory: async (id) => world.history[id]?.row ?? null,
    listKelaboJourneyLinks: async (kelaboId) => world.journeyLinks[kelaboId] || [],
    unlinkKelaboFromJourney: async ({ journeyId, kelaboId }) => ops.push(["unlink", journeyId, kelaboId]),
    listInvitesByIdentity: async () => world.invitesNamingMe,
    listFavourites: async () => world.favourites,
    deleteContactsForIdentity: async (identity) => {
      ops.push(["contacts", identity]);
      return world.favourites.length;
    },
    getMcpServers: async () => world.mcpServers,
    deleteMcpToken: async (scope, name) => ops.push(["mcpToken", name]),
    deleteMcpServer: async (scope, name) => ops.push(["mcpServer", name]),
    listRefreshTokensByIdentity: async () => world.refreshRows,
    deleteRefreshRowsByIdentity: async (hash) => {
      assert.equal(hash, sha256(IDENTITY), "credentials are looked up by the identity HASH");
      ops.push(["refresh"]);
      return world.refreshRows.length;
    },
    deleteOtp: async (email) => ops.push(["otp", email]),
    deleteUser: async (email) => ops.push(["deleteUser", email]),
  };
  const records = {
    deleteRecord: async ({ identity, archiveId }) => {
      ops.push(["deleteRecord", archiveId]);
      const row = world.history[archiveId]?.row;
      return { archiveId, outcome: row?.host === identity ? "purged" : "removed_from_list" };
    },
  };
  const secrets = {
    deleteMcpSecret: async (config, identity, name) => ops.push(["mcpSecret", name]),
  };
  const closeAccount = createCloseAccount({
    config: { retentionDays: 30 },
    db,
    records,
    secrets,
    log: () => {},
  });
  return { ops, world, closeAccount };
}

// --- refusals ---------------------------------------------------------------

{
  const { ops, closeAccount } = makeWorld({
    active: [{ kelaboId: "k1", hostIdentity: IDENTITY }],
  });
  await assert.rejects(
    () => closeAccount.close({ identity: IDENTITY }),
    (e) => e.status === 409 && e.code === "kelabo_active"
  );
  assert.equal(ops.length, 0, "nothing touched before the refusal");
  ok("refuses while hosting a live kelabo, before touching anything");
}

{
  const { ops, closeAccount } = makeWorld({
    journeysOwned: [{ journeyId: "j1", ownerIdentity: IDENTITY }],
  });
  await assert.rejects(
    () => closeAccount.close({ identity: IDENTITY }),
    (e) => e.status === 409 && e.code === "journey_owner"
  );
  assert.equal(ops.length, 0);
  ok("refuses while owning a journey — shared work is not deleted with an account");
}

{
  const { closeAccount } = makeWorld();
  await assert.rejects(
    () => closeAccount.close({ identity: "not-an-email" }),
    (e) => e.status === 400
  );
  ok("refuses a non-email identity");
}

// --- the full closure -------------------------------------------------------

{
  const { ops, closeAccount } = makeWorld({
    scheduled: [{ kelaboId: "sch1", hostIdentity: IDENTITY, tenantId: "example.com" }],
    invitesByKelabo: { sch1: [{ inviteKey: IDENTITY }, { inviteKey: "guest@x.com" }] },
    indexRows: [
      { kelaboId: "hosted1" },
      { kelaboId: "attended1" },
      { kelaboId: "hosted1" }, // duplicate index row — must not double-delete
    ],
    history: {
      hosted1: { row: { archiveId: "hosted1", kelaboId: "hosted1", host: IDENTITY, endedAt: 5 } },
      attended1: { row: { archiveId: "attended1", kelaboId: "attended1", host: "other@x.com", endedAt: 5 } },
    },
    journeyLinks: { hosted1: [{ journeyId: "j9" }] },
    invitesNamingMe: [{ PK: "KELABO#other-kelabo", SK: `INVITE#${IDENTITY}` }],
    favourites: [{ peer: "pal@x.com" }],
    mcpServers: [{ name: "github", secretRef: `${IDENTITY}/github` }, { SK: "SERVER#plain" }],
    refreshRows: [{ PK: "RT#1" }, { PK: "AGT#2" }],
  });

  const report = await closeAccount.close({ identity: IDENTITY });

  assert.deepEqual(report.scheduledCancelled, ["sch1"]);
  assert.equal(report.recordsPurged, 1);
  assert.equal(report.recordsLeftLists, 1);
  assert.equal(report.journeysUnlinked, 1);
  assert.equal(report.invitesRemoved, 1);
  assert.equal(report.contactRowsRemoved, 1);
  assert.equal(report.mcpServersRemoved, 2);
  assert.equal(report.credentialRowsRemoved, 2);
  assert.equal(report.userDeleted, true);
  assert.equal(report.warnings.length, 0);
  ok("full closure reports every category it touched");

  // The ordering property: unlink strictly before its record's deletion, and
  // the USER# row strictly last.
  const names = ops.map((o) => o[0]);
  assert.equal(names[names.length - 1], "deleteUser", "USER# row goes last");
  assert.ok(
    ops.findIndex((o) => o[0] === "unlink") < ops.findIndex((o) => o[0] === "deleteRecord" && o[1] === "hosted1"),
    "journey unlink precedes the hosted record's deletion"
  );
  ok("USER# row is deleted last; unlink precedes the hosted purge");

  // The hosted record was deleted once despite two index rows; the secretless
  // MCP server deleted without a secret call.
  assert.equal(ops.filter((o) => o[0] === "deleteRecord" && o[1] === "hosted1").length, 1);
  assert.deepEqual(
    ops.filter((o) => o[0] === "mcpSecret").map((o) => o[1]),
    ["github"],
    "only the server with a secretRef gets a Secrets Manager delete"
  );
  ok("duplicate index rows collapse to one deletion; only real secrets are deleted");
}

// --- dry run ----------------------------------------------------------------

{
  const { ops, closeAccount } = makeWorld({
    scheduled: [{ kelaboId: "sch1", hostIdentity: IDENTITY, tenantId: "example.com" }],
    indexRows: [{ kelaboId: "hosted1" }],
    history: { hosted1: { row: { archiveId: "hosted1", host: IDENTITY, endedAt: 5 } } },
    invitesNamingMe: [{ PK: "KELABO#z", SK: `INVITE#${IDENTITY}` }],
    favourites: [{ peer: "pal@x.com" }],
    mcpServers: [{ name: "github", secretRef: "x" }],
    refreshRows: [{ PK: "RT#1" }],
  });
  const report = await closeAccount.close({ identity: IDENTITY, dryRun: true });
  assert.equal(ops.length, 0, "a dry run deletes nothing");
  assert.equal(report.recordsPurged, 1);
  assert.equal(report.invitesRemoved, 1);
  assert.equal(report.mcpServersRemoved, 1);
  assert.equal(report.userDeleted, false);
  ok("dryRun walks every list, counts everything, deletes nothing");
}

console.log(`\n${passed} passed`);
