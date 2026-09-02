// The Gateway, booted the way `gateway/test/smoke.mjs` boots it: the real
// `createContainer` + `createGateway`, listening on a real port, with only the
// AWS clients replaced. Everything the browser touches — the SSE hub, the
// caption route, presence, `/rtc/*`, the journey legs channel — is the shipped
// code.

import { createContainer } from "../../gateway/src/container.js";
import { createGateway } from "../../gateway/src/server.js";

/**
 * @param {object} opts
 * @param {object} opts.dynamoClient  the shared in-memory document client
 * @param {object} opts.s3            the shared in-memory S3 client
 * @param {string} opts.cookieKey     the one signing key
 */
export async function createGatewayServer({ dynamoClient, s3, cookieKey }) {
  const container = await createContainer({
    db: dynamoClient,
    s3,
    secrets: {
      // The container reads secrets through `GetSecretValueCommand`, so the
      // stub answers at that level rather than at `getCookieKey` — which keeps
      // its TTL cache and its JSON-or-string handling in the path.
      send: async () => ({ SecretString: cookieKey }),
    },
    // Nothing to rebuild: the harness starts from an empty store, and
    // `rebuildState` would only Scan it. Skipped rather than tolerated so a
    // failure here is a real failure.
    skipRebuild: true,
    // Faster than the 25 s production keepalive, so a presence assertion does
    // not have to wait for one (docs 18 §5).
    presencePingMs: 1000,
  });

  return { container, server: createGateway(container) };
}
