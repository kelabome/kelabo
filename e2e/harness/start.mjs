// Start the whole control plane offline: scripted LLM, Gateway, REST API.
//
// Run directly (`node harness/start.mjs`) or let Playwright start it as a
// `webServer`. Prints one line per service and then stays up.
//
// Order matters here and is not obvious:
//   1. the environment, before ANY config module is imported — both services
//      cache their config on first read, so a variable set afterwards is a
//      variable that does nothing.
//   2. the scripted LLM, before the Gateway — the agent worker resolves its
//      endpoint from the config the container was built with.
//   3. the Gateway, before the REST API — not required to boot, but the REST
//      API calls it over HTTP for end/minutes/report, so a suite that starts
//      asserting immediately would otherwise race the listener.

import { applyHarnessEnv, PORTS, COOKIE_KEY, TENANT_DOMAIN, ROOT_ADMIN_EMAIL, GATEWAY_BASE, API_BASE, PORTAL_URL } from "./env.mjs";

applyHarnessEnv();

const LLM_PORT = 3002;
process.env.KELABO_OPENAI_BASE_URL = `http://localhost:${LLM_PORT}/v1`;

const { createInMemoryDynamo } = await import("./ddb.mjs");
const { createInMemoryS3 } = await import("./s3.mjs");
const { createLlmServer } = await import("./llmServer.mjs");
const { createGatewayServer } = await import("./gatewayServer.mjs");
const { createRestServer } = await import("./restServer.mjs");
const { ensureConfig } = await import("../../rest-api/src/config.js");

const listen = (server, port, name) =>
  new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, () => {
      console.log(`[e2e] ${name} listening on http://localhost:${port}`);
      resolve(server);
    });
  });

const config = await ensureConfig();
const dynamoClient = createInMemoryDynamo(config.tableNames);
const s3 = createInMemoryS3();

const llm = createLlmServer();
await listen(llm.server, LLM_PORT, "llm (scripted)");

const gateway = await createGatewayServer({ dynamoClient, s3, cookieKey: COOKIE_KEY });
await listen(gateway.server, PORTS.gateway, "gateway");

const rest = await createRestServer({
  config,
  dynamoClient,
  s3,
  cookieKey: COOKIE_KEY,
  // Dynamo only. The Gateway keeps live rooms in process (`state.js`), and
  // clearing the table under a running room would leave the two disagreeing —
  // which is a bug this suite should be able to find, not one it should
  // manufacture. Suites get isolation from creating their own kelabos, not
  // from a shared reset.
  reset: () => dynamoClient.reset(),
});
await listen(rest.server, PORTS.rest, "rest-api");

console.log(
  [
    "[e2e] harness ready",
    `      portal   ${PORTAL_URL}`,
    `      api      ${API_BASE}`,
    `      gateway  ${GATEWAY_BASE}`,
    `      tenant   ${TENANT_DOMAIN}   root admin ${ROOT_ADMIN_EMAIL}`,
  ].join("\n")
);

const shutdown = () => {
  llm.server.close();
  gateway.server.close();
  rest.server.close();
  gateway.container.shutdown?.();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
