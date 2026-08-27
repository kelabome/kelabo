// **What a kelabo may do, how much of it, and until when.**
//
// One function, called at four moments (docs/saas/design-entitlements.md §3):
// PLAN at creation, GRANT when a call starts, REVISE while it runs, and it is
// what SETTLE reconciles against at the end. Both services call it and neither
// re-derives it; the SPA renders its output and decides nothing.
//
// It exists because docs/19 gave a capability three states and no *quantity*.
// Every rule in design-billing-system §0 is about amounts and deadlines —
// ninety minutes, a cent a minute, three minutes of grace, a balance that runs
// out mid-call — and with nowhere to put them they ended up in nine gate
// functions with nine shapes, plus four ad-hoc fields the SPA turned back into
// policy by hand. This is that policy, in one place, as data.
//
// Pure and IO-free on purpose, like `priceEpisode` and `splitFunding` beside
// it: the decision that governs both services and every screen is the one that
// most needs to be testable under plain node.

/** The shape's own version, stamped on a grant and on the receipt it settles. */
export const ENTITLEMENT_VERSION = 1;

/**
 * Why a capability is off. `not_configured` and `policy` are docs/19's;
 * a hosted tier appends its own money states (design-billing-system §5.3).
 */
export const OFF_REASONS = ["not_configured", "policy"];

/** An assistant reads speech always; typed input is what a balance buys (§5.8). */
export const INPUT_SPEECH = "speech";
export const INPUT_TYPED = "typed";

const cap = (on, extra = {}) => ({ on, ...extra });
const off = (reason, extra = {}) => ({ on: false, reason, ...extra });

/**
 * The entitlement for one kelabo (or, with no `options`, for an owner about to
 * create one — the PLAN moment, §3.1).
 *
 * @param {object} input
 * @param {'guest'|'registered'} input.tier
 * @param {object} [input.standing] - owner's week + balance (`ownerStanding`)
 * @param {object} input.card - the rate card in effect
 * @param {object} [input.options] - what the kelabo was created with
 * @param {object} [input.usage] - live counters for this room
 * @param {object} [input.providers] - which providers this deployment has
 * @param {number} [input.now]
 */
export function entitlementFor({
  tier = "registered",
  standing = null,
  card,
  options = {},
  usage = {},
  providers = {},
  now = Date.now(),
} = {}) {
  // Absent means present: a probe that could not answer must never switch a
  // working feature off (docs/19 §3).
  const hasStt = providers.stt !== false;
  const hasAssistant = providers.assistant !== false;
  const hasRtc = providers.rtc !== false;
  // Deployment-level: a build with video compiled out has none, whoever pays.
  const hasVideo = providers.video !== false;

  const base = {
    version: ENTITLEMENT_VERSION,
    asOf: now,
    tier,
    rateCardVersion: card?.version ?? 0,
  };

  // ---- guest (user-tiers §1) ------------------------------------------------
  //
  // Not a degraded registered room: a deliberate tier with its own floor.
  // Signaling and a message store, forever, free, and outside the ledger.
  if (tier === "guest") {
    return {
      ...base,
      payer: { scope: null, orgScope: null, mode: "none", fundedBy: "none" },
      capabilities: {
        messages: cap(true),
        call: cap(hasRtc, { mode: "mesh", modes: ["mesh"], seats: options.meshMaxParticipants ?? 0, video: hasVideo }),
        stt: off("policy"),
        assistant: off("policy", { inputs: [] }),
        minutes: off("policy"),
        agent: off("policy"),
      },
    };
  }

  const scope = standing?.scope ?? null;

  // ---- registered ------------------------------------------------------------
  //
  // Permissive, deliberately (docs/19 §4, §4.1): with no policy behind it a
  // deployment grants everything, without limit — no `allowance` and no
  // `until` on any capability — and behaves exactly as it did before
  // entitlements existed. A hosted tier replaces this section with its money
  // rules; the shape it returns is the same.
  const sttOn = hasStt;
  const assistant = !hasAssistant
    ? off("not_configured", { inputs: [] })
    : cap(true, { inputs: sttOn ? [INPUT_SPEECH, INPUT_TYPED] : [INPUT_TYPED] });
  return {
    ...base,
    payer: { scope, orgScope: null, mode: "none", fundedBy: "none" },
    capabilities: {
      messages: cap(true),
      call: cap(hasRtc, {
        mode: options.rtcMode === "sfu" ? "sfu" : "mesh",
        modes: ["mesh", "sfu"],
        meshSeats: options.meshMaxParticipants ?? 0,
        video: hasVideo,
      }),
      stt: sttOn ? cap(true) : off("not_configured"),
      assistant,
      // Minutes are assistant spend (§5.9), so they follow the assistant
      // *capability* rather than the dial behind it: an assistant that is off
      // for any reason writes no summary.
      minutes: assistant.on ? cap(true) : off(assistant.reason),
      // Dev-agent access follows transcription access (user-tiers §4), and that
      // holds however transcription came to be off.
      agent: sttOn ? cap(true) : off("not_configured"),
    },
  };
}

/**
 * What changed between two entitlements, as the room needs to hear it.
 *
 * The wording lives in the SPA; this says *what happened*, so a notice is a
 * function of the diff rather than of six bespoke `reason` strings invented at
 * six call sites (§3.3).
 *
 * @returns {Array<{capability: string, kind: 'off'|'on'|'inputs'|'warning', reason?: string}>}
 */
export function diffEntitlement(prev, next) {
  const changes = [];
  if (!next?.capabilities) return changes;
  const before = prev?.capabilities ?? {};
  for (const [name, now_] of Object.entries(next.capabilities)) {
    const was = before[name];
    if (!was) continue;
    if (was.on && !now_.on) changes.push({ capability: name, kind: "off", reason: now_.reason });
    else if (!was.on && now_.on) changes.push({ capability: name, kind: "on" });
    // The assistant staying on while it stops reading typed messages is a real
    // change to what the room can do, and invisible in `on` alone.
    else if (was.on && now_.on && (was.inputs?.length ?? 0) !== (now_.inputs?.length ?? 0)) {
      changes.push({ capability: name, kind: "inputs", reason: now_.typedReason });
    }
    // The call's allowance running out. It is a *warning* rather than an
    // `off`, because the call keeps running: `grace` is how long it has left,
    // and it is the only notice anybody gets before the kelabo ends.
    const a = now_.allowance;
    if (a?.grace != null && a.remaining <= 0 && (was.allowance?.remaining ?? Infinity) > 0) {
      changes.push({ capability: name, kind: "warning", reason: "call_budget_spent" });
    }
  }
  return changes;
}

/**
 * Does a receipt agree with the grant it ran under (§3.4)?
 *
 * The invariant that makes "the debt is bounded" checkable rather than
 * asserted: a call cannot meter more than it was granted plus its grace, and a
 * line item cannot exist for a capability the grant had switched off. Returns
 * the violations, so a caller can log them without failing a settlement —
 * money that has been spent must still be recorded.
 */
export function reconcileWithGrant(grant, { meteredSeconds = 0, lineItemsMicros = {} } = {}) {
  const problems = [];
  if (!grant?.capabilities) return problems;
  const call = grant.capabilities.call;
  const bound = (call?.allowance?.limit ?? Infinity) + (call?.allowance?.grace ?? 0);
  if (meteredSeconds > bound) {
    problems.push({ kind: "over_grant", granted: bound, metered: meteredSeconds });
  }
  const owed = [
    ["stt", lineItemsMicros.stt],
    ["assistant", lineItemsMicros.llm],
  ];
  for (const [name, micros] of owed) {
    if ((micros || 0) > 0 && grant.capabilities[name]?.on === false) {
      problems.push({ kind: "billed_while_off", capability: name, micros });
    }
  }
  return problems;
}
