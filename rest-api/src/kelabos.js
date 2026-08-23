import { randomUUID } from "node:crypto";
import { RTC_MODES } from "@kelabo/contracts";
import { err } from "./errors.js";

export function createKelabos({ config, db, internal, secrets }) {
  // Is this optional provider configured at all? Existence of its secret is
  // the deployment-config signal (docs 19 §3). Anything short of a definitive
  // "no" — no secrets module wired (tests), probe error — answers "on": a
  // capability probe must never switch a working feature off (docs 19 §4).
  const providerOn = async (secretName) => {
    if (!secrets?.secretExists) return true;
    try {
      return await secrets.secretExists(secretName);
    } catch {
      return true;
    }
  };
  function toSummary(item) {
    return {
      kelaboId: item.kelaboId,
      title: item.title,
      status: item.status,
      participantCount: (item.participants || []).length,
      startedAt: item.startedAt,
      hostIdentity: item.hostIdentity,
      hasMinutes: !!item.hasMinutes,
      isCall: !!item.isCall,
    };
  }

  async function createKelabo({ identity, body }) {
    const tenantId = identity.split("@")[1].toLowerCase();
    const now = Date.now();
    const kelaboId = randomUUID();
    const meta = {
      kelaboId,
      status: "active",
      title: body.title?.trim() || "Untitled kelabo",
      hostIdentity: identity,
      createdAt: now,
      startedAt: now,
      participants: [],
      mode: "unknown",
      isDeveloperPresent: false,
      hasMinutes: false,
      hostJoinedAt: null,
      mcpEnabled: body.mcpEnabled !== false,
      // Opt-IN, so `=== true` rather than `!== false`: an absent field means no,
      // and every kelabo created before this existed means no too.
      historyEnabled: body.historyEnabled === true,
      // Conference transport, fixed for the life of the kelabo (docs 15). It
      // cannot change mid-kelabo: switching a `mesh` room to `sfu` would revoke
      // the peer-to-peer guarantee participants joined under.
      rtcMode: RTC_MODES.includes(body.rtcMode) ? body.rtcMode : config.rtc.defaultMode,
      // Unlisted (a private call): excluded from the tenant's public active
      // list for everyone not in it. Not part of the public create schema —
      // only internal callers (huddle.create) can set it.
      unlisted: body.unlisted === true,
      // A call (huddle) rather than a convened kelabo — display only, and
      // like `unlisted` settable solely by internal callers.
      isCall: body.isCall === true,
      tenantId,
      tenantStatus: `${tenantId}#active`,
    };
    const created = {
      status: 200,
      body: { kelaboId, title: meta.title, joinUrl: config.joinUrl(kelaboId), status: "active" },
    };
    // A host may run any number of live kelabos: the old one-live-per-host
    // guard silently bounced a second create to the existing kelabo, which
    // read as a bug, not a rule. A condition failure here means a kelaboId
    // collision, and those ids are random — let it surface.
    await db.createKelabo(meta);
    return created;
  }

  async function listKelabos({ identity }) {
    const { sameTenant, crossTenant } = await db.listKelabosByStatusForIdentity(identity, "active");
    // An unlisted kelabo (a private call) exists only for the people in it:
    // the host and anyone who has joined. Everyone else's list simply does not
    // contain it — the join link is the sole way in. This is the tenant-wide
    // default, so it only applies within the tenant that default belongs to.
    const sameTenantVisible = sameTenant.filter(
      (m) =>
        !m.unlisted ||
        m.hostIdentity === identity ||
        (m.participants || []).some((p) => p.identity === identity)
    );
    // A kelabo hosted at another tenant is never tenant-wide visible to begin
    // with — there is no "not unlisted" default across a domain boundary.
    // Being in `crossTenant` at all already means a specific INVITE# row
    // named this identity, which is the stronger, narrower grant and is not
    // lessened by `unlisted` (docs 18 §2.8).
    const active = [...sameTenantVisible, ...crossTenant].map(toSummary);
    const mine = active.filter((m) => m.hostIdentity === identity);
    return { active, mine };
  }

  async function getKelabo({ kelaboId, participant }) {
    const meta = await db.getKelaboMeta(kelaboId);
    if (!meta) throw err(404, "kelabo_not_found");
    // "Not started yet" and "already over" are opposite situations and used to
    // produce the same 410 kelabo_ended, which sends a caller who arrived early
    // away instead of to the scheduled view (GET /kelabos/:id/scheduled).
    if (meta.status === "scheduled") throw err(409, "kelabo_not_started");
    if (meta.status === "cancelled") throw err(409, "kelabo_cancelled");
    if (meta.status !== "active") throw err(410, "kelabo_ended");
    const body = {
      kelaboId: meta.kelaboId,
      title: meta.title,
      status: meta.status,
      hostIdentity: meta.hostIdentity,
      hostJoinedAt: meta.hostJoinedAt || null,
      startedAt: meta.startedAt,
    };
    if (participant && participant.kelaboId === kelaboId) {
      body.participants = meta.participants || [];
      body.gatewayBaseUrl = config.gatewayBaseUrl;
      // The caller's own participant identity — which for a guest is a generated
      // id, not an email. Everything that has to recognise "this is me" (echo
      // suppression on fanned-out utterances, the call roster) must compare
      // against this and not against the signed-in address, which guests lack.
      body.me = participant.identity;
      body.isDeveloperPresent = !!meta.isDeveloperPresent;
      // Kelabos created before conference audio existed have no rtcMode; they
      // fall back to the environment default rather than losing the call.
      body.rtcMode = meta.rtcMode || config.rtc.defaultMode;
      body.rtcVideo = config.rtc.video;
      // Told to everyone in the room, not just the host. The assistant reading
      // the host's past kelabos can put another kelabo's contents in front of
      // a guest who was not at it — so the room says so, in the same strip as
      // "P2P secure" and "agent". A capability nobody can see is one nobody can
      // object to.
      body.historyEnabled = !!meta.historyEnabled;
      // Which journeys this kelabo belongs to (docs 20 §4.3's mirror,
      // §11's touch-up) — told to the whole room, same reasoning as
      // `historyEnabled` two lines up: a journey's context reaches the
      // live agent (docs 20 §12.1) with no opt-in of its own, on the
      // premise that linking a kelabo is itself the deliberate, visible
      // act. The `{id, title, visibility}` shape is the frozen snapshot
      // taken at link time, not a live re-fetch of the journey's own META.
      body.journeys = (await db.listKelaboJourneyLinks(kelaboId).catch(() => [])).map((l) => ({
        id: l.journeyId,
        title: l.journeyTitleSnapshot || "",
        visibility: l.journeyVisibilitySnapshot,
      }));
      // What this deployment can actually run (docs 19 §2/§3), stated up front
      // so the client renders absence instead of discovering it by failing.
      // `on: false` means OFF — the UI shows no trace of the capability;
      // runtime failures of an `on` capability are the client's `degraded`
      // path and are not represented here.
      const [stt, assistant, rtc] = await Promise.all([
        providerOn(config.secrets.stt),
        providerOn(config.secrets.llm),
        providerOn(config.secrets.cloudflareRealtime),
      ]);
      body.capabilities = {
        // `provider` so the client can pick its defaults before it has minted
        // anything — silence skipping is a saving on a provider that bills the
        // audio it receives and a liability on one that bills the stream. No
        // new disclosure: the same name is on every session and on the
        // connection light.
        stt: { on: stt, ...(stt ? { provider: config.stt.provider } : {}) },
        assistant: { on: assistant },
        video: { on: !!config.rtc.video },
        rtc: { on: rtc, mode: body.rtcMode },
      };
    }
    return body;
  }

  async function startKelabo({ kelaboId, identity }) {
    const meta = await db.getKelaboMeta(kelaboId);
    if (!meta) throw err(404, "kelabo_not_found");
    if (meta.hostIdentity !== identity) throw err(403, "not_host");
    if (meta.status !== "active") throw err(409, "already_ended");
    if (meta.hostJoinedAt) return { kelaboId, status: "active", hostJoinedAt: meta.hostJoinedAt };
    const hostJoinedAt = Date.now();
    await db.updateKelaboMeta(kelaboId, { hostJoinedAt });
    return { kelaboId, status: "active", hostJoinedAt };
  }

  async function endKelabo({ kelaboId, identity }) {
    const meta = await db.getKelaboMeta(kelaboId);
    if (!meta) throw err(404, "kelabo_not_found");
    if (meta.hostIdentity !== identity) throw err(403, "not_host");
    // An already-ended kelabo whose archive never landed is not "already
    // ended", it is half-ended: the host has no record and nothing else will
    // ever produce one. Ending it again resumes the archive instead of 409ing.
    const resuming = meta.status === "ended" && meta.archivePending === true;
    if (meta.status !== "active" && !resuming) throw err(409, "already_ended");
    const endedAt = resuming ? (meta.endedAt ?? Date.now()) : Date.now();
    const ttl = Math.floor(endedAt / 1000) + config.retentionDays * 86400;
    // Call the gateway FIRST while the kelabo is still "active": the gateway's
    // endKelabo writes the S3 archive + history row (and kicks off summary/minutes
    // generation asynchronously). If we marked it ended here first, the gateway
    // would short-circuit with 409 and never create the record.
    let archived = false;
    try {
      const out = await internal.endKelabo(kelaboId, identity, { retry: resuming });
      archived = out?.archived !== false;
    } catch (e) {
      console.warn(JSON.stringify({ level: "warn", msg: "gateway end call failed", kelaboId, error: String(e) }));
    }
    // Ensure the kelabo is marked ended locally regardless of the gateway
    // outcome (the gateway also sets this on success; this is idempotent) —
    // an unreachable Gateway must not leave a kelabo live forever.
    //
    // But say so. Before this flag, a failed archive was indistinguishable from
    // a successful one on this side, and the host simply had no record and no
    // error: `allowIps` closed the Gateway's ALB to this Lambda for an entire
    // deployment and nothing surfaced it (docs 07).
    await db.updateKelaboMeta(kelaboId, {
      status: "ended",
      endedAt,
      ttl,
      tenantStatus: null,
      archivePending: archived ? null : true,
    });
    // Legacy cleanup: guard rows written before hosts could run several live
    // kelabos (pre-2026-07-31). Nothing writes them any more.
    await db.deleteHostGuard(identity);
    return { kelaboId, status: "ended", archived };
  }

  async function requestMinutes({ kelaboId, identity }) {
    const meta = await db.getKelaboMeta(kelaboId);
    if (!meta) throw err(404, "kelabo_not_found");
    if (meta.hostIdentity !== identity) throw err(403, "not_host");
    await internal.requestMinutes(kelaboId, identity);
    return { status: "queued" };
  }

  async function board({ kelaboId, participant, since, limit }) {
    const meta = await db.getKelaboMeta(kelaboId);
    if (!meta) throw err(404, "kelabo_not_found");
    const isParticipant = (meta.participants || []).some((p) => p.identity === participant.identity);
    if (!isParticipant && meta.hostIdentity !== participant.identity) {
      throw err(403, "forbidden");
    }
    const items = await db.queryContributions(kelaboId, { since, limit });
    const contributions = items.map(({ PK, SK, tenantStatus, ...c }) => c);
    const nextSince = contributions.length ? contributions[contributions.length - 1].at : undefined;
    return { contributions, ...(nextSince !== undefined ? { nextSince } : {}) };
  }

  return { createKelabo, listKelabos, getKelabo, startKelabo, endKelabo, requestMinutes, board, toSummary };
}
