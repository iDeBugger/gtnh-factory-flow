import { describe, expect, test } from "vitest";
import type { MachineHandler, Recipe } from "@/lib/model/types";
import { applyMachineHandlerToRecipe } from "@/lib/model/recipe-rules";
import { getRecipeMinimumVoltageTier } from "@/lib/model/tiers";
import { getOverclockedRecipeStats } from "@/lib/solver/overclock";
import { getNodePowerReport } from "@/lib/solver/power-report";
import { getRecipeMapAmperage } from "./recipe-map-amperage";

const LADDER = ["LV", "MV", "HV", "EV", "IV", "LuV", "ZPM", "UV", "UHV", "UEV", "UIV", "UMV"];

function single(machineType: string, minimumTier: string): MachineHandler {
  return {
    id: machineType.toLowerCase().replace(/ /g, "-"),
    label: machineType,
    kind: "single",
    machineType,
    minimumTier,
    maximumTier: "UMV",
    availableTiers: LADDER,
  };
}

/** A dataset recipe on `recipeMapId`; `declared` is the singleblock handler's stored minimum. */
function recipe(recipeMapId: string, mapName: string, machineType: string, eut: number, durationTicks: number,
  declared: string, extraHandlers: MachineHandler[] = []): Recipe {
  return {
    id: `${recipeMapId}:${eut}`,
    name: `${mapName}: test`,
    kind: "gregtech_machine",
    machineType: mapName,
    minimumTier: declared,
    durationTicks,
    eut,
    inputs: [],
    outputs: [{ kind: "item", id: "minecraft:sand", amount: 1 }],
    machineHandlers: [single(machineType, declared), ...extraHandlers],
    source: { recipeMap: mapName },
    metadata: { recipeMapId },
  };
}

const run = (r: Recipe, tier: string, version: string) => {
  const stats = getOverclockedRecipeStats(r, { overclockTier: tier }, version);
  return { tier: stats.tier, minimumTier: stats.minimumTier, steps: stats.overclockSteps, ticks: stats.durationTicks, eut: stats.eut };
};

const REFINERY: MachineHandler = {
  id: "large-thermal-refinery", label: "Large Thermal Refinery", kind: "multiblock",
  machineType: "Large Thermal Refinery", minimumTier: "MV", durationTicks: 200, eut: 38.4,
};

describe("the minimum tier counts the recipe map's amperage", () => {
  test("recipe-map-amperage.ts map amperage per version: thermal centrifuge 2 and mass fab 8 on both, arc furnace 3 on 2.8.1 only", () => {
    for (const version of ["2.9", "2.8.1"]) {
      expect(getRecipeMapAmperage("gt.recipe.thermalcentrifuge", version)).toBe(2);
      expect(getRecipeMapAmperage("gt.recipe.massfab", version)).toBe(8);
      expect(getRecipeMapAmperage("gt.recipe.macerator", version)).toBe(1);
    }
    expect(getRecipeMapAmperage("gt.recipe.arcfurnace", "2.8.1")).toBe(3);
    expect(getRecipeMapAmperage("gt.recipe.arcfurnace", "2.9")).toBe(1);
    expect(getRecipeMapAmperage(undefined, "2.9")).toBe(1);
  });

  for (const version of ["2.9", "2.8.1"]) {
    test(`${version}: a 48 EU/t thermal centrifuge recipe runs on LV (32 V x 2 A), overclocking against V x 2`, () => {
      // Old datasets stamp the singleblock at MV (the 1 A tier); re-normalized ones say LV. Both run on LV.
      for (const declared of ["MV", "LV"]) {
        const tc = recipe("gt.recipe.thermalcentrifuge", "Thermal Centrifuge", "Thermal Centrifuge", 48, 500, declared, [REFINERY]);
        expect(run(tc, "LV", version)).toEqual({ tier: "LV", minimumTier: "LV", steps: 0, ticks: 500, eut: 48 });
        expect(run(tc, "MV", version)).toEqual({ tier: "MV", minimumTier: "LV", steps: 1, ticks: 250, eut: 192 });
        expect(run(tc, "HV", version)).toEqual({ tier: "HV", minimumTier: "LV", steps: 2, ticks: 125, eut: 768 });
        const lv = getNodePowerReport(tc, { overclockTier: "LV" }, version);
        expect(lv).toMatchObject({ state: "ok", poolEuT: 64, drawEuT: 48 });
      }
    });

    test(`${version}: the Large Thermal Refinery's hatches still carry the whole draw`, () => {
      const tc = recipe("gt.recipe.thermalcentrifuge", "Thermal Centrifuge", "Thermal Centrifuge", 48, 500, "LV", [REFINERY]);
      const refinery = applyMachineHandlerToRecipe(tc, { machineHandlerId: "large-thermal-refinery" }, version);
      expect(refinery.recipeMapAmperage).toBeUndefined();
      expect(getRecipeMinimumVoltageTier(refinery)).toBe("MV");
    });

    test(`${version}: the mass fabricator runs its 256 EU/t recipe on LV (8 A), each step 2x speed for 2x EU/t`, () => {
      const fab = recipe("gt.recipe.massfab", "Mass Fabrication", "Mass Fabricator", 256, 3215, "HV");
      expect(run(fab, "LV", version)).toEqual({ tier: "LV", minimumTier: "LV", steps: 0, ticks: 3215, eut: 256 });
      expect(run(fab, "MV", version)).toEqual({ tier: "MV", minimumTier: "LV", steps: 1, ticks: 1607, eut: 512 });
      expect(run(fab, "HV", version)).toEqual({ tier: "HV", minimumTier: "LV", steps: 2, ticks: 803, eut: 1024 });
      expect(getNodePowerReport(fab, { overclockTier: "LV" }, version)).toMatchObject({ state: "ok", poolEuT: 256 });
    });
  }

  test("2.8.1: an LV arc furnace runs a 90 EU/t recipe (32 V x 3 A = 96)", () => {
    for (const declared of ["MV", "LV"]) {
      const arc = recipe("gt.recipe.arcfurnace", "Arc Furnace", "Arc Furnace", 90, 100, declared);
      expect(run(arc, "LV", "2.8.1")).toEqual({ tier: "LV", minimumTier: "LV", steps: 0, ticks: 100, eut: 90 });
      expect(run(arc, "MV", "2.8.1")).toEqual({ tier: "MV", minimumTier: "LV", steps: 1, ticks: 50, eut: 360 });
      expect(getNodePowerReport(arc, { overclockTier: "LV" }, "2.8.1")).toMatchObject({ state: "ok", poolEuT: 96 });
    }
  });

  test("2.9: the arc furnace map is 1 A, so a 90 EU/t recipe still needs MV", () => {
    const arc = recipe("gt.recipe.arcfurnace", "Arc Furnace", "Arc Furnace", 90, 100, "MV");
    expect(run(arc, "LV", "2.9")).toMatchObject({ tier: "MV", minimumTier: "MV" });
  });

  test("a declared minimum above the EU/t's own tier is a real gate and stands", () => {
    const gated = recipe("gt.recipe.thermalcentrifuge", "Thermal Centrifuge", "Thermal Centrifuge", 48, 500, "HV");
    expect(run(gated, "LV", "2.9")).toMatchObject({ tier: "HV", minimumTier: "HV" });
  });
});
