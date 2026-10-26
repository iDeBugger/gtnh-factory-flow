import { describe, expect, it } from "vitest";
import type { BoardClipboardPayload } from "@/store/factory-store";
import { computeBlueprintIo } from "./io-stats";

/**
 * A captured chain has every wire that crossed the selection boundary
 * severed, so in a closed plan its bare slots stop the machines dead. The
 * IO stats must heal the cut before solving, or every blueprint saves with
 * blank needs and outputs.
 */
function makeChainPayload(): BoardClipboardPayload {
  return {
    nodes: [
      {
        id: "smelter",
        recipeId: "smelt",
        machineCount: 1,
        solvePin: 1,
        parallel: 1,
        overclockTier: "LV",
        enabled: true,
        position: { x: 0, y: 0 },
      },
      {
        id: "presser",
        recipeId: "press",
        machineCount: 1,
        solvePin: 1,
        parallel: 1,
        overclockTier: "LV",
        enabled: true,
        position: { x: 300, y: 0 },
      },
    ],
    storages: [],
    annotations: [],
    pockets: [],
    edges: [
      {
        id: "e-ingot",
        source: "smelter",
        target: "presser",
        resourceKind: "item",
        resourceId: "iron_ingot",
      },
    ],
    recipes: [
      {
        id: "smelt",
        name: "Smelt",
        machineType: "Electric Furnace",
        minimumTier: "LV",
        durationTicks: 20,
        eut: 30,
        inputs: [{ kind: "item", id: "iron_ore", amount: 1 }],
        outputs: [{ kind: "item", id: "iron_ingot", amount: 1 }],
      },
      {
        id: "press",
        name: "Press",
        machineType: "Bending Machine",
        minimumTier: "LV",
        durationTicks: 20,
        eut: 30,
        inputs: [{ kind: "item", id: "iron_ingot", amount: 1 }],
        outputs: [{ kind: "item", id: "iron_plate", amount: 1 }],
      },
    ],
  };
}

describe("computeBlueprintIo", () => {
  it("reports needs and outputs for a captured chain", () => {
    const io = computeBlueprintIo(makeChainPayload());

    expect(io.needs.map((stat) => stat.resourceId)).toEqual(["iron_ore"]);
    expect(io.needs[0]!.ratePerSecond).toBeCloseTo(1);
    expect(io.outputs.map((stat) => stat.resourceId)).toEqual(["iron_plate"]);
    expect(io.outputs[0]!.ratePerSecond).toBeCloseTo(1);
    expect(io.highestTier).toBe("LV");
  });
});
