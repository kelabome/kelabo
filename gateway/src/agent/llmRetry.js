// Retry policy for provider calls — pure, so test/agent.mjs can pin it.
//
// Why this exists: a transient 429/500 at the trigger gate became verdict NONE
// with reason `classifier_error` — a rate-limited moment silently swallowed a
// real spoken question, with nothing on the board to show the room was ever
// heard. The same failure one layer up lost a whole orchestration turn. One
// retry with a short delay converts almost all of those into a late answer
// instead of a missing one.
//
// What is deliberately NOT retried:
//   - timeouts (`TimeoutError`/`AbortError` from llm.js's per-call bound): the
//     call already consumed its whole budget; retrying doubles the hold on a
//     kelabo whose queue is strictly one turn at a time.
//   - 4xx other than 429: the request itself is wrong (a malformed thread, a
//     bad key) and will be wrong again.

/** True for errors worth one more attempt: provider 429/5xx and network-level
 *  failures. llm.js throws `Error("<provider> <status>: <body>")`, so the
 *  status is read from that known position, never from the body text. */
export function isTransientLlmError(err) {
  if (!err) return false;
  const name = String(err.name ?? "");
  // The per-call timeout (AbortSignal.timeout) — not transient by policy.
  if (name === "TimeoutError" || name === "AbortError") return false;
  const msg = String(err.message ?? "");
  const status = /^(?:anthropic|openai-compatible) (\d{3})\b/.exec(msg)?.[1];
  if (status) return status === "429" || status.startsWith("5");
  // No parseable status: a network-level failure (fetch failed, ECONNRESET,
  // socket hang up) — the request may never have arrived; safe to resend.
  return true;
}

/**
 * Run `fn` and retry it once (by default) on a transient failure.
 * `log`/`event`/`fields` name the retry in the structured log so a provider
 * having a bad minute is visible rather than inferred.
 */
export async function withLlmRetry(fn, { retries = 1, delayMs = 1000, log, event = "llm_retry", fields = {} } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt >= retries || !isTransientLlmError(err)) throw err;
      log?.(event, { ...fields, attempt: attempt + 1, error: err.message });
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastErr;
}
