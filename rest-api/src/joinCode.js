// Join codes: a two-minute, speakable stand-in for a kelabo URL.
//
// The problem it solves is narrow and real. You are in a kelabo and you want
// one more person in it, and the only thing you can reach them on is a phone.
// A kelabo id is a UUID — unreadable aloud, and mistyped even when it is not.
// So the room mints `A5B4C7`, you say it, they type it, and it is worthless
// two minutes later.
//
// Three things about the design are deliberate:
//
//   * It resolves to a kelaboId and stops. Redeeming does NOT join, does not
//     mint a participant cookie and does not touch the kelabo — the caller is
//     sent to the ordinary /join flow, so the display-name prompt and every
//     other join-time rule keep applying and there is only one way in.
//   * It is reusable until it expires. You read a code to three people; all
//     three must be able to use it. Burning on first redeem would make the
//     second person's failure look like a typo.
//   * Guessing is bounded by the per-IP redeem counter, not by the code. Six
//     characters is ~7.1M combinations, which is nothing next to the 128-bit
//     id it stands for; an attacker guessing at random is not attacking one
//     code, they are fishing for any code live anywhere, so a per-code attempt
//     counter (the OTP's control) would not see them at all. The IP counter is
//     the control that does.
import { randomBytes } from "node:crypto";
import {
  JOIN_CODE_DIGITS,
  JOIN_CODE_LETTERS,
  JOIN_CODE_LENGTH,
  JOIN_CODE_PAIRS,
} from "@kelabo/contracts";
import { err } from "./errors.js";

/** Uniform over an alphabet. `% n` on a raw byte is not, and the whole point of
 *  a short code is that every position carries real weight. */
function pick(alphabet) {
  const n = alphabet.length;
  const limit = Math.floor(256 / n) * n;
  for (;;) {
    for (const b of randomBytes(8)) if (b < limit) return alphabet[b % n];
  }
}

export function generateJoinCode() {
  let out = "";
  for (let i = 0; i < JOIN_CODE_PAIRS; i += 1) out += pick(JOIN_CODE_LETTERS) + pick(JOIN_CODE_DIGITS);
  return out;
}

/**
 * Accept what a human typed. Case, spaces and dashes are theirs; the alternating
 * letter/digit shape is ours, and a string that does not have it cannot be a
 * code we issued — so it is rejected here rather than costing a lookup.
 *
 * Returns "" for anything unusable, which every caller turns into the same
 * `join_code_invalid` an unknown code produces. A typist must not be able to
 * tell "wrong shape" from "no such code": that difference is a free oracle.
 */
export function normalizeJoinCode(raw) {
  const clean = String(raw || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (clean.length !== JOIN_CODE_LENGTH) return "";
  for (let i = 0; i < clean.length; i += 1) {
    const alphabet = i % 2 === 0 ? JOIN_CODE_LETTERS : JOIN_CODE_DIGITS;
    if (!alphabet.includes(clean[i])) return "";
  }
  return clean;
}

export function createJoinCodes({ config, db, opConfig }) {
  // Published operational config (contracts/src/opconfig.js), resolved per
  // call. `redeemPerIp*` is the control that actually bounds guessing, so it is
  // also the one an operator most needs to tighten *while* a deployment is
  // being fished — which is precisely what waiting for a redeploy prevented.
  const dialsNow = async () => (opConfig ? (await opConfig.effective()).joinCode : config.joinCode);

  /**
   * Mint a code for a kelabo. The caller holds a participant cookie for it —
   * being in the room is the authority, which is both the right one and the
   * only one a guest with no account can hold.
   */
  async function mint({ kelaboId }) {
    const meta = await db.getKelaboMeta(kelaboId);
    if (!meta) throw err(404, "kelabo_not_found");
    // A code for a kelabo nobody can join is a code that fails two minutes
    // later, on the other end of a phone call, for no visible reason.
    if (meta.status !== "active") throw err(410, "kelabo_ended");

    // Minting does not invalidate the previous code, so without this a room
    // could hold hundreds of live codes at once and widen the guess surface by
    // exactly that factor.
    const dials = await dialsNow();
    const counter = await db.bumpJoinCodeCounter(`k:${kelaboId}`, 3600);
    if ((counter?.count || 0) > dials.mintPerKelaboPerHour) throw err(429, "rate_limited");

    const now = Date.now();
    const expiresAt = now + dials.ttlSeconds * 1000;
    // Collisions are rare (7.1M codes, a 2-minute window) but not impossible,
    // and one would silently point two rooms at the same string. The
    // conditional put is what makes that a retry instead of a mystery.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const code = generateJoinCode();
      try {
        await db.putJoinCode({
          code,
          kelaboId,
          createdAt: now,
          // Milliseconds, and it is what every check reads. `ttl` is seconds and
          // only tells DynamoDB's sweeper to tidy up — that is best-effort and
          // may lag by two days, so no correctness rests on it.
          expiresAt,
          ttl: Math.floor(expiresAt / 1000),
        });
        return { code, expiresAt, expiresInSeconds: dials.ttlSeconds };
      } catch (e) {
        if (e.name !== "ConditionalCheckFailedException") throw e;
      }
    }
    throw err(503, "internal_error", "could not mint a join code");
  }

  /**
   * Resolve a typed code to the kelabo it stands for. Unauthenticated, because
   * the person holding it is by definition someone who does not have a link.
   */
  async function redeem({ code: raw, ip }) {
    const dials = await dialsNow();
    // Counted before the code is even parsed: an attacker who could spend
    // malformed guesses for free would simply send malformed guesses.
    const counter = await db.bumpJoinCodeCounter(`ip:${ip || "unknown"}`, dials.redeemPerIpWindowSeconds);
    if ((counter?.count || 0) > dials.redeemPerIpMaxRequests) throw err(429, "rate_limited");

    const code = normalizeJoinCode(raw);
    if (!code) throw err(404, "join_code_invalid");
    const item = await db.getJoinCode(code);
    if (!item) throw err(404, "join_code_invalid");
    if (item.expiresAt <= Date.now()) {
      await db.deleteJoinCode(code);
      throw err(410, "join_code_expired");
    }

    const meta = await db.getKelaboMeta(item.kelaboId);
    if (!meta) throw err(404, "kelabo_not_found");
    if (meta.status !== "active") throw err(410, "kelabo_ended");

    // The title so the redeemer can see they reached the right room before they
    // type their name into it, and the join URL so the SPA does not rebuild it.
    return {
      kelaboId: item.kelaboId,
      title: meta.title || "",
      joinUrl: config.joinUrl(item.kelaboId),
      expiresAt: item.expiresAt,
    };
  }

  return { mint, redeem };
}
