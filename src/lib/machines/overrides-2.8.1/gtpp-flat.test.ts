import { describe, expect, test } from "vitest";
import type { Recipe } from "@/lib/model/types";
import { getMachineEutMultiplier, getMachineParallelMultiplier } from "@/lib/solver/machine-effects";
import { getOverclockedRecipeStats } from "@/lib/solver/overclock";
import { getMachineBehaviour, getMachineTableControls } from "../machine-table";
import { f32, floatBonus, speedFromBonus } from "../java-float";
import { coefficients } from "./test-helpers";

/** Coil and solenoid both set high: a 2.8.1 number that reads either one is wrong. */
const COILS_SET = { tier: () => 4 };

describe("2.8.1 GT++ flat machines", () => {
  test("Large Thermal Refinery 2.8.1 runs flat 2.5x, 80% EU and 8 per tier with no coil or solenoid", () => {
    const flat = { speed: speedFromBonus(floatBonus(2.5)), power: f32(0.8), parallels: 40 };
    expect(coefficients("Large Thermal Refinery", "2.8.1")).toMatchObject(flat);
    expect(coefficients("Large Thermal Refinery", "2.8.1", COILS_SET)).toMatchObject(flat);
    expect(coefficients("Large Thermal Refinery", "2.8.1").durationMultiplier).toBe(f32(0.4));
    expect(coefficients("Large Thermal Refinery", "2.9")).toMatchObject({ speed: 2.5, power: 0.8, parallels: 44 });
  });

  test("Cryogenic Freezer 2.8.1 runs 2.2x, 90% EU and 8 parallels", () => {
    expect(coefficients("Cryogenic Freezer", "2.8.1")).toMatchObject({
      speed: speedFromBonus(floatBonus(2.2)),
      power: f32(0.9),
      parallels: 8,
    });
    expect(coefficients("Cryogenic Freezer", "2.8.1").durationMultiplier).toBe(f32(1 / f32(2.2)));
    expect(coefficients("Cryogenic Freezer", "2.9")).toMatchObject({ speed: 3, power: 0.9, parallels: 16 });
  });

  test("Industrial Centrifuge 2.8.1 runs flat 2.25x, 90% EU and 6 per tier", () => {
    expect(coefficients("Industrial Centrifuge", "2.8.1")).toMatchObject({
      speed: speedFromBonus(floatBonus(2.25)),
      power: f32(0.9),
      parallels: 30,
    });
    expect(getMachineBehaviour("Industrial Centrifuge", "2.8.1")?.note).toBeUndefined();
    expect(coefficients("Industrial Centrifuge", "2.9")).toMatchObject({ speed: 3, power: 0.9, parallels: 40 });
    expect(getMachineBehaviour("Industrial Centrifuge", "2.9")?.note).toBe("Assumes max speed.");
  });

  test("Industrial Centrifuge 2.8.1 reaches a card on the handler-less Multiblock Centrifuge map", () => {
    // The 2.8.1 map lists no handlers (one machine family), so its cards are named after the map
    // and carry the scraped per-tier knob and the exporter's plain-calculator ladder.
    const card = {
      machineType: "Multiblock Centrifuge",
      source: { recipeMap: "Multiblock Centrifuge" },
      minimumTier: "LV",
      durationTicks: 900,
      eut: 30,
      machineConfigControls: [
        {
          id: "voltageParallel",
          label: "Parallels per Tier",
          minimumKey: "per-tier-6",
          defaultKey: "per-tier-6",
          tiers: [{ key: "per-tier-6", label: "6 per Voltage Tier", parallelPerVoltageTier: 6 }],
        },
      ],
      runtimeCalculation: {
        sourceKind: "gregtech-overclock-calculator",
        recipeMap: "Multiblock Centrifuge",
        status: "computed",
        variants: [{ id: "tier-iv", label: "IV", overclockTier: "IV", durationTicks: 56, eut: 7680, parallel: 1 }],
      },
    } as unknown as Recipe;
    const ivNode = { overclockTier: "IV" as const };
    expect(getMachineBehaviour("Multiblock Centrifuge", "2.8.1")).toBe(
      getMachineBehaviour("Industrial Centrifuge", "2.8.1"),
    );
    expect(getMachineParallelMultiplier(card, ivNode, "2.8.1")).toBe(30);
    expect(getMachineEutMultiplier(card, ivNode, "2.8.1")).toBe(f32(0.9));
    // 30 parallels of ceil(30 x 0.9F) = 27 EU/t is 810 EU/t: one step on IV.
    // (int) (900 x (1F / 2.25F)) = 400 ticks, halved by the step.
    const stats = getOverclockedRecipeStats(card, ivNode, "2.8.1");
    expect(stats.overclockSteps).toBe(1);
    expect(stats.durationTicks).toBe(200);
    // 2.9's map has handlers, so the map name is no table machine there.
    expect(getMachineBehaviour("Multiblock Centrifuge", "2.9")).toBeUndefined();
  });

  test("Industrial Extrusion Machine 2.8.1 runs 3.5x and 4 per tier", () => {
    expect(coefficients("Industrial Extrusion Machine", "2.8.1")).toMatchObject({
      speed: speedFromBonus(floatBonus(3.5)),
      power: 1,
      parallels: 20,
    });
    expect(coefficients("Industrial Extrusion Machine", "2.9")).toMatchObject({ speed: 3.5, power: 1, parallels: 30 });
  });

  test("Multiblock Electrolyzer 2.8.1 runs 2.8x, 90% EU and 2 per tier", () => {
    const flat = { speed: speedFromBonus(floatBonus(2.8)), power: f32(0.9), parallels: 10 };
    expect(coefficients("Multiblock Electrolyzer", "2.8.1")).toMatchObject(flat);
    expect(coefficients("Industrial Electrolyzer", "2.8.1")).toMatchObject(flat);
    expect(coefficients("Multiblock Electrolyzer", "2.9")).toMatchObject({ speed: 2.8, power: 0.9, parallels: 20 });
  });

  test("Dangote Distillus 2.8.1 runs tower mode at 3.5x with 12 parallels", () => {
    const tower = { recipeMap: "Distillation Tower" };
    expect(coefficients("Dangote Distillus", "2.8.1", tower)).toMatchObject({
      speed: speedFromBonus(floatBonus(3.5)),
      power: 1,
      parallels: 12,
    });
    expect(coefficients("Dangote Distillus", "2.9", tower)).toMatchObject({ speed: 3, power: 1, parallels: 12 });
  });

  test("Dangote Distillus 2.8.1 runs distillery mode at 8 per tier at any height", () => {
    for (const h of [3, 12]) {
      expect(coefficients("Dangote Distillus", "2.8.1", { recipeMap: "distillery", value: () => h })).toMatchObject({
        speed: 2,
        power: f32(0.15),
        parallels: 40,
      });
    }
    expect(coefficients("Dangote Distillus", "2.9", { recipeMap: "distillery", value: () => 3 })).toMatchObject({
      speed: 2,
      power: 0.15,
      parallels: 10,
    });
  });

  test("Dangote Distillus 2.8.1 has no height knob", () => {
    const distillery = { machineType: "Dangote Distillus", source: { recipeMap: "Distillery" } } as Recipe;
    expect(getMachineBehaviour("Dangote Distillus", "2.8.1")?.controlsFor?.(distillery, "2.8.1")).toEqual([]);
    expect(getMachineTableControls("Dangote Distillus", distillery, "2.8.1")).toEqual([]);
    expect(getMachineBehaviour("Dangote Distillus", "2.9")?.controlsFor?.(distillery, "2.9")).toHaveLength(1);
  });
});

describe("2.8.1 arc furnaces", () => {
  const arcRecipe90 = { machineType: "Arc Furnace", minimumTier: "LV", durationTicks: 122, eut: 90 } as Recipe;
  const arcRecipe30 = { ...arcRecipe90, eut: 30 } as Recipe;
  const lvNode = { overclockTier: "LV" as const };

  test("Arc Furnace 2.8.1 bills the EU/t as written on 3 amps", () => {
    expect(getMachineEutMultiplier(arcRecipe90, lvNode, "2.8.1")).toBe(1);
    expect(getMachineEutMultiplier(arcRecipe90, lvNode, "2.9")).toBe(3);
    expect(getMachineBehaviour("Arc Furnace", "2.8.1")?.amperage).toBe(3);
    expect(getOverclockedRecipeStats(arcRecipe30, lvNode, "2.8.1").eut).toBe(30);
    expect(getOverclockedRecipeStats(arcRecipe30, lvNode, "2.9").eut).toBe(90);
    // A 90 EU/t recipe's minimum tier is MV from its EU/t, so it runs on MV: 3 A x 128 = 384 EU/t
    // buys one step over 90 in 2.8.1, and none over the 270 EU/t 2.9 bills.
    const mvNode = { overclockTier: "MV" as const };
    expect(getOverclockedRecipeStats(arcRecipe90, mvNode, "2.8.1")).toMatchObject({ overclockSteps: 1, eut: 360, durationTicks: 61 });
    expect(getOverclockedRecipeStats(arcRecipe90, mvNode, "2.9")).toMatchObject({ overclockSteps: 0, eut: 270, durationTicks: 122 });
  });

  test("Short Circuit Heater 2.8.1 bills the EU/t as written on 3 amps", () => {
    expect(coefficients("Short Circuit Heater", "2.8.1").power).toBe(1);
    expect(getMachineBehaviour("Short Circuit Heater", "2.8.1")?.amperage).toBe(3);
    expect(coefficients("Short Circuit Heater", "2.9").power).toBe(3);
    expect(getMachineBehaviour("Short Circuit Heater", "2.9")?.amperage).toBe(3);
  });
});
