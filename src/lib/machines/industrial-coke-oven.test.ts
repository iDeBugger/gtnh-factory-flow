import { describe, expect, it } from "vitest";
import type { FactoryNode, MachineConfigControl, Recipe } from "@/lib/model/types";
import { getRecipeCoilTierControl } from "@/lib/model/recipe-rules";
import { normalizeHatchInput } from "@/lib/solver/hatch-input";
import { getOverclockedRecipeStats } from "@/lib/solver/overclock";
import { getNodePowerReport } from "@/lib/solver/power-report";

const control = (id: string, keys: string[]): MachineConfigControl => ({
  id,
  label: id,
  minimumKey: keys[0]!,
  tiers: keys.map((key) => ({ key, label: key, resource: { kind: "item", id: key, amount: 1 } })),
});

// Issue #58's published plan, read September 11, 2026. Compact recipe shape
// preserves the relevant exported stats and config keys:
// gtpp.recipe.cokeoven:6661ae242651d73a, 16 logs -> 20 charcoal + 1500 L tar.
const industrial: Recipe = {
  id: "ico-charcoal",
  name: "Industrial Coke Oven: Charcoal",
  machineType: "Industrial Coke Oven",
  minimumTier: "MV",
  durationTicks: 512,
  eut: 60,
  inputs: [{ kind: "item", id: "minecraft:log@32767", amount: 16 }],
  outputs: [
    { kind: "item", id: "minecraft:coal@1", amount: 20 },
    { kind: "fluid", id: "woodtar", amount: 1500 },
  ],
  machineConfigControls: [
    control("heatingCoil", ["cupronickel", "kanthal"]),
    control("cokeOvenCasing", ["heat_resistant", "heat_proof"]),
    control("cokeOvenSlices", ["slice-1", "slice-2"]),
  ],
};
const node: FactoryNode = {
  id: "ico",
  recipeId: industrial.id,
  enabled: true,
  position: { x: 0, y: 0 },
  machineCount: 1,
  parallel: 1,
  coilTier: "kanthal",
  overclockTier: "EV",
  energyHatches: 1,
};

describe("Industrial Coke Oven issue #58 verification", () => {
  it("keeps a lone EV hatch at one working amp through legacy migration", () => {
    const migrated = normalizeHatchInput(industrial, node, "2.9", true);
    expect(migrated.hatchVoltageTier).toBe("EV");
    expect(migrated.hatchAmps).toBe(1);
    expect(migrated.powerEuT).toBe(2048);
    expect(getNodePowerReport(industrial, migrated, "2.9").amps).toBe(1);
  });

  it("preserves the linked plan's explicit 4096 EU/t budget as 2A at EV", () => {
    const saved = { ...node, energyHatches: 2, powerEuT: 4096 };
    const migrated = normalizeHatchInput(industrial, saved, "2.9", true);
    expect(migrated.hatchAmps).toBe(2);
    expect(migrated.powerEuT).toBe(4096);
    expect(getNodePowerReport(industrial, migrated, "2.9").typedBudget).toBe(true);
  });

  it.each([
    [1, 512, 0, 12.5, 937.5],
    // Two hatches: one alone works at 1A, so a second hatch is what buys the overclock.
    [4, 256, 1, 25, 1875],
  ])(
    "verifies %i EV amp(s) against the game's parallel-first calculation",
    (amps, ticks, overclocks, charcoal, tar) => {
      const configured = { ...node, hatchVoltageTier: "EV" as const, hatchAmps: amps };
      const stats = getOverclockedRecipeStats(industrial, configured, "2.9");
      const power = getNodePowerReport(industrial, configured, "2.9");
      // MTEIndustrialCokeOven: 16 base parallels, Kanthal modifier 0.98^2.
      // A batch costs 922.0 EU/t before overclocking. One 4x-EU normal OC
      // fits into 8192 EU/t but not 2048; duration halves only in that case.
      // The batch's bill is ceiled to a whole EU/t after the steps
      // (GT5U@5.09.54.205 OverclockCalculator.java:421).
      expect(power.parallels).toBe(16);
      expect(stats.durationTicks).toBe(ticks);
      expect(stats.overclockSteps).toBe(overclocks);
      expect(power.drawEuT).toBe(Math.ceil(60 * 16 * 0.98 ** 2 * 4 ** overclocks));
      const operationsPerSecond = (power.parallels * 20) / stats.durationTicks;
      expect(operationsPerSecond * 20).toBe(charcoal);
      expect(operationsPerSecond * 1500).toBe(tar);
    },
  );

  it("keeps the old industrial map label equivalent without giving brick ovens industrial settings", () => {
    const oldLabel = { ...industrial, machineType: "Coke Oven" };
    expect(getOverclockedRecipeStats(oldLabel, node, "2.9")).toEqual(
      getOverclockedRecipeStats(industrial, node, "2.9"),
    );
    const brick: Recipe = {
      id: "brick-charcoal",
      name: "Coke Oven: Charcoal",
      machineType: "Coke Oven",
      minimumTier: "ULV",
      durationTicks: 1800,
      eut: 0,
      inputs: [{ kind: "item", id: "minecraft:log@32767", amount: 1 }],
      outputs: [
        { kind: "item", id: "minecraft:coal@1", amount: 1 },
        { kind: "fluid", id: "creosote", amount: 250 },
      ],
    };
    expect(getRecipeCoilTierControl(brick, {}, "2.9")).toBeUndefined();
    expect(getOverclockedRecipeStats(brick, node, "2.9").durationTicks).toBe(1800);
    expect(getNodePowerReport(brick, node, "2.9").parallels).toBe(1);
    expect(
      normalizeHatchInput(brick, { ...node, recipeId: brick.id }, "2.9", true).hatchAmps,
    ).toBeUndefined();
  });
});
