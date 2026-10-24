import { describe, expect, test } from "vitest";
import type { Recipe } from "@/lib/model/types";
import { getMachineParallelMultiplier } from "@/lib/solver/machine-effects";
import {
  getMachineBehaviour,
  getMachineHiddenControlIds,
  getMachineTableControls,
  machineTableSeedsFromBase,
} from "../machine-table";
import { coefficients } from "./test-helpers";

// A 30 EU/t recipe on one regular HV hatch (512 V, 2 A): mega-style power reads
// getMaxInputEu() = 1024 EU/t, the base rule clamps a lone hatch to 512.
const mcr30 = { machineType: "Mega Chemical Reactor", eut: 30, durationTicks: 100, minimumTier: "LV" as const };
const hvOneHatch = { overclockTier: "HV" as const, energyHatches: 1 };
const distilleryRecipe: Partial<Recipe> = { machineType: "Distillery", source: { recipeMap: "Distillery" } };
const towerRecipe: Partial<Recipe> = { machineType: "Distillation Tower", source: { recipeMap: "Distillation Tower" } };

describe("mega machines in 2.8.1", () => {
  // GT5U@5.09.51.476 bartworks/common/tileentities/multis/mega/MegaMultiBlockBase.java:136
  // GT5U@5.09.54.205 MTEMegaChemicalReactor extends MTEExtendedPowerMultiBlockBase (line 52), base hatch power.
  test("Mega Chemical Reactor 2.8.1 draws both amps of a lone hatch", () => {
    expect(getMachineParallelMultiplier(mcr30, hvOneHatch, "2.8.1")).toBe(34); // 1024 / 30
    expect(getMachineParallelMultiplier(mcr30, hvOneHatch, "2.9")).toBe(17); // 512 / 30
  });

  test("Mega Chemical Reactor 2.8.1 keeps perfect overclocks and 256 parallels", () => {
    for (const version of ["2.8.1", "2.9"] as const) {
      expect(coefficients("Mega Chemical Reactor", version).parallels).toBe(256);
      expect(getMachineBehaviour("Mega Chemical Reactor", version)?.unlimitedTierSkip).toBe(true);
    }
    expect(getMachineBehaviour("Mega Chemical Reactor", "2.8.1")?.overclock).toBe(
      getMachineBehaviour("Mega Chemical Reactor", "2.9")?.overclock,
    );
    expect(getMachineBehaviour("Mega Chemical Reactor", "2.9")?.fullPowerPool).toBeUndefined();
  });

  // GT5U@5.09.51.476 bartworks/common/tileentities/multis/mega/MTEMegaOilCracker.java:223
  // GT5U@5.09.54.205 gregtech/common/tileentities/machines/multi/MTEMegaOilCracker.java:468
  test("Mega Oil Cracker 2.8.1 caps its coil discount at half", () => {
    expect(coefficients("Mega Oil Cracker", "2.8.1", { tier: () => 9 }).power).toBe(0.5);
    expect(coefficients("Mega Oil Cracker", "2.9", { tier: () => 9 }).power).toBeCloseTo(0.9 ** 10, 12);
    expect(coefficients("Mega Oil Cracker", "2.8.1").power).toBe(Math.fround(1 - Math.fround(Math.fround(0.1) * 1)));
    expect(coefficients("Mega Oil Cracker", "2.9").power).toBe(0.9);
    // A coil between the first and the cap: Java's 1.0F - 0.1F * 2 is the float 0.8, 0.800000011920929.
    expect(coefficients("Mega Oil Cracker", "2.8.1", { tier: () => 1 }).power).toBe(0.800000011920929);
    expect(coefficients("Mega Oil Cracker", "2.9", { tier: () => 1 }).power).toBeCloseTo(0.9 ** 2, 12);
  });

  test("Mega Oil Cracker 2.8.1 keeps 256 parallels and the mega power pool", () => {
    for (const version of ["2.8.1", "2.9"] as const) {
      expect(coefficients("Mega Oil Cracker", version).parallels).toBe(256);
      expect(getMachineBehaviour("Mega Oil Cracker", version)?.fullPowerPool).toBe(true);
    }
  });

  // GT5U@5.09.51.476 bartworks/common/tileentities/multis/mega/MTEMegaDistillTower.java:250,392,397
  // GT5U@5.09.54.205 gregtech/common/tileentities/machines/multi/MTEMegaDistillationTower.java:507,541-552
  test("Mega Distillation Tower 2.8.1 has no bonus and no distillery mode", () => {
    expect(coefficients("Mega Distillation Tower", "2.8.1", { recipeMap: "distillery" })).toMatchObject({
      speed: 1,
      power: 1,
      parallels: 256,
    });
    expect(coefficients("Mega Distillation Tower", "2.8.1", { recipeMap: "Distillation Tower" })).toMatchObject({
      speed: 1,
      power: 1,
      parallels: 256,
    });
    expect(getMachineTableControls("Mega Distillation Tower", distilleryRecipe, "2.8.1")).toEqual([]);
    expect(getMachineTableControls("Mega Distillation Tower", towerRecipe, "2.8.1")).toEqual([]);
    expect(getMachineBehaviour("Mega Distillation Tower", "2.8.1")?.note).toBeUndefined();
    expect(getMachineHiddenControlIds("Mega Distillation Tower", "2.8.1")).toContain("structure-tower-height");
    expect(getMachineBehaviour("Mega Distillation Tower", "2.8.1")?.fullPowerPool).toBe(true);

    expect(coefficients("Mega Distillation Tower", "2.9", { recipeMap: "distillery" })).toMatchObject({
      speed: 2,
      power: 0.5,
    });
    expect(coefficients("Mega Distillation Tower", "2.9", { recipeMap: "Distillation Tower" })).toMatchObject({
      speed: 1.5,
      power: 0.9,
      parallels: 256,
    });
    expect(getMachineTableControls("Mega Distillation Tower", distilleryRecipe, "2.9").map((c) => c.id)).toEqual([
      "megaDtHeight",
    ]);
    expect(getMachineBehaviour("Mega Distillation Tower", "2.9")?.note).toMatch(/^Distillery mode/);
    expect(getMachineHiddenControlIds("Mega Distillation Tower", "2.9")).toContain("structure-tower-height");
  });

  test("Mega Distillation Tower 2.8.1 still seeds from the map's base", () => {
    expect(machineTableSeedsFromBase("Mega Distillation Tower", "2.8.1")).toBe(true);
    expect(machineTableSeedsFromBase("Mega Distillation Tower", "2.9")).toBe(true);
  });

  // GT5U@5.09.51.476 goodgenerator/blocks/tileEntity/MTEFuelRefineFactory.java:204-228 (no getMaxParallelRecipes)
  // GT5U@5.09.54.205 gregtech/common/tileentities/machines/multi/MTENaquadahFuelRefinery.java:285-292
  test("Naquadah Fuel Refinery 2.8.1 runs one parallel on the mega power pool", () => {
    expect(coefficients("Naquadah Fuel Refinery", "2.8.1", { tier: () => 3 }).parallels).toBe(1);
    expect(coefficients("Naquadah Fuel Refinery", "2.9", { tier: () => 3 }).parallels).toBe(16);
    expect(getMachineBehaviour("Naquadah Fuel Refinery", "2.8.1")?.fullPowerPool).toBe(true);
    expect(getMachineBehaviour("Naquadah Fuel Refinery", "2.9")?.fullPowerPool).toBeUndefined();
    expect(getMachineBehaviour("Naquadah Fuel Refinery", "2.8.1")?.overclock).toBe(
      getMachineBehaviour("Naquadah Fuel Refinery", "2.9")?.overclock,
    );
  });
});
