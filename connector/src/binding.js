// The kelabo binding: what the bridge is attached to, and how transcript gets
// from the tunnel into the agent (docs 16).
//
// Deliberately thin. All the judgement lives in two pure modules — `envelope.js`
// decides what the agent sees, `transcriptQueue.js` decides when — and the
// runtime-specific half lives behind `adapter.inject`. What is left here is
// wiring, which is the part that cannot be unit-tested without a live kelabo
// and therefore should contain as little as possible.
import { briefingEnvelope, noticeEnvelope, transcriptEnvelope } from "./envelope.js";
import { createTranscriptQueue } from "./transcriptQueue.js";

export function createBinding({ tunnel, adapter, maxBacklog, log = () => {}, now = Date.now, onBatch = () => {} }) {
  const queue = createTranscriptQueue({ maxBacklog });
  let kelabo = null; // { kelaboId, title, status }

  tunnel.on("briefing", async (frame) => {
    kelabo = { kelaboId: frame.kelaboId, title: frame.title, status: frame.status };
    queue.reset();
    try {
      // Silent: loading context must not cost a turn, and on a scheduled kelabo
      // there is nothing to respond to yet.
      await adapter.inject(briefingEnvelope(frame, now()), {
        silent: true,
        kelaboId: frame.kelaboId,
      });
    } catch (err) {
      log("briefing_inject_failed", { error: err.message });
    }
  });

  tunnel.on("transcript", (frame) => {
    queue.push({
      messageId: frame.messageId,
      seq: frame.seq,
      speaker: frame.speaker,
      text: frame.text,
      at: frame.at,
      human: frame.human,
    });
    drain();
  });

  tunnel.on("kelabo", async (frame) => {
    if (frame.event === "ended") {
      await inject(noticeEnvelope(frame.kelaboId, "The kelabo has ended."), {
        silent: true,
        kelaboId: frame.kelaboId,
      });
      kelabo = null;
      queue.reset();
    } else if (frame.event === "started") {
      // Informational only. Attending is a separate, deliberate `kelabo_join`:
      // having prepared for a kelabo is not consent to sit in it (docs 16 §5).
      await inject(
        noticeEnvelope(
          frame.kelaboId,
          "The kelabo you prepared for has started. Call kelabo_join again to attend it, or do nothing to stay out."
        ),
        { silent: true, kelaboId: frame.kelaboId }
      );
    }
  });

  // One in-flight minutes request. Runtime-independent on purpose: minutes come
  // back through the `kelabo_minutes` tool on every runtime, so there is a single
  // path rather than one per adapter. It also avoids blocking on the agent's HTTP
  // reply, which deadlocks if the agent is already mid-turn.
  let awaitingMinutes = null;

  tunnel.on("request", async (frame) => {
    if (frame.kind === "summary") return onSummaryRequest(frame);
    // Archive is not answered. The Gateway's own persisted transcript and board
    // are complete, and reconstructing them from the agent's message history is
    // what used to overwrite the real kelabo title with "Kelabo". Staying
    // silent makes the Gateway use its own copy.
  });

  const MINUTES_WAIT_MS = 55_000;

  async function onSummaryRequest(frame) {
    if (awaitingMinutes) clearTimeout(awaitingMinutes.timer);
    const timer = setTimeout(() => {
      // No minutes is better than holding the kelabo's end open. The Gateway
      // treats an empty answer as "none available".
      log("minutes_timeout", { kelaboId: frame.kelaboId });
      finishMinutes("");
    }, MINUTES_WAIT_MS);
    timer.unref?.();
    awaitingMinutes = { requestId: frame.requestId, kelaboId: frame.kelaboId, timer };

    // The Gateway resolves the minutes language (the host's, when known) and
    // sends it on the request frame — the same rule server-mode minutes
    // follow. Without the sentence, the language of a dev-mode record was
    // whatever the developer's own model happened to pick.
    const languageRule = frame.language
      ? `Write every string value in ${frame.language} — the host's language — translating what was said as you write; proper nouns, code and figures keep their original form.`
      : "Write in the dominant language of the transcript.";
    // A real turn, not a silent one: producing the minutes is the work.
    await inject(
      noticeEnvelope(
        frame.kelaboId,
        `The kelabo has ended. Write the minutes now and pass them to kelabo_minutes as a single JSON object. ${languageRule} Do not call kelabo_post.`
      ),
      { silent: false, kelaboId: frame.kelaboId }
    );
  }

  /** Called by the `kelabo_minutes` tool. Returns false when nothing asked for
   *  minutes, so the agent is told rather than silently ignored. */
  function submitMinutes(text) {
    if (!awaitingMinutes) return false;
    finishMinutes(text);
    return true;
  }

  function finishMinutes(text) {
    const req = awaitingMinutes;
    if (!req) return;
    clearTimeout(req.timer);
    awaitingMinutes = null;
    tunnel.send({ type: "summary", requestId: req.requestId, kelaboId: req.kelaboId, text: text || "" });
  }

  let draining = false;
  async function drain() {
    if (draining) return;
    draining = true;
    try {
      while (adapter.ready()) {
        const batch = queue.take();
        if (!batch) break;
        const kelaboId = kelabo?.kelaboId || tunnel.attachedKelabo();
        try {
          await inject(
            transcriptEnvelope({
              kelaboId,
              messages: batch.messages,
              dropped: batch.dropped,
              now: now(),
            }),
            {
              silent: false,
              kelaboId,
              // Who is in this batch, deduplicated and in order of first
              // appearance. On Claude Code it becomes a `speakers` attribute on
              // the <channel> tag, which is what lets the model see who is
              // talking without re-reading the envelope; every other runtime
              // ignores it.
              speakers: [...new Set(batch.messages.map((m) => m.speaker).filter(Boolean))],
            }
          );
        } finally {
          // Unconditional: a batch that is never released wedges the queue for
          // the rest of the kelabo.
          queue.done();
        }
        // The pulse a live kelabo always has. Board cards the agent opened and
        // walked away from are swept here rather than from a timer (cards.js).
        try {
          onBatch();
        } catch (err) {
          log("on_batch_failed", { error: err.message });
        }
      }
    } finally {
      draining = false;
    }
  }

  async function inject(text, opts) {
    try {
      await adapter.inject(text, opts);
    } catch (err) {
      log("inject_failed", { error: err.message });
    }
  }

  return {
    /** The adapter calls this when it becomes able to take a batch again — on
     *  opencode, when the session goes idle. */
    notifyReady: drain,
    submitMinutes,
    awaitingMinutes: () => !!awaitingMinutes,
    current: () => kelabo,
    pending: () => queue.size(),
    reset: () => {
      kelabo = null;
      queue.reset();
    },
  };
}
