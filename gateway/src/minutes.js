import { getMeta, getArchiveObject, putMinutes, updateMeta, markHistoryMinutesSkipped, queryUtt } from "./db.js";
import { persistMinutes } from "./archive.js";
import { parseMinutesJson } from "./agent/serverAgentRunner.js";
import { languageName } from "./agent/language.js";

/**
 * Generate (or regenerate) the minutes of a kelabo on demand.
 *
 * This is the retry. Minutes are written once, automatically, when a kelabo
 * ends, and that attempt can fail for reasons that have nothing to do with the
 * kelabo — an LLM call that came back unusable, a provider timeout, an output
 * budget spent before the answer began. The transcript is still in the table
 * when it does, so the minutes are still recoverable; there was simply no way
 * to ask.
 *
 * It refuses only when asking again cannot help — a kelabo with nothing
 * recorded — because a second call there would burn a model invocation to fail
 * in exactly the same way.
 */
export async function generateMinutes(c, kelaboId) {
  const meta = await getMeta(c, kelaboId);
  if (!meta) return { status: 404, body: { error: "kelabo_not_found" } };

  const runtime = c.tunnel.attachedRuntime(kelaboId);
  // The precondition is a transcript, NOT a live agent context.
  //
  // `agentWorkers` is the wrong thing to ask: `endKelabo` drops the dispatcher,
  // so an ended kelabo never has one, and guarding on it would refuse every
  // retry there is — the only case this endpoint exists for. `summarize` builds
  // its own context, rehydrating the whole transcript out of DynamoDB
  // (`ensureContext`, agent/runner.js), so what actually has to be true is that
  // those rows are still there.
  //
  // Which also means a kelabo whose assistant was switched off can have minutes
  // written after the fact: nobody was listening at the time, but everything
  // said was recorded anyway.
  if (!runtime) {
    const rows = await queryUtt(c, kelaboId, { limit: 1 }).catch(() => []);
    if (!rows.length) {
      c.log("minutes_retry_refused", { kelaboId, reason: "no_transcript" });
      return { status: 409, body: { error: "no_transcript" } };
    }
  }
  // One at a time. Without this, an impatient second click starts a second
  // whole-transcript LLM call whose only possible effect is to overwrite the
  // first one's answer with an equivalent one, at full cost.
  if (c.state.minutesInFlight?.has(kelaboId)) return { status: 202, body: { ok: true, status: "generating" } };
  c.state.minutesInFlight?.add(kelaboId);

  // Answer now, generate after. The whole-transcript call is bounded at seven
  // minutes and routinely takes more than one; the caller is a browser behind
  // an API Gateway that gives up in thirty seconds, so a synchronous reply here
  // would be a gateway timeout on every retry that had any work to do. The
  // record page already polls for minutes it does not have — this hands the
  // result back the same way the automatic path does.
  runMinutes(c, kelaboId, meta, runtime)
    .catch((err) => c.logError("minutes_retry_crashed", err, { kelaboId }))
    .finally(() => c.state.minutesInFlight?.delete(kelaboId));
  return { status: 202, body: { ok: true, status: "generating" } };
}

async function runMinutes(c, kelaboId, meta, runtime) {
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
    minutes = await c.agentDispatcher.summarize(kelaboId).catch((err) => {
      c.logError("minutes_retry_summarize_failed", err, { kelaboId });
      return null;
    });
  }
  const reason = runtime ? "dev_summary_unparseable" : "no_minutes_returned";
  if (!minutes) {
    // A failed retry has to leave the record exactly as honest as a failed
    // first attempt: marked, with the reason, and still retryable. Otherwise
    // the page returns to a spinner and the reader is back where they started.
    c.log("minutes_skipped", { kelaboId, reason, mode: runtime || "server", retry: true });
    await updateMeta(c, kelaboId, { minutesSkipped: true, minutesSkippedReason: reason }).catch((err) =>
      c.logError("minutes_skipped_flag_failed", err, { kelaboId })
    );
    await markHistoryMinutesSkipped(c, kelaboId, reason).catch(() => {});
    return;
  }

  // An ended kelabo already has an archive object, and that object is what the
  // record page reads `minutes` out of. Regenerating without merging into it —
  // which is what this endpoint used to do — left the reader looking at the
  // same empty tab, so the retry appeared to do nothing at all.
  const s3Key = `${c.config.archiveKeyPrefix}/${meta.hostIdentity}/${kelaboId}.json`;
  const archive = await getArchiveObject(c, s3Key);
  if (!archive) {
    // A kelabo that has not been archived yet (minutes asked for mid-kelabo).
    // Nothing to merge into and no history row to correct; the MINUTES row and
    // `hasMinutes` are enough, and `endKelabo` picks them up when it runs.
    try {
      await putMinutes(c, minutes);
      await updateMeta(c, kelaboId, { hasMinutes: true });
    } catch (err) {
      c.logError("minutes_persist_failed", err, { kelaboId });
      return;
    }
    c.log("minutes_generated", { kelaboId, generatedBy: minutes.generatedBy, archived: false });
    return;
  }

  await persistMinutes(c, { kelaboId, minutes, archive, s3Key });
  c.log("minutes_generated", { kelaboId, generatedBy: minutes.generatedBy, archived: true });
}
