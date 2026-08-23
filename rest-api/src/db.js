import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
  DeleteCommand,
  QueryCommand,
  TransactWriteCommand,
  BatchWriteCommand,
} from "@aws-sdk/lib-dynamodb";

// Must match the width the Gateway writes with (`pad(at, 13)` in
// gateway/src/db.js), because the sort key is compared as a *string*. Padding to
// 15 here put two extra zeros in front of every `since` cursor, and `'1' > '0'`
// at the first differing byte made `SK > :sk` true for every contribution ever
// written — so an incremental board backfill silently returned the oldest items
// instead of the ones after the cursor. Invisible until a board got long, which
// is exactly what prep posts do (docs 16 §5).
const CONTRIB_KEY_WIDTH = 13;
const pad = (n, width = CONTRIB_KEY_WIDTH) => String(Math.max(0, Math.floor(n))).padStart(width, "0");

// Same-millisecond tie-breaker for a timeline row's sort key (docs 20 §9.1) —
// not a secret, not an identity, exactly like the CONTRIB# suffix the Gateway
// writes (`gateway/src/db.js`'s `Math.random().toString(36)`).
const randSuffix = () => Math.random().toString(36).slice(2, 8);

export function createDb({ config, client } = {}) {
  const doc =
    client ||
    DynamoDBDocumentClient.from(new DynamoDBClient({ region: config?.region || process.env.AWS_REGION }), {
      marshallOptions: { removeUndefinedValues: true },
    });
  const T = config.tableNames;

  async function getKelaboMeta(kelaboId) {
    const res = await doc.send(
      new GetCommand({ TableName: T.kelabos, Key: { PK: `KELABO#${kelaboId}`, SK: "META" } })
    );
    return res.Item || null;
  }

  // No host guard: a host may run any number of live kelabos at once (the
  // HOSTACTIVE#<host> GUARD row that used to forbid a second one was removed
  // 2026-07-31 — it silently bounced "create" to the existing kelabo). The
  // condition only defends against a kelaboId collision.
  async function createKelabo(meta) {
    await doc.send(
      new PutCommand({
        TableName: T.kelabos,
        Item: { PK: `KELABO#${meta.kelaboId}`, SK: "META", ...meta },
        ConditionExpression: "attribute_not_exists(PK)",
      })
    );
  }

  // Legacy cleanup only: HOSTACTIVE#<host> GUARD rows written before hosts
  // could run several live kelabos (pre-2026-07-31). Nothing writes or reads
  // them any more; end/purge paths delete them so the rows drain away.
  async function deleteHostGuard(hostIdentity) {
    await doc.send(
      new DeleteCommand({ TableName: T.kelabos, Key: { PK: `HOSTACTIVE#${hostIdentity}`, SK: "GUARD" } })
    );
  }

  async function listKelabosByStatus(tenantId, status) {
    const res = await doc.send(
      new QueryCommand({
        TableName: T.kelabos,
        IndexName: "status-index",
        KeyConditionExpression: "tenantStatus = :ts",
        ScanIndexForward: false,
        ExpressionAttributeValues: { ":ts": `${tenantId}#${status}` },
      })
    );
    return res.Items || [];
  }

  /**
   * Every kelabo `identity` can reach at `status`, from both halves of "who
   * can see this": their own tenant's index (the common case — colleagues
   * share visibility by tenant alone) and, separately, any kelabo hosted at a
   * DIFFERENT tenant where `identity` specifically holds an INVITE# row of
   * this status. Returned as two arrays rather than merged, because they are
   * not the same visibility rule — a caller applies its own policy to
   * `sameTenant` (e.g. "not unlisted, or host, or already joined") and a
   * cross-tenant kelabo is visible for the narrower reason that put it in
   * `crossTenant` at all: a specific invite, nothing broader.
   */
  async function listKelabosByStatusForIdentity(identity, status) {
    const tenantId = identity.split("@")[1]?.toLowerCase();
    const [sameTenant, myInvites] = await Promise.all([
      listKelabosByStatus(tenantId, status),
      listInvitesByIdentity(identity),
    ]);
    const known = new Set(sameTenant.map((m) => m.kelaboId));
    const otherIds = [
      ...new Set(
        myInvites.map((i) => String(i.PK).slice("KELABO#".length)).filter((id) => id && !known.has(id))
      ),
    ];
    const otherMetas = await Promise.all(otherIds.map((id) => getKelaboMeta(id)));
    const crossTenant = otherMetas.filter((m) => m && m.status === status);
    return { sameTenant, crossTenant };
  }

  async function updateKelaboMeta(kelaboId, updates) {
    const names = {};
    const values = {};
    const sets = [];
    const removes = [];
    for (const [k, v] of Object.entries(updates)) {
      if (v === null) {
        removes.push(`#${k}`);
        names[`#${k}`] = k;
      } else {
        sets.push(`#${k} = :${k}`);
        names[`#${k}`] = k;
        values[`:${k}`] = v;
      }
    }
    const expr = [sets.length ? `SET ${sets.join(", ")}` : "", removes.length ? `REMOVE ${removes.join(", ")}` : ""]
      .filter(Boolean)
      .join(" ");
    await doc.send(
      new UpdateCommand({
        TableName: T.kelabos,
        Key: { PK: `KELABO#${kelaboId}`, SK: "META" },
        UpdateExpression: expr,
        ExpressionAttributeNames: names,
        ...(Object.keys(values).length ? { ExpressionAttributeValues: values } : {}),
      })
    );
  }

  async function appendParticipant(kelaboId, participant) {
    await doc.send(
      new UpdateCommand({
        TableName: T.kelabos,
        Key: { PK: `KELABO#${kelaboId}`, SK: "META" },
        UpdateExpression:
          "SET participants = list_append(if_not_exists(participants, :empty), :p)",
        ExpressionAttributeValues: { ":p": [participant], ":empty": [] },
      })
    );
  }


  // --- scheduled kelabos, invitations, people ------------------------------

  async function createScheduledKelabo(meta) {
    await doc.send(
      new PutCommand({
        TableName: T.kelabos,
        Item: { PK: `KELABO#${meta.kelaboId}`, SK: "META", ...meta },
        ConditionExpression: "attribute_not_exists(PK)",
      })
    );
  }

  // Flips a scheduled kelabo live. The condition on the META item is what
  // stops two clicks of "Start now" — or a click and a retry — producing two
  // live kelabos from one schedule.
  async function startScheduledKelabo({ kelaboId, tenantId, startedAt }) {
    await doc.send(
      new UpdateCommand({
        TableName: T.kelabos,
        Key: { PK: `KELABO#${kelaboId}`, SK: "META" },
        UpdateExpression:
          "SET #status = :active, tenantStatus = :ts, startedAt = :now, hostJoinedAt = :now",
        ConditionExpression: "#status = :scheduled",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":active": "active",
          ":scheduled": "scheduled",
          ":ts": `${tenantId}#active`,
          ":now": startedAt,
        },
      })
    );
  }

  // Cancel a scheduled kelabo (docs 18 §2.3). The condition `#status =
  // :scheduled` is the serialization point against startScheduledKelabo, whose
  // own condition is the mirror image: a cancel and a "Start now" that race
  // resolve cleanly — one wins, the other's condition fails. `tenantStatus` is
  // set to `<tenant>#cancelled` (NOT removed, unlike end), `startedAt` stays a
  // Number so the row is not silently un-indexed, and a `ttl` is set so the
  // cancelled row self-expires — the first place a never-started kelabo gets
  // one.
  //
  // `ttl` is written through `#ttl`, not by name: TTL is a DynamoDB **reserved
  // word**, so a bare `ttl = :ttl` fails the whole update with a
  // ValidationException — every cancel was a 500. Nothing else here needs an
  // alias, which is exactly why this one was easy to miss.
  async function cancelScheduledKelabo({ kelaboId, tenantId, cancelledAt, reason, ttl }) {
    await doc.send(
      new UpdateCommand({
        TableName: T.kelabos,
        Key: { PK: `KELABO#${kelaboId}`, SK: "META" },
        UpdateExpression:
          "SET #status = :cancelled, tenantStatus = :ts, cancelledAt = :now, #ttl = :ttl" +
          (reason ? ", cancelReason = :r" : ""),
        ConditionExpression: "#status = :scheduled",
        ExpressionAttributeNames: { "#status": "status", "#ttl": "ttl" },
        ExpressionAttributeValues: {
          ":cancelled": "cancelled",
          ":scheduled": "scheduled",
          ":ts": `${tenantId}#cancelled`,
          ":now": cancelledAt,
          ":ttl": ttl,
          ...(reason ? { ":r": reason } : {}),
        },
      })
    );
  }

  // Reschedule a scheduled kelabo (docs 18 §3). Same `#status = :scheduled`
  // guard. `updates` is a partial META (scheduledAt/durationMinutes/title/note
  // plus the rescheduledAt/previousScheduledAt bookkeeping the handler adds);
  // every key is applied as a SET so a caller cannot remove attributes here.
  async function rescheduleKelabo({ kelaboId, updates }) {
    const names = { "#status": "status" };
    const values = { ":scheduled": "scheduled" };
    const sets = [];
    for (const [k, v] of Object.entries(updates)) {
      names[`#${k}`] = k;
      values[`:${k}`] = v;
      sets.push(`#${k} = :${k}`);
    }
    await doc.send(
      new UpdateCommand({
        TableName: T.kelabos,
        Key: { PK: `KELABO#${kelaboId}`, SK: "META" },
        UpdateExpression: `SET ${sets.join(", ")}`,
        ConditionExpression: "#status = :scheduled",
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
      })
    );
  }

  // Reset every non-host invitee to `pending` (docs 18 §3.2). Called on a
  // reschedule only when the *time* moved: a new time invalidates "I can
  // attend". `invitedAt` is preserved, `respondedAt` is dropped. The host's
  // auto-RSVP is left accepted. putInvite is a full Put, so each row is rewritten
  // whole from the row already read.
  async function resetInviteResponses(kelaboId) {
    const invites = await listInvites(kelaboId);
    for (const inv of invites) {
      if (inv.isHost) continue;
      if (inv.response === "pending") continue;
      const { respondedAt, ...rest } = inv;
      await doc.send(
        new PutCommand({
          TableName: T.kelabos,
          Item: { PK: `KELABO#${kelaboId}`, SK: `INVITE#${inv.inviteKey}`, ...rest, response: "pending" },
        })
      );
    }
  }

  /**
   * One invitation. `inviteKey` is the email for someone with an address and
   * `g:<uuid>` for a guest who only ever gave a name, so both live in the same
   * partition and one query lists everybody.
   */
  async function putInvite(kelaboId, invite) {
    await doc.send(
      new PutCommand({
        TableName: T.kelabos,
        Item: { PK: `KELABO#${kelaboId}`, SK: `INVITE#${invite.inviteKey}`, ...invite },
      })
    );
  }

  async function getInvite(kelaboId, inviteKey) {
    const res = await doc.send(
      new GetCommand({ TableName: T.kelabos, Key: { PK: `KELABO#${kelaboId}`, SK: `INVITE#${inviteKey}` } })
    );
    return res.Item || null;
  }

  /** Drop one invitation (docs 18 §3.5) — the host removing someone from a
   *  kelabo that has not started yet, as opposed to `cancelScheduledKelabo`
   *  which drops everyone by ending the kelabo itself. */
  async function removeInvite(kelaboId, inviteKey) {
    await doc.send(
      new DeleteCommand({ TableName: T.kelabos, Key: { PK: `KELABO#${kelaboId}`, SK: `INVITE#${inviteKey}` } })
    );
  }

  async function listInvites(kelaboId) {
    const res = await doc.send(
      new QueryCommand({
        TableName: T.kelabos,
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk)",
        ExpressionAttributeValues: { ":pk": `KELABO#${kelaboId}`, ":sk": "INVITE#" },
      })
    );
    return res.Items || [];
  }

  /**
   * Every INVITE# row naming `identity`, across every kelabo — the
   * `invitee-index` GSI, sparse on `inviteKey`. This is the query
   * `listInvites` cannot do: that one lists everybody invited to ONE kelabo
   * you already know the id of; this lists every kelabo ONE person was
   * invited to, including ones hosted at a tenant they do not belong to.
   */
  async function listInvitesByIdentity(identity) {
    const res = await doc.send(
      new QueryCommand({
        TableName: T.kelabos,
        IndexName: "invitee-index",
        KeyConditionExpression: "inviteKey = :k",
        ExpressionAttributeValues: { ":k": identity },
      })
    );
    return res.Items || [];
  }

  /**
   * Everyone registered at one email domain, optionally narrowed by an address
   * prefix. Reads the `tenant-index` GSI on the users table — the people who
   * actually have accounts, rather than a parallel list that can drift from
   * them. Partitioned by tenant, so a query cannot see another domain even by
   * accident.
   */
  async function listUsersByTenant(tenantId, prefix, limit = 8) {
    const res = await doc.send(
      new QueryCommand({
        TableName: T.users,
        IndexName: "tenant-index",
        KeyConditionExpression: prefix
          ? "tenantId = :t AND begins_with(email, :p)"
          : "tenantId = :t",
        ExpressionAttributeValues: prefix
          ? { ":t": tenantId, ":p": prefix.toLowerCase() }
          : { ":t": tenantId },
        Limit: limit,
      })
    );
    return res.Items || [];
  }

  // --- contacts: favourites (docs 18 §4) ------------------------------------
  //
  // A favourite is one row the favouriter owns: `PK = CONTACT#<owner>`,
  // `SK = FAV#<peer>`. It is private and one-way — there is no row on the peer's
  // side and no query that reveals who favourited them. Add is a conditional
  // Put (idempotent-safe), remove is a Delete, list is a prefix Query. No
  // transaction: a one-way marker cannot be half-written.

  async function listFavourites(owner) {
    const res = await doc.send(
      new QueryCommand({
        TableName: T.contacts,
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk)",
        ExpressionAttributeValues: { ":pk": `CONTACT#${owner}`, ":sk": "FAV#" },
      })
    );
    return res.Items || [];
  }

  async function getFavourite(owner, peer) {
    const res = await doc.send(
      new GetCommand({ TableName: T.contacts, Key: { PK: `CONTACT#${owner}`, SK: `FAV#${peer}` } })
    );
    return res.Item || null;
  }

  async function putFavourite({ owner, peer, tenantId }) {
    await doc.send(
      new PutCommand({
        TableName: T.contacts,
        Item: { PK: `CONTACT#${owner}`, SK: `FAV#${peer}`, owner, peer, tenantId, createdAt: Date.now() },
      })
    );
  }

  async function deleteFavourite(owner, peer) {
    await doc.send(
      new DeleteCommand({ TableName: T.contacts, Key: { PK: `CONTACT#${owner}`, SK: `FAV#${peer}` } })
    );
  }

  // The owner's accepted external contacts (docs 18 §4/§6). Only `PEER#` rows in
  // the `accepted` state; used to authorize ringing someone outside your org.
  // Empty until external contacts are enabled.
  async function listAcceptedContacts(owner) {
    const res = await doc.send(
      new QueryCommand({
        TableName: T.contacts,
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk)",
        ExpressionAttributeValues: { ":pk": `CONTACT#${owner}`, ":sk": "PEER#" },
      })
    );
    return (res.Items || []).filter((r) => r.state === "accepted").map((r) => r.peer);
  }

  // --- Journeys (docs 20) ---------------------------------------------------
  //
  // One partition per journey, `PK = JOURNEY#<id>`. META, a DESC# version
  // chain, ACCESSOR# (private-journey roster) and LINK# (kelabo membership)
  // items share it. A journey's own forward LINK# is mirrored onto the
  // KELABO's own partition as a `JOURNEY#<id>` item — written in the same
  // transaction as the forward link — so "does this kelabo belong to any
  // journey" is a query on the kelabo's own partition: no new GSI, no
  // cross-table scan (docs 20 §4.3).

  // Description versions are their own, narrower sort-key width: six digits
  // is ample for how many edits one journey's description will ever have,
  // and keeping it distinct from CONTRIB_KEY_WIDTH documents that the two
  // are unrelated contracts that happen to both zero-pad a counter.
  const DESC_KEY_WIDTH = 6;
  const padVersion = (n) => String(Math.max(0, Math.floor(n))).padStart(DESC_KEY_WIDTH, "0");

  async function createJourney(meta) {
    await doc.send(
      new PutCommand({
        TableName: T.journeys,
        Item: { PK: `JOURNEY#${meta.journeyId}`, SK: "META", ...meta },
        ConditionExpression: "attribute_not_exists(PK)",
      })
    );
  }

  async function getJourneyMeta(journeyId) {
    const res = await doc.send(
      new GetCommand({ TableName: T.journeys, Key: { PK: `JOURNEY#${journeyId}`, SK: "META" } })
    );
    return res.Item || null;
  }

  async function updateJourneyMeta(journeyId, updates) {
    const names = {};
    const values = {};
    const sets = [];
    const removes = [];
    for (const [k, v] of Object.entries(updates)) {
      if (v === null) {
        removes.push(`#${k}`);
        names[`#${k}`] = k;
      } else {
        sets.push(`#${k} = :${k}`);
        names[`#${k}`] = k;
        values[`:${k}`] = v;
      }
    }
    const expr = [sets.length ? `SET ${sets.join(", ")}` : "", removes.length ? `REMOVE ${removes.join(", ")}` : ""]
      .filter(Boolean)
      .join(" ");
    await doc.send(
      new UpdateCommand({
        TableName: T.journeys,
        Key: { PK: `JOURNEY#${journeyId}`, SK: "META" },
        UpdateExpression: expr,
        ExpressionAttributeNames: names,
        ...(Object.keys(values).length ? { ExpressionAttributeValues: values } : {}),
      })
    );
  }

  // Owner-only structural transitions, conditional on the status they expect —
  // the same shape as startScheduledKelabo/cancelScheduledKelabo above, so a
  // double-click or a race resolves to a clean condition failure rather than a
  // double transition.
  async function completeJourney({ journeyId, tenantId, completedAt, completedBy }) {
    await doc.send(
      new UpdateCommand({
        TableName: T.journeys,
        Key: { PK: `JOURNEY#${journeyId}`, SK: "META" },
        UpdateExpression:
          "SET #status = :completed, tenantStatus = :ts, completedAt = :now, completedBy = :by, updatedAt = :now",
        ConditionExpression: "#status = :active",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":completed": "completed",
          ":active": "active",
          ":ts": `${tenantId}#completed`,
          ":now": completedAt,
          ":by": completedBy,
        },
      })
    );
  }

  async function reopenJourney({ journeyId, tenantId, reopenedAt }) {
    await doc.send(
      new UpdateCommand({
        TableName: T.journeys,
        Key: { PK: `JOURNEY#${journeyId}`, SK: "META" },
        UpdateExpression: "SET #status = :active, tenantStatus = :ts, reopenedAt = :now, updatedAt = :now",
        ConditionExpression: "#status = :completed",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":active": "active",
          ":completed": "completed",
          ":ts": `${tenantId}#active`,
          ":now": reopenedAt,
        },
      })
    );
  }

  /** Every ACTIVE-or-COMPLETED journey at one tenant, by status — the same
   *  sparse-on-`tenantStatus` trick `listKelabosByStatus` plays. */
  async function listJourneysByTenantStatus(tenantId, status) {
    const res = await doc.send(
      new QueryCommand({
        TableName: T.journeys,
        IndexName: "tenant-status-index",
        KeyConditionExpression: "tenantStatus = :ts",
        ScanIndexForward: false,
        ExpressionAttributeValues: { ":ts": `${tenantId}#${status}` },
      })
    );
    return res.Items || [];
  }

  /** Every PRIVATE journey `identity` is an explicit accessor of, across every
   *  tenant — the `accessor-index` GSI, sparse on `accessorIdentity`. */
  async function listAccessorJourneys(identity) {
    const res = await doc.send(
      new QueryCommand({
        TableName: T.journeys,
        IndexName: "accessor-index",
        KeyConditionExpression: "accessorIdentity = :i",
        ExpressionAttributeValues: { ":i": identity },
      })
    );
    return res.Items || [];
  }

  async function putJourneyDescriptionVersion(journeyId, version) {
    await doc.send(
      new PutCommand({
        TableName: T.journeys,
        Item: { PK: `JOURNEY#${journeyId}`, SK: `DESC#${padVersion(version.version)}`, ...version },
      })
    );
  }

  async function listJourneyDescriptionVersions(journeyId) {
    const res = await doc.send(
      new QueryCommand({
        TableName: T.journeys,
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk)",
        ExpressionAttributeValues: { ":pk": `JOURNEY#${journeyId}`, ":sk": "DESC#" },
        ScanIndexForward: false,
      })
    );
    return res.Items || [];
  }

  // Health/progress snapshots (docs 20 §5) — same version-chain shape as
  // description, just a different SK prefix and width.
  async function putJourneyStatusVersion(journeyId, version) {
    await doc.send(
      new PutCommand({
        TableName: T.journeys,
        Item: { PK: `JOURNEY#${journeyId}`, SK: `STATUS#${padVersion(version.version)}`, ...version },
      })
    );
  }

  async function listJourneyStatusVersions(journeyId) {
    const res = await doc.send(
      new QueryCommand({
        TableName: T.journeys,
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk)",
        ExpressionAttributeValues: { ":pk": `JOURNEY#${journeyId}`, ":sk": "STATUS#" },
        ScanIndexForward: false,
      })
    );
    return res.Items || [];
  }

  // --- journey accessors (private-journey roster) ---------------------------

  async function putAccessor(journeyId, accessor) {
    await doc.send(
      new PutCommand({
        TableName: T.journeys,
        Item: {
          PK: `JOURNEY#${journeyId}`,
          SK: `ACCESSOR#${accessor.identity}`,
          // The GSI partition key attribute — only an ACCESSOR# item ever
          // carries it, which is what makes accessor-index sparse.
          accessorIdentity: accessor.identity,
          ...accessor,
        },
      })
    );
  }

  async function getAccessor(journeyId, identity) {
    const res = await doc.send(
      new GetCommand({ TableName: T.journeys, Key: { PK: `JOURNEY#${journeyId}`, SK: `ACCESSOR#${identity}` } })
    );
    return res.Item || null;
  }

  async function removeAccessor(journeyId, identity) {
    await doc.send(
      new DeleteCommand({ TableName: T.journeys, Key: { PK: `JOURNEY#${journeyId}`, SK: `ACCESSOR#${identity}` } })
    );
  }

  async function listAccessors(journeyId) {
    const res = await doc.send(
      new QueryCommand({
        TableName: T.journeys,
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk)",
        ExpressionAttributeValues: { ":pk": `JOURNEY#${journeyId}`, ":sk": "ACCESSOR#" },
      })
    );
    return res.Items || [];
  }

  // --- message board (docs 20 §7) --------------------------------------------
  //
  // Two item kinds, both prefixed `BOARDMSG#`, told apart by whether the SK
  // contains `#V#`: `BOARDMSG#<msgId>` is the current, mutable head;
  // `BOARDMSG#<msgId>#V#<version>` is one immutable snapshot behind it.
  // Listing heads therefore queries the shared prefix and filters the
  // version rows out in code — same "query broad, filter in the handler"
  // idiom `listKelabosByStatusForIdentity` already uses, and cheap here
  // because a pinned board stays small.

  async function createBoardMessageHead(journeyId, head) {
    await doc.send(
      new PutCommand({
        TableName: T.journeys,
        Item: { PK: `JOURNEY#${journeyId}`, SK: `BOARDMSG#${head.msgId}`, ...head },
        ConditionExpression: "attribute_not_exists(SK)",
      })
    );
  }

  /** Unconditional overwrite of the head — used for edits and removal,
   *  where the caller already holds the current item and is rewriting it
   *  whole, the same `putInvite` pattern uses. */
  async function putBoardMessageHead(journeyId, head) {
    await doc.send(
      new PutCommand({
        TableName: T.journeys,
        Item: { PK: `JOURNEY#${journeyId}`, SK: `BOARDMSG#${head.msgId}`, ...head },
      })
    );
  }

  async function getBoardMessageHead(journeyId, msgId) {
    const res = await doc.send(
      new GetCommand({ TableName: T.journeys, Key: { PK: `JOURNEY#${journeyId}`, SK: `BOARDMSG#${msgId}` } })
    );
    return res.Item || null;
  }

  async function listBoardMessageHeads(journeyId) {
    const res = await doc.send(
      new QueryCommand({
        TableName: T.journeys,
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk)",
        ExpressionAttributeValues: { ":pk": `JOURNEY#${journeyId}`, ":sk": "BOARDMSG#" },
      })
    );
    return (res.Items || []).filter((i) => !String(i.SK).includes("#V#"));
  }

  async function putBoardMessageVersion(journeyId, version) {
    await doc.send(
      new PutCommand({
        TableName: T.journeys,
        Item: {
          PK: `JOURNEY#${journeyId}`,
          SK: `BOARDMSG#${version.msgId}#V#${padVersion(version.version)}`,
          ...version,
        },
      })
    );
  }

  /** Unambiguous even sharing the `BOARDMSG#` prefix with the head: the
   *  head's SK never contains `#V#`, so this begins_with cannot match it. */
  async function listBoardMessageVersions(journeyId, msgId) {
    const res = await doc.send(
      new QueryCommand({
        TableName: T.journeys,
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk)",
        ExpressionAttributeValues: { ":pk": `JOURNEY#${journeyId}`, ":sk": `BOARDMSG#${msgId}#V#` },
        ScanIndexForward: false,
      })
    );
    return res.Items || [];
  }

  // --- documents (docs 20 §8) -------------------------------------------------
  //
  // One item per document, `DOC#<docId>`. No version chain — a document is
  // added once and only ever soft-removed, never edited (docs 20 §8: "no
  // further edit"), so there is nothing to version.

  async function createDocument(journeyId, item) {
    await doc.send(
      new PutCommand({
        TableName: T.journeys,
        Item: { PK: `JOURNEY#${journeyId}`, SK: `DOC#${item.docId}`, ...item },
        ConditionExpression: "attribute_not_exists(SK)",
      })
    );
  }

  /** Unconditional overwrite — used only for the soft-delete flip. */
  async function putDocument(journeyId, item) {
    await doc.send(
      new PutCommand({
        TableName: T.journeys,
        Item: { PK: `JOURNEY#${journeyId}`, SK: `DOC#${item.docId}`, ...item },
      })
    );
  }

  async function getDocument(journeyId, docId) {
    const res = await doc.send(
      new GetCommand({ TableName: T.journeys, Key: { PK: `JOURNEY#${journeyId}`, SK: `DOC#${docId}` } })
    );
    return res.Item || null;
  }

  async function listDocuments(journeyId) {
    const res = await doc.send(
      new QueryCommand({
        TableName: T.journeys,
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk)",
        ExpressionAttributeValues: { ":pk": `JOURNEY#${journeyId}`, ":sk": "DOC#" },
      })
    );
    return res.Items || [];
  }

  // --- kelabo <-> journey membership -----------------------------------------
  //
  // Many-to-many: linking writes the forward LINK# item in the journey's own
  // partition AND mirrors it onto the kelabo's own partition, in one
  // transaction spanning both tables. DynamoDB transactions may include items
  // from more than one table within an account/region — this is the only
  // place that fact is used.

  async function linkKelaboToJourney({ journeyId, kelaboId, link, mirror }) {
    await doc.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: T.journeys,
              Item: { PK: `JOURNEY#${journeyId}`, SK: `LINK#${kelaboId}`, ...link },
              ConditionExpression: "attribute_not_exists(SK)",
            },
          },
          {
            Update: {
              TableName: T.journeys,
              Key: { PK: `JOURNEY#${journeyId}`, SK: "META" },
              UpdateExpression: "SET kelaboCount = if_not_exists(kelaboCount, :zero) + :one, updatedAt = :now",
              ConditionExpression: "#status = :active",
              ExpressionAttributeNames: { "#status": "status" },
              ExpressionAttributeValues: { ":zero": 0, ":one": 1, ":now": link.linkedAt, ":active": "active" },
            },
          },
          {
            Put: {
              TableName: T.kelabos,
              Item: { PK: `KELABO#${kelaboId}`, SK: `JOURNEY#${journeyId}`, ...mirror },
              ConditionExpression: "attribute_not_exists(SK)",
            },
          },
        ],
      })
    );
  }

  async function unlinkKelaboFromJourney({ journeyId, kelaboId, now }) {
    await doc.send(
      new TransactWriteCommand({
        TransactItems: [
          { Delete: { TableName: T.journeys, Key: { PK: `JOURNEY#${journeyId}`, SK: `LINK#${kelaboId}` } } },
          {
            Update: {
              TableName: T.journeys,
              Key: { PK: `JOURNEY#${journeyId}`, SK: "META" },
              UpdateExpression: "SET kelaboCount = if_not_exists(kelaboCount, :one) - :one, updatedAt = :now",
              ExpressionAttributeValues: { ":one": 1, ":now": now },
            },
          },
          { Delete: { TableName: T.kelabos, Key: { PK: `KELABO#${kelaboId}`, SK: `JOURNEY#${journeyId}` } } },
        ],
      })
    );
  }

  async function getJourneyLink(journeyId, kelaboId) {
    const res = await doc.send(
      new GetCommand({ TableName: T.journeys, Key: { PK: `JOURNEY#${journeyId}`, SK: `LINK#${kelaboId}` } })
    );
    return res.Item || null;
  }

  async function listJourneyLinks(journeyId) {
    const res = await doc.send(
      new QueryCommand({
        TableName: T.journeys,
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk)",
        ExpressionAttributeValues: { ":pk": `JOURNEY#${journeyId}`, ":sk": "LINK#" },
      })
    );
    return res.Items || [];
  }

  /** Every journey this kelabo is linked to — the mirror on its own
   *  partition (docs 20 §4.3). Answers "does this kelabo belong to any
   *  journey" for the purge guard, and renders a "Part of: …" banner. */
  async function listKelaboJourneyLinks(kelaboId) {
    const res = await doc.send(
      new QueryCommand({
        TableName: T.kelabos,
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk)",
        ExpressionAttributeValues: { ":pk": `KELABO#${kelaboId}`, ":sk": "JOURNEY#" },
      })
    );
    return res.Items || [];
  }

  /** One kelabo's mirror of a journey link, deleted on its own — used only
   *  when the whole journey is deleted (the kelabo itself is never touched,
   *  docs 20 §14.1). Ordinary unlink goes through unlinkKelaboFromJourney. */
  async function deleteKelaboJourneyMirror(kelaboId, journeyId) {
    await doc.send(
      new DeleteCommand({ TableName: T.kelabos, Key: { PK: `KELABO#${kelaboId}`, SK: `JOURNEY#${journeyId}` } })
    );
  }

  /**
   * Delete every non-META item under PK=JOURNEY#<id> (docs 20 §14.1). META is
   * deliberately excluded and deleted separately, last, by deleteJourneyMeta —
   * the same "pointer row dies last so a crash is resumable" rule
   * /records/purge already follows.
   * @returns {Promise<number>} items deleted
   */
  async function deleteJourneyChildren(journeyId) {
    let deleted = 0;
    let ExclusiveStartKey;
    do {
      const res = await doc.send(
        new QueryCommand({
          TableName: T.journeys,
          KeyConditionExpression: "PK = :pk",
          FilterExpression: "SK <> :meta",
          ExpressionAttributeValues: { ":pk": `JOURNEY#${journeyId}`, ":meta": "META" },
          ProjectionExpression: "PK, SK",
          ExclusiveStartKey,
        })
      );
      const items = res.Items || [];
      for (let i = 0; i < items.length; i += 25) {
        const chunk = items.slice(i, i + 25);
        let unprocessed = {
          [T.journeys]: chunk.map((it) => ({ DeleteRequest: { Key: { PK: it.PK, SK: it.SK } } })),
        };
        for (let attempt = 0; attempt < 5 && unprocessed[T.journeys]?.length; attempt++) {
          const out = await doc.send(new BatchWriteCommand({ RequestItems: unprocessed }));
          unprocessed = out.UnprocessedItems || {};
        }
        if (unprocessed[T.journeys]?.length) {
          throw new Error(`journey ${journeyId}: ${unprocessed[T.journeys].length} items could not be deleted`);
        }
        deleted += chunk.length;
      }
      ExclusiveStartKey = res.LastEvaluatedKey;
    } while (ExclusiveStartKey);
    return deleted;
  }

  async function deleteJourneyMeta(journeyId) {
    await doc.send(new DeleteCommand({ TableName: T.journeys, Key: { PK: `JOURNEY#${journeyId}`, SK: "META" } }));
  }

  // --- reports (docs 20 §6) ---------------------------------------------------
  //
  // `REPORT#<reportId>` — no timestamp in the sort key, unlike CONTRIB#/TL#:
  // reports are a small, unpaginated collection per journey (no cursor is
  // ever needed), and a bare reportId lets a report be fetched directly by
  // id, which a timestamp-prefixed key would not.

  async function putJourneyReport(journeyId, report) {
    await doc.send(
      new PutCommand({
        TableName: T.journeys,
        Item: { PK: `JOURNEY#${journeyId}`, SK: `REPORT#${report.reportId}`, ...report },
      })
    );
  }

  async function getJourneyReport(journeyId, reportId) {
    const res = await doc.send(
      new GetCommand({ TableName: T.journeys, Key: { PK: `JOURNEY#${journeyId}`, SK: `REPORT#${reportId}` } })
    );
    return res.Item || null;
  }

  async function listJourneyReports(journeyId) {
    const res = await doc.send(
      new QueryCommand({
        TableName: T.journeys,
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk)",
        ExpressionAttributeValues: { ":pk": `JOURNEY#${journeyId}`, ":sk": "REPORT#" },
      })
    );
    return res.Items || [];
  }

  /** Only ever called when the Gateway could not be reached at all — the
   *  Gateway itself marks a report failed for every other reason, straight
   *  from `generateJourneyReport`. */
  async function markJourneyReportFailed(journeyId, reportId, error) {
    await doc.send(
      new UpdateCommand({
        TableName: T.journeys,
        Key: { PK: `JOURNEY#${journeyId}`, SK: `REPORT#${reportId}` },
        UpdateExpression: "SET #status = :failed, #error = :error",
        ConditionExpression: "attribute_exists(PK)",
        ExpressionAttributeNames: { "#status": "status", "#error": "error" },
        ExpressionAttributeValues: { ":failed": "failed", ":error": error },
      })
    ).catch(() => {});
  }

  // --- contributor rollups (docs 20 §10) --------------------------------------
  //
  // The same unconditional-ADD idiom every other usage counter in this system
  // already uses: a fresh identity's first bump creates the row implicitly,
  // so there is no separate "add this person" step. Cumulative, never
  // decremented — a rollup of contribution to the journey, not a live
  // membership count.

  async function bumpContributor(journeyId, identity, field) {
    const now = Date.now();
    await doc.send(
      new UpdateCommand({
        TableName: T.journeys,
        Key: { PK: `JOURNEY#${journeyId}`, SK: `CONTRIBUTOR#${identity}` },
        UpdateExpression:
          `SET contributorIdentity = if_not_exists(contributorIdentity, :identity), ` +
          `firstSeenAt = if_not_exists(firstSeenAt, :now), lastActiveAt = :now, ` +
          `#field = if_not_exists(#field, :zero) + :one`,
        ExpressionAttributeNames: { "#field": field },
        ExpressionAttributeValues: { ":identity": identity, ":now": now, ":zero": 0, ":one": 1 },
      })
    );
  }

  async function listContributors(journeyId) {
    const res = await doc.send(
      new QueryCommand({
        TableName: T.journeys,
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk)",
        ExpressionAttributeValues: { ":pk": `JOURNEY#${journeyId}`, ":sk": "CONTRIBUTOR#" },
      })
    );
    return res.Items || [];
  }

  /**
   * One timeline row (docs 20 §9.1), written alongside whatever it
   * summarizes so the timeline is a genuine index, never a second source of
   * truth that can drift from the items it describes.
   */
  async function putJourneyTimelineEntry(journeyId, entry) {
    const at = entry.at ?? Date.now();
    await doc.send(
      new PutCommand({
        TableName: T.journeys,
        Item: { PK: `JOURNEY#${journeyId}`, SK: `TL#${pad(at)}#${randSuffix()}`, ...entry, at },
      })
    );
  }

  /**
   * Backward cursor (docs 20 §9.2) — `before` excludes everything at or
   * after that timestamp, the same "SK < prefix" shape `/caption/history`
   * uses, chosen over the board's forward `since` because a journey
   * timeline is unbounded and read newest-first. `type` filters in the
   * query, not after — cheap because entries are already few per journey.
   */
  async function listJourneyTimeline(journeyId, { type, before, limit }) {
    const keyCond = before ? "PK = :pk AND SK < :sk" : "PK = :pk AND begins_with(SK, :sk)";
    const values = before
      ? { ":pk": `JOURNEY#${journeyId}`, ":sk": `TL#${pad(before)}` }
      : { ":pk": `JOURNEY#${journeyId}`, ":sk": "TL#" };
    const res = await doc.send(
      new QueryCommand({
        TableName: T.journeys,
        KeyConditionExpression: keyCond,
        ...(type
          ? { FilterExpression: "#type = :type", ExpressionAttributeNames: { "#type": "type" }, ExpressionAttributeValues: { ...values, ":type": type } }
          : { ExpressionAttributeValues: values }),
        ScanIndexForward: false,
        Limit: limit,
      })
    );
    return res.Items || [];
  }

  async function queryContributions(kelaboId, { since, limit }) {
    const keyCond = since
      ? "PK = :pk AND SK > :sk"
      : "PK = :pk AND begins_with(SK, :sk)";
    const values = since
      ? { ":pk": `KELABO#${kelaboId}`, ":sk": `CONTRIB#${pad(since)}` }
      : { ":pk": `KELABO#${kelaboId}`, ":sk": "CONTRIB#" };
    const res = await doc.send(
      new QueryCommand({
        TableName: T.kelabos,
        KeyConditionExpression: keyCond,
        ExpressionAttributeValues: values,
        ScanIndexForward: !!since,
        Limit: limit,
      })
    );
    let items = res.Items || [];
    if (!since) items = items.reverse();
    return items;
  }

  async function getOtp(email) {
    const res = await doc.send(new GetCommand({ TableName: T.otp, Key: { PK: `OTP#${email}` } }));
    return res.Item || null;
  }

  async function putOtp(item) {
    await doc.send(new PutCommand({ TableName: T.otp, Item: { PK: `OTP#${item.email}`, ...item } }));
  }

  async function deleteOtp(email) {
    await doc.send(new DeleteCommand({ TableName: T.otp, Key: { PK: `OTP#${email}` } }));
  }

  async function incrementOtpAttempts(email) {
    const res = await doc.send(
      new UpdateCommand({
        TableName: T.otp,
        Key: { PK: `OTP#${email}` },
        UpdateExpression: "SET attempts = if_not_exists(attempts, :zero) + :one",
        ExpressionAttributeValues: { ":zero": 0, ":one": 1 },
        ReturnValues: "ALL_NEW",
      })
    );
    return res.Attributes;
  }

  async function bumpIpCounter(ip, windowSeconds) {
    const now = Math.floor(Date.now() / 1000);
    const res = await doc.send(
      new UpdateCommand({
        TableName: T.otp,
        Key: { PK: `OTPIP#${ip}` },
        UpdateExpression: "SET #c = if_not_exists(#c, :zero) + :one, #ttl = if_not_exists(#ttl, :ttl)",
        ExpressionAttributeNames: { "#c": "count", "#ttl": "ttl" },
        ExpressionAttributeValues: { ":zero": 0, ":one": 1, ":ttl": now + windowSeconds },
        ReturnValues: "ALL_NEW",
      })
    );
    return res.Attributes;
  }

  async function getUser(email) {
    const res = await doc.send(new GetCommand({ TableName: T.users, Key: { PK: `USER#${email}` } }));
    return res.Item || null;
  }

  async function getUserSettings(email) {
    const user = await getUser(email);
    if (!user?.settings || typeof user.settings !== "object") return null;
    return { settings: user.settings, updatedAt: user.settingsUpdatedAt ?? 0 };
  }

  // Last-write-wins: only apply when the incoming snapshot is newer.
  async function putUserSettings(email, settings, updatedAt) {
    const now = Date.now();
    const ts = Number.isFinite(updatedAt) && updatedAt > 0 ? updatedAt : now;
    try {
      await doc.send(
        new UpdateCommand({
          TableName: T.users,
          Key: { PK: `USER#${email}` },
          UpdateExpression: "SET settings = :s, settingsUpdatedAt = :ts, email = if_not_exists(email, :email), createdAt = if_not_exists(createdAt, :now)",
          ConditionExpression: "attribute_not_exists(settingsUpdatedAt) OR settingsUpdatedAt < :ts",
          ExpressionAttributeValues: { ":s": settings, ":ts": ts, ":email": email, ":now": now },
        })
      );
    } catch (e) {
      if (e.name !== "ConditionalCheckFailedException") throw e;
    }
    return getUserSettings(email);
  }

  async function upsertUser({ email, displayName, tenantId }) {
    const now = Date.now();
    await doc.send(
      new UpdateCommand({
        TableName: T.users,
        Key: { PK: `USER#${email}` },
        UpdateExpression:
          "SET email = :email, displayName = if_not_exists(displayName, :dn), createdAt = if_not_exists(createdAt, :now), lastLoginAt = :now, tenantId = :t",
        ExpressionAttributeValues: { ":email": email, ":dn": displayName, ":now": now, ":t": tenantId },
      })
    );
    return getUser(email);
  }

  async function putRefreshToken(item) {
    await doc.send(new PutCommand({ TableName: T.refresh, Item: { PK: `RT#${item.tokenId}`, ...item } }));
  }

  async function getRefreshToken(tokenId) {
    const res = await doc.send(new GetCommand({ TableName: T.refresh, Key: { PK: `RT#${tokenId}` } }));
    return res.Item || null;
  }

  async function setRefreshRevoked(tokenId, revoked = true, extra = {}) {
    const sets = ["revoked = :r"];
    const values = { ":r": revoked };
    for (const [k, v] of Object.entries(extra)) {
      sets.push(`#${k} = :${k}`);
      values[`:${k}`] = v;
    }
    const ExpressionAttributeNames = Object.keys(extra).length
      ? Object.fromEntries(Object.keys(extra).map((k) => [`#${k}`, k]))
      : undefined;
    await doc.send(
      new UpdateCommand({
        TableName: T.refresh,
        Key: { PK: `RT#${tokenId}` },
        UpdateExpression: `SET ${sets.join(", ")}`,
        ExpressionAttributeValues: values,
        ...(ExpressionAttributeNames ? { ExpressionAttributeNames } : {}),
      })
    );
  }

  async function listRefreshTokensByIdentity(identityHash) {
    const res = await doc.send(
      new QueryCommand({
        TableName: T.refresh,
        IndexName: "identity-index",
        KeyConditionExpression: "identityHash = :h",
        ExpressionAttributeValues: { ":h": identityHash },
      })
    );
    return res.Items || [];
  }

  async function listRecordsByParticipant(identity) {
    const res = await doc.send(
      new QueryCommand({
        TableName: T.history,
        IndexName: "participant-index",
        KeyConditionExpression: "participantIdentity = :p",
        ScanIndexForward: false,
        ExpressionAttributeValues: { ":p": identity },
      })
    );
    return res.Items || [];
  }

  async function getHistory(archiveId) {
    const res = await doc.send(new GetCommand({ TableName: T.history, Key: { archiveId } }));
    return res.Item || null;
  }

  // ---- Purge ---------------------------------------------------------------
  // Deleting a record touches four places: the authoritative history row, one
  // fan-out row per non-guest participant, the whole kelabos partition
  // (META + UTT# + CONTRIB# + MINUTES + PROMOTION), and the S3 archive object.
  // Each is exposed separately so records.js can order them safely and report
  // partial failures rather than silently half-deleting.

  async function deleteHistoryRow(archiveId) {
    await doc.send(new DeleteCommand({ TableName: T.history, Key: { archiveId } }));
  }

  /** The participant fan-out row keyed `PARTICIPANT#<identity>#<archiveId>`. */
  async function deleteParticipantIndexRow(identity, archiveId) {
    await doc.send(
      new DeleteCommand({ TableName: T.history, Key: { archiveId: `PARTICIPANT#${identity}#${archiveId}` } })
    );
  }

  /**
   * Delete every item under PK=KELABO#<id>. The partition holds the transcript
   * (UTT#) and board (CONTRIB#) as separate rows, so a single DeleteItem on META
   * would orphan them permanently — which is exactly the bug the existing META
   * `ttl` has today.
   * @returns {Promise<number>} items deleted
   */
  async function deleteKelaboPartition(kelaboId) {
    let deleted = 0;
    let ExclusiveStartKey;
    do {
      const res = await doc.send(
        new QueryCommand({
          TableName: T.kelabos,
          KeyConditionExpression: "PK = :pk",
          ExpressionAttributeValues: { ":pk": `KELABO#${kelaboId}` },
          ProjectionExpression: "PK, SK",
          ExclusiveStartKey,
        })
      );
      const items = res.Items || [];
      for (let i = 0; i < items.length; i += 25) {
        const chunk = items.slice(i, i + 25);
        let unprocessed = {
          [T.kelabos]: chunk.map((it) => ({ DeleteRequest: { Key: { PK: it.PK, SK: it.SK } } })),
        };
        // BatchWrite can return unprocessed items under throttling; retry them.
        for (let attempt = 0; attempt < 5 && unprocessed[T.kelabos]?.length; attempt++) {
          const out = await doc.send(new BatchWriteCommand({ RequestItems: unprocessed }));
          unprocessed = out.UnprocessedItems || {};
        }
        if (unprocessed[T.kelabos]?.length) {
          throw new Error(`kelabo ${kelaboId}: ${unprocessed[T.kelabos].length} items could not be deleted`);
        }
        deleted += chunk.length;
      }
      ExclusiveStartKey = res.LastEvaluatedKey;
    } while (ExclusiveStartKey);
    return deleted;
  }

  /** Clear the one-active-kelabo guard, but only if it still points here. */
  async function deleteHostGuardIfKelabo(hostIdentity, kelaboId) {
    await doc
      .send(
        new DeleteCommand({
          TableName: T.kelabos,
          Key: { PK: `HOSTACTIVE#${hostIdentity}`, SK: "GUARD" },
          ConditionExpression: "kelaboId = :m",
          ExpressionAttributeValues: { ":m": kelaboId },
        })
      )
      .catch(() => {}); // absent, or guarding a different kelabo — both fine
  }

  async function getMcpServers(scope) {
    const res = await doc.send(
      new QueryCommand({
        TableName: T.mcp,
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk)",
        ExpressionAttributeValues: { ":pk": `MCP#${scope}`, ":sk": "SERVER#" },
      })
    );
    return res.Items || [];
  }

  async function putMcpServer(scope, server) {
    await doc.send(
      new PutCommand({
        TableName: T.mcp,
        Item: { PK: `MCP#${scope}`, SK: `SERVER#${server.name}`, ...server },
      })
    );
  }

  async function deleteMcpServer(scope, name) {
    await doc.send(
      new DeleteCommand({ TableName: T.mcp, Key: { PK: `MCP#${scope}`, SK: `SERVER#${name}` } })
    );
  }

  // ---- MCP OAuth ----------------------------------------------------------
  // Tokens live beside their server item under the same partition, so a user's
  // whole MCP state is one query and deleting a user is one partition delete.
  // The table is encrypted with a customer-managed KMS key; these attributes are
  // never returned by any API route.

  async function getMcpToken(scope, name) {
    const res = await doc.send(
      new GetCommand({ TableName: T.mcp, Key: { PK: `MCP#${scope}`, SK: `TOKEN#${name}` } })
    );
    if (!res.Item) return null;
    const { PK, SK, ...token } = res.Item;
    return token;
  }

  // One query for the whole partition slice, so listing servers costs 2 queries
  // rather than 1 + N gets.
  async function getMcpTokens(scope) {
    const res = await doc.send(
      new QueryCommand({
        TableName: T.mcp,
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk)",
        ExpressionAttributeValues: { ":pk": `MCP#${scope}`, ":sk": "TOKEN#" },
      })
    );
    return (res.Items || []).map(({ PK, SK, ...t }) => ({ name: SK.slice("TOKEN#".length), ...t }));
  }

  async function putMcpToken(scope, name, token) {
    await doc.send(
      new PutCommand({ TableName: T.mcp, Item: { PK: `MCP#${scope}`, SK: `TOKEN#${name}`, ...token } })
    );
  }

  async function deleteMcpToken(scope, name) {
    await doc.send(new DeleteCommand({ TableName: T.mcp, Key: { PK: `MCP#${scope}`, SK: `TOKEN#${name}` } }));
  }

  // One dynamic client registration per authorization server, shared by every
  // user of this deployment — RFC 7591 registers a redirect_uri, not a user, so
  // re-registering per user would be both wasteful and (for some servers) rate
  // limited. Keyed by issuer.
  async function getMcpClient(issuer) {
    const res = await doc.send(
      new GetCommand({ TableName: T.mcp, Key: { PK: "MCP#client", SK: `AS#${issuer}` } })
    );
    if (!res.Item) return null;
    const { PK, SK, ...reg } = res.Item;
    return reg;
  }

  async function putMcpClient(issuer, registration) {
    await doc.send(
      new PutCommand({ TableName: T.mcp, Item: { PK: "MCP#client", SK: `AS#${issuer}`, ...registration } })
    );
  }

  // --- agent bridge pairing + tokens (docs 16) ------------------------------
  //
  // Device codes are short-lived keyed items with a TTL, which is exactly what
  // the `otp` table is, so they live there rather than in a table of their own.
  // Agent tokens are long-lived, listable-per-identity and revocable, which is
  // exactly what the `refresh` table is — including its `identity-index`. Both
  // reuses avoid a new table, and so avoid the deploy-ordering hazard that
  // comes with one.

  async function putDeviceCode(item) {
    await doc.send(
      new PutCommand({ TableName: T.otp, Item: { PK: `DEVICE#${item.deviceCode}`, ...item } })
    );
    // Second item so the portal can resolve what the human typed. It holds only
    // a pointer: the device code is the secret and must not be derivable from
    // the user code, which is short enough to guess if it were.
    await doc.send(
      new PutCommand({
        TableName: T.otp,
        Item: { PK: `USERCODE#${item.userCode}`, deviceCode: item.deviceCode, ttl: item.ttl },
      })
    );
  }

  async function getDeviceCode(deviceCode) {
    const res = await doc.send(
      new GetCommand({ TableName: T.otp, Key: { PK: `DEVICE#${deviceCode}` } })
    );
    return res.Item || null;
  }

  async function getDeviceCodeByUserCode(userCode) {
    const res = await doc.send(
      new GetCommand({ TableName: T.otp, Key: { PK: `USERCODE#${userCode}` } })
    );
    if (!res.Item?.deviceCode) return null;
    return getDeviceCode(res.Item.deviceCode);
  }

  async function approveDeviceCode(deviceCode, { identity, tenantId, approvedAt }) {
    await doc.send(
      new UpdateCommand({
        TableName: T.otp,
        Key: { PK: `DEVICE#${deviceCode}` },
        // `identity` is a DynamoDB reserved word, so it has to be aliased.
        UpdateExpression: "SET #identity = :i, tenantId = :t, approvedAt = :a",
        // Approving twice would let one code mint two tokens.
        ConditionExpression: "attribute_exists(PK) AND attribute_not_exists(approvedAt)",
        ExpressionAttributeNames: { "#identity": "identity" },
        ExpressionAttributeValues: { ":i": identity, ":t": tenantId, ":a": approvedAt },
      })
    );
  }

  async function deleteDeviceCode(item) {
    await doc.send(new DeleteCommand({ TableName: T.otp, Key: { PK: `DEVICE#${item.deviceCode}` } }));
    await doc.send(new DeleteCommand({ TableName: T.otp, Key: { PK: `USERCODE#${item.userCode}` } }));
  }

  // Join codes (rest-api/src/joinCode.js). Short-lived keyed items with a TTL,
  // so the `otp` table again — same reasoning as device codes above, and the
  // same avoided deploy-ordering hazard.

  async function putJoinCode(item) {
    await doc.send(
      new PutCommand({
        TableName: T.otp,
        Item: { PK: `JOINCODE#${item.code}`, ...item },
        // Two kelabos behind one code would send someone into a room they were
        // never told about. The caller retries with a fresh code on this.
        ConditionExpression: "attribute_not_exists(PK)",
      })
    );
  }

  async function getJoinCode(code) {
    const res = await doc.send(new GetCommand({ TableName: T.otp, Key: { PK: `JOINCODE#${code}` } }));
    return res.Item || null;
  }

  async function deleteJoinCode(code) {
    await doc.send(new DeleteCommand({ TableName: T.otp, Key: { PK: `JOINCODE#${code}` } }));
  }

  /**
   * Join-code abuse budget. Its own key space, like the OTP counter it copies:
   * `scope` is `ip:<ip>` for redeem guessing and `k:<kelaboId>` for minting, so
   * a room that mints a lot cannot spend the budget that bounds guessing.
   *
   * Fixed window rather than sliding — `#ttl` is only set `if_not_exists`, so
   * the window opens on the first request and both it and the count vanish when
   * DynamoDB sweeps the row.
   */
  async function bumpJoinCodeCounter(scope, windowSeconds) {
    const now = Math.floor(Date.now() / 1000);
    const res = await doc.send(
      new UpdateCommand({
        TableName: T.otp,
        Key: { PK: `JCODE#${scope}` },
        // `ttl` is a DynamoDB reserved word — aliased, never written bare.
        UpdateExpression: "SET #c = if_not_exists(#c, :zero) + :one, #ttl = if_not_exists(#ttl, :ttl)",
        ExpressionAttributeNames: { "#c": "count", "#ttl": "ttl" },
        ExpressionAttributeValues: { ":zero": 0, ":one": 1, ":ttl": now + windowSeconds },
        ReturnValues: "ALL_NEW",
      })
    );
    return res.Attributes;
  }

  async function putAgentToken(item) {
    await doc.send(new PutCommand({ TableName: T.refresh, Item: { PK: `AGT#${item.jti}`, ...item } }));
  }

  async function getAgentToken(jti) {
    const res = await doc.send(new GetCommand({ TableName: T.refresh, Key: { PK: `AGT#${jti}` } }));
    return res.Item || null;
  }

  async function setAgentTokenRevoked(jti, revoked = true) {
    await doc.send(
      new UpdateCommand({
        TableName: T.refresh,
        Key: { PK: `AGT#${jti}` },
        UpdateExpression: "SET revoked = :r, revokedAt = :at",
        ConditionExpression: "attribute_exists(PK)",
        ExpressionAttributeValues: { ":r": revoked, ":at": Date.now() },
      })
    );
  }

  async function listAgentTokensByIdentity(identityHash) {
    const items = await listRefreshTokensByIdentity(identityHash);
    // One index, two credential families: refresh cookies and agent tokens. The
    // PK prefix is what tells them apart.
    return items.filter((t) => typeof t.PK === "string" && t.PK.startsWith("AGT#"));
  }

  return {
    getKelaboMeta,
    createKelabo,
    createScheduledKelabo,
    startScheduledKelabo,
    cancelScheduledKelabo,
    rescheduleKelabo,
    resetInviteResponses,
    putInvite,
    getInvite,
    removeInvite,
    listInvites,
    listInvitesByIdentity,
    listUsersByTenant,
    listFavourites,
    getFavourite,
    putFavourite,
    deleteFavourite,
    listAcceptedContacts,
    deleteHostGuard,
    listKelabosByStatus,
    listKelabosByStatusForIdentity,
    updateKelaboMeta,
    appendParticipant,
    queryContributions,
    getOtp,
    putOtp,
    deleteOtp,
    incrementOtpAttempts,
    bumpIpCounter,
    getUser,
    getUserSettings,
    putUserSettings,
    upsertUser,
    putRefreshToken,
    getRefreshToken,
    setRefreshRevoked,
    listRefreshTokensByIdentity,
    putDeviceCode,
    getDeviceCode,
    getDeviceCodeByUserCode,
    approveDeviceCode,
    deleteDeviceCode,
    putJoinCode,
    getJoinCode,
    deleteJoinCode,
    bumpJoinCodeCounter,
    putAgentToken,
    getAgentToken,
    setAgentTokenRevoked,
    listAgentTokensByIdentity,
    listRecordsByParticipant,
    getHistory,
    deleteHistoryRow,
    deleteParticipantIndexRow,
    deleteKelaboPartition,
    deleteHostGuardIfKelabo,
    getMcpServers,
    putMcpServer,
    deleteMcpServer,
    getMcpToken,
    getMcpTokens,
    putMcpToken,
    deleteMcpToken,
    getMcpClient,
    putMcpClient,
    createJourney,
    getJourneyMeta,
    updateJourneyMeta,
    completeJourney,
    reopenJourney,
    listJourneysByTenantStatus,
    listAccessorJourneys,
    putJourneyDescriptionVersion,
    listJourneyDescriptionVersions,
    putJourneyStatusVersion,
    listJourneyStatusVersions,
    putJourneyTimelineEntry,
    listJourneyTimeline,
    putAccessor,
    getAccessor,
    removeAccessor,
    listAccessors,
    createBoardMessageHead,
    putBoardMessageHead,
    getBoardMessageHead,
    listBoardMessageHeads,
    putBoardMessageVersion,
    listBoardMessageVersions,
    createDocument,
    putDocument,
    getDocument,
    listDocuments,
    linkKelaboToJourney,
    unlinkKelaboFromJourney,
    getJourneyLink,
    listJourneyLinks,
    listKelaboJourneyLinks,
    deleteKelaboJourneyMirror,
    deleteJourneyChildren,
    deleteJourneyMeta,
    putJourneyReport,
    getJourneyReport,
    listJourneyReports,
    markJourneyReportFailed,
    bumpContributor,
    listContributors,
  };
}
