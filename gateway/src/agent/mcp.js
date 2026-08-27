// `getMcpSecret` is in this list for a reason worth recording: it is easy to
// call below and **never import**, from the day pasted bearer tokens moved out
// of Secrets Manager and into `SECRET#` rows in this table. A bearer-auth MCP
// server would then throw `getMcpSecret is not defined`, be caught by the
// handler two lines under the call, and be dropped from the kelabo — so the
// feature is silently off for every user, with one log line
// (`mcp_secret_resolve_failed`) that reads like a credential problem. That is
// what `test/mcp.mjs` pins, on the Authorization header rather than on the
// server's presence: presence alone passes while the token is missing entirely.
import { queryMcpScope, getMcpSecret, getMcpToken, putMcpToken, getMcpClient } from "../db.js";
import { refreshAccessToken, isTokenExpired } from "@kelabo/contracts/mcp-auth";
import { createMcpQuery } from "./subagents.js";

// Prompt budget for the tool catalogue. A server may expose dozens of tools and
// the catalogue is injected into every sub-agent system prompt, so cap it.
const MAX_TOOLS_PER_SERVER = 40;
const MAX_TOOL_DESC_CHARS = 180;

/**
 * Resolve the MCP servers a kelabo may use, with credentials attached.
 *
 * Three auth shapes (see mcpServerSchema):
 *   none   - nothing to attach
 *   bearer - a static token from a SECRET# row here, written by the rest-api
 *   oauth  - an access token from the mcp table, refreshed HERE when stale
 *
 * A kelabo can outlive an access token (they are commonly ~1h), so callers also
 * get `reauthorizers`: a name -> async fn map that forces a refresh and returns
 * a fresh Authorization header. That map is deliberately kept OUT of `servers`
 * — `servers` is structured-cloned across the worker_thread boundary and
 * functions are not cloneable, so the worker asks the main thread to reauthorize
 * over postMessage instead (see runner.js / worker.js).
 *
 * @returns {Promise<{servers: object[], reauthorizers: Map<string, () => Promise<string|null>>}>}
 */
export async function loadEffectiveMcp(c, { hostIdentity }) {
  const scopePk = hostIdentity ? `MCP#host#${hostIdentity}` : null;
  const host = scopePk ? await queryMcpScope(c, scopePk) : [];

  const byName = new Map();
  for (const s of host) byName.set(s.name, s);

  const servers = [];
  const reauthorizers = new Map();
  for (const server of byName.values()) {
    if (server.enabled === false) continue;
    const resolved = {
      name: server.name,
      transport: server.transport ?? "http",
      url: server.url,
      headers: { ...(server.headers ?? {}) },
      enabled: true,
    };

    const hasSecret = !!(server.hasSecret ?? server.secretRef);
    const authType = server.authType ?? (hasSecret ? "bearer" : "none");
    // The partition this server's credential lives in: its own for a shared
    // one, the host's for a personal one.
    const credentialPk = server.scopePk ?? scopePk;

    if (authType === "oauth") {
      const refresh = makeOauthRefresher(c, { scopePk: credentialPk, server });
      const token = await refresh({ force: false }).catch((err) => {
        c.logError("mcp_oauth_resolve_failed", err, { server: server.name });
        return null;
      });
      if (!token) {
        // Not connected, or the refresh token is dead. Drop the server rather
        // than handing the agent a tool that will only ever 401.
        c.log("mcp_server_skipped", { server: server.name, reason: "oauth_unavailable" });
        continue;
      }
      resolved.headers.Authorization = `${token.tokenType || "Bearer"} ${token.accessToken}`;
      // Called (via the main thread) after a 401: forces a refresh and returns
      // the new Authorization header, or null when the user must reconnect.
      reauthorizers.set(server.name, async () => {
        const next = await refresh({ force: true }).catch((err) => {
          c.logError("mcp_oauth_refresh_failed", err, { server: server.name });
          return null;
        });
        if (!next) return null;
        return `${next.tokenType || "Bearer"} ${next.accessToken}`;
      });
    } else if (authType === "bearer" && hasSecret) {
      try {
        // A `SECRET#<name>` row in the same partition as the server itself —
        // the token used to be a Secrets Manager secret per user per server,
        // reached through a `secretRef` path on this item.
        const token = await getMcpSecret(c, credentialPk, server.name);
        if (token) resolved.headers.Authorization = `Bearer ${token}`;
      } catch (err) {
        c.logError("mcp_secret_resolve_failed", err, { hostIdentity, server: server.name });
        continue;
      }
    }

    servers.push(resolved);
  }

  await attachToolCatalogue(c, servers, reauthorizers);
  return { servers, reauthorizers };
}

/**
 * Call `tools/list` once per server at kelabo start and cache the result on the
 * server object.
 *
 * Without this the agent is told only that a server called e.g. "Deepwiki"
 * exists, with no hint of what it can do — so it has no reason to prefer
 * mcp_query over guessing URLs with web_fetch, and in practice never calls the
 * server at all. The catalogue is what makes an MCP server discoverable to the
 * model. One round trip per server per kelabo; failures are non-fatal (the
 * server stays usable, the agent can still call {listTools:true} itself).
 */
async function attachToolCatalogue(c, servers, reauthorizers) {
  if (!servers.length) return;
  const query = createMcpQuery({
    mcp: { servers },
    log: (event, fields) => c.log(event, fields),
    reauthorize: (name) => reauthorizers.get(name)?.() ?? Promise.resolve(null),
  });
  await Promise.all(
    servers.map(async (s) => {
      s.tools = [];
      try {
        const res = await query(s.name, { listTools: true });
        if (res?.tools?.length) {
          s.tools = res.tools.slice(0, MAX_TOOLS_PER_SERVER).map((t) => ({
            name: t.name,
            description: String(t.description ?? "").slice(0, MAX_TOOL_DESC_CHARS),
          }));
        }
        c.log("mcp_tools_discovered", { server: s.name, tools: s.tools.length, error: res?.error ?? null });
      } catch (err) {
        c.logError("mcp_tools_discovery_failed", err, { server: s.name });
      }
    })
  );
}

/**
 * Build a token getter/refresher bound to one (user, server) pair.
 *
 * Serialised per server so a burst of parallel sub-agent tool calls cannot fire
 * several refresh grants at once — with OAuth 2.1 refresh-token rotation, a
 * concurrent second refresh would invalidate the first one's result and knock
 * the user offline.
 */
function makeOauthRefresher(c, { scopePk, server }) {
  let inflight = null;

  async function run({ force }) {
    const current = await getMcpToken(c, scopePk, server.name);
    if (!current?.accessToken) return null;
    if (!force && !isTokenExpired(current)) return current;
    if (!current.refreshToken) {
      // Nothing to refresh with. If it is merely near expiry it may still work;
      // if we were forced here by a 401 it is definitively dead.
      return force ? null : current;
    }

    const meta = server.oauth;
    if (!meta?.tokenEndpoint || !meta?.resource) {
      c.log("mcp_oauth_meta_missing", { server: server.name });
      return force ? null : current;
    }
    const client = await getMcpClient(c, meta.issuer);
    if (!client?.clientId) {
      c.log("mcp_oauth_client_missing", { server: server.name, issuer: meta.issuer });
      return force ? null : current;
    }

    let next;
    try {
      next = await refreshAccessToken({
        tokenEndpoint: meta.tokenEndpoint,
        refreshToken: current.refreshToken,
        clientId: client.clientId,
        clientSecret: client.clientSecret ?? null,
        resource: meta.resource,
        scope: meta.scope ?? undefined,
      });
    } catch (err) {
      if (err.code === "refresh_rejected") {
        // The grant is gone (revoked, or rotation raced). The user has to
        // reconnect from Settings; there is no automated recovery.
        c.log("mcp_oauth_needs_reauth", { server: server.name, issuer: meta.issuer });
        return null;
      }
      throw err;
    }
    // Persist immediately: OAuth 2.1 mandates refresh-token rotation for public
    // clients, so `current.refreshToken` is now spent and losing `next` would
    // permanently orphan the connection.
    await putMcpToken(c, scopePk, server.name, next);
    c.log("mcp_oauth_refreshed", { server: server.name, expiresAt: next.expiresAt ?? null });
    return next;
  }

  return function refresh(opts) {
    if (inflight) return inflight;
    inflight = run(opts).finally(() => {
      inflight = null;
    });
    return inflight;
  };
}
