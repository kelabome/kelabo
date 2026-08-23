/**
 * The label an utterance is attributed by — in the room, in the persisted
 * record, and in the prompt handed to the language model.
 *
 * **One function, because it is one concept.** The label is written into the
 * persisted utterance and is the only speaker information the agent ever
 * receives (`tagTranscript` in `llmcon.js`). A second derivation for "what the
 * model sees" would mean the room and the model disagreeing about who spoke,
 * and the transcript rule (docs 13) is that speech is attributed once.
 *
 * **It never yields a full email address.** The transcript leaves the
 * deployment's own infrastructure twice: to whichever language model is
 * configured, and — when a participant attaches their own coding agent
 * (docs 16) — to that participant's machine and their model provider. Neither
 * destination is chosen by the person who spoke, and neither is a place a
 * colleague's address should arrive merely because they were in the room. The
 * local part is already what every other display name in the product uses
 * (`rest-api/src/sessions.js`, `rest-api/src/otp.js`), so this is the existing
 * convention applied at the one boundary that had been missing it, not a new
 * kind of name.
 *
 * Callers previously fell back to `participant.identity` raw, which is the
 * verified email address. Through the SPA that fallback was unreachable — it
 * sends the local part already (`spa/src/auth.jsx`) — so this closes a latent
 * path rather than a routine one. It is still the server's job: what reaches a
 * third party must not depend on a client choosing to be careful.
 */

/** Longest label carried into a record and a prompt. Matches the
 *  `displayName` cap in `captionPostSchema`, so a client cannot lengthen a
 *  label by omitting one and letting the identity be used instead. */
const MAX_LABEL = 64;

/** A bare address-like token: no whitespace, and an `@` in it. Deliberately not
 *  an email validator — the question is only "would returning this ship an
 *  address", and `a@b@c` and `alice@acme.example` answer it the same way.
 *  A label like `Alex (alex@acme.example)` has whitespace and is left alone:
 *  someone who types that as their public name has chosen it. */
const looksLikeAddress = (s) => !/\s/.test(s) && s.includes("@");
const localPart = (s) => s.slice(0, s.indexOf("@"));

/** Guest identities are `guest:<uuid>` (`rest-api/src/otp.js`). The uuid means
 *  nothing to a reader, so it is not a name — and it is not worth carrying into
 *  a prompt either. */
const GUEST_IDENTITY = /^guest:/i;

/**
 * Derive the one speaker label.
 *
 * @param {string|null|undefined} displayName What the speaker is called — the
 *   client's `displayName`, or a host's rename of a diarization label.
 * @param {string|null|undefined} identity The authenticated identity, used only
 *   when there is no name to use.
 * @returns {string} A non-empty label that is never a bare email address.
 */
export function speakerLabel(displayName, identity) {
  const given = String(displayName ?? "").trim();
  if (given) {
    const label = looksLikeAddress(given) ? localPart(given) : given;
    if (label) return label.slice(0, MAX_LABEL);
  }

  const id = String(identity ?? "").trim();
  // Nothing to attribute to. "Speaker" rather than an empty string: the label
  // is required downstream, and a blank one renders as an unattributed bubble.
  if (!id) return "Speaker";
  if (GUEST_IDENTITY.test(id)) return "Guest";
  if (looksLikeAddress(id)) return (localPart(id) || "Speaker").slice(0, MAX_LABEL);
  return id.slice(0, MAX_LABEL);
}
