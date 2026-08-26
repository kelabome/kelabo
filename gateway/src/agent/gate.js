import { tagTranscript } from "@kelabo/contracts";
import { ASSISTANT_NAME } from "./persona.js";

const SENSITIVITY_THRESHOLD = { low: 0.8, medium: 0.5, high: 0.2 };

// Pure backchannel: an utterance that is only acknowledgement can never be
// the "LAST line" an assistant should act on, so it never needs a model to
// say NONE. This is the cheapest latency/cost lever the gate has — meetings
// are full of these, and each one otherwise pays a full classifier call.
// Deliberately a closed list of exact matches (after stripping punctuation),
// not a length heuristic: "what is it?" is nine letters and a real question.
const BACKCHANNEL = new Set([
  "yeah", "yep", "yes", "no", "nope", "ok", "okay", "right", "sure", "cool",
  // Hyphens normalize to spaces before lookup, so the hyphenated spellings
  // STT produces ("mm-hmm", "uh-huh") land on the space-joined entries.
  "mm", "hmm", "mhm", "mm hmm", "uh huh", "huh", "oh", "ah", "wow", "nice",
  "thanks", "thank you", "got it", "gotcha", "i see", "makes sense", "sounds good",
  "exactly", "totally", "true", "fair", "fair enough", "alright", "all right",
  "good", "great", "perfect", "awesome", "hello", "hi", "hey", "bye", "goodbye",
  "see you", "one sec", "one second", "hang on", "hold on",
]);

/** True when the caption is pure acknowledgement — nothing to classify. */
export function isBackchannel(text) {
  const t = String(text ?? "")
    .toLowerCase()
    .replace(/[.,!?…'’-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return t.length > 0 && BACKCHANNEL.has(t);
}
const GATE_SYSTEM = `You are a TRIGGER GATE for a kelabo assistant. Given a rolling kelabo transcript, decide whether an expert assistant should proactively help with the LAST line.

Verdicts:
- INFO_GAP: the kelabo hit a factual unknown, an external reference, or a "does anyone know / what is / how does X work" moment the assistant could resolve.
- CODE_QUESTION: a technical/code question the assistant could answer (APIs, errors, libraries, design tradeoffs).
- NONE: small talk, status updates, rhetorical questions, opinions, or anything the assistant would add noise to.

THE TRANSCRIPT IS MACHINE TRANSCRIPTION, NOT A VERBATIM RECORD: words are misheard, punctuation is dropped, one sentence is split across lines and speakers are sometimes confused. Judge INTENT from context, not the literal string. A line that reads as nonsense is usually a mishearing of something the kelabo has already been discussing — resolve it against that context before deciding. A question does not need a question mark to be a question.

BEING ADDRESSED BY NAME: the assistant is called "${ASSISTANT_NAME}", which speech-to-text renders as kelabo, kalabo, klabo, clabo, clarbo, clavo, calabo, colabo, kilabo, cabo, club, global, "kay labo" and similar. When one of these appears in vocative position alongside a request or question ("<name>, what's …", "ask <name> to …", "<name> can you check …"), the assistant IS being addressed: that is a strong INFO_GAP/CODE_QUESTION signal even if the question is vague — raise confidence rather than lowering it. But when the same word is doing ordinary work in the sentence ("the global market", "our book club", "we met in Cabo"), it is not a trigger. "Assistant", "the bot" and "hey bot" count the same way.

Reply with ONLY a JSON object: {"verdict":"INFO_GAP"|"CODE_QUESTION"|"NONE","confidence":0..1,"reason":"short"}. Be conservative: when in doubt, NONE — except when the assistant was directly addressed, where the participants have asked for an answer.

When the verdict is not NONE, also include "query": a short standalone lookup title for the assistant, resolving references from context so it makes sense on its own (e.g. "latest Windows version 2026", not "the newest one" or a repeat of the last line). Correct obvious mistranscriptions in it — write the term the speaker meant, spelled properly. Write "query" in the SAME language the participants used (a Chinese question → a Chinese query); do not translate it to English.`;

export class TriggerGate {
  constructor({ llm, smallModel, knobs, log, debug }) {
    this.llm = llm;
    this.smallModel = smallModel;
    this.knobs = knobs;
    this.log = log;
    this.debug = debug;
    // Per KELABO, not per gate. One TriggerGate serves every kelabo in the
    // task, so shared counters meant one room's question put every other room
    // on a 45-second cooldown.
    this.kelabos = new Map();
  }

  state(kelaboId) {
    let st = this.kelabos.get(kelaboId);
    if (!st) {
      st = { lastFireAt: 0, fireTimes: [], classifying: false };
      this.kelabos.set(kelaboId, st);
    }
    return st;
  }

  forget(kelaboId) {
    this.kelabos.delete(kelaboId);
  }

  async decide(kelaboId, caption, transcript) {
    const now = Date.now();
    const at = caption.at ?? now;
    const cooldownMs = (this.knobs.cooldownSeconds ?? 45) * 1000;
    const st = this.state(kelaboId);

    if (now - st.lastFireAt < cooldownMs) {
      return this.record(kelaboId, at, "NONE", "cooldown_active");
    }
    // Before any counter or model: a pure acknowledgement line has no
    // question in it by construction. Skipping the call matters twice over —
    // the classifier is often the single largest line item, and on a
    // reasoning model each skipped call is ~10 seconds the room does not
    // spend wondering whether the assistant is thinking.
    if (isBackchannel(caption.text)) {
      return this.record(kelaboId, at, "NONE", "backchannel");
    }
    // Captions arrive faster than a classification returns. Checking the
    // cooldown, awaiting the model, and only then recording the fire is a
    // check-then-act race: two captions half a second apart both passed the
    // check and both fired, 45-second cooldown and all. Two turns then ran at
    // once on one kelabo's thread and corrupted it.
    if (st.classifying) {
      return this.record(kelaboId, at, "NONE", "classifier_busy");
    }
    st.fireTimes = st.fireTimes.filter((t) => now - t < 60_000);
    if (st.fireTimes.length >= (this.knobs.maxContributionsPerMinute ?? 3)) {
      return this.record(kelaboId, at, "NONE", "rate_cap_reached");
    }
    st.classifying = true;

    // The whole transcript, oldest → newest. No per-request marker lines: the
    // system prompt is static and the transcript only ever changes at the
    // tail, so provider-side prompt caching keeps hitting the shared prefix.
    const user = transcript.map((u) => tagTranscript(u.speaker, u.text)).join("\n");

    this.debug?.(kelaboId, {
      kind: "gate",
      phase: "request",
      model: this.smallModel,
      system: GATE_SYSTEM,
      // Clip for display only — the full transcript grows unbounded and the
      // debug stream shouldn't carry it verbatim every turn.
      messages: [{ role: "user", content: user.length > 4000 ? `…${user.slice(-4000)}` : user }],
    });

    let verdict = "NONE";
    let confidence = 0;
    let reason = "classifier_error";
    let query = "";
    let raw = "";
    let usage = null;
    try {
      // completeRaw so the gate's own tokens are counted — it runs on every
      // closed caption, so it is often the largest single line item.
      const res = await this.llm.completeRaw({
        model: this.smallModel,
        system: GATE_SYSTEM,
        messages: [{ role: "user", content: user }],
        maxTokens: 1024,
        temperature: 0,
        // JSON mode: the reply is one JSON object and nothing else (the
        // prompt already says so — providers require the word to appear).
        // Beyond parse reliability, this reins in reasoning-model
        // narration, which is where the gate's seconds actually go.
        responseFormat: "json",
      });
      raw = res.text;
      usage = res.usage ?? null;
      const parsed = JSON.parse(raw.replace(/```json|```/g, "").trim().match(/\{[\s\S]*\}/)?.[0] ?? "{}");
      verdict = ["INFO_GAP", "CODE_QUESTION", "NONE"].includes(parsed.verdict) ? parsed.verdict : "NONE";
      confidence = typeof parsed.confidence === "number" ? parsed.confidence : 0;
      reason = String(parsed.reason ?? "").slice(0, 200);
      query = String(parsed.query ?? "").trim().slice(0, 140);
    } catch (err) {
      reason = `classifier_error: ${err.message}`;
    } finally {
      st.classifying = false;
    }

    this.debug?.(kelaboId, {
      kind: "gate",
      phase: "response",
      model: this.smallModel,
      raw,
      verdict,
      confidence,
      reason,
      query,
      usage,
    });

    const threshold = SENSITIVITY_THRESHOLD[this.knobs.sensitivity] ?? SENSITIVITY_THRESHOLD.medium;
    if (verdict !== "NONE" && confidence < threshold) {
      return this.record(kelaboId, at, "NONE", `below_threshold(${confidence}<${threshold}): ${reason}`);
    }
    // Re-check against the clock we are firing on, not the one we started on:
    // a turn may have fired while this classification was in flight.
    const settledAt = Date.now();
    if (verdict !== "NONE" && settledAt - st.lastFireAt < cooldownMs) {
      return this.record(kelaboId, at, "NONE", "cooldown_active_on_settle");
    }
    if (verdict !== "NONE") {
      st.lastFireAt = settledAt;
      st.fireTimes.push(settledAt);
    }
    return this.record(kelaboId, at, verdict, reason, verdict !== "NONE" ? query : "");
  }

  record(kelaboId, at, verdict, reason, query = "") {
    this.log("gate_decision", { kelaboId, at, verdict, reason, ...(query ? { query } : {}) });
    return { verdict, reason, query };
  }
}
