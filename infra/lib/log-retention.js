import * as logs from "aws-cdk-lib/aws-logs";

/**
 * `cfg.logRetentionDays` as the CloudWatch enum, or a loud failure.
 *
 * CloudWatch does not accept an arbitrary number of days — it accepts a fixed
 * set, and anything else is rejected at deploy time with a message that names
 * the API call rather than the config key. Worse, the nearest-value approach is
 * silent: ask for 100 days, get 90, and the privacy policy that says 100 is now
 * wrong with nothing to show for it.
 *
 * So this maps exactly and throws on anything else, naming the value and the
 * legal ones. A retention period we publish has to be the retention period we
 * set.
 */
const BY_DAYS = new Map([
  [1, logs.RetentionDays.ONE_DAY],
  [3, logs.RetentionDays.THREE_DAYS],
  [5, logs.RetentionDays.FIVE_DAYS],
  [7, logs.RetentionDays.ONE_WEEK],
  [14, logs.RetentionDays.TWO_WEEKS],
  [30, logs.RetentionDays.ONE_MONTH],
  [60, logs.RetentionDays.TWO_MONTHS],
  [90, logs.RetentionDays.THREE_MONTHS],
  [120, logs.RetentionDays.FOUR_MONTHS],
  [150, logs.RetentionDays.FIVE_MONTHS],
  [180, logs.RetentionDays.SIX_MONTHS],
  [365, logs.RetentionDays.ONE_YEAR],
  [400, logs.RetentionDays.THIRTEEN_MONTHS],
  [545, logs.RetentionDays.EIGHTEEN_MONTHS],
  [731, logs.RetentionDays.TWO_YEARS],
  [1096, logs.RetentionDays.THREE_YEARS],
  [1827, logs.RetentionDays.FIVE_YEARS],
  [2192, logs.RetentionDays.SIX_YEARS],
  [2557, logs.RetentionDays.SEVEN_YEARS],
  [2922, logs.RetentionDays.EIGHT_YEARS],
  [3288, logs.RetentionDays.NINE_YEARS],
  [3653, logs.RetentionDays.TEN_YEARS],
]);

/** @param {number} days @returns {logs.RetentionDays} */
export function logRetention(days) {
  const found = BY_DAYS.get(Number(days));
  if (found === undefined) {
    throw new Error(
      `kelabo infra: logRetentionDays ${days} is not a retention period CloudWatch accepts. ` +
        `Use one of: ${[...BY_DAYS.keys()].join(", ")}.`,
    );
  }
  return found;
}
