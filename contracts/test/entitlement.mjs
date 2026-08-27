// The one decision: what a kelabo may do, how much of it, and until when
// (docs/saas/design-entitlements.md).
//
// Master carries the MECHANISM — the capability map with an optional
// `allowance` and `until` per entry, the diff and the settlement check — with
// permissive defaults (docs/19 §4.1). The money rules that narrow it, and
// their tests, live on the saas branch beside the rate card they read.
import assert from "node:assert/strict";
import { diffEntitlement, entitlementFor, reconcileWithGrant } from "../src/entitlement.js";

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
  } catch (err) {
    console.error(`FAIL ${name}`);
    throw err;
  }
}

// --- the tiers --------------------------------------------------------------

test("a guest room is a tier, not a degraded registered one", () => {
  const e = entitlementFor({ tier: "guest", options: { meshMaxParticipants: 5 } });
  // The floor: signaling and a message store, forever, free.
  assert.equal(e.capabilities.messages.on, true);
  assert.equal(e.capabilities.call.on, true);
  assert.equal(e.capabilities.call.mode, "mesh");
  assert.equal(e.capabilities.call.seats, 5);
  // And nothing that costs money, by policy rather than by exhaustion.
  for (const name of ["stt", "assistant", "minutes", "agent"]) {
    assert.equal(e.capabilities[name].on, false, name);
    assert.equal(e.capabilities[name].reason, "policy", name);
  }
  // No ledger, no payer.
  assert.equal(e.payer.mode, "none");
  // A guest call has no length limit: nothing is metering it.
  assert.equal(e.capabilities.call.allowance, undefined);
});

test("a registered room with no policy behind it grants everything, unlimited", () => {
  const e = entitlementFor({});
  for (const name of ["messages", "call", "stt", "assistant", "minutes", "agent"]) {
    assert.equal(e.capabilities[name].on, true, name);
  }
  assert.deepEqual(e.capabilities.assistant.inputs, ["speech", "typed"]);
  assert.deepEqual(e.capabilities.call.modes, ["mesh", "sfu"]);
  assert.equal(e.capabilities.call.video, true);
  // Unlimited is the ABSENCE of an allowance, not a large one (docs/19 §4.1):
  // a deployment that sets no allowance behaves exactly as it did before
  // entitlements existed.
  assert.equal(e.capabilities.call.allowance, undefined);
  assert.equal(e.capabilities.call.until, undefined);
});

test("the kelabo's own transport choice is honoured", () => {
  assert.equal(entitlementFor({ options: { rtcMode: "sfu" } }).capabilities.call.mode, "sfu");
  assert.equal(entitlementFor({ options: { rtcMode: "mesh" } }).capabilities.call.mode, "mesh");
  // A plan computed before any kelabo exists always reads mesh — no kelabo
  // exists to have a mode — which is why `modes` is carried separately.
  assert.equal(entitlementFor({}).capabilities.call.mode, "mesh");
});

// --- deployment capability still wins ---------------------------------------

test("a provider that is absent is off, however permissive the policy", () => {
  const e = entitlementFor({ providers: { stt: false, assistant: false } });
  assert.equal(e.capabilities.stt.reason, "not_configured");
  assert.equal(e.capabilities.assistant.reason, "not_configured");
  assert.equal(e.capabilities.minutes.reason, "not_configured");
  assert.equal(e.capabilities.agent.reason, "not_configured");
  // The call and the messages are unaffected: no rung may gate a lower one.
  assert.equal(e.capabilities.call.on, true);
  assert.equal(e.capabilities.messages.on, true);
});

test("with no transcription the assistant still reads typed input", () => {
  // Rung 4 may consume rung 3, never depend on it absolutely (docs/19 §1).
  const e = entitlementFor({ providers: { stt: false } });
  assert.equal(e.capabilities.stt.on, false);
  assert.equal(e.capabilities.assistant.on, true);
  assert.deepEqual(e.capabilities.assistant.inputs, ["typed"]);
  // Dev-agent access follows transcription access (user-tiers §4).
  assert.equal(e.capabilities.agent.on, false);
});

test("a deployment with no video has none, whoever is paying", () => {
  const e = entitlementFor({ options: { rtcMode: "sfu" }, providers: { video: false } });
  assert.equal(e.capabilities.call.video, false);
});

// --- the diff, which is what the room is told -------------------------------

test("the diff names what changed, so wording is not invented per call site", () => {
  const before = {
    capabilities: {
      stt: { on: true },
      assistant: { on: true, inputs: ["speech", "typed"] },
    },
  };
  const after = {
    capabilities: {
      stt: { on: false, reason: "policy" },
      assistant: { on: true, inputs: ["speech"], typedReason: "policy" },
    },
  };
  assert.deepEqual(diffEntitlement(before, after), [
    { capability: "stt", kind: "off", reason: "policy" },
    { capability: "assistant", kind: "inputs", reason: "policy" },
  ]);
  // Coming back is a change too, and a capability the previous entitlement
  // never carried is not one — there is no "was" to compare against.
  assert.deepEqual(diffEntitlement(after, before), [
    { capability: "stt", kind: "on" },
    { capability: "assistant", kind: "inputs", reason: undefined },
  ]);
  assert.deepEqual(diffEntitlement({ capabilities: {} }, before), []);

  // The allowance running out is the warning, and the call then has its grace
  // to run. A property of the allowance rather than a message someone
  // remembered to send.
  const early = { capabilities: { call: { on: true, allowance: { limit: 1800, remaining: 600, grace: 180 } } } };
  const late = { capabilities: { call: { on: true, allowance: { limit: 1800, remaining: 0, grace: 180 } } } };
  assert.deepEqual(diffEntitlement(early, late), [
    { capability: "call", kind: "warning", reason: "call_budget_spent" },
  ]);

  // Nothing changed is no notice at all — the common case, and the one that
  // must stay silent.
  assert.deepEqual(diffEntitlement(early, early), []);
});

// --- settlement has to agree with the grant ---------------------------------

test("a receipt is checked against the grant it ran under", () => {
  const grant = {
    capabilities: {
      call: { on: true, allowance: { limit: 1800, grace: 120 } },
      stt: { on: true },
      assistant: { on: false, reason: "policy" },
    },
  };
  // Inside the grant plus its grace: nothing to report.
  assert.deepEqual(reconcileWithGrant(grant, { meteredSeconds: 1800 + 120 }), []);
  // Past it: the overshoot the grace bounds, made visible instead of asserted.
  const over = reconcileWithGrant(grant, { meteredSeconds: 3600 });
  assert.equal(over[0].kind, "over_grant");
  assert.equal(over[0].granted, 1800 + 120);

  // A line item for a capability the grant switched off is spend nobody
  // authorised, on a kelabo that was told it did not have the thing.
  const billed = reconcileWithGrant(grant, { meteredSeconds: 0, lineItemsMicros: { llm: 5_000 } });
  assert.equal(billed[0].kind, "billed_while_off");
  assert.equal(billed[0].capability, "assistant");

  // An unlimited grant — no allowance at all — bounds nothing (docs/19 §4.1).
  const unlimited = { capabilities: { call: { on: true }, stt: { on: true }, assistant: { on: true } } };
  assert.deepEqual(reconcileWithGrant(unlimited, { meteredSeconds: 10 ** 9, lineItemsMicros: { llm: 5_000 } }), []);
});

console.log(`contracts/entitlement: ${passed} passed`);
