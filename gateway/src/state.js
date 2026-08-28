import { queryActiveKelabos, getPromotion, getMeta } from "./db.js";

export function createState() {
  return {
    // Kelabos a developer's agent is *attending*: transcript is routed here.
    tunnelByKelabo: new Map(),
    // Kelabos a developer's agent is only *preparing for* — scheduled, not yet
    // started (docs 16 §5). Deliberately a separate map: `caption.js` consults
    // only `tunnelByKelabo`, so a prep binding cannot receive transcript even
    // once the kelabo goes live. Attending is a second, explicit attach, which
    // is what makes "I prepared but I am not joining" expressible.
    prepByKelabo: new Map(),
    sseSubscribers: new Map(),
    promotedByKelabo: new Map(),
    agentWorkers: new Map(),
    // Kelabos whose minutes are being regenerated right now. In-process and
    // ephemeral on purpose: it exists only to stop a second click starting a
    // second whole-transcript LLM call, and a task restart has already lost the
    // call it would have been guarding.
    minutesInFlight: new Set(),
    uttSeq: new Map(),
    // Last accepted caption per kelabo, for race-free duplicate suppression.
    lastCaption: new Map(),
    // Conference-audio presence: kelaboId -> { mode, peers: Map<participantId, Peer> }.
    // Ephemeral like sseSubscribers — rebuilt as clients reconnect after a
    // restart. The durable half is `rtcMode` on the kelabo META.
    rtcRooms: new Map(),
    // Contact presence (docs 18 §5): who currently holds an open /presence/stream.
    //   presence         : identity -> { tenantId, streams:Set<res> }
    //   presenceByTenant  : tenantId -> Set<identity>
    // Ephemeral and in-process, like sseSubscribers and rtcRooms — a task
    // restart rebuilds it as tabs reconnect and re-send a snapshot. `desiredCount`
    // is 1, so one identity's every tab and every watcher's stream live in the
    // same process, which is what makes online/offline globally consistent.
    presence: new Map(),
    presenceByTenant: new Map(),
    // Active rings (docs 18 §6): kelaboId -> { from, fromName, title, targets:Set,
    // answered:Set, expiresAt, timer }. Ephemeral — a ring is a few seconds of
    // "someone is calling you" delivered over the presence streams, gone on
    // timeout, answer or cancel.
    rings: new Map(),
  };
}

const KELABO_PREFIX = "KELABO#";

export async function rebuildState(c) {
  const actives = await queryActiveKelabos(c);
  for (const item of actives) {
    const kelaboId = item.PK?.startsWith(KELABO_PREFIX)
      ? item.PK.slice(KELABO_PREFIX.length)
      : item.kelaboId;
    if (!kelaboId) continue;
    try {
      const promotion = await getPromotion(c, kelaboId);
      if (promotion) {
        // Both shapes: `runtime`/`sessionRef` since docs 16, and the opencode
        // triple written before it. An old row is still a real binding.
        c.state.promotedByKelabo.set(kelaboId, {
          runtime: promotion.runtime ?? "opencode",
          sessionRef: promotion.sessionRef ?? promotion.opencodeSessionId ?? "",
          workspace: promotion.workspace ?? promotion.opencodeDirectory ?? "",
          label: promotion.label ?? "",
          boundBy: promotion.boundBy ?? "",
          boundAt: promotion.boundAt ?? 0,
        });
        continue;
      }
      const meta = item.SK === "META" ? item : await getMeta(c, kelaboId);
      if (meta?.status === "active") {
        c.state.agentWorkers.set(kelaboId, {
          kelaboId,
          createdAt: Date.now(),
          rehydrated: false,
        });
      }
    } catch (err) {
      c.logError("state_rebuild_kelabo_failed", err, { kelaboId });
    }
  }
  c.log("state_rebuilt", {
    kelabos: actives.length,
    promoted: c.state.promotedByKelabo.size,
    agentContexts: c.state.agentWorkers.size,
  });
}
