import { describe, expect, test } from "vitest";
import type { MachineConfigControl, Recipe } from "@/lib/model/types";
import { getMachineEutMultiplier, getMachineSettingWarning, getMachineStructuralParallels } from "@/lib/solver/machine-effects";
import { getOverclockedRecipeStats } from "@/lib/solver/overclock";
import {
  getMachineBehaviour,
  getMachineHiddenControlIds,
  getMachineTableControls,
  OVERCLOCK,
  resolveOverclockSpec,
} from "../machine-table";
import { f32, floatBonus, speedFromBonus } from "../java-float";
import { FORGE_HAMMER_ANVIL_CONTROL } from "./gtpp-knobs";
import { ctx, coefficients } from "./test-helpers";

/** Every knob set high: a 2.8.1 number that reads a knob 2.8.1 lacks is wrong. */
const KNOBS_SET = { tier: () => 3, value: () => 4 };
const ivNode = { overclockTier: "IV" as const };

const card = (machineType: string, controls: MachineConfigControl[] = []) =>
  ({
    machineType,
    source: { recipeMap: machineType },
    minimumTier: "LV",
    durationTicks: 200,
    eut: 30,
    machineConfigControls: controls,
  }) as unknown as Recipe;

const keyed = (id: string, keys: string[]): MachineConfigControl => ({
  id,
  label: id,
  minimumKey: keys[0]!,
  defaultKey: keys[0]!,
  tiers: keys.map((key) => ({ key, label: key, resource: { kind: "item", id: key, amount: 1 } })),
});

describe("2.8.1 GT++ machines whose knob changed or went away", () => {
  test("Industrial Cutting Factory 2.8.1 is flat 3x, 75% EU, 4 per tier", () => {
    const flat = { durationMultiplier: f32(1 / f32(3)), power: f32(0.75), parallels: 20 };
    expect(coefficients("Industrial Cutting Factory", "2.8.1")).toMatchObject(flat);
    expect(coefficients("Industrial Cutting Factory", "2.8.1", KNOBS_SET)).toMatchObject(flat);
    expect(getMachineTableControls("Industrial Cutting Factory", undefined, "2.8.1")).toEqual([]);
    expect(getMachineHiddenControlIds("Industrial Cutting Factory", "2.8.1")).toEqual(["sawblade", "cuttingSawblade"]);
    // 2.9: the sawblade sets all three (Tungsten Titanium Carbide 2.5x, 90%, 2 per tier).
    expect(coefficients("Industrial Cutting Factory", "2.9")).toMatchObject({ speed: 2.5, power: 0.9, parallels: 10 });
    expect(coefficients("Industrial Cutting Factory", "2.9", KNOBS_SET)).toMatchObject({ speed: 4.5, power: 0.6, parallels: 30 });
    expect(getMachineTableControls("Industrial Cutting Factory", undefined, "2.9").map((c) => c.id)).toEqual(["sawblade"]);
    expect(getMachineHiddenControlIds("Industrial Cutting Factory", "2.9")).toEqual([]);
  });

  test("Industrial Cutting Factory 2.8.1 ignores a saved sawblade", () => {
    const cuttingRecipe = card("Industrial Cutting Factory");
    const saved = { ...ivNode, machineConfigTiers: { sawblade: "neutronium" } };
    expect(getMachineStructuralParallels(cuttingRecipe, saved, "2.8.1")).toBe(20);
    expect(getMachineEutMultiplier(cuttingRecipe, saved, "2.8.1")).toBe(f32(0.75));
    expect(getOverclockedRecipeStats(cuttingRecipe, saved, "2.8.1").durationTicks).toBeGreaterThan(0);
    // 2.9 reads it: Neutronium is 4 per tier at 70% EU.
    expect(getMachineStructuralParallels(cuttingRecipe, saved, "2.9")).toBe(20);
    expect(getMachineEutMultiplier(cuttingRecipe, saved, "2.9")).toBe(0.7);
    const transcendent = { ...ivNode, machineConfigTiers: { sawblade: "transcendent-metal" } };
    expect(getMachineStructuralParallels(cuttingRecipe, transcendent, "2.8.1")).toBe(20);
    expect(getMachineStructuralParallels(cuttingRecipe, transcendent, "2.9")).toBe(30);
  });

  test("Industrial Sledgehammer 2.8.1 scales on the anvil, not a solenoid", () => {
    expect(coefficients("Industrial Sledgehammer", "2.8.1", { tier: (id) => (id === "forgeHammerAnvil" ? 3 : 0) }).parallels).toBe(160);
    expect(coefficients("Industrial Sledgehammer", "2.8.1").parallels).toBe(40);
    expect(coefficients("Industrial Sledgehammer", "2.8.1", { tier: (id) => (id === "solenoidCoil" ? 4 : 0) }).parallels).toBe(40);
    expect(coefficients("Industrial Sledgehammer", "2.8.1").speed).toBe(2);
    expect(getMachineTableControls("Industrial Sledgehammer", undefined, "2.8.1")).toEqual([FORGE_HAMMER_ANVIL_CONTROL]);
    expect(FORGE_HAMMER_ANVIL_CONTROL.tiers.map((t) => t.label)).toEqual([
      "Vanilla Anvil",
      "Steel Anvil",
      "Dark Steel or Thaumium Anvil",
      "Void Metal Anvil",
    ]);
    expect(getMachineHiddenControlIds("Industrial Sledgehammer", "2.8.1")).toEqual(["solenoidCoil"]);
    expect(coefficients("Industrial Sledgehammer", "2.9").parallels).toBe(60);
    expect(coefficients("Industrial Sledgehammer", "2.9").speed).toBe(2);
    expect(getMachineTableControls("Industrial Sledgehammer", undefined, "2.9")).toEqual([]);
    expect(getMachineHiddenControlIds("Industrial Sledgehammer", "2.9")).toEqual([]);
  });

  test("Industrial Sledgehammer 2.8.1 reads a saved anvil on a card", () => {
    const hammer = card("Industrial Sledgehammer");
    const voidAnvil = { ...ivNode, machineConfigTiers: { forgeHammerAnvil: "void-metal-anvil" } };
    expect(getMachineStructuralParallels(hammer, voidAnvil, "2.8.1")).toBe(160);
    expect(getMachineStructuralParallels(hammer, ivNode, "2.8.1")).toBe(40);
    // 2.9 has no anvil: the solenoid's MV floor gives 6 x 2 x 5.
    expect(getMachineStructuralParallels(hammer, voidAnvil, "2.9")).toBe(60);
  });

  test("Industrial Maceration Stack 2.8.1 keeps 1.6x with the chip", () => {
    expect(coefficients("Industrial Maceration Stack", "2.8.1", { tier: () => 1 })).toMatchObject({ speed: 1.6, parallels: 40 });
    expect(coefficients("Industrial Maceration Stack", "2.8.1")).toMatchObject({ speed: 1.6, parallels: 10 });
    expect(speedFromBonus(floatBonus(1.6))).toBe(1.6);
    expect(coefficients("Industrial Maceration Stack", "2.9", { tier: () => 1 })).toMatchObject({ speed: 6.4, parallels: 40 });
    expect(coefficients("Industrial Maceration Stack", "2.9")).toMatchObject({ speed: 1.6, parallels: 10 });
  });

  test("Industrial Mixing Machine 2.8.1 is flat 3.5x and 8 per tier with no item pipe", () => {
    const flat = { speed: speedFromBonus(floatBonus(3.5)), power: 1, parallels: 40 };
    expect(coefficients("Industrial Mixing Machine", "2.8.1")).toMatchObject(flat);
    expect(coefficients("Industrial Mixing Machine", "2.8.1", KNOBS_SET)).toMatchObject(flat);
    expect(coefficients("Multiblock Mixer", "2.8.1")).toMatchObject(flat);
    expect(getMachineTableControls("Industrial Mixing Machine", undefined, "2.8.1")).toEqual([]);
    expect(getMachineHiddenControlIds("Industrial Mixing Machine", "2.8.1")).toEqual(["pipeCasing", "itemPipeCasing"]);
    expect(coefficients("Industrial Mixing Machine", "2.9")).toMatchObject({ speed: 3, power: 1, parallels: 40 });
    expect(coefficients("Industrial Mixing Machine", "2.9", KNOBS_SET).speed).toBe(6);
    expect(getMachineTableControls("Industrial Mixing Machine", undefined, "2.9").map((c) => c.id)).toEqual(["itemPipeCasing"]);
    expect(getMachineHiddenControlIds("Industrial Mixing Machine", "2.9")).toEqual(["pipeCasing"]);
  });

  test("Industrial Mixing Machine 2.8.1 ignores a saved item pipe casing", () => {
    const mixer = card("Industrial Mixing Machine");
    const saved = { ...ivNode, machineConfigTiers: { itemPipeCasing: "black-plutonium" } };
    expect(getMachineStructuralParallels(mixer, saved, "2.8.1")).toBe(40);
    expect(getOverclockedRecipeStats(mixer, saved, "2.8.1").durationTicks).toBe(
      getOverclockedRecipeStats(mixer, ivNode, "2.8.1").durationTicks,
    );
    expect(getOverclockedRecipeStats(mixer, saved, "2.9").durationTicks).toBeLessThan(
      getOverclockedRecipeStats(mixer, ivNode, "2.9").durationTicks,
    );
  });

  test("Industrial Wire Factory 2.8.1 is flat 3x, 75% EU and 4 per tier with no item pipe", () => {
    const flat = { speed: speedFromBonus(floatBonus(3)), power: f32(0.75), parallels: 20 };
    expect(coefficients("Industrial Wire Factory", "2.8.1")).toMatchObject(flat);
    expect(coefficients("Industrial Wire Factory", "2.8.1", KNOBS_SET)).toMatchObject(flat);
    expect(getMachineTableControls("Industrial Wire Factory", undefined, "2.8.1")).toEqual([]);
    expect(getMachineHiddenControlIds("Industrial Wire Factory", "2.8.1")).toEqual(["pipeCasing", "itemPipeCasing"]);
    expect(coefficients("Industrial Wire Factory", "2.9")).toMatchObject({ speed: 0.5, power: 0.75, parallels: 20 });
    expect(getMachineTableControls("Industrial Wire Factory", undefined, "2.9").map((c) => c.id)).toEqual(["itemPipeCasing"]);
    expect(getMachineHiddenControlIds("Industrial Wire Factory", "2.9")).toEqual(["pipeCasing"]);
  });

  test("Amazon Warehousing Depot 2.8.1 is flat 6x, 75% EU and 16 per tier with no item pipe", () => {
    const flat = { speed: speedFromBonus(floatBonus(6)), power: f32(0.75), parallels: 80 };
    expect(coefficients("Amazon Warehousing Depot", "2.8.1")).toMatchObject(flat);
    expect(coefficients("Amazon Warehousing Depot", "2.8.1", KNOBS_SET)).toMatchObject(flat);
    expect(getMachineTableControls("Amazon Warehousing Depot", undefined, "2.8.1")).toEqual([]);
    expect(getMachineHiddenControlIds("Amazon Warehousing Depot", "2.8.1")).toEqual(["pipeCasing", "itemPipeCasing"]);
    expect(coefficients("Amazon Warehousing Depot", "2.9")).toMatchObject({ speed: 2, power: 0.75, parallels: 80 });
    expect(getMachineTableControls("Amazon Warehousing Depot", undefined, "2.9").map((c) => c.id)).toEqual(["itemPipeCasing"]);
    expect(getMachineHiddenControlIds("Amazon Warehousing Depot", "2.9")).toEqual(["pipeCasing"]);
  });

  test("Industrial Coke Oven 2.8.1 runs 18 or 30 parallels and 4% less EU per tier", () => {
    const casing = { recipe: { machineConfigControls: [keyed("cokeOvenCasing", ["18", "30"])] } };
    expect(coefficients("Industrial Coke Oven", "2.8.1", { ...casing, tier: () => 1 })).toMatchObject({
      parallels: 30,
      power: Math.fround(Math.fround(80) / 100),
    });
    expect(coefficients("Industrial Coke Oven", "2.8.1", { ...casing, voltageTier: 2 })).toMatchObject({
      parallels: 18,
      power: f32(f32(92) / 100),
    });
    // No casing control: the brick oven, one parallel.
    expect(coefficients("Industrial Coke Oven", "2.8.1").parallels).toBe(1);
    // No coil: the coil knob set high changes nothing.
    expect(coefficients("Industrial Coke Oven", "2.8.1", { ...casing, tier: () => 1 }).power).toBe(
      coefficients("Industrial Coke Oven", "2.8.1", { ...casing, tier: (id) => (id === "heatingCoil" ? 4 : 1) }).power,
    );
    expect(getMachineHiddenControlIds("Industrial Coke Oven", "2.8.1")).toEqual(["heatingCoil", "cokeOvenSlices"]);
    // 2.9: 0.98^(coil + 1), and with no slices one parallel (the brick oven guard).
    expect(coefficients("Industrial Coke Oven", "2.9")).toMatchObject({ parallels: 1, power: 0.98 });
    expect(getMachineHiddenControlIds("Industrial Coke Oven", "2.9")).toEqual([]);
  });

  test("Industrial Coke Oven 2.8.1 overclocks only with a casing control", () => {
    const behaviour = getMachineBehaviour("Industrial Coke Oven", "2.8.1");
    const casing = { recipe: { machineConfigControls: [keyed("cokeOvenCasing", ["18", "30"])] } };
    expect(resolveOverclockSpec(behaviour, ctx("2.8.1", casing))).toEqual(OVERCLOCK.normal());
    expect(resolveOverclockSpec(behaviour, ctx("2.8.1"))).toEqual(OVERCLOCK.none());
    // The Railcraft brick oven under the "Coke Oven" alias has no casing control.
    expect(getMachineBehaviour("Coke Oven", "2.8.1")).toBe(behaviour);
    const brick = card("Coke Oven");
    expect(getMachineStructuralParallels(brick, ivNode, "2.8.1")).toBe(1);
    expect(getOverclockedRecipeStats(brick, ivNode, "2.8.1").overclockSteps).toBe(0);
    expect(getMachineSettingWarning(brick, ivNode, "2.8.1")).toBeUndefined();
    const v29 = getMachineBehaviour("Industrial Coke Oven", "2.9");
    expect(resolveOverclockSpec(v29, ctx("2.9", { value: () => 1 }))).toEqual(OVERCLOCK.normal());
    expect(resolveOverclockSpec(v29, ctx("2.9"))).toEqual(OVERCLOCK.none());
    expect(getMachineStructuralParallels(brick, ivNode, "2.9")).toBe(1);
  });

  test("Industrial Coke Oven 2.8.1 reads the casing key and ignores saved slices and coils", () => {
    const oven = card("Industrial Coke Oven", [keyed("cokeOvenCasing", ["18", "30"])]);
    const heatProof = { ...ivNode, machineConfigTiers: { cokeOvenCasing: "30", cokeOvenSlices: "slice-8", heatingCoil: "infinity" } };
    expect(getMachineStructuralParallels(oven, ivNode, "2.8.1")).toBe(18);
    expect(getMachineStructuralParallels(oven, heatProof, "2.8.1")).toBe(30);
    expect(getMachineEutMultiplier(oven, heatProof, "2.8.1")).toBe(f32(f32(80) / 100));
    expect(getOverclockedRecipeStats(oven, heatProof, "2.8.1").overclockSteps).toBeGreaterThan(0);
    expect(getMachineSettingWarning(oven, heatProof, "2.8.1")).toBeUndefined();
  });

  test("Industrial Coke Oven 2.8.1 reads a converted plan's 2.9 casing key", () => {
    // A 2.9 plan stores the 2.9 keys; the 2.8.1 control keys each casing by its parallels.
    const oven281 = card("Industrial Coke Oven", [keyed("cokeOvenCasing", ["18", "30"])]);
    const converted = {
      ...ivNode,
      machineConfigTiers: { cokeOvenCasing: "heat_proof", cokeOvenSlices: "slice-8", heatingCoil: "infinity" },
    };
    expect(getMachineStructuralParallels(oven281, converted, "2.8.1")).toBe(30);
    const resistant = { ...ivNode, machineConfigTiers: { cokeOvenCasing: "heat_resistant" } };
    expect(getMachineStructuralParallels(oven281, resistant, "2.8.1")).toBe(18);
    expect(getMachineSettingWarning(oven281, converted, "2.8.1")).toBeUndefined();
    // 2.9 twin: the same stored keys on the 2.9 control, 32 + 7 x 16 Heat Proof parallels for 8 slices.
    const oven29 = card("Industrial Coke Oven", [
      keyed("heatingCoil", ["cupronickel", "kanthal"]),
      keyed("cokeOvenCasing", ["heat_resistant", "heat_proof"]),
      keyed("cokeOvenSlices", ["slice-1", "slice-2", "slice-3", "slice-4", "slice-5", "slice-6", "slice-7", "slice-8"]),
    ]);
    expect(getMachineStructuralParallels(oven29, converted, "2.9")).toBe(144);
    expect(getMachineSettingWarning(oven29, converted, "2.9")).toBeUndefined();
  });

  test("Industrial Coke Oven 2.8.1 counts a casing key it does not know as Heat Resistant and says so", () => {
    // A 2.8.1 dataset still on the 2.9 casing keys: the formula takes the default, never 1 parallel.
    const stale = card("Industrial Coke Oven", [keyed("cokeOvenCasing", ["heat_resistant", "heat_proof"])]);
    const heatProof = { ...ivNode, machineConfigTiers: { cokeOvenCasing: "heat_proof" } };
    expect(getMachineStructuralParallels(stale, heatProof, "2.8.1")).toBe(18);
    expect(getOverclockedRecipeStats(stale, heatProof, "2.8.1").overclockSteps).toBeGreaterThan(0);
    expect(getMachineSettingWarning(stale, heatProof, "2.8.1")).toBe(
      "The casing setting could not be read, so this counts Heat Resistant casings: 18 parallels.",
    );
    expect(getMachineSettingWarning(stale, heatProof, "2.9")).toBeUndefined();
  });
});
