// Age -> cutoff-timestamp arithmetic for record retention.
//
// Pure and dependency-free (no node:, no zod) so the SPA can render the same
// cutoff the API will compute, and the two can never disagree about what
// "3 months ago" means.

/**
 * Resolve "N units ago" to an absolute epoch-ms cutoff. Anything that ended
 * STRICTLY BEFORE the returned value is older than the requested age.
 *
 * Months and years use real calendar arithmetic rather than 30-/365-day
 * approximations: a user asking to purge everything older than 6 months means
 * six calendar months, and over a year the naive version drifts by days.
 *
 * Day-of-month overflow is clamped, so "1 month before 31 March" is 28/29 Feb
 * rather than silently rolling forward into March — rolling forward would make
 * the window slightly SHORTER than asked and delete more than intended.
 *
 * @param {number} value - whole units, 1..99 regardless of unit
 * @param {"days"|"weeks"|"months"|"years"} unit
 * @param {number} [now] - epoch ms, injectable for tests
 * @returns {number} epoch ms
 */
export function cutoffFromAge(value, unit, now = Date.now()) {
  const n = Number(value);
  // Same 1..99 bound purgeRecordsBodySchema enforces at the API boundary,
  // restated here so this pure function can't be handed something the
  // schema would have rejected by any future direct caller.
  if (!Number.isFinite(n) || n < 1 || n > 99) throw new Error(`invalid retention value: ${value}`);
  const d = new Date(now);

  switch (unit) {
    case "days":
      d.setUTCDate(d.getUTCDate() - n);
      return d.getTime();
    case "weeks":
      d.setUTCDate(d.getUTCDate() - n * 7);
      return d.getTime();
    case "months":
      return shiftMonths(d, -n);
    case "years":
      return shiftMonths(d, -n * 12);
    default:
      throw new Error(`invalid retention unit: ${unit}`);
  }
}

/** Shift by whole months, clamping the day to the target month's length. */
function shiftMonths(date, months) {
  const day = date.getUTCDate();
  const target = new Date(date.getTime());
  target.setUTCDate(1); // avoid rolling over while the month is being changed
  target.setUTCMonth(target.getUTCMonth() + months);
  const daysInTarget = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)
  ).getUTCDate();
  target.setUTCDate(Math.min(day, daysInTarget));
  return target.getTime();
}

/** "3 months" / "1 day" — for confirmation copy on both sides. */
export function describeAge(value, unit) {
  const n = Number(value);
  const singular = String(unit).replace(/s$/, "");
  return `${n} ${n === 1 ? singular : `${singular}s`}`;
}
