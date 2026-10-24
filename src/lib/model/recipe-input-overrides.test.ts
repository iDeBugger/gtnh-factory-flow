import { describe, expect, it } from "vitest";
import type { Recipe } from "./types";
import { applyRecipeInputOverrides, inputOverrideAmount } from "./recipe-input-overrides";

describe("switching a slot to a substitute of the same kind", () => {
  it("scales the requirement by the substitute's ratio", () => {
    const solder = {
      kind: "fluid" as const,
      id: "molten.solderingalloy",
      displayName: "Molten Soldering Alloy",
      amount: 72,
      alternatives: [{ kind: "fluid" as const, id: "molten.lead", amount: 4 }],
    };

    expect(inputOverrideAmount(solder, "fluid", { kind: "fluid", amount: 4 })).toBe(288);
  });

  it("leaves an ore dictionary member's requirement untouched", () => {
    const planks = {
      kind: "item" as const,
      id: "oredict:plankWood",
      displayName: "Ore Dictionary: plankWood",
      amount: 3,
      alternatives: [{ kind: "item" as const, id: "minecraft:planks", amount: 1 }],
    };

    expect(inputOverrideAmount(planks, "item", { kind: "item", amount: 1 })).toBe(3);
    expect(inputOverrideAmount(planks, "item", undefined)).toBe(3);
  });

  // A cell slot lists its fluid at 1000 L. Nothing crosses the two forms any
  // more, so that entry must never be read as "use 1000x as many cells" - the
  // exact misreading that once made a reactor wanting 2 cells ask for 2,000.
  it("never converts across kinds, whichever way the ratio points", () => {
    const cellInput = {
      kind: "item" as const,
      id: "gregtech:gt.metaitem.01@30734",
      displayName: "Sulfuric Gas Cell",
      amount: 2,
      alternatives: [{ kind: "fluid" as const, id: "gas_sulfuricgas", amount: 1000 }],
    };
    const fluidInput = {
      kind: "fluid" as const,
      id: "gas_sulfuricgas",
      displayName: "Sulfuric Gas",
      amount: 16000,
      alternatives: [
        { kind: "item" as const, id: "gregtech:gt.metaitem.01@30734", amount: 1 / 1000 },
      ],
    };

    expect(inputOverrideAmount(cellInput, "item")).toBe(2);
    expect(inputOverrideAmount(cellInput, "fluid", { amount: 1000 })).toBe(2);
    expect(inputOverrideAmount(fluidInput, "fluid")).toBe(16000);
    expect(inputOverrideAmount(fluidInput, "item", { amount: 1 / 1000 })).toBe(16000);
  });
});

describe("applyRecipeInputOverrides", () => {
  it("applies a same-kind substitute to the slot", () => {
    const recipe: Recipe = {
      id: "circuit",
      name: "Circuit Assembler",
      machineType: "Circuit Assembler",
      minimumTier: "LV",
      durationTicks: 20,
      eut: 30,
      inputs: [
        {
          kind: "fluid",
          id: "molten.solderingalloy",
          amount: 72,
          displayName: "Molten Soldering Alloy",
          neiSlot: { x: 34, y: 17 },
        },
      ],
      outputs: [{ kind: "item", id: "circuit", amount: 1 }],
    };

    const effective = applyRecipeInputOverrides(recipe, {
      recipeInputOverrides: {
        "0": { kind: "fluid", id: "molten.lead", amount: 288, displayName: "Molten Lead" },
      },
    }, "2.9");

    expect(effective.inputs[0]).toEqual(
      expect.objectContaining({ kind: "fluid", id: "molten.lead", amount: 288 }),
    );
    // The slot's NEI position survives an override; only the contents change.
    expect(effective.inputs[0]?.neiSlot).toEqual({ x: 34, y: 17 });
  });
});
