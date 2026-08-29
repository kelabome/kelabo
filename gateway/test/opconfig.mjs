// The gateway's half of published operational configuration.
//
// Two things live here that nothing else can check. The **route** — a change
// published in the control plane has to reach the running task, and the only
// thing that carries it is `POST /internal/config/reload`; if that route stops
// requiring the internal JWT, anything on the internet can make this task
// re-read its own settings and re-initialise the agent worker at will. And the
// **fallback** — a task whose config table is missing or unreadable has to keep
// running on its own environment config rather than on the schema's empty
// defaults, because the alternative is a deployment that silently loses its
// model mid-call.
import assert from "node:assert/strict";
import http from "node:http";
import { createGateway } from "../src/server.js";
import { createOpConfig } from "../src/opconfig.js";
import { signJwt } from "../src/cookies.js";
import { createState } from "../src/state.js";

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

const KEY = "test-cookie-signing-key";
const now = Math.floor(Date.now() / 1000);
const internalJwt = signJwt({ sub: "rest-lambda", aud: "gateway-internal", iat: now, exp: now + 300 }, KEY);
// The same key, the wrong audience. Three token families share one signing key
// (browser cookies, this internal JWT, agent tokens), so `aud` is the ONLY
// thing separating them — a verifier that forgot to check it would accept any
// signed-in user's session cookie here.
const sessionJwt = signJwt({ sub: "alice@example.com", aud: "kelabo-session", iat: now, exp: now + 300 }, KEY);

// The deployment's own configuration: the bootstrap everything falls back to.
const CONFIG = {
  env: "test",
  region: "us-east-1",
  portalUrl: "http://portal.test",
  allowedOrigins: ["http://portal.test"],
  tableNames: {},
  llm: { provider: "anthropic", model: "claude-x", smallModel: "claude-s" },
  openaiBaseUrl: "https://api.anthropic.com",
  gateway: { agent: { sensitivity: "low", cooldownSeconds: 45, maxConcurrentRuns: 4 } },
  rtc: { defaultMode: "sfu", meshMaxParticipants: 5, video: true },
  contacts: { external: false },
  retentionDays: 30,
  secrets: {},
};

function container(overrides = {}) {
  const c = {
    config: CONFIG,
    state: createState(),
    log: () => {},
    logError: () => {},
    getCookieKey: async () => KEY,
    db: { send: async () => ({ Items: [] }) },
    // `createGateway` builds the SSE hub, which registers a shutdown hook for
    // its keepalive timer. A container without this array fails at construction
    // rather than at the route being tested.
    shutdownHooks: [],
    ...overrides,
  };
  c.opConfig = overrides.opConfig ?? createOpConfig(c, { ttlMs: 0 });
  return c;
}

function req(port, { method = "GET", path, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: "127.0.0.1", port, path, method, headers }, (res) => {
      const chunks = [];
      res.on("data", (d) => chunks.push(d));
      res.on("end", () =>
        resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }),
      );
    });
    r.on("error", reject);
    r.end();
  });
}

/**
 * `createGateway` constructs the agent dispatcher itself — there is no override
 * seam for it, unlike `createContainer` — so a stub has to be installed
 * afterwards rather than passed in. Patching here instead of adding a seam to
 * production code for a test's benefit.
 */
async function withServer(c, fn, { dispatcher } = {}) {
  const server = createGateway(c);
  if (dispatcher) c.agentDispatcher = dispatcher;
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    await fn(server.address().port);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

// --- falling back -----------------------------------------------------------

await test("no config table: the task runs entirely on its own configuration", async () => {
  // This is what every existing deployment looks like the moment this code
  // ships, and what a local run always looks like. It must change nothing.
  const c = container();
  const r = await c.opConfig.resolved();
  assert.equal(r.llm.provider, "anthropic");
  assert.equal(r.llm.model, "claude-x");
  assert.equal(r.llm.baseUrl, "https://api.anthropic.com", "the gateway's own name for this field is honoured");
  assert.equal(r.agent.sensitivity, "low");
  assert.equal(r.agent.maxConcurrentRuns, 4);
  assert.equal(r.rtc.video, true);
  assert.equal(r.retentionDays, 30);
});

await test("a published version wins, and untouched fields still fall back", async () => {
  const c = container({
    db: {
      send: async () => ({
        Items: [
          {
            PK: "OPCONFIG",
            SK: "V#000002",
            version: 2,
            effectiveFrom: 0,
            llm: { provider: "deepseek", model: "deepseek-v4", baseUrl: "https://api.deepseek.com/v1" },
            agent: { sensitivity: "high" },
          },
        ],
      }),
    },
    config: { ...CONFIG, tableNames: { config: "kelabo-test-config" } },
  });
  const r = await c.opConfig.resolved();
  assert.equal(r.llm.provider, "deepseek");
  assert.equal(r.llm.baseUrl, "https://api.deepseek.com/v1");
  assert.equal(r.agent.sensitivity, "high");
  // Not published, so still the deployment's.
  assert.equal(r.llm.smallModel, "claude-s");
  assert.equal(r.agent.cooldownSeconds, 45);
});

await test("an unreadable table keeps the last good version, never the empty defaults", async () => {
  // The failure that matters: reverting to the schema's defaults would leave
  // the task with no model at all, mid-call, and the log would be the only
  // evidence. Serving stale settings is the right degradation.
  let fail = false;
  const c = container({
    db: {
      send: async () => {
        if (fail) throw new Error("dynamo is down");
        return {
          Items: [{ PK: "OPCONFIG", SK: "V#000002", version: 2, effectiveFrom: 0, llm: { provider: "deepseek" } }],
        };
      },
    },
    config: { ...CONFIG, tableNames: { config: "kelabo-test-config" } },
  });
  assert.equal((await c.opConfig.resolved()).llm.provider, "deepseek");
  fail = true;
  assert.equal((await c.opConfig.resolved()).llm.provider, "deepseek");
  assert.equal(c.opConfig.status().source, "stale");
});

// --- the reload route -------------------------------------------------------

await test("the reload route requires the internal JWT", async () => {
  const c = container();
  await withServer(c, async (port) => {
    const anon = await req(port, { method: "POST", path: "/internal/config/reload" });
    assert.equal(anon.status, 401, "an unauthenticated caller must not be able to poke this task");

    // Signed with the right key, but it is a session token. `aud` is the only
    // thing separating the three token families that share this key.
    const wrongAud = await req(port, {
      method: "POST",
      path: "/internal/config/reload",
      headers: { authorization: `Bearer ${sessionJwt}` },
    });
    assert.equal(wrongAud.status, 401, "a session cookie must not pass as the internal JWT");

    const garbage = await req(port, {
      method: "POST",
      path: "/internal/config/reload",
      headers: { authorization: "Bearer not-a-jwt" },
    });
    assert.equal(garbage.status, 401);
  });
});

await test("a reload invalidates the cache and reports what happened to the worker", async () => {
  let reads = 0;
  const c = container({
    db: {
      send: async () => {
        reads++;
        return { Items: [] };
      },
    },
    config: { ...CONFIG, tableNames: { config: "kelabo-test-config" } },
  });
  // A real cache lifetime, so "invalidate" is the thing being tested rather
  // than a zero TTL re-reading anyway.
  c.opConfig = createOpConfig(c, { ttlMs: 60_000 });
  await c.opConfig.resolved();
  assert.equal(reads, 1);
  await c.opConfig.resolved();
  assert.equal(reads, 1, "cached, as it should be");

  await withServer(c, async (port) => {
    const res = await req(port, {
      method: "POST",
      path: "/internal/config/reload",
      headers: { authorization: `Bearer ${internalJwt}` },
    });
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.ok, true);
    // No agent worker is running in this container, and that is reported rather
    // than claimed as a success — the control plane's console tells the
    // operator whether their change is live, so this must not lie.
    assert.equal(body.reconfigured, false);
    assert.equal(body.reason, "no_worker");
  });

  await c.opConfig.resolved();
  assert.equal(reads, 2, "the reload forced the next read to hit the table");
});

await test("a dispatcher that throws does not fail the reload", async () => {
  // The config is already invalidated by the time the worker is touched, so the
  // next turn picks the change up regardless. A 500 here would make the control
  // plane report a failed publish for a change that was saved and will apply.
  const c = container();
  await withServer(
    c,
    async (port) => {
      const res = await req(port, {
        method: "POST",
        path: "/internal/config/reload",
        headers: { authorization: `Bearer ${internalJwt}` },
      });
      assert.equal(res.status, 200);
      assert.equal(JSON.parse(res.body).reason, "error");
    },
    {
      dispatcher: {
        reconfigure: async () => {
          throw new Error("worker is wedged");
        },
      },
    },
  );
});

await test("a running worker is reconfigured, and says so", async () => {
  const c = container();
  await withServer(
    c,
    async (port) => {
      const res = await req(port, {
        method: "POST",
        path: "/internal/config/reload",
        headers: { authorization: `Bearer ${internalJwt}` },
      });
      const body = JSON.parse(res.body);
      assert.equal(body.reconfigured, true);
      assert.equal(body.model, "deepseek-v4");
    },
    { dispatcher: { reconfigure: async () => ({ reconfigured: true, model: "deepseek-v4" }) } },
  );
});

// --- the sync snapshot --------------------------------------------------------

await test("resolvedNow serves the bootstrap before any read, then converges", async () => {
  // The sync reader exists for call sites inside callbacks (a stream's close
  // handler scheduling an eviction) that cannot await. It must be correct
  // before the first read — the pure bootstrap fold — and converge to the
  // published value once a read completes.
  const c = container({
    db: {
      send: async () => ({
        Items: [{ PK: "OPCONFIG", SK: "V#000002", version: 2, effectiveFrom: 0, rtc: { meshMaxParticipants: 9 } }],
      }),
    },
    config: { ...CONFIG, tableNames: { config: "kelabo-test-config" } },
  });
  assert.equal(c.opConfig.resolvedNow().rtc.meshMaxParticipants, 5, "bootstrap until something is read");
  await c.opConfig.resolved();
  assert.equal(c.opConfig.resolvedNow().rtc.meshMaxParticipants, 9, "the published cap after a read");
});

// --- no dead knobs, gateway side ---------------------------------------------

await test("every gateway consumer of a publishable field resolves it, never reads config", async () => {
  // The same check rest-api/test/admin.mjs runs on the Lambda's sources, for
  // the same reason: a consumer that reads `c.config.rtc.x` does not fail, it
  // silently pins the bootstrap — so the operator publishes a mesh cap the
  // REST entitlement advertises and this task never enforces. Checked as text
  // because the defect is invisible from outside.
  const { readFileSync } = await import("node:fs");
  const src = (f) => readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8");

  const wired = [
    ["rtc/routes.js", /c\.config\.rtc\./, "ICE TTL / mesh cap / video"],
    ["rtc/room.js", /c\.config\.rtc\./, "mesh cap / grace / default mode"],
    ["sseHub.js", /c\.config\.rtc/, "the departure grace window"],
    ["archive.js", /c\.config\.retentionDays/, "retention"],
    ["presence.js", /c\.config\.contacts/, "external contacts"],
  ];
  for (const [file, direct, what] of wired) {
    const offending = src(file)
      .split("\n")
      .filter((line) => direct.test(line) && !/^\s*(\*|\/\/)/.test(line));
    assert.equal(
      offending.length,
      0,
      `${file} still reads ${what} straight off config — publishing it would do nothing:\n  ${offending.join("\n  ")}`,
    );
  }
});

await test("the dispatcher re-inits a running worker on a knob change, not only a model change", async () => {
  // The motivating case for publishing the knobs at all is turning sensitivity
  // down against a live room — which almost never changes the model in the
  // same breath. A dispatcher that only compared the model config would keep a
  // knobs-only publish from every running worker until the next task restart:
  // exactly the wait publishing exists to remove, and invisible from outside
  // because nothing errors. Pinned in the source (the worker_thread lifecycle
  // cannot run under this harness): the running-worker branch must compare the
  // knobs and re-init on either change.
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../src/agent/runner.js", import.meta.url), "utf8");
  assert.match(src, /sameKnobs\(/, "runner.js no longer compares the knobs at all");
  assert.match(src, /knobsChanged/, "the running-worker branch does not track a knob change");
  assert.match(
    src,
    /modelChanged \|\| knobsChanged/,
    "a knob change alone no longer re-inits the running worker",
  );
});

console.log(`gateway/opconfig: ${passed} passed`);
