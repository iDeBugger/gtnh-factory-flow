import { describe, expect, it } from "vitest";
import type { FactoryNode, Recipe } from "@/lib/model/types";
import { applyMachineHandlerToRecipe, getRecipeMachineConfigTierControls } from "@/lib/model/recipe-rules";
import { getMachineDurationMultiplier, getMachineEutMultiplier, getMachineStructuralParallels } from "@/lib/solver/machine-effects";

// MTEMegaDistillationTower#getMaxParallelRecipes and #setProcessingLogicPower (GT5-Unofficial 5.09.54.205): the mode
// is the recipe map. Distillery: 256 * (1 + height / 2), height being the middle slices plus the top; x2 speed, 50% EU.
// Tower: 256 parallels, x1.5 speed, 90% EU.
function recipe(map: string): Recipe {
  return {
    id: map, name: map, machineType: map, source: { recipeMap: map },
    minimumTier: "MV", eut: 120, durationTicks: 600,
    inputs: [{ kind: "fluid", id: "feed", amount: 1000 }],
    outputs: [{ kind: "fluid", id: "fraction", amount: 1000 }],
    machineHandlers: [{
      id: "mega-distillation-tower", label: "Mega Distillation Tower", machineType: "Mega Distillation Tower",
      kind: "multiblock", minimumTier: "IV",
      machineConfigControls: [{
        id: "structure-tower-height", label: "Tower Height", minimumKey: "tower-height-1",
        tiers: [{ key: "tower-height-1", label: "Tower Height 1", parallelMultiplier: 1.5, resource: { kind: "item", id: "stale", amount: 1 } }],
      }],
    }],
  };
}
const node: FactoryNode = {
  id: "mdt", recipeId: "Distillery", machineHandlerId: "mega-distillation-tower",
  enabled: true, machineCount: 1, parallel: 1, position: { x: 0, y: 0 },
  overclockTier: "IV", hatchVoltageTier: "IV", hatchAmps: 1,
};

describe("Mega Distillation Tower modes", () => {
  it("offers its own Tower Height in distillery mode only, never the dataset's", () => {
    const ids = (map: string) =>
      getRecipeMachineConfigTierControls(applyMachineHandlerToRecipe(recipe(map), node, "2.9"), node, "2.9").map((c) => c.id);
    expect(ids("Distillery")).toEqual(["megaDtHeight"]);
    expect(ids("Distillation Tower")).toEqual([]);
  });

  it.each([
    [1, 512],
    [2, 512],
    [3, 768],
    [4, 768],
    [5, 1024],
  ])("runs %i middle slices in distillery mode at %i parallels", (height, parallels) => {
    const configured = { ...node, machineConfigTiers: { megaDtHeight: String(height) } };
    const effective = applyMachineHandlerToRecipe(recipe("Distillery"), configured, "2.9");
    expect(getMachineStructuralParallels(effective, configured, "2.9")).toBe(parallels);
  });

  it("defaults to the full 5 slices, and keeps distillery's speed and EU", () => {
    const effective = applyMachineHandlerToRecipe(recipe("Distillery"), node, "2.9");
    expect(getMachineStructuralParallels(effective, node, "2.9")).toBe(1024);
    expect(getMachineDurationMultiplier(effective, node, "2.9")).toBe(0.5);
    expect(getMachineEutMultiplier(effective, node, "2.9")).toBe(0.5);
  });

  it("runs tower mode at 256 parallels, x1.5 speed and 90% EU at any height", () => {
    const configured = { ...node, machineConfigTiers: { megaDtHeight: "1" } };
    const effective = applyMachineHandlerToRecipe(recipe("Distillation Tower"), configured, "2.9");
    expect(getMachineStructuralParallels(effective, configured, "2.9")).toBe(256);
    expect(getMachineDurationMultiplier(effective, configured, "2.9")).toBeCloseTo(1 / 1.5, 10);
    expect(getMachineEutMultiplier(effective, configured, "2.9")).toBe(0.9);
  });
});
