// Supplier credentials, in DynamoDB.
//
// What is worth testing here is not the shape — there is barely one — but the
// rules that made it safe to move key material out of Secrets Manager and into
// a table: that a slot is a closed set, that a status projection can never
// carry any part of a value, that a credential round-trips byte for byte, and
// that the item is addressed per slot so IAM can name one without naming all.
import assert from "node:assert/strict";
import {
  CREDENTIAL_SK,
  CREDENTIAL_SLOTS,
  CREDENTIAL_STATUS_ATTRS,
  credentialItem,
  credentialPk,
  credentialSlotFromPk,
  credentialStatus,
  CREDENTIAL_FIELDS,
  LLM_CONFIG,
  credentialFieldKeys,
  credentialStatusSchema,
  isCredentialSlot,
  validateCredentialFields,
  mcpSecretSk,
  parseCredential,
  sttKeyFrom,
  mailKeyFrom,
} from "../src/credentials.js";

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
  } catch (err) {
    console.error(`FAIL ${name}`);
    throw err;
  }
}

// --- addressing -------------------------------------------------------------

await test("one partition per slot, so IAM can name them individually", () => {
  // This is the whole reason the key is shaped this way. A single `PK = CRED`
  // partition with the slot in the sort key would make "list every slot" one
  // Query — and would make every slot readable by anything that can read one.
  assert.equal(credentialPk("llm"), "CRED#llm");
  assert.equal(credentialPk("rtc"), "CRED#rtc");
  assert.notEqual(credentialPk("llm"), credentialPk("rtc"));
  assert.equal(CREDENTIAL_SK, "META");
});

await test("slots are a closed set", () => {
  assert.deepEqual(CREDENTIAL_SLOTS, ["llm", "stt", "rtc", "mail"]);
  assert.equal(isCredentialSlot("mail"), true);
  assert.equal(isCredentialSlot("mial"), false);
  // A free-form slot would let a typo create a credential nothing ever reads,
  // which looks identical to one that was never set.
  assert.equal(isCredentialSlot("__proto__"), false);
  assert.equal(isCredentialSlot(""), false);
});

await test("a partition key round-trips to its slot, and rejects anything else", () => {
  for (const slot of CREDENTIAL_SLOTS) assert.equal(credentialSlotFromPk(credentialPk(slot)), slot);
  assert.equal(credentialSlotFromPk("CRED#cookie"), "");
  assert.equal(credentialSlotFromPk("RATECARD"), "");
  assert.equal(credentialSlotFromPk(undefined), "");
});

// --- the item ---------------------------------------------------------------

await test("an item carries its own keys and never a ttl", () => {
  const item = credentialItem({ slot: "llm", value: '{"apiKey":"sk-1"}', rotatedBy: "ops@example.com", at: 1_700_000_000_000 });
  assert.equal(item.PK, "CRED#llm");
  assert.equal(item.SK, "META");
  assert.equal(item.slot, "llm");
  assert.equal(item.version, 1);
  assert.equal(item.rotatedAt, 1_700_000_000_000);
  assert.equal(item.rotatedBy, "ops@example.com");
  // A credential that expired itself would take a live capability down with
  // nothing to say why.
  assert.equal("ttl" in item, false);
});

// --- the non-secret marker ---------------------------------------------------

await test("an item carries a non-secret marker saying it is configured", () => {
  // The attribute that makes "is this configured?" answerable without reading
  // the credential. Deriving it from `value` was free, and was exactly what
  // cost the boundary: the only way to ask the question was to read the answer.
  const item = credentialItem({ slot: "llm", value: '{"apiKey":"sk-1"}' });
  assert.equal(item.configured, true);
  // Always true — `credentialItem` refuses an empty value, so writing the row
  // at all is what the marker records. It is a marker, not data.
  assert.equal(credentialItem({ slot: "stt", value: "x" }).configured, true);
});

await test("the status attribute list covers the item minus the credential", () => {
  // One list, two consumers that must never disagree: the ProjectionExpression
  // in rest-api/src/db.js and the `dynamodb:Attributes` condition in
  // infra/lib/lambda-stack.js. A projection naming an attribute the policy
  // omits is denied; a policy naming one the projection omits is a boundary
  // that is not there.
  const item = credentialItem({ slot: "llm", value: "k", rotatedBy: "op" });
  assert.deepEqual(
    Object.keys(item).filter((k) => k !== "value").sort(),
    [...CREDENTIAL_STATUS_ATTRS].sort(),
    "every non-secret attribute of the item is in the list, and nothing else is"
  );
  // `value` is the one attribute that must never be in it.
  assert.equal(CREDENTIAL_STATUS_ATTRS.includes("value"), false);
  // The table's key attributes are, and for IAM's sake rather than the
  // status's: a `dynamodb:Attributes` condition omitting them denies the
  // GetItem outright, because the request's `Key` counts as attributes accessed.
  assert.ok(CREDENTIAL_STATUS_ATTRS.includes("PK"));
  assert.ok(CREDENTIAL_STATUS_ATTRS.includes("SK"));
  assert.equal(Object.isFrozen(CREDENTIAL_STATUS_ATTRS), true);
});

await test("a credential is stored verbatim, not re-encoded", () => {
  // Byte for byte: a supplier whose key happens to look like JSON, or one with
  // significant whitespace, must come back exactly as it went in.
  const raw = '{ "soniox": "aaa",\n  "deepgram": "bbb" }';
  assert.equal(credentialItem({ slot: "stt", value: raw }).value, raw);
});

await test("an unknown slot or an empty value is refused", () => {
  assert.throws(() => credentialItem({ slot: "cookie", value: "x" }), /unknown slot/);
  assert.throws(() => credentialItem({ slot: "llm", value: "" }), /non-empty string/);
  assert.throws(() => credentialItem({ slot: "llm", value: { apiKey: "x" } }), /non-empty string/);
});

await test("version counts rotations and never goes backwards from a bad input", () => {
  assert.equal(credentialItem({ slot: "llm", value: "x", version: 7 }).version, 7);
  assert.equal(credentialItem({ slot: "llm", value: "x", version: 0 }).version, 1);
  assert.equal(credentialItem({ slot: "llm", value: "x", version: -3 }).version, 1);
  assert.equal(credentialItem({ slot: "llm", value: "x", version: NaN }).version, 1);
});

// --- what the console may know ----------------------------------------------

await test("a status carries no part of the value", () => {
  const item = credentialItem({ slot: "llm", value: '{"apiKey":"sk_live_SECRET"}', rotatedBy: "root@x", at: 42 });
  const status = credentialStatus("llm", item);
  assert.deepEqual(Object.keys(status).sort(), [
    "configured", "fields", "rotatedAt", "rotatedBy", "slot", "unknown", "version",
  ]);
  // No `value`, no `last4`, no `prefix`. A "last four" affordance is how a key
  // ends up in a screenshot in a support thread, and it buys nothing the
  // rotation date does not.
  assert.equal(JSON.stringify(status).includes("SECRET"), false);
  credentialStatusSchema.parse(status);
});

await test("a status is an explicit pick, so a new attribute cannot leak by default", () => {
  const status = credentialStatus("llm", { value: "k", version: 2, rotatedAt: 9, somethingNew: "leaky" });
  assert.equal("somethingNew" in status, false);
});

await test("a missing item reads as not configured rather than throwing", () => {
  const st = credentialStatus("rtc", null);
  assert.equal(st.configured, false);
  assert.equal(st.version, 0);
  assert.equal(st.rotatedAt, null);
  // Every field the slot defines still appears, as false. A field that vanished
  // when unset would make "not configured" and "no such field" look the same.
  assert.deepEqual(st.fields, {
    sfuAppId: false, sfuAppSecret: false, turnKeyId: false, turnKeyApiToken: false,
  });
});

await test("a status can be built from a row that has no value attribute at all", () => {
  // The projected read (`CREDENTIAL_STATUS_ATTRS`), which is the only read the
  // control plane's role may do on `CRED#llm` and `CRED#rtc`. If this needed
  // `value`, the boundary could not exist.
  const projected = {
    PK: "CRED#llm", SK: "META", slot: "llm",
    configured: true, version: 4, rotatedAt: 99, rotatedBy: "op@x", createdAt: 1,
  };
  const st = credentialStatus("llm", projected);
  assert.equal(st.configured, true);
  assert.equal(st.version, 4);
  assert.equal(st.rotatedBy, "op@x");
  // Per-field detail is derived from the value, so a projected row cannot have
  // it — and should not: it is information about the credential.
  assert.deepEqual(st.fields, { apiKey: false });
  assert.deepEqual(st.unknown, []);
  credentialStatusSchema.parse(st);
});

await test("configured falls back to the value for rows written before the marker", () => {
  // Legacy row, read whole by a component that may read it. No `configured`
  // attribute, so the old value-derived check decides.
  assert.equal(credentialStatus("llm", { value: '{"apiKey":"k"}', version: 1 }).configured, true);
  assert.equal(credentialStatus("llm", { value: "", version: 1 }).configured, false);
  assert.equal(credentialStatus("llm", { version: 1, value: undefined }).configured, false);
});

await test("a legacy row seen through the projection reads as configured, not as off", () => {
  // Neither marker nor `value`: a row written before this change, read the only
  // way the control plane is now allowed to read it. There is by construction
  // nothing left to check, and the row existing is the signal (docs 19 §3) —
  // which is what "configured" meant before the marker. Answering `false` would
  // report a working deployment's capability as off, silently, until the slot
  // was next written.
  const legacy = { PK: "CRED#rtc", SK: "META", slot: "rtc", version: 2, rotatedAt: 5, rotatedBy: "" };
  assert.equal("configured" in legacy, false);
  assert.equal("value" in legacy, false);
  assert.equal(credentialStatus("rtc", legacy).configured, true);
  // A genuinely absent row is still off. That distinction is the whole
  // permissive rule: only a definitive "no item" switches a capability off.
  assert.equal(credentialStatus("rtc", null).configured, false);
});

await test("the marker wins over the value, in both directions", () => {
  // The marker is the authority once a row has one, so a whole-row read and a
  // projected read of the same row can never disagree.
  assert.equal(credentialStatus("llm", { configured: true }).configured, true);
  assert.equal(credentialStatus("llm", { configured: false, value: "leftover" }).configured, false);
});

// --- parsing ----------------------------------------------------------------

await test("JSON parses; anything else is wrapped, never lost", () => {
  assert.deepEqual(parseCredential('{"apiKey":"k"}'), { apiKey: "k" });
  assert.deepEqual(parseCredential("sk-plain-key"), { value: "sk-plain-key" });
  // A bare JSON scalar is a value, not a shape — wrapping it keeps every
  // consumer's `cred.apiKey ?? cred.value` working.
  assert.deepEqual(parseCredential('"quoted"'), { value: '"quoted"' });
  assert.equal(parseCredential(""), null);
  assert.equal(parseCredential(undefined), null);
});

await test("the stt credential holds one key per engine, looked up by exact name", () => {
  const cred = parseCredential('{"soniox":"s-key","deepgram":"d-key"}');
  assert.equal(sttKeyFrom(cred, "soniox"), "s-key");
  assert.equal(sttKeyFrom(cred, "deepgram"), "d-key");
  assert.throws(() => sttKeyFrom(cred, "whisper"), /no key for stt provider whisper/);
  assert.throws(() => sttKeyFrom(null, "soniox"), /no key for stt provider/);
});

await test("there is no fallback chain, which is what hid the typo", () => {
  // `s[provider] || s.apiKey || s.key || s.value` used to be the lookup, so a
  // credential whose soniox key was stored as `oniox` would fall through to
  // whatever else was in the blob and appear to work. The exact name is the
  // only name now: a misspelling is an error at mint time, not a mystery later.
  assert.throws(() => sttKeyFrom({ apiKey: "x" }, "soniox"), /no key for stt provider soniox/);
  assert.throws(() => sttKeyFrom({ oniox: "typo" }, "soniox"), /no key for stt provider soniox/);
});

// --- the field list ---------------------------------------------------------

await test("every slot declares a closed field list", () => {
  assert.deepEqual(credentialFieldKeys("llm"), ["apiKey"]);
  assert.deepEqual(credentialFieldKeys("stt"), ["soniox", "deepgram"]);
  assert.deepEqual(credentialFieldKeys("rtc"), ["sfuAppId", "sfuAppSecret", "turnKeyId", "turnKeyApiToken"]);
  assert.deepEqual(credentialFieldKeys("mail"), ["mailersend"]);
  // Every field carries what the console needs to render it.
  for (const slot of Object.keys(CREDENTIAL_FIELDS)) {
    for (const f of CREDENTIAL_FIELDS[slot]) {
      assert.equal(typeof f.key, "string");
      assert.equal(typeof f.label, "string");
      assert.equal(typeof f.required, "boolean");
    }
  }
});

await test("an unknown field is reported, not absorbed", () => {
  // The exact shape the stt credential drifted into, typos and all.
  const { fields, unknown } = validateCredentialFields("stt", {
    soniox: "s",
    deepgram: "d",
    oniox: "typo",
    onionx: "typo2",
  });
  assert.deepEqual(Object.keys(fields).sort(), ["deepgram", "soniox"]);
  assert.deepEqual(unknown.sort(), ["onionx", "oniox"]);
});

await test("a required field that is absent is named", () => {
  assert.deepEqual(validateCredentialFields("rtc", { sfuAppId: "a" }).missing, ["sfuAppSecret"]);
  // TURN is optional: a room without it degrades to STUN rather than breaking,
  // so its absence must not read as a misconfiguration.
  assert.deepEqual(validateCredentialFields("rtc", { sfuAppId: "a", sfuAppSecret: "b" }).missing, []);
});

await test("an empty string is 'not set', never 'set to empty'", () => {
  // So a form can submit every field it renders without blanking the ones
  // nobody typed into.
  const { fields } = validateCredentialFields("stt", { soniox: "s", deepgram: "   " });
  assert.deepEqual(Object.keys(fields), ["soniox"]);
});

await test("a status names which fields are set, and never their values", () => {
  const item = credentialItem({ slot: "stt", value: '{"soniox":"SECRET-A","oniox":"SECRET-B"}' });
  const status = credentialStatus("stt", item);
  assert.deepEqual(status.fields, { soniox: true, deepgram: false });
  // The stray key is surfaced rather than hidden — this is the display that
  // would have caught the typo on the day it was pasted.
  assert.deepEqual(status.unknown, ["oniox"]);
  assert.equal(JSON.stringify(status).includes("SECRET"), false);
  credentialStatusSchema.parse(status);
});

// --- the assistant ----------------------------------------------------------

await test("the model config is one frozen object, whatever supplies it", () => {
  // The seam: the four values come from the gateway's own environment here and
  // may be pinned to a single vendor in a hosted build. What every consumer
  // relies on is the shape and that nothing can mutate it at run time — so
  // that is what is pinned, not the vendor.
  assert.deepEqual(Object.keys(LLM_CONFIG).sort(), ["baseUrl", "model", "provider", "smallModel"]);
  assert.match(LLM_CONFIG.baseUrl, /^https:\/\//);
  assert.equal(typeof LLM_CONFIG.provider, "string");
  assert.equal(LLM_CONFIG.provider.length > 0, true);
  assert.equal(Object.isFrozen(LLM_CONFIG), true);
});

// --- MCP bearer tokens ------------------------------------------------------

await test("a bearer token sits beside the server it authenticates", () => {
  // Same partition as `SERVER#<name>` and `TOKEN#<name>`, so a user's whole MCP
  // state is one query and deleting a user is one partition delete. It used to
  // be one Secrets Manager secret per user per server — the same material as
  // the OAuth tokens two rows away, in a different store.
  assert.equal(mcpSecretSk("github"), "SECRET#github");
  assert.notEqual(mcpSecretSk("github"), "TOKEN#github");
});


// --- mail, the slot that may legitimately be empty ---------------------------

await test("no mail field is required, because SES takes no key", () => {
  // Every other slot has at least one required field: without it the capability
  // does not work. Mail is different — the SES transport authenticates with the
  // deployment's own IAM role — so an empty slot is a working configuration,
  // and a `required: true` here would make the console report a healthy
  // deployment as broken.
  assert.equal(CREDENTIAL_FIELDS.mail.some((f) => f.required), false);
  for (const slot of ["llm", "rtc"]) {
    assert.equal(CREDENTIAL_FIELDS[slot].some((f) => f.required), true, `${slot} should still require something`);
  }
});

await test("mailKeyFrom answers empty rather than throwing, unlike its stt twin", () => {
  // The difference is the whole point. `sttKeyFrom` throws because a missing
  // transcription key can only be a mistake; a missing mail key is what an SES
  // deployment looks like, and throwing would stop it sending sign-in codes.
  assert.equal(mailKeyFrom({ mailersend: "ms-key" }, "mailersend"), "ms-key");
  assert.equal(mailKeyFrom({ mailersend: "ms-key" }, "ses"), "");
  assert.equal(mailKeyFrom(null, "ses"), "");
  assert.equal(mailKeyFrom(undefined, "mailersend"), "");
  assert.throws(() => sttKeyFrom({ deepgram: "k" }, "soniox"));
});

// The name is exact here too: the fallback chain that hid `oniox`/`onionx` in
// the stt secret would hide a mail key under a misspelt provider just as well.
await test("a mail key stored under the wrong provider name is not found", () => {
  assert.equal(mailKeyFrom({ mailsend: "ms-key" }, "mailersend"), "");
  assert.equal(mailKeyFrom({ apiKey: "ms-key" }, "mailersend"), "");
});

await test("every slot's status validates, including the one added last", () => {
  // The schema used to restate the slot list instead of deriving it, so adding
  // a fifth slot left the console rendering a row whose status this rejected —
  // in a place nothing exercised.
  for (const slot of CREDENTIAL_SLOTS) {
    credentialStatusSchema.parse(credentialStatus(slot, null));
    credentialStatusSchema.parse(credentialStatus(slot, credentialItem({ slot, value: "{}" })));
  }
});

console.log(`contracts/credentials: ${passed} passed`);
