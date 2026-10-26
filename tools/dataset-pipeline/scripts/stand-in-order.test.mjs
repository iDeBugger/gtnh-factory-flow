import { describe, expect, it } from "vitest";
import { compareStandIns, nbtOf, orderCropDrops, orderOreMembers } from "./stand-in-order.mjs";

describe("stand-in order", () => {
  it("reads the NBT line the normalizer writes", () => {
    expect(nbtOf({ tooltip: ["Lore", "NBT: {a:1}"] })).toBe("{a:1}");
    expect(nbtOf({ tooltip: ["Lore"] })).toBeUndefined();
  });

  it("puts a stack with no NBT before one with NBT, and the smaller NBT before the larger", () => {
    const plain = { displayName: "Z" };
    const small = { tooltip: ["NBT: {a:1}"], displayName: "A" };
    const large = { tooltip: ["NBT: {b:1}"], displayName: "A" };
    expect([large, small, plain].sort(compareStandIns)).toEqual([plain, small, large]);
  });

  it("orders crop drops heaviest first, then by id", () => {
    const drop = (id, weight) => ({ resource: { kind: "item", id }, weight });
    expect(orderCropDrops([drop("b", 10), drop("a", 10), drop("c", 90)]).map((entry) => entry.resource.id)).toEqual([
      "c",
      "a",
      "b",
    ]);
  });

  it("drops a repeated member and keeps the target first", () => {
    const member = (id) => ({ kind: "item", id });
    expect(orderOreMembers([member("b"), member("a"), member("b"), member("t")], { target: "t" }).map((entry) => entry.id)).toEqual([
      "t",
      "a",
      "b",
    ]);
  });
});
