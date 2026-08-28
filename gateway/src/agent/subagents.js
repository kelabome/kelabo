// web_search is ON again, but only where a Brave key exists: runner.js (and
// devAgent.mjs) still grant the capability per deployment — no `braveApiKey`
// in the llm secret means no tool, exactly as before. It was disabled
// project-wide while dev had no key, which left sub-agents guessing URLs for
// web_fetch and burning whole LLM iterations on 403/404s; a keyed deployment
// answers in one search instead. This constant remains the kill switch.
export const WEB_SEARCH_ENABLED = true;

const BRAVE_URL = "https://api.search.brave.com/res/v1/web/search";
const SEARCH_BUDGET_MS = 15_000;
const FETCH_BUDGET_MS = 15_000;
const FETCH_MAX_BYTES = 64_000;
const FETCH_MAX_CHARS = 8_000;
const MCP_BUDGET_MS = 20_000;

// A failed search must not look like an empty one. Returning `[]` on error
// read to the model as "nothing exists on the web about this", which sent it
// guessing URLs for web_fetch — each 403/404 costing a full LLM iteration.
// An `{error}` object (the same shape web_fetch already uses) tells it the
// TOOL failed, which it handles sensibly: retries differently or reports the
// gap instead of concluding the fact does not exist.
export function createWebSearch({ apiKey, log } = {}) {
  if (!apiKey) {
    return async function webSearch() {
      log?.("web_search_unavailable", { reason: "no_api_key" });
      return { error: "search_unavailable: no search API key is configured" };
    };
  }
  return async function webSearch(query) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), SEARCH_BUDGET_MS);
    try {
      const url = `${BRAVE_URL}?q=${encodeURIComponent(query)}&count=5`;
      const res = await fetch(url, {
        headers: { Accept: "application/json", "X-Subscription-Token": apiKey },
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`brave ${res.status}`);
      const data = await res.json();
      return (data.web?.results ?? []).slice(0, 5).map((r) => ({
        title: r.title ?? "",
        url: r.url ?? "",
        snippet: r.description ?? "",
      }));
    } catch (err) {
      log?.("web_search_failed", { error: err.message });
      return { error: `search_failed: ${err.message}` };
    } finally {
      clearTimeout(timer);
    }
  };
}

export function createWebFetch({ log } = {}) {
  return async function webFetch(url) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_BUDGET_MS);
    try {
      let parsed;
      try {
        parsed = new URL(String(url ?? ""));
      } catch {
        return { error: "invalid_url" };
      }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return { error: "invalid_url_scheme" };
      const res = await fetch(parsed, {
        headers: { Accept: "text/html,application/json,text/plain,*/*", "User-Agent": "kelabo-agent/1.0" },
        redirect: "follow",
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`fetch ${res.status}`);
      const contentType = res.headers.get("content-type") ?? "";
      const reader = res.body?.getReader();
      if (!reader) return { error: "empty_body" };
      const chunks = [];
      let received = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.length;
        chunks.push(value);
        if (received >= FETCH_MAX_BYTES) {
          ctrl.abort();
          break;
        }
      }
      const raw = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8");
      const text = contentType.includes("html") ? htmlToText(raw) : raw;
      return { url: parsed.toString(), contentType, text: text.slice(0, FETCH_MAX_CHARS) };
    } catch (err) {
      log?.("web_fetch_failed", { error: err.message });
      return { error: err.message };
    } finally {
      clearTimeout(timer);
    }
  };
}

function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
}

/**
 * @param {object} opts
 * @param {object} opts.mcp   - { servers } as resolved by loadEffectiveMcp
 * @param {(name: string) => Promise<string|null>} [opts.reauthorize] - forces an
 *   OAuth refresh for one server and resolves to a new Authorization header (or
 *   null if the user must reconnect). In the gateway this hops to the main
 *   thread, because the refresher closures cannot cross the worker boundary.
 */
export function createMcpQuery({ mcp, log, reauthorize } = {}) {
  const servers = new Map((mcp?.servers ?? []).map((s) => [s.name, s]));
  const sessions = new Map();

  async function rpc(server, method, params, session) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), MCP_BUDGET_MS);
    try {
      const headers = {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(server.headers ?? {}),
      };
      if (session?.id) headers["mcp-session-id"] = session.id;
      const res = await fetch(server.url, {
        method: "POST",
        headers,
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: ctrl.signal,
      });
      const sessionId = res.headers.get("mcp-session-id");
      if (sessionId && session) session.id = sessionId;
      if (!res.ok) {
        const e = new Error(`mcp ${server.name} ${res.status}`);
        // Surfaced so the caller can tell "token expired" (recoverable, retry
        // once after a refresh) from any other failure (report and move on).
        e.status = res.status;
        e.wwwAuthenticate = res.headers.get("www-authenticate") ?? null;
        throw e;
      }
      const text = await res.text();
      const dataLine = text.startsWith("event:")
        ? text.split("\n").find((l) => l.startsWith("data:"))?.slice(5).trim()
        : text;
      const data = JSON.parse(dataLine || "{}");
      if (data.error) throw new Error(`mcp ${server.name} rpc error ${data.error.code}: ${data.error.message}`);
      return data.result;
    } finally {
      clearTimeout(timer);
    }
  }

  async function ensureSession(server) {
    let session = sessions.get(server.name);
    if (session) return session;
    session = { id: null };
    try {
      await rpc(server, "initialize", {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "kelabo-agent", version: "1.0" },
      }, session);
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), MCP_BUDGET_MS);
      try {
        const headers = { "content-type": "application/json", ...(server.headers ?? {}) };
        if (session.id) headers["mcp-session-id"] = session.id;
        await fetch(server.url, {
          method: "POST",
          headers,
          body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
          signal: ctrl.signal,
        });
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      log?.("mcp_initialize_failed", { server: server.name, error: err.message });
    }
    sessions.set(server.name, session);
    return session;
  }

  async function call(server, request) {
    const session = await ensureSession(server);
    if (request?.listTools) {
      const result = await rpc(server, "tools/list", {}, session);
      return { tools: (result?.tools ?? []).map((t) => ({ name: t.name, description: t.description })) };
    }
    const result = await rpc(server, "tools/call", {
      name: request?.tool,
      arguments: request?.arguments ?? {},
    }, session);
    const content = (result?.content ?? [])
      .map((b) => (b.type === "text" ? b.text : JSON.stringify(b)))
      .join("\n");
    return { content: content.slice(0, 8000) };
  }

  return async function mcpQuery(serverName, request) {
    const server = servers.get(serverName);
    if (!server) return { error: `unknown_mcp_server:${serverName}` };
    if (server.transport !== "http" || !server.url) return { error: `unsupported_transport:${server.transport}` };
    try {
      return await call(server, request);
    } catch (err) {
      // MCP spec: an invalid or expired access token MUST come back as 401.
      // Refresh once and retry; anything else is reported as-is.
      if (err.status === 401 && reauthorize) {
        const authorization = await reauthorize(serverName).catch(() => null);
        if (authorization) {
          server.headers = { ...(server.headers ?? {}), Authorization: authorization };
          // The old mcp-session-id was established under the dead token; force a
          // fresh initialize so the server does not reject the resumed session.
          sessions.delete(serverName);
          log?.("mcp_reauthorized", { server: serverName });
          try {
            return await call(server, request);
          } catch (retryErr) {
            log?.("mcp_query_failed", { server: serverName, error: retryErr.message, afterReauth: true });
            return { error: retryErr.message };
          }
        }
        log?.("mcp_needs_reauth", { server: serverName });
        return { error: `mcp_unauthorized:${serverName} — reconnect this server in Settings` };
      }
      log?.("mcp_query_failed", { server: serverName, error: err.message });
      return { error: err.message };
    }
  };
}
