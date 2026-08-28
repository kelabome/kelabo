import { getMeta, updateMeta, putMinutes } from "./db.js";
import { parseMinutesJson } from "./agent/serverAgentRunner.js";
import { languageName } from "./agent/language.js";

export async function generateMinutes(c, kelaboId) {
  const meta = await getMeta(c, kelaboId);
  if (!meta) return { status: 404, body: { error: "kelabo_not_found" } };

  const runtime = c.tunnel.attachedRuntime(kelaboId);

  let minutes = null;
  if (runtime) {
    // Same language resolution as server mode (runner.js): the host's, or
    // nothing — the bridge then falls back to the transcript's dominant one.
    const summary = await c.tunnel.requestDevSummary(kelaboId, { language: languageName(meta?.hostLang) || "" });
    // `generatedBy` names the runtime that wrote them, so a reader can tell
    // minutes from a developer's local agent apart from the server agent's — and
    // which agent, now that it may be any of several.
    if (summary) minutes = parseMinutesJson(summary.text, kelaboId, runtime);
  } else {
    minutes = await c.agentDispatcher.summarize(kelaboId);
  }
  if (!minutes) return { status: 504, body: { error: "minutes_unavailable" } };

  try {
    await putMinutes(c, minutes);
    await updateMeta(c, kelaboId, { hasMinutes: true });
  } catch (err) {
    c.logError("minutes_persist_failed", err, { kelaboId });
    return { status: 500, body: { error: "internal_error" } };
  }
  c.log("minutes_generated", { kelaboId, generatedBy: minutes.generatedBy });
  return { status: 200, body: { ok: true, minutes } };
}
