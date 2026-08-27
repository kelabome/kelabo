// Money on screen. One module, shared by every surface that prints an amount —
// the app, and the public figures site — because they are checked against each
// other in public: a receipt in the app and a total on the transparency page
// are the same money, and two implementations of "what does this number look
// like" is how they come to disagree by a rounding step nobody can explain.
//
// It lives in contracts rather than in either SPA for exactly that reason. It
// used to live in `spa/src/money.js` with a hand-kept copy inside the static
// about page, and a test that diffed the copy against the original — which
// works only for as long as somebody keeps running it, and says nothing about
// the third copy the next page would bring.
//
// Everything in the system is **micros** — 1 cent = 1 000 000, so 1e-8 AUD —
// and AUD is the only currency. Nothing here
// converts a currency; a page that did would be inventing a number the receipt
// cannot reproduce.
//
// The reason the unit is that small is on every receipt. A thirty-minute call
// costs a few cents, so each of its five lines lands between zero and one cent.
// Printed in whole cents, a measured transcription line of 0.842 cents read
// A$0.01, a call-routing line of 0.31 cents read A$0.00 — a third of the call,
// gone — and a 1.75-cent total read A$0.02. The rate card is published so that
// people can check the arithmetic; rounding the answer to forty times its own
// size makes that impossible.
//
// Pure and dependency-free (no zod, no React), so a plain `node` test can load
// it and both SPAs can bundle it.

export const MICROS_PER_DOLLAR = 100_000_000;

/**
 * `A$3.40`, `A$0.0084`, `A$0.000012`.
 *
 * Two decimals once an amount is worth two decimals, and as many as six below
 * that — the precision receipts are required to hold. Trailing zeroes are
 * trimmed on the small ones so `A$0.0084` does not read as `A$0.008400` and
 * invite a false sense of a measurement finer than it is.
 */
export function formatAud(micros, { sign = false, rounded = false } = {}) {
  const n = Number(micros) || 0;
  const negative = n < 0;
  const dollars = Math.abs(n) / MICROS_PER_DOLLAR;
  let body;
  if (dollars === 0) {
    body = "A$0.00";
  } else if (rounded) {
    // A headline balance, where sub-cent noise helps nobody: this is money
    // somebody has, not a figure anybody checks against a rate card.
    body = `A$${dollars.toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  } else {
    // Exact, to the accuracy the receipts are held to: six decimals is
    // 0.000001 AUD. Two at minimum, so ordinary amounts read like money, and
    // trailing zeroes trimmed so `A$0.0084` does not imply a measurement finer
    // than it is.
    //
    // No threshold above which this rounds. There used to be one at a cent, and
    // it printed a 1.746-cent total as A$0.02 — a 15% overstatement on the line
    // the whole page exists to make checkable.
    const whole = Math.floor(dollars);
    const fixed = dollars.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
    if (Number(fixed) === 0) return `${negative ? "−" : ""}A$<0.000001`;
    const [int, frac = ""] = fixed.split(".");
    const grouped = whole >= 1000 ? Number(int).toLocaleString("en-AU") : int;
    body = `A$${grouped}.${frac.padEnd(2, "0")}`;
  }
  if (negative) return `−${body}`;
  return sign ? `+${body}` : body;
}

/**
 * An amount a human typed, in whole cents — an AWS bill, a supplier payment —
 * lifted into the micros everything else speaks.
 *
 * It exists because reading one *as* micros prints a $58 bill as A$0.000058,
 * which is a mistake with no visible symptom: the page renders, the number is
 * simply wrong by a factor of a million.
 */
export const formatAudCents = (cents) => formatAud((Number(cents) || 0) * 1_000_000);

/**
 * A supplier's own published rate, in their own currency, to the precision they
 * quote it in — `US$0.0004`. Eight decimals trimmed, because a per-second rate
 * is genuinely that small and rounding it to four printed twice the real one.
 *
 * `—` rather than `US$0.00` for a rate a card does not carry: a rate card whose
 * shape changed between versions must say "not priced this way" and never
 * invent a zero.
 */
export function formatUsd(value) {
  const n = Number(value);
  if (value === null || value === undefined || value === "" || !Number.isFinite(n)) return "—";
  return `US$${n.toFixed(8).replace(/0+$/, "").replace(/\.$/, "")}`;
}

/**
 * The same thing as `formatAud`, and the same answer. It used to say "under a
 * cent" for anything that rounded to zero, which was the honest response to a
 * unit too coarse to hold the number — and is now just a refusal to show a
 * figure we have.
 */
export const formatCost = (micros) => formatAud(micros);

/** `3 min`, `1 h 12 min` — durations on a receipt, never a stopwatch. */
/**
 * `2 min 50 s` — a length with its seconds kept, for a receipt.
 *
 * `formatDuration` rounds to the nearest minute, which is right for "how long
 * was that meeting" and exactly wrong for a document whose job is checkable
 * arithmetic. A call of 180.089 s printed as "3 min", beside a free-call window
 * also printed as "3 min", reads as a contradiction — and the reader has no way
 * to see that it cleared the threshold by 89 milliseconds. One did happen.
 */
export function formatLength(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  if (s < 60) return `${s} s`;
  const mins = Math.floor(s / 60);
  const rest = s % 60;
  if (mins < 60) return rest ? `${mins} min ${rest} s` : `${mins} min`;
  const h = Math.floor(mins / 60);
  return `${h} h ${mins % 60} min`;
}

export function formatDuration(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  if (s < 60) return `${s} s`;
  const mins = Math.round(s / 60);
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  return `${h} h ${mins % 60} min`;
}

/**
 * `412 MB`, `1.2 GB` — the unit Cloudflare actually bills in, at a scale a
 * person can hold. Never bytes: "431,282,176" is a true number nobody can
 * check against a rate quoted per gigabyte.
 */
export function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n <= 0) return "0 MB";
  if (n < 1e6) return `${(n / 1e3).toFixed(0)} kB`;
  if (n < 1e9) return `${(n / 1e6).toFixed(1)} MB`;
  return `${(n / 1e9).toFixed(2)} GB`;
}
