import http from "node:http";
import { pathToFileURL } from "node:url";
import { COOKIE_PARTICIPANT, COOKIE_SESSION } from "@kelabo/contracts";
import { createContainer } from "./container.js";
import { parseCookies, verifyParticipantCookie, verifySessionCookie, verifyInternalJwt, bearerToken } from "./cookies.js";
import { createSseHub, setCorsHeaders } from "./sseHub.js";
import { createPresence } from "./presence.js";
import { createTunnel } from "./tunnel.js";
import { createAgentDispatcher } from "./agent/runner.js";
import { createMessageBuffer } from "./agent/messageBuffer.js";
import { createRtcRoom } from "./rtc/room.js";
import { RTC_PATHS, handleRtc } from "./rtc/routes.js";
import { handleCaptionPost, handleCaptionRename, handleCaptionHistory, transcriptEntitled, readJson, send } from "./caption.js";
import { endKelabo, cancelKelabo, rescheduleKelabo } from "./archive.js";
import { generateMinutes } from "./minutes.js";
import { generateJourneyReport } from "./journeys.js";
import { log, logError } from "./log.js";

export function createGateway(c) {
  c.sseHub = createSseHub(c);
  c.tunnel = createTunnel(c);
  c.agentDispatcher = createAgentDispatcher(c);
  c.messageBuffer = createMessageBuffer(c);
  c.rtcRoom = createRtcRoom(c);
  c.presence = createPresence(c);

  const server = http.createServer((req, res) => {
    route(c, req, res).catch((err) => {
      logError("request_failed", err, { method: req.method, url: req.url });
      if (!res.headersSent) send(res, 500, { error: "internal_error" });
    });
  });

  server.on("upgrade", (req, socket, head) => {
    const { pathname } = new URL(req.url, "http://localhost");
    if (pathname === "/rig") {
      c.tunnel.handleUpgrade(req, socket, head);
    } else {
      socket.destroy();
    }
  });

  return server;
}

async function route(c, req, res) {
  const url = new URL(req.url, "http://localhost");
  const path = url.pathname;
  const method = req.method;

  const captionPaths = path === "/caption" || path === "/caption/replies" || path === "/caption/rename" || path === "/caption/history";
  // Same browser-origin rules as the caption channel: the SPA calls all of these
  // from the portal host with credentials. `/presence/stream` is the first
  // non-kelabo-scoped one (docs 18 §5).
  const corsPaths = captionPaths || path === "/presence/stream" || RTC_PATHS.has(path);
  if (method === "OPTIONS" && corsPaths) {
    setCorsHeaders(c, res);
    res.writeHead(204);
    res.end();
    return;
  }
  if (corsPaths) setCorsHeaders(c, res);

  if (method === "GET" && path === "/health") {
    return send(res, 200, { ok: true, service: "kelabo-gateway" });
  }

  if (method === "POST" && path === "/caption") {
    return handleCaptionPost(c, req, res);
  }

  if (method === "POST" && path === "/caption/rename") {
    return handleCaptionRename(c, req, res);
  }

  if (method === "GET" && path === "/caption/replies") {
    const kelaboId = url.searchParams.get("kelaboId") ?? "";
    const cookies = parseCookies(req);
    const key = await c.getCookieKey();
    const participant = verifyParticipantCookie(cookies[COOKIE_PARTICIPANT], key);
    if (!participant) return send(res, 401, { error: "unauthenticated" });
    if (!kelaboId || kelaboId !== participant.kelaboId) return send(res, 403, { error: "forbidden" });
    // The participant identity travels with the subscription so mesh signalling
    // can address one peer, and so a dropped stream removes them from the call.
    // Transcript entitlement is decided here, where the cookie is verified, and
    // enforced inside the hub's fan-out.
    return c.sseHub.subscribe(kelaboId, res, participant.identity, {
      transcriptEntitled: transcriptEntitled(c, participant),
    });
  }

  // Persisted messages for a participant (re)entering a live kelabo, filtered
  // by the same entitlement the fan-out enforces.
  if (method === "GET" && path === "/caption/history") {
    return handleCaptionHistory(c, req, res, url);
  }

  // Contact presence (docs 18 §5). Authenticated by the browser SESSION cookie,
  // not the participant cookie: it is not about any one kelabo. One stream per
  // open tab; the person is online while any stream is held.
  if (method === "GET" && path === "/presence/stream") {
    const cookies = parseCookies(req);
    const key = await c.getCookieKey();
    const session = verifySessionCookie(cookies[COOKIE_SESSION], key);
    if (!session) return send(res, 401, { error: "unauthenticated" });
    return c.presence.subscribe(res, { identity: session.identity, tenantId: session.tenantId });
  }

  if (RTC_PATHS.has(path)) {
    return handleRtc(c, req, res, path, method);
  }

  // Ring (docs 18 §6): deliver "someone is calling you into <kelabo>" over the
  // targets' presence streams. REST authorizes and resolves targets; the Gateway
  // delivers to whoever is online and reports who was not. Internal-JWT only.
  const ringMatch = path.match(/^\/internal\/kelabos\/([^/]+)\/ring(\/cancel|\/answer)?$/);
  if (method === "POST" && ringMatch) {
    const [, kelaboId, sub] = ringMatch;
    const key = await c.getCookieKey();
    const payload = verifyInternalJwt(bearerToken(req), key);
    if (!payload) return send(res, 401, { error: "unauthenticated" });
    const body = await readJson(req).catch(() => ({}));
    if (sub === "/cancel") {
      c.presence.ringCancel(kelaboId, "cancelled");
      return send(res, 200, { ok: true });
    }
    if (sub === "/answer") {
      c.presence.ringAnswer(kelaboId, { from: payload.sub, response: body.response });
      return send(res, 200, { ok: true });
    }
    const { rung, offline } = c.presence.ring(kelaboId, {
      from: payload.sub,
      fromName: body.fromName,
      fromAvatar: Number(body.fromAvatar) || 0,
      title: body.title,
      targets: Array.isArray(body.targets) ? body.targets : [],
    });
    return send(res, 200, { rung, offline });
  }

  const internalMatch = path.match(/^\/internal\/kelabos\/([^/]+)\/(end|minutes|cancel|reschedule)$/);
  if (method === "POST" && internalMatch) {
    const [, kelaboId, action] = internalMatch;
    const key = await c.getCookieKey();
    const payload = verifyInternalJwt(bearerToken(req), key);
    if (!payload) return send(res, 401, { error: "unauthenticated" });
    const body = await readJson(req).catch(() => ({}));
    c.log("internal_request", { kelaboId, action, sub: payload.sub });
    const handlers = {
      end: endKelabo,
      minutes: generateMinutes,
      cancel: cancelKelabo,
      reschedule: rescheduleKelabo,
    };
    // `retry` reaches `endKelabo` only: the control plane sets it when a
    // previous end reached DynamoDB but never reached here, so the kelabo is
    // already "ended" and has no record. Without it the retry would 409 on the
    // status it set itself.
    const result = await handlers[action](c, kelaboId, { retry: body?.retry === true });
    return send(res, result.status, result.body);
  }

  // Journey reports (docs 20 §6) — a bounded synthesis over rows already in
  // DynamoDB, run inline (no worker thread, no dev-tunnel): the LLM
  // credential lives here, which is the entire reason this call exists.
  const reportMatch = path.match(/^\/internal\/journeys\/([^/]+)\/report$/);
  if (method === "POST" && reportMatch) {
    const [, journeyId] = reportMatch;
    const key = await c.getCookieKey();
    const payload = verifyInternalJwt(bearerToken(req), key);
    if (!payload) return send(res, 401, { error: "unauthenticated" });
    const body = await readJson(req).catch(() => ({}));
    c.log("internal_request", { journeyId, action: "report", sub: payload.sub, reportId: body?.reportId });
    const result = await generateJourneyReport(c, journeyId, { reportId: body?.reportId, question: body?.question });
    return send(res, result.status, result.body);
  }

  return send(res, 404, { error: "not_found" });
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const port = Number(process.env.PORT || 8080);
  const container = await createContainer();
  const server = createGateway(container);
  server.listen(port, () => log("gateway_listening", { port }));
  const shutdown = async (signal) => {
    log("gateway_shutdown", { signal });
    server.close();
    await container.shutdown();
    process.exit(0);
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}
