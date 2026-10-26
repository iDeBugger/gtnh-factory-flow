import { describe, expect, it } from "vitest";
import type { DatasetResourceIndexEntry } from "@/lib/datasets/types";
import { neiOrderRanks, usableResourceOrder } from "./nei-order";

const entry = (kind: string, id: string) => ({ kind, id }) as DatasetResourceIndexEntry;

/** The records' ids in rank order. */
function ranked(records: DatasetResourceIndexEntry[], order?: Array<number | null>) {
  const ranks = neiOrderRanks(records, order);
  return records
    .map((record, index) => ({ id: `${record.kind}:${record.id}`, rank: ranks[index]! }))
    .sort((left, right) => left.rank - right.rank)
    .map((record) => record.id);
}

describe("NEI's order without an export (the approximation)", () => {
  it("lists vanilla first, then items by mod, registry name and meta, then fluids, then aspects", () => {
    const records = [
      entry("aspect", "thaumcraft:aspect:terra"),
      entry("fluid", "water"),
      entry("item", "gregtech:gt.metaitem.01@11305"),
      entry("item", "ic2:itemcellempty"),
      entry("item", "gregtech:gt.metaitem.01@2305"),
      entry("item", "minecraft:stone"),
      entry("item", "gregtech:gt.metaitem.01"),
      entry("item", "gregtech:gt.blockmachines@1"),
      entry("fluid", "lava"),
      entry("item", "minecraft:log@1"),
      entry("item", "minecraft:log"),
    ];
    expect(ranked(records)).toEqual([
      "item:minecraft:log",
      "item:minecraft:log@1",
      "item:minecraft:stone",
      "item:gregtech:gt.blockmachines@1",
      "item:gregtech:gt.metaitem.01",
      // Meta by number, not by text: the dust (2305) before the ingot (11305), as NEI lists them.
      "item:gregtech:gt.metaitem.01@2305",
      "item:gregtech:gt.metaitem.01@11305",
      "item:ic2:itemcellempty",
      "fluid:lava",
      "fluid:water",
      "aspect:thaumcraft:aspect:terra",
    ]);
  });
});

describe("NEI's order from the export", () => {
  it("follows the export's places, and puts everything NEI does not list after, in the approximation's order", () => {
    const records = [
      entry("item", "minecraft:stone"),
      entry("item", "zmod:thing"),
      entry("fluid", "water"),
      entry("item", "amod:thing"),
      entry("item", "oredict:ingotIron"),
    ];
    expect(ranked(records, [1, 0, null, null, null])).toEqual([
      "item:zmod:thing",
      "item:minecraft:stone",
      "item:amod:thing",
      "item:oredict:ingotIron",
      "fluid:water",
    ]);
  });

  it("is used only when it fits the list", () => {
    const records = [entry("item", "a:b"), entry("item", "a:c")];
    expect(usableResourceOrder(records, [0, null])).toEqual([0, null]);
    expect(usableResourceOrder(records, [0])).toBeUndefined();
    expect(usableResourceOrder(records, [0, 1.5])).toBeUndefined();
    expect(usableResourceOrder(records, [0, "1"])).toBeUndefined();
    expect(usableResourceOrder(records, undefined)).toBeUndefined();
  });
});
