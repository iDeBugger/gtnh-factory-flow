import { describe, expect, it } from "vitest";
import type { Recipe } from "@/lib/model/types";
import { applyMachineHandlerToRecipe, getRecipeCoilTierControl } from "@/lib/model/recipe-rules";
import { getHeatOverclockStats } from "@/lib/solver/heat";
import { getMachineParallelMultiplier } from "@/lib/solver/machine-effects";
import { getOverclockedRecipeStats } from "@/lib/solver/overclock";
import { getMachineBehaviour } from "./machine-table";

// Shape of the reported recipe in the 2.9.0-beta-2 export:
// gtpp.recipe.vacfurnace:a068a7261b3d65c2 (sulfur/antimony/poor nether waste).
// A one-family map has NO handlers. Its separate runtime calculation knows
// neither this machine's coils nor its speed/EU modifiers.
const vacuum: Recipe = {
  id: "vacuum-sulfur",
  name: "Vacuum Furnace: Sulfur Dust",
  machineType: "Vacuum Furnace",
  minimumTier: "LuV",
  durationTicks: 1200,
  eut: 30720,
  source: { recipeMap: "Vacuum Furnace" },
  nei: { additionalInfo: ["Special value: 7200"] },
  inputs: [{ kind: "fluid", id: "froth", amount: 4000 }],
  outputs: [{ kind: "item", id: "sulfur", amount: 256 }],
  runtimeCalculation: {
    status: "computed",
    sourceKind: "gregtech-overclock-calculator",
    oracleEligible: true,
    variants: [
      {
        id: "tier-uv",
        label: "UV",
        overclockTier: "UV",
        durationTicks: 300,
        eut: 491520,
        parallel: 1,
        inputs: [],
        outputs: [],
      },
    ],
  },
};

describe("Utupu-Tanuri's two modes", () => {
  it("recognizes both exported maps as the same multiblock without absorbing singleblocks", () => {
    expect(getMachineBehaviour("Vacuum Furnace", "2.9")).toBe(getMachineBehaviour("Utupu-Tanuri", "2.9"));
    expect(getMachineBehaviour("Multiblock Dehydrator", "2.9")).toBe(getMachineBehaviour("Utupu-Tanuri", "2.9"));
    expect(getMachineBehaviour("Dehydrator", "2.9")).toBeUndefined();
    expect(getMachineBehaviour("Chemical Dehydrator", "2.9")).toBeUndefined();
  });

  it("offers the real minimum coil for the reported 7200 K recipe, including on old plans", () => {
    const effective = applyMachineHandlerToRecipe(vacuum, {}, "2.9");
    for (const coilTier of [undefined, "cupronickel", "hss_s", "naquadah"]) {
      const control = getRecipeCoilTierControl(effective, { coilTier }, "2.9")!;
      expect(control.minimum.key).toBe("naquadah");
      expect(control.current.key).toBe("naquadah");
      expect(control.tiers.every((coil) => coil.heat! >= 7200)).toBe(true);
    }
    expect(getRecipeCoilTierControl(effective, { coilTier: "trinium" }, "2.9")!.current.key).toBe(
      "trinium",
    );
  });

  it.each([
    [0, "cupronickel"],
    [5500, "hss_s"],
    [7200, "naquadah"],
  ])("uses %i K to choose minimum %s", (heat, minimum) => {
    const recipe = { ...vacuum, nei: { additionalInfo: [`Special value: ${heat}`] } };
    expect(getRecipeCoilTierControl(recipe, {}, "2.9")!.minimum.key).toBe(minimum);
  });

  it("pays heat bonuses only above the vacuum recipe's requirement, with no voltage heat bonus", () => {
    for (const tier of ["LuV", "UV"] as const) {
      expect(getHeatOverclockStats(vacuum, { coilTier: "naquadah" }, tier, 3, "2.9")).toEqual({
        heatOverclockSteps: 0,
        regularOverclockSteps: 3,
        heatDiscountMultiplier: 1,
      });
      expect(getHeatOverclockStats(vacuum, { coilTier: "trinium" }, tier, 3, "2.9")).toEqual({
        heatOverclockSteps: 1,
        regularOverclockSteps: 2,
        heatDiscountMultiplier: 0.95 ** 2,
      });
    }
  });

  it("uses four parallels, 2.2x speed and half EU before heat bonuses instead of the exported runtime", () => {
    const base = getOverclockedRecipeStats(vacuum, { overclockTier: "UV", coilTier: "naquadah" }, "2.9");
    const hot = getOverclockedRecipeStats(vacuum, { overclockTier: "UV", coilTier: "trinium" }, "2.9");
    expect(getMachineParallelMultiplier(vacuum, { overclockTier: "UV" }, "2.9")).toBe(4);
    expect(getMachineParallelMultiplier(vacuum, { overclockTier: "LuV" }, "2.9")).toBe(2);
    expect(base.overclockSteps).toBe(1);
    expect(base.perfectOverclockSteps).toBe(0);
    expect(base.durationTicks).toBe(272); // floor(1200 / 2.2 / 2)
    expect(base.eut).toBe(30720 * 0.5 * 4);
    expect(hot.overclockSteps).toBe(1);
    expect(hot.perfectOverclockSteps).toBe(1);
    expect(hot.durationTicks).toBe(136); // floor(1200 / 2.2 / 4)
    // The game bills the four parallels' draw ceiled to a whole EU/t (GT5U@5.09.54.205
    // OverclockCalculator.java:382, :421); eut is one parallel's share.
    expect(hot.eut).toBeCloseTo(Math.ceil(30720 * 4 * 0.5 * 0.95 ** 2 * 4) / 4, 6);
  });

  it("keeps the zero-K dehydrator mode's existing bonuses", () => {
    const recipe = {
      ...vacuum,
      machineType: "Multiblock Dehydrator",
      durationTicks: 400,
      eut: 1920,
      source: { recipeMap: "Multiblock Dehydrator" },
      nei: { additionalInfo: ["Special value: 0"] },
    };
    const stats = getOverclockedRecipeStats(recipe, { overclockTier: "LuV", coilTier: "nichrome" }, "2.9");
    expect(getRecipeCoilTierControl(recipe, {}, "2.9")!.minimum.key).toBe("cupronickel");
    expect(stats.durationTicks).toBe(45);
    // Four parallels' draw ceiled to a whole EU/t (GT5U@5.09.54.205 OverclockCalculator.java:421).
    expect(stats.eut).toBeCloseTo(Math.ceil(1920 * 4 * 0.5 * 0.95 ** 4 * 4) / 4, 6);
  });
});
