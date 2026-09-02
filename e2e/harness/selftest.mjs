// Does the harness actually stand the product up? Asserted without a browser.
//
// This is not a substitute for the Playwright suite and does not test the SPA.
// It exists because a browser test that fails tells you almost nothing about
// WHERE it failed — the store, the adapter, the cookie key, the agent — and
// because those layers are worth a gate that runs in a second and needs no
// Chromium download. If this passes and a spec fails, the defect is in the
// front end or in the spec; if this fails, nothing else is worth running.
//
// Offline, hermetic, and part of `make test`.

import assert from "node:assert/strict";
import { applyHarnessEnv, PORTS, COOKIE_KEY } from "./env.mjs";

applyHarnessEnv();

const LLM_PORT = 3102;
const REST_PORT = PORTS.rest + 100;
const GW_PORT = PORTS.gateway + 100;
process.env.KELABO_OPENAI_BASE_URL = `http://localhost:${LLM_PORT}/v1`;
// The harness's own ports are shifted so a selftest run does not collide with a
// harness already up for a Playwright session — this is the gate people will
// run WHILE debugging a spec.
process.env.KELABO_GATEWAY_BASE_URL = `http://localhost:${GW_PORT}`;

const { createInMemoryDynamo } = await import("./ddb.mjs");
const { createInMemoryS3 } = await import("./s3.mjs");
const { createLlmServer } = await import("./llmServer.mjs");
const { createGatewayServer } = await import("./gatewayServer.mjs");
const { createRestServer } = await import("./restServer.mjs");
const { ensureConfig } = await import("../../rest-api/src/config.js");

const listen = (server, port) => new Promise((r) => server.listen(port, r));

const config = await ensureConfig();
const dynamoClient = createInMemoryDynamo(config.tableNames);
const s3 = createInMemoryS3();

const llm = createLlmServer();
await listen(llm.server, LLM_PORT);
const gateway = await createGatewayServer({ dynamoClient, s3, cookieKey: COOKIE_KEY });
await listen(gateway.server, GW_PORT);
const rest = await createRestServer({ config, dynamoClient, s3, cookieKey: COOKIE_KEY, reset: () => dynamoClient.reset() });
await listen(rest.server, REST_PORT);

const API = `http://localhost:${REST_PORT}`;
const GW = `http://localhost:${GW_PORT}`;

const jar = new Map();
async function call(base, method, path, body) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(jar.size ? { cookie: [...jar.entries()].map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("; ") } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "manual",
  });
  for (const line of res.headers.getSetCookie?.() ?? []) {
    const [pair] = line.split(";");
    const i = pair.indexOf("=");
    const value = decodeURIComponent(pair.slice(i + 1));
    if (value) jar.set(pair.slice(0, i).trim(), value);
  }
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {}
  return { status: res.status, json, text };
}
const api = (m, p, b) => call(API, m, p, b);
const gw = (m, p, b) => call(GW, m, p, b);

const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (e) {
    results.push({ name, ok: false, error: e });
  }
}

const EMAIL = "selftest@example.test";
let kelaboId;
let journeyId;

await check("both services answer /health", async () => {
  assert.equal((await api("GET", "/health")).json.ok, true);
  assert.equal((await gw("GET", "/health")).json.service, "kelabo-gateway");
});

await check("the OTP exchange signs a person in, and the code came from the composed mail", async () => {
  assert.equal((await api("POST", "/auth/otp/request", { email: EMAIL })).status, 200);
  const outbox = (await api("GET", `/__test/mail?to=${encodeURIComponent(EMAIL)}`)).json.messages;
  assert.equal(outbox.length, 1, "no mail was composed");
  const code = outbox[0].code;
  assert.match(code, /^\d{6}$/, "no six-digit code in the message body");
  assert.match(outbox[0].subject, new RegExp(code), "the subject does not carry the code");
  const verify = await api("POST", "/auth/otp/verify", { email: EMAIL, code });
  assert.equal(verify.status, 200);
  assert.equal(verify.json.tenantId, "example.test");
});

await check("the session cookie is accepted on a later request", async () => {
  const me = await api("GET", "/me");
  assert.equal(me.status, 200, `/me said ${me.status}`);
  assert.equal(me.json.identity.email, EMAIL);
});

await check("a kelabo created through the REST API is joinable", async () => {
  const created = await api("POST", "/kelabos", { title: "Selftest" });
  assert.equal(created.status, 200, created.text);
  kelaboId = created.json.kelaboId;
  const joined = await api("POST", `/kelabos/${kelaboId}/join`, { displayName: "Selftest", mode: "audio-board" });
  assert.equal(joined.status, 200, joined.text);
  // The whole reason the store is shared: the Gateway must see what the
  // control plane wrote.
  assert.equal(joined.json.gatewayBaseUrl, GW);
});

await check("a caption posted to the Gateway is persisted and replayed", async () => {
  const posted = await gw("POST", "/caption", {
    kelaboId,
    messageId: "selftest-1",
    kind: "sealed",
    isFinal: true,
    text: "The harness is speaking.",
    source: "typed",
  });
  // 202 for a live relay, 200 for a persisted seal — both are success, and
  // which one a sealed typed message gets is the caption route's business
  // (gateway/src/caption.js), not something this gate should pin.
  assert.ok(posted.status < 300, `${posted.status} ${posted.text}`);
  const history = await gw("GET", `/caption/history?kelaboId=${kelaboId}`);
  assert.equal(history.json.utterances.length, 1);
  assert.equal(history.json.utterances[0].text, "The harness is speaking.");
});

await check("the agent runs a whole turn offline and reaches the board", async () => {
  // Two spoken lines, because the gate reads the LAST line of a window and a
  // single caption is not yet a conversation.
  for (const n of [2, 3]) {
    await gw("POST", "/caption", {
      kelaboId,
      messageId: `selftest-${n}`,
      kind: "sealed",
      isFinal: true,
      text: "What is the latest version of Node.js?",
      source: "speech",
    });
  }
  const deadline = Date.now() + 15_000;
  let contributions = [];
  while (Date.now() < deadline) {
    contributions = (await api("GET", `/kelabos/${kelaboId}/board`)).json.contributions ?? [];
    if (contributions.length) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  assert.ok(contributions.length, "the agent produced no board contribution in 15s");
  assert.equal(contributions[0].author, "assistant");
  assert.equal(contributions[0].tag, "LLM_CON");
});

await check("the SSE board stream delivers a contribution live", async () => {
  const controller = new AbortController();
  const res = await fetch(`${GW}/caption/replies?kelaboId=${kelaboId}`, {
    headers: { cookie: [...jar.entries()].map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("; ") },
    signal: controller.signal,
  });
  assert.equal(res.status, 200, "the SSE stream was refused");
  assert.match(res.headers.get("content-type") || "", /text\/event-stream/);
  const reader = res.body.getReader();
  const first = await Promise.race([
    reader.read().then(({ value }) => new TextDecoder().decode(value)),
    new Promise((r) => setTimeout(() => r(""), 3000)),
  ]);
  controller.abort();
  // Anything at all: the hub opens with a hello/ping. An empty read means the
  // stream authenticated and then never spoke, which is the failure mode worth
  // catching here.
  assert.ok(first.length, "the SSE stream opened but sent nothing");
});

await check("a journey holds a kelabo, a board note and a document", async () => {
  const created = await api("POST", "/journeys", { title: "Selftest journey" });
  assert.equal(created.status, 200, created.text);
  journeyId = created.json.journeyId;
  assert.equal((await api("POST", `/journeys/${journeyId}/kelabos`, { kelaboId })).json.linked, true);
  assert.equal((await api("POST", `/journeys/${journeyId}/board`, { content: "Harness note" })).status, 200);
  const doc = await api("POST", `/journeys/${journeyId}/documents`, { title: "Spec", content: "Mesh for secure kelabos." });
  assert.equal(doc.status, 200, doc.text);
  const timeline = (await api("GET", `/journeys/${journeyId}/timeline`)).json.entries;
  const kinds = new Set(timeline.map((e) => e.type));
  for (const kind of ["kelabo_linked", "board_message", "document"]) {
    assert.ok(kinds.has(kind), `the timeline is missing a ${kind} entry`);
  }
});

await check("ending a kelabo archives it where the record page reads it", async () => {
  const ended = await api("POST", `/kelabos/${kelaboId}/end`);
  assert.equal(ended.status, 200, ended.text);
  const archived = Object.keys(s3.dump());
  assert.ok(archived.length, "nothing was written to the archive bucket");
  // Read back through `/records`, which is what the record page calls
  // (spa/src/api.js:152) — the Gateway wrote the archive object, the control
  // plane serves it, and the two only meet because they share one store.
  const list = await api("GET", "/records");
  assert.equal(list.status, 200, list.text);
  // A record is addressed by `archiveId`, which is the kelabo's own id for a
  // kelabo archived once — the list carries no separate `kelaboId`.
  const record = (list.json.records ?? []).find((r) => r.archiveId === kelaboId);
  assert.ok(record, `the ended kelabo does not appear in /records: ${list.text.slice(0, 200)}`);
  const detail = await api("GET", `/records/${record.archiveId}`);
  assert.equal(detail.status, 200, detail.text);
});

await check("a malformed body is a client error, not a server error", async () => {
  const res = await api("POST", "/auth/otp/request", { email: 123 });
  assert.equal(res.status, 400, `expected 400 for a malformed body, got ${res.status} ${res.text}`);
});

llm.server.close();
gateway.server.close();
rest.server.close();
await gateway.container.shutdown?.();

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? "ok  " : "FAIL"} ${r.name}`);
for (const r of failed) console.error(`\n--- ${r.name}\n${r.error?.stack || r.error}`);
console.log(`\ne2e/harness: ${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
