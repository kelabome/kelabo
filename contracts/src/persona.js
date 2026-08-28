// Persona fragments shared by everything that reads a live transcript
// (docs 14, docs 16 §4.2).
//
// Two facts about a kelabo are the same whichever half of the product is
// listening: what the assistant is called, and that the words arrive from
// speech-to-text rather than a keyboard. The Gateway's gate and orchestrator
// (server-agent mode) and the connector's bridge persona (the developer's own
// agent, in their own terminal) all need both.
//
// They live here because the alternative is a third copy. The name was already
// written out twice inside the Gateway, and the failure mode of a drifting copy
// is specific and bad: a name the gate recognises but the bridge does not is an
// assistant that answers when Kelabo runs it and ignores you when your own
// agent does.

/** What participants call the assistant out loud. */
export const ASSISTANT_NAME = "Kelabo";

// Deepgram has no reason to know "Kelabo", so it emits the nearest words it does
// know — which means a participant who addresses the assistant by name is, to
// every model downstream, addressing something called "club" or "global". Any
// component that decides whether it was spoken to has to recognise the mangled
// forms, and has to refuse to fire when the same word is doing ordinary work in
// the sentence.
//
// The list itself is a separate export because the trigger gate's prompt is
// phrased in the third person ("the assistant is called…") and cannot reuse
// ADDRESSED_NOTE verbatim — and its own hand-restated copy of this list had
// already drifted (it lost "collabo" and "ka labo"). One list, two phrasings.
export const NAME_MANGLINGS = `kelabo, kalabo, klabo, clabo, clarbo, clavo, calabo, colabo, collabo, kilabo, cabo, club, global, "kay labo", "ka labo"`;

export const ADDRESSED_NOTE = `BEING ADDRESSED: participants call you "assistant", "the bot", or by name — ${ASSISTANT_NAME}. Speech-to-text almost never spells it correctly. It arrives as: ${NAME_MANGLINGS}, and other near-homophones. Treat any of these as your name WHEN the sentence reads like someone speaking TO an assistant — vocative position, a request or a question ("<name>, what's the …", "ask <name> to …", "<name> can you look up …"). Do NOT treat them as your name when the word is doing ordinary work in the sentence ("the global market", "our book club", "we met in Cabo"). Being addressed is a strong signal that a response is wanted; you still judge whether you can actually help.`;

// Every prompt that reads machine transcription should read it for intent.
export const NOISY_TRANSCRIPT_NOTE = `THE TRANSCRIPT IS MACHINE TRANSCRIPTION, NOT A VERBATIM RECORD: it mishears words, invents plausible-sounding ones, drops or misplaces punctuation, splits one sentence across two lines and sometimes attributes a line to the wrong speaker. Read for INTENT, in context — never literally. Reconstruct garbled terms from the surrounding discussion: a product, ticker, person or number stated earlier in the kelabo is far more likely than a rare word that appears once and fits nothing. When a phrase only makes sense as a mishearing of something the kelabo has been talking about, resolve it to that BEFORE acting on it. If a question is genuinely unintelligible and cannot be recovered from context, do not guess at a lookup — stay silent.`;
