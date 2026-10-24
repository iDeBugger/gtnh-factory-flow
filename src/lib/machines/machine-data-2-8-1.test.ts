import { describe, expect, it } from "vitest";
import { getVatRequirements, radioMaterials } from "./bacterial-vat";
import { matchTgsTree } from "./tree-growth-simulator";
import type { Recipe } from "@/lib/model/types";

// The oracle's machine data files differ between packs (data/2.8.1/*.json, from GT5U 5.09.51.476, against data/*.json
// from 5.09.54.205). Each test pins one entry that differs, read through its module, beside its 2.9 twin.

/** The vat's concrete to wet concrete recipe: 2.8.1 runs it at 16 EU/t, 2.9 at 15. */
function concrete(eut: number): Recipe {
  return {
    id: `vat-concrete-${eut}`,
    name: "Bacterial Vat: Wet Concrete",
    machineType: "Bacterial Vat",
    minimumTier: "ULV",
    durationTicks: 20,
    eut,
    inputs: [
      {
        kind: "item",
        id: "bartworks:biolabparts",
        amount: 1,
        consumed: false,
        tooltip: ['NBT: {Name:"Saccharomyces escherichia"}'],
      },
      { kind: "fluid", id: "concrete", amount: 1000 },
    ],
    outputs: [{ kind: "fluid", id: "wet.concrete", amount: 1000 }],
  };
}

describe("machine data files on 2.8.1", () => {
  it("bio-vat.json 2.8.1 knows the wet concrete recipe at 16 EU/t", () => {
    expect(getVatRequirements(concrete(16), "2.8.1")).toMatchObject({ known: true, glass: 3, sievert: 0 });
    expect(getVatRequirements(concrete(15), "2.8.1").known).toBe(false);
    expect(getVatRequirements(concrete(15), "2.9")).toMatchObject({ known: true, glass: 3, sievert: 0 });
    expect(getVatRequirements(concrete(16), "2.9").known).toBe(false);
  });

  it("radio-hatch.json 2.8.1 gives the Tiberium fuel rod 123 sieverts", () => {
    const rod = (version: "2.8.1" | "2.9") =>
      radioMaterials(version).find((material) => material.id === "gregtech:gt.rodtiberium")?.sievert;
    expect(rod("2.8.1")).toBe(123);
    expect(rod("2.9")).toBe(43);
    const curium = (version: "2.8.1" | "2.9") =>
      radioMaterials(version).some((material) => material.id === "miscutils:item.itemrodcurium");
    expect(curium("2.8.1")).toBe(true);
    expect(curium("2.9")).toBe(false);
  });

  it("tgs-trees.json 2.8.1 farms the Ignis Fruit tree", () => {
    const ignis: Partial<Recipe> = {
      machineType: "Tree Growth Simulator",
      outputs: [
        { kind: "item", id: "harvestthenether:netherlog", amount: 5 },
        { kind: "item", id: "harvestthenether:nethersapling", amount: 5 },
        { kind: "item", id: "harvestthenether:netherleaves", amount: 2 },
        { kind: "item", id: "harvestthenether:ignisfruititem", amount: 2 },
      ],
    };
    const match = matchTgsTree(ignis, "2.8.1");
    expect(match?.tree.sapling.name).toBe("Ignis Fruit Sapling");
    expect(match?.modes).toEqual(["log", "sapling", "leaves", "fruit"]);
    expect(matchTgsTree(ignis, "2.9")).toBeUndefined();
  });
});
