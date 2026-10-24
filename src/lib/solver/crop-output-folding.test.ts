import { describe, expect, it } from "vitest";
import type { Recipe } from "@/lib/model/types";
import { enrichPassiveProductionRecipe } from "@/lib/model/passive-production";
import { applyMachineOutputMultipliers } from "./machine-effects";

// Two drops that share an ore name (Lazulia's Lapis Lazuli and Lapis Dust) are two outputs: outputs only ever fold
// when they are the same item id, and a crop card keeps every drop.
describe("crop card outputs", () => {
  const lazulia = (): Recipe =>
    enrichPassiveProductionRecipe({
      id: "cropsnh-crop-lazulia",
      name: "Crop Farm: Lazulia",
      machineType: "Crop Farm",
      minimumTier: "NONE",
      durationTicks: 3328,
      eut: 0,
      inputs: [],
      outputs: [
        { kind: "item", id: "minecraft:dye@4", amount: 1.2, displayName: "Lapis Lazuli" },
        {
          kind: "item",
          id: "gregtech:gt.metaitem.01@2503",
          amount: 0.8,
          displayName: "Lapis Dust",
        },
      ],
      metadata: {
        cropsNh: {
          tier: 7,
          growthPoints: 1400,
          dropChance: 0.7,
          growthCycleTicks: 256,
          growthMultiplier: 1,
          drops: [
            { id: "minecraft:dye@4", stackSize: 1, weight: 6000 },
            { id: "gregtech:gt.metaitem.01@2503", stackSize: 1, weight: 4000 },
          ],
        },
      },
      source: { recipeMap: "Crop Farm" },
    });

  it("keeps both drops, each scaled by its own weight", () => {
    const recipe = lazulia();
    expect(recipe.outputs.map((output) => output.id)).toEqual([
      "minecraft:dye@4",
      "gregtech:gt.metaitem.01@2503",
    ]);
    const applied = applyMachineOutputMultipliers(recipe, { machineConfigTiers: {} }, "LV", "2.9");
    expect(applied.outputs).toHaveLength(2);
    expect(applied.outputs.every((output) => output.amount > 0)).toBe(true);
  });
});
