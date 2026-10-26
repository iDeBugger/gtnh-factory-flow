/**
 * The order of a list of rates: biggest first, rows equal within float noise by name, then by key.
 *
 * Two rates a plan takes from different cards can be the same number in exact arithmetic and differ only in the
 * solver's last bits (17.000000000000000 and 17.000000000000004); which one is larger changes with every new target, so
 * a list sorted on the raw numbers reorders rows that read the same. The sort key is the rate rounded to
 * `RATE_ORDER_DIGITS` significant digits: a function of one value, so the order stays transitive (a tolerance test
 * `|a - b| < eps` is not, and breaks `Array.sort`). Nine digits leave six orders of magnitude between the noise
 * (about 1e-15 of the value) and the key's step, and the panels print at most five significant digits, so two rates
 * that read differently differ at nine digits too (short of one sitting within 5e-9 of a printed rounding edge).
 */
export const RATE_ORDER_DIGITS = 9;

/** The rate as the sort reads it: rounded to `RATE_ORDER_DIGITS` significant digits; 0, -0 and NaN read as 0. */
export function rateOrderKey(value: number): number {
  if (!Number.isFinite(value)) return Number.isNaN(value) ? 0 : value;
  if (value === 0) return 0;
  return Number(value.toPrecision(RATE_ORDER_DIGITS));
}

export const orderNames = new Intl.Collator("en", { sensitivity: "base", numeric: true });

const byKey = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Biggest rate first; rates equal at `RATE_ORDER_DIGITS` by name (A to Z, case and accents aside), then by key. */
export function compareByRate(
  a: { rate: number; name: string; key: string },
  b: { rate: number; name: string; key: string },
): number {
  const ka = rateOrderKey(a.rate);
  const kb = rateOrderKey(b.rate);
  if (ka !== kb) return kb > ka ? 1 : -1;
  return orderNames.compare(a.name, b.name) || byKey(a.key, b.key);
}
