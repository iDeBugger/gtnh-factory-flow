import { describe, expect, it } from "vitest";
import type { Recipe } from "@/lib/model/types";
import { getHeatOverclockStats, isHeatOverclockMachine } from "./heat";
import { getNodePowerReport } from "./power-report";

// A coil is a heat gate only for a heat machine's recipe (the blast furnaces and their kin). The Multi Smelter's
// coil sets its parallels and carries no heat, so a recipe that reads a special value never stops it.
function smelterRecipe(): Recipe {
  return {
    id: "multi-smelter",
    name: "Multi Smelter",
    machineType: "Multi Smelter",
    minimumTier: "LV",
    eut: 4,
    durationTicks: 128,
    inputs: [{ kind: "item", id: "minecraft:iron_ore", amount: 1 }],
    outputs: [{ kind: "item", id: "minecraft:iron_ingot", amount: 1 }],
    source: { recipeMap: "Furnace" },
    nei: { additionalInfo: ["Special Value: 9001"] },
    machineConfigControls: [
      {
        id: "heatingCoil",
        label: "Coil",
        defaultKey: "cupronickel",
        minimumKey: "cupronickel",
        tiers: [
          {
            key: "cupronickel",
            label: "Cupronickel",
            parallelMultiplier: 8,
            resource: { kind: "item", id: "gregtech:gt.blockcasings5", amount: 1 },
          },
        ],
      },
    ],
  } as unknown as Recipe;
}

describe("coil heat gate", () => {
  it("is a heat machine's only", () => {
    expect(isHeatOverclockMachine("Multi Smelter", "2.9")).toBe(false);
    expect(isHeatOverclockMachine("Electric Blast Furnace", "2.9")).toBe(true);
  });

  it("asks nothing of a Multi Smelter coil", () => {
    const node = { machineConfigTiers: {}, coilTier: "cupronickel", machineHandlerId: undefined };
    const stats = getHeatOverclockStats(smelterRecipe(), node, "MV", 2, "2.9");
    expect(stats).toEqual({
      heatOverclockSteps: 0,
      regularOverclockSteps: 2,
      heatDiscountMultiplier: 1,
    });
    const report = getNodePowerReport(smelterRecipe(), {
      id: "n",
      recipeId: "multi-smelter",
      enabled: true,
      machineCount: 1,
      parallel: 1,
      position: { x: 0, y: 0 },
      overclockTier: "MV",
      coilTier: "cupronickel",
    } as never, "2.9");
    expect(report.recipeGateReason).toBeUndefined();
    expect(report.state).not.toBe("over-tier");
  });
});
