// Pure scheduling predicate for the agent run queue. Lives outside worker.js
// because that module grabs `parentPort` at import time and cannot be loaded
// by a plain node test — same reason composer/transcriptStore are pure.
//
// `maxConcurrent <= 0` means unlimited: runs are I/O-bound LLM calls, provider
// concurrency limits are generous, and the real limiter is the one-turn-per-
// kelabo rule (a MainAgent owns ONE persistent thread; two turns on one kelabo
// interleave their writes and produce a malformed thread). A positive value is
// an opt-in valve for deployments on a low-quota provider key.

/** @param {number} activeRuns @param {number} maxConcurrent @returns {boolean} */
export function hasCapacity(activeRuns, maxConcurrent) {
  return maxConcurrent <= 0 || activeRuns < maxConcurrent;
}
