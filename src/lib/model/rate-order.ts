/**
 * The order of a list of rates: biggest first, rows equal within float noise by name, then by key.
 *
 * Two rates a plan takes from different cards can be the same number in exact arithmetic and differ only in the
 * solver's last bits (17.000000000000000 and 17.000000000000004); which one is larger changes with every new target, so
 * a list sorted on the raw numbers reorders rows that read the same. The sort key is the rate rounded to
 * `RATE_ORDER_DIGITS` significant digits: a function of one value, so the order stays transitive (a tolerance test
 * `|a - b| < eps` is not, and breaks `Array.sort`). Nine digits leave six orders of magnitude between the noise
 * (about 1e-15 of the value) and the key's step.
 *
 * Two edges no fixed key avoids, both rare:
 * - a rate whose exact value sits on the key's own rounding edge (ten significant digits ending in 5, as some small
 *   dyadic rates do: 2^-14 /s) can round either way on one ulp of noise, so two such rows can still swap;
 * - the panels print at most five significant digits, so two rates within 5e-9 of a printed rounding edge share a key
 *   and go by name although they print one digit apart (1.23455 and 1.234549999 print 1.2346 and 1.2345).
 *
 * The name is the one the list prints (the overview's label, a balance's `displayName ?? resourceId`): the same string
 * for every resource the export names, so tied rows read A to Z in each list.
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

export interface RateRow {
  rate: number;
  name: string;
  key: string;
}

/** Bigger rate first; equal rates by name (A to Z, case and accents aside), then by key. Rates already keyed. */
function compareKeyed(a: RateRow, b: RateRow): number {
  if (a.rate !== b.rate) return b.rate > a.rate ? 1 : -1;
  return orderNames.compare(a.name, b.name) || byKey(a.key, b.key);
}

/** Biggest rate first; rates equal at `RATE_ORDER_DIGITS` by name, then by key. */
export function compareByRate(a: RateRow, b: RateRow): number {
  return compareKeyed({ ...a, rate: rateOrderKey(a.rate) }, { ...b, rate: rateOrderKey(b.rate) });
}

/** Sorts `list` in place by `compareByRate`, keying each row once rather than at every comparison. */
export function sortByRate<T>(list: T[], row: (item: T) => RateRow): T[] {
  const keyed = list.map((item) => {
    const r = row(item);
    return { item, row: { ...r, rate: rateOrderKey(r.rate) } };
  });
  keyed.sort((a, b) => compareKeyed(a.row, b.row));
  for (let i = 0; i < keyed.length; i += 1) list[i] = keyed[i]!.item;
  return list;
}
