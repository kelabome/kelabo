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
import { JOURNEY_LEGS_PATH, handleJourneyLegs } from "./journeyLegs.js";
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
  // The journey channel (docs 20 §19) — matched once here and reused below,
  // because it is a pattern rather than a fixed path and CORS must agree with
  // routing about which requests it covers.
  const journeyLegsMatch = JOURNEY_LEGS_PATH.exec(path);
  // Same browser-origin rules as the caption channel: the SPA calls all of these
  // from the portal host with credentials. `/presence/stream` is the first
  // non-kelabo-scoped one (docs 18 §5).
  const corsPaths = captionPaths || path === "/presence/stream" || !!journeyLegsMatch || RTC_PATHS.has(path);
  if (method === "OPTIONS" && corsPaths) {
    setCorsHeaders(c, res, req);
    res.writeHead(204);
    res.end();
    return;
  }
  if (corsPaths) setCorsHeaders(c, res, req);

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

  // The journey channel (docs 20 §19). Session-cookie authenticated, like
  // `/presence/stream` above and unlike everything kelabo-scoped: a journey
  // has no participant cookie and no guests. Every other journey route is
  // served by rest-api; these are here because they are the per-message path.
  if (journeyLegsMatch) {
    return handleJourneyLegs(c, req, res, journeyLegsMatch, url);
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

  // An administrator published new operational configuration
  // (contracts/src/opconfig.js). Re-read it now instead of at the end of the
  // 60-second cache window, and push it at the agent worker.
  //
  // The reload is an **optimisation of the wait, not the mechanism**: this task
  // converges on the published config on its own within the TTL whether or not
  // this call ever arrives, which is why the control plane treats a failure
  // here as a log line rather than a failed publish. What it buys is the case
  // the TTL does not cover well — a quiet kelabo, where `ensureWorker` is not
  // called again until somebody speaks, so a model change would otherwise sit
  // unapplied for as long as the room stayed silent.
  //
  // Same internal JWT as every other `/internal/*` route: minted by the Lambda
  // from the shared signing key with `aud` = internal, and verified here. It
  // carries no body — it is a "look again", not a value — so nothing an
  // administrator typed reaches this task except through the table.
  if (method === "POST" && path === "/internal/config/reload") {
    const key = await c.getCookieKey();
    const payload = verifyInternalJwt(bearerToken(req), key);
    if (!payload) return send(res, 401, { error: "unauthenticated" });
    c.opConfig?.invalidate();
    // Awaited so the response tells the truth about whether the running worker
    // has the new settings, rather than reporting a reload that is still in
    // flight. Failure is reported, not thrown: the config is already
    // invalidated by this point, so the next turn picks it up regardless.
    let agent = { reconfigured: false, reason: "no_dispatcher" };
    try {
      if (c.agentDispatcher?.reconfigure) agent = await c.agentDispatcher.reconfigure();
    } catch (err) {
      c.logError("opconfig_reconfigure_failed", err);
      agent = { reconfigured: false, reason: "error" };
    }
    c.log("internal_request", { action: "config_reload", sub: payload.sub, ...agent });
    return send(res, 200, { ok: true, ...agent });
  }

  // Journey reports (docs 20 §6) — a bounded synthesis over rows already in
  // DynamoDB, run inline (no worker leg, no dev-tunnel): the LLM
  // credential lives here, which is the entire reason this call exists.
  const reportMatch = path.match(/^\/internal\/journeys\/([^/]+)\/report$/);
  if (method === "POST" && reportMatch) {
    const [, journeyId] = reportMatch;
    const key = await c.getCookieKey();
    const payload = verifyInternalJwt(bearerToken(req), key);
    if (!payload) return send(res, 401, { error: "unauthenticated" });
    const body = await readJson(req).catch(() => ({}));
    c.log("internal_request", { journeyId, action: "report", sub: payload.sub, reportId: body?.reportId });
    // `payload.sub` is the identity that asked — carried through so a
    // deployment that meters this call knows who to attribute it to. On
    // master nothing reads it; see `generateJourneyReport`'s own note.
    const result = await generateJourneyReport(c, journeyId, {
      reportId: body?.reportId,
      question: body?.question,
      identity: payload.sub,
    });
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
