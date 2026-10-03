import { err } from "./errors.js";
import { createTenancy } from "./tenancy.js";

/**
 * Huddle / ring (docs 18 §6) — "call" an online contact.
 *
 * Two entry points:
 *   - `create`  : start an instant kelabo and ring people into it (a dial).
 *   - `ringInto`: ring more people into a kelabo that is already live (the
 *                 "invite an online contact into this kelabo" action).
 *
 * A huddle is an ordinary ACTIVE kelabo — same partition, same join link, same
 * room — and needs no new kelabo concept. One `INVITE#` row per target keeps
 * the join flow and the agent briefing working.
 *
 * Authorization lives here, the one place with both the users directory and the
 * contacts table: a target must be a same-tenant colleague OR an accepted
 * external contact, else `no_contact`. The Gateway is told whom to ring and does
 * not re-derive it. Delivery to whichever targets are online — and the report of
 * who was offline — is the Gateway's (over the presence streams).
 */
export function createHuddle({ config, db, internal, kelabos, opConfig, tenancy = createTenancy({ config, opConfig }) }) {

  // The ringer's name and chosen avatar for the "X is calling you" modal. The
  // session cookie carries neither, so read the users directory; fall back to
  // the address and the default identicon.
  async function ringerInfo(identity, displayName) {
    const user = await db.getUser(identity).catch(() => null);
    return {
      fromName: displayName || user?.settings?.name?.trim() || user?.displayName || identity,
      fromAvatar: Number(user?.settings?.avatar) || 0,
    };
  }

  /** Filter `emails` to those the caller may ring; throw if none qualify. The
   *  returned list is normalized (lowercased, de-duped, self removed). */
  async function authorizeTargets(identity, emails) {
    const wanted = [...new Set((emails || []).map((e) => e.trim().toLowerCase()).filter(Boolean))].filter(
      (e) => e !== identity
    );
    if (wanted.length === 0) throw err(400, "no_targets");
    // Same-organisation colleagues are always allowed — an alias domain counts
    // as the organisation, and nobody is a colleague under a public mailbox
    // tenant (tenancy.sameOrg). Anyone else requires an accepted contact row.
    const colleague = new Set();
    for (const e of wanted) if (await tenancy.sameOrg(identity, e)) colleague.add(e);
    let acceptedSet = new Set();
    if (colleague.size < wanted.length) acceptedSet = new Set(await db.listAcceptedContacts(identity));
    const allowed = wanted.filter((e) => colleague.has(e) || acceptedSet.has(e));
    if (allowed.length === 0) throw err(403, "no_contact");
    return allowed;
  }

  async function addInvites(kelaboId, targets, now) {
    for (const email of targets) {
      await db.putInvite(kelaboId, { inviteKey: email, email, isGuest: false, response: "pending", invitedAt: now });
    }
  }

  /** Start an instant kelabo and ring the targets into it. */
  async function create({ identity, displayName, body }) {
    const targets = await authorizeTargets(identity, body.invitees);
    const created = await kelabos.createKelabo({
      identity,
      // isCall marks the kelabo as a dial for the life of its record, so
      // lists can show a phone where kelabos get a camera.
      body: { title: body.title || "Kelabo", unlisted: body.private === true, isCall: true },
    });
    // createKelabo returns { status, body }; a non-200 bubbles up unchanged.
    if (created.status !== 200) return created;
    const kelaboId = created.body.kelaboId;
    const now = Date.now();
    await addInvites(kelaboId, targets, now);

    let rung = [];
    let offline = targets;
    try {
      const r = await internal.ring(kelaboId, identity, { targets, title: created.body.title, ...(await ringerInfo(identity, displayName)) });
      rung = r.rung || [];
      offline = r.offline || [];
    } catch (e) {
      console.warn(JSON.stringify({ level: "warn", msg: "ring dispatch failed", kelaboId, error: String(e) }));
    }

    return {
      status: 200,
      body: { kelaboId, title: created.body.title, joinUrl: config.joinUrl(kelaboId), status: "active", rung, offline },
    };
  }

  /** Ring more people into an already-live kelabo the caller hosts. */
  async function ringInto({ kelaboId, identity, displayName, body }) {
    const meta = await db.getKelaboMeta(kelaboId);
    if (!meta) throw err(404, "kelabo_not_found");
    if (meta.status !== "active") throw err(409, "kelabo_not_started");
    // Only someone in the kelabo may pull others in: the host, or a participant.
    const isParticipant =
      meta.hostIdentity === identity || (meta.participants || []).some((p) => p.identity === identity);
    if (!isParticipant) throw err(403, "not_a_participant");

    const targets = await authorizeTargets(identity, body.invitees);
    await addInvites(kelaboId, targets, Date.now());

    let rung = [];
    let offline = targets;
    try {
      const r = await internal.ring(kelaboId, identity, { targets, title: meta.title, ...(await ringerInfo(identity, displayName)) });
      rung = r.rung || [];
      offline = r.offline || [];
    } catch (e) {
      console.warn(JSON.stringify({ level: "warn", msg: "ring dispatch failed", kelaboId, error: String(e) }));
    }
    return { status: 200, body: { kelaboId, rung, offline } };
  }

  /** A rung person accepted or declined. Relayed to the ringer by the Gateway. */
  async function answer({ kelaboId, identity, body }) {
    const meta = await db.getKelaboMeta(kelaboId);
    if (!meta) throw err(404, "kelabo_not_found");
    // Must actually have been rung — an INVITE row is proof enough here.
    const invite = await db.getInvite(kelaboId, identity);
    if (!invite) throw err(403, "not_invited");
    try {
      await internal.ringAnswer(kelaboId, identity, { response: body.response });
    } catch (e) {
      console.warn(JSON.stringify({ level: "warn", msg: "ring answer relay failed", kelaboId, error: String(e) }));
    }
    return { status: 200, body: { kelaboId, response: body.response } };
  }

  /** The ringer hung up before anyone answered. */
  async function cancel({ kelaboId, identity }) {
    const meta = await db.getKelaboMeta(kelaboId);
    if (!meta) throw err(404, "kelabo_not_found");
    if (meta.hostIdentity !== identity) throw err(403, "not_host");
    try {
      await internal.ringCancel(kelaboId, identity);
    } catch (e) {
      console.warn(JSON.stringify({ level: "warn", msg: "ring cancel relay failed", kelaboId, error: String(e) }));
    }
    return { status: 200, body: { kelaboId, cancelled: true } };
  }

  return { create, ringInto, answer, cancel };
}
