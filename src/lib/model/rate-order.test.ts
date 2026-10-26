import { describe, expect, it } from "vitest";
import { compareByRate, rateOrderKey, sortByRate } from "./rate-order";

const row = (rate: number, name: string, key = name) => ({ rate, name, key });

describe("the order of a list of rates", () => {
  it("ties rates that differ only in the solver's last bits", () => {
    expect(rateOrderKey(17.000000000000004)).toBe(rateOrderKey(17));
    expect(rateOrderKey(15.999999999999998)).toBe(rateOrderKey(16));
    expect(rateOrderKey(1 / 3)).toBe(rateOrderKey(0.33333333333333337));
    expect(rateOrderKey(-0)).toBe(0);
    expect(rateOrderKey(Number.NaN)).toBe(0);
  });

  it("never ties rates the panels print differently", () => {
    // formatCompact prints at most five significant digits.
    expect(rateOrderKey(1.2346)).not.toBe(rateOrderKey(1.2345));
    expect(rateOrderKey(99999)).not.toBe(rateOrderKey(99998));
    expect(rateOrderKey(0.0012)).not.toBe(rateOrderKey(0.0013));
  });

  it("goes biggest first, ties A to Z then by key, zero at the bottom", () => {
    const rows = [
      row(0, "Zinc"),
      row(8.000000000000002, "Oxygen"),
      row(16, "Chlorine"),
      row(0, "Apple"),
      row(7.999999999999999, "Benzene"),
      row(8, "Ethylene", "b"),
      row(8, "Ethylene", "a"),
    ];
    expect(rows.sort(compareByRate).map((r) => `${r.name}/${r.key}`)).toEqual([
      "Chlorine/Chlorine",
      "Benzene/Benzene",
      "Ethylene/a",
      "Ethylene/b",
      "Oxygen/Oxygen",
      "Apple/Apple",
      "Zinc/Zinc",
    ]);
  });

  it("is transitive where a tolerance test is not", () => {
    // |a-b| and |b-c| under 1e-9 but |a-c| over: a tolerance would call a=b, b=c, a<c. The key is one value each.
    const a = row(1, "C");
    const b = row(1 + 0.8e-9, "B");
    const c = row(1 + 1.6e-9, "A");
    const sorted = [a, b, c].sort(compareByRate);
    for (const perm of [
      [a, b, c],
      [c, b, a],
      [b, a, c],
      [c, a, b],
    ]) {
      expect([...perm].sort(compareByRate)).toEqual(sorted);
    }
  });
});

describe("sorting a list of rates", () => {
  it("orders as compareByRate does, keying each row once", () => {
    const rows = [
      row(0, "Zinc"),
      row(8.000000000000002, "Oxygen"),
      row(16, "Chlorine"),
      row(7.999999999999999, "Benzene"),
    ];
    const expected = [...rows].sort(compareByRate);
    let keyed = 0;
    const list = [...rows].reverse();
    expect(
      sortByRate(list, (r) => {
        keyed += 1;
        return r;
      }),
    ).toBe(list);
    expect(list).toEqual(expected);
    expect(keyed).toBe(rows.length);
  });
});
