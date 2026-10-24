import { describe, expect, test } from "vitest";
import { getOverclockedRecipeStats, overclockTiersAbove } from "./overclock";
import { hasAmperageOverclock } from "./power-input-rules";
import { getMachineBehaviour } from "@/lib/machines/machine-table";
import type { FactoryNode, MachineConfigControl, Recipe } from "@/lib/model/types";
import { workingLines } from "@/components/flow/clean/menus/working-lines";

/** Cupronickel is the cracker's first coil: a 10% discount, so 143 EU/t draws 128.7. */
function coilControl(): MachineConfigControl {
  return {
    id: "heatingCoil",
    label: "Heating Coil",
    minimumKey: "cupronickel",
    tiers: [
      {
        key: "cupronickel",
        label: "Cupronickel",
        heat: 1801,
        resource: { kind: "item", id: "gregtech:gt.blockcasings5", amount: 1 },
      },
    ],
  };
}

const oilCracker = {
  machineType: "Oil Cracker",
  eut: 143,
  durationTicks: 200,
  minimumTier: "HV" as const,
  machineConfigControls: [coilControl()],
};

/** One HV energy hatch: 1 A at 512 EU/t. */
const hvOneHatch = {
  overclockTier: "HV" as const,
  coilTier: "cupronickel",
  energyHatches: 1,
  machineConfigTiers: {},
};

describe("overclock step count on 2.8.1", () => {
  test("standard OC 2.8.1 counts the Oil Cracker by amperage, as 2.9 does", () => {
    expect(hasAmperageOverclock("Oil Cracker", "2.9")).toBe(true);
    expect(hasAmperageOverclock("Oil Cracker", "2.8.1")).toBe(true);
  });

  test("standard OC 2.8.1 truncates a fractional draw before counting steps", () => {
    const r = { ...oilCracker, eut: 143, durationTicks: 200 };
    expect(getOverclockedRecipeStats(r, hvOneHatch, "2.9")).toMatchObject({ overclockSteps: 0, durationTicks: 200 });
    expect(getOverclockedRecipeStats(r, hvOneHatch, "2.8.1")).toMatchObject({ overclockSteps: 1, durationTicks: 100 });
  });

  test("standard OC 2.8.1 floors the draw on the sub-tick path too", () => {
    const r = { ...oilCracker, eut: 143, durationTicks: 1 };
    // 2.9 counts the sub-tick parallels with the same getTiersAbove as the time
    // (GT5U@5.09.54.205 OverclockCalculator.java:446, :513): 51200 / 12870 buys no step.
    expect(getOverclockedRecipeStats(r, hvOneHatch, "2.9")).toMatchObject({ overclockSteps: 0, durationTicks: 1 });
    expect(getOverclockedRecipeStats(r, hvOneHatch, "2.8.1")).toMatchObject({ overclockSteps: 1, durationTicks: 0.5 });
  });

  test("standard OC 2.8.1 working lines divide by the same draw as the solve", () => {
    const node = { id: "n", recipeId: "r", ...hvOneHatch } as unknown as FactoryNode;
    for (const durationTicks of [200, 1]) {
      const r = { ...oilCracker, eut: 143, durationTicks } as unknown as Recipe;
      const lines = (v: string) => workingLines(r, node, v);
      expect(lines("2.9").find((l) => l.label === "overclocks")).toMatchObject({
        result: "none",
        math: ["⌊log4(512 / 128.7)⌋"],
      });
      expect(lines("2.8.1").find((l) => l.label === "overclocks")).toMatchObject({
        result: "1",
        math: ["⌊log4(512 / 128)⌋"],
      });
    }
  });

  test("a working line shows a draw near a step boundary to the hundredth the count reads", () => {
    // 142.27 EU/t at 90% power draws 128.04: past the step on 2.9, so the line must not read 512 / 128.
    const node = { id: "n", recipeId: "r", ...hvOneHatch } as unknown as FactoryNode;
    const r = { ...oilCracker, eut: 142.27, durationTicks: 200 } as unknown as Recipe;
    expect(workingLines(r, node, "2.9").find((l) => l.label === "overclocks")).toMatchObject({
      result: "none",
      math: ["⌊log4(512 / 128.04)⌋"],
    });
  });

  test("standard OC 2.8.1 truncates both sides where 2.9 rounds them to 0.01 EU/t", () => {
    // 2.9: getTiersAbove (GT5U@5.09.54.205 OverclockCalculator.java:513) rounds both
    // sides to 0.01 and divides. The planner's former ceil lost a step on each of these.
    expect(overclockTiersAbove(512, 128.004, "2.9")).toBe(1);
    expect(overclockTiersAbove(512, 128 + 1e-9, "2.9")).toBe(1);
    expect(overclockTiersAbove(511.996, 128, "2.9")).toBe(1);
    // Past half a hundredth the draw no longer fits.
    expect(overclockTiersAbove(512, 128.006, "2.9")).toBe(0);
    expect(overclockTiersAbove(512, 128.7, "2.9")).toBe(0);
    // Under 32 EU/t the draw is billed as 32 in both versions.
    expect(overclockTiersAbove(512, 20, "2.9")).toBe(2);
    expect(overclockTiersAbove(512, 20, "2.8.1")).toBe(2);
    // 2.8.1: (long) machinePower / max((long) recipePower, 32) (GT5U@5.09.51.476 :343).
    expect(overclockTiersAbove(512, 128.004, "2.8.1")).toBe(1);
    expect(overclockTiersAbove(512, 128.7, "2.8.1")).toBe(1);
    expect(overclockTiersAbove(511.996, 128, "2.8.1")).toBe(0);
  });

  test("standard OC 2.8.1 counts a cracker draw just over a step as 2.9 does", () => {
    // 142.226 EU/t at 90% power draws 128.0034, which fits one step in 512 on both versions.
    const r = { ...oilCracker, eut: 142.226, durationTicks: 200 };
    expect(getOverclockedRecipeStats(r, hvOneHatch, "2.9")).toMatchObject({ overclockSteps: 1, durationTicks: 100 });
    expect(getOverclockedRecipeStats(r, hvOneHatch, "2.8.1")).toMatchObject({ overclockSteps: 1, durationTicks: 100 });
  });

  test("laser OC is not modelled in either version", () => {
    // No table machine is an Advanced Assembly Line, the only laser-OC machine in both versions.
    for (const v of ["2.9", "2.8.1"] as const) expect(getMachineBehaviour("Advanced Assembly Line", v)).toBeUndefined();
  });
});
