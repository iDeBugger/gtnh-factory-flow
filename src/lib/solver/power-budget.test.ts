import { describe, expect, it } from "vitest";
import type { Recipe } from "@/lib/model/types";
import { getNodePowerReport, describePowerStall } from "./power-report";
import { getEffectiveVoltageOrdinal, getNodePowerAmps, getNodeRunTier } from "./power";
import { getVoltageTierIndex } from "@/lib/model/tiers";

/** A synthetic LCR recipe: the table marks the machine a multiblock. */
function lcrRecipe(eut: number, minimumTier: string): Recipe {
  return {
    id: `lcr-${eut}`,
    name: "LCR test",
    machineType: "Large Chemical Reactor",
    minimumTier,
    durationTicks: 400,
    eut,
    inputs: [],
    outputs: [],
  } as unknown as Recipe;
}

/** A GT++ "tier x 4 parallels" multiblock, to watch the parallel ordinal. */
function icbRecipe(): Recipe {
  return {
    id: "icb-test",
    name: "ICB test",
    machineType: "Industrial Chemical Bath",
    minimumTier: "LV",
    durationTicks: 200,
    eut: 30,
    inputs: [],
    outputs: [],
  } as unknown as Recipe;
}

describe("typed power budget", () => {
  it("reads the tier as the highest voltage inside the budget and the rest as amps", () => {
    // 6,000 EU/t is EV hatches (2,048) carrying 2.93 amps - never an IV hatch
    // fed short. The pool is the typed number, to the EU.
    const recipe = lcrRecipe(480, "HV");
    const node = { overclockTier: "LV", powerEuT: 6000 };
    expect(getNodeRunTier(recipe, node, "2.9")).toBe("EV");
    expect(getNodePowerAmps(recipe, node, "2.9")).toBeCloseTo(6000 / 2048, 9);
    const report = getNodePowerReport(recipe, node, "2.9");
    expect(report.typedBudget).toBe(true);
    expect(report.tier).toBe("EV");
    expect(report.poolEuT).toBeCloseTo(6000, 9);
    expect(report.state).toBe("ok");
    // 6000 / 480 = 12.5: one power-of-four step, not two.
    expect(report.overclockSteps).toBe(1);
  });

  it("overrides the hatch pair while it is set, and the pair returns when it is cleared", () => {
    const recipe = lcrRecipe(480, "HV");
    const typed = getNodePowerReport(recipe, {
      overclockTier: "MV",
      energyHatches: 2,
      powerEuT: 8192,
    }, "2.9");
    expect(typed.tier).toBe("IV");
    expect(typed.overclockSteps).toBe(2);
    const built = getNodePowerReport(recipe, { overclockTier: "MV", energyHatches: 2 }, "2.9");
    expect(built.typedBudget).toBe(false);
    expect(built.tier).toBe("MV");
    expect(built.poolEuT).toBe(512);
  });

  it("is ignored on a singleblock, whose tier is the block", () => {
    const recipe = {
      id: "chem",
      name: "Chem",
      machineType: "Chemical Reactor",
      minimumTier: "LV",
      durationTicks: 10,
      eut: 30,
      inputs: [],
      outputs: [],
      machineHandlers: [
        {
          id: "chemical-reactor",
          label: "Chemical Reactor",
          kind: "single",
          machineType: "Chemical Reactor",
          minimumTier: "LV",
        },
      ],
    } as unknown as Recipe;
    const report = getNodePowerReport(recipe, { overclockTier: "MV", powerEuT: 100000 }, "2.9");
    expect(report.typedBudget).toBe(false);
    expect(report.tier).toBe("MV");
  });

  it("reads a budget as regular hatches for the parallel ordinal: half the budget, floored at the tier", () => {
    // 4 x EV regular hatches = 2,048 x 8 = 16,384 EU/t of pool, and the game
    // sums their voltages (8,192) for the "tier x N parallels" ordinal: IV.
    // The typed 16,384 must land on the same IV ordinal, not LuV.
    const recipe = icbRecipe();
    const built = getEffectiveVoltageOrdinal(recipe, { energyHatches: 4 }, "EV", "2.9");
    const typed = getEffectiveVoltageOrdinal(recipe, { powerEuT: 16384 }, "EV", "2.9");
    expect(typed).toBe(built);
    expect(typed).toBe(getVoltageTierIndex("IV"));
    // One EV hatch's worth (2,048) is one hatch, one amp: still EV.
    expect(getEffectiveVoltageOrdinal(recipe, { powerEuT: 2048 }, "EV", "2.9")).toBe(
      getVoltageTierIndex("EV"),
    );
  });

  it("is under-powered below the draw and names the typed supply", () => {
    const report = getNodePowerReport(lcrRecipe(480, "HV"), {
      overclockTier: "LV",
      powerEuT: 300,
    }, "2.9");
    expect(report.state).toBe("under-powered");
    expect(describePowerStall(report)).toBe(
      "Needs 480 EU/t. Supplied 300.",
    );
  });

  it("reads a zero budget as no supply at all, not as the hatch pair", () => {
    // Subtracting past zero in the calculator lands on 0, and 0 must mean
    // unpowered - never a silent fall back to whatever hatches were stored.
    const report = getNodePowerReport(lcrRecipe(480, "HV"), {
      overclockTier: "HV",
      energyHatches: 2,
      powerEuT: 0,
    }, "2.9");
    expect(report.typedBudget).toBe(true);
    expect(report.poolEuT).toBe(0);
    expect(report.state).toBe("under-powered");
  });

  it("still refuses a recipe more than one tier above the budget's hatch tier", () => {
    // 500 EU/t reads as LV hatches (32) carrying 15.6 amps; a 1,920 EU/t EV
    // recipe is three tiers up, and amps cannot skip more than one.
    const report = getNodePowerReport(lcrRecipe(1920, "EV"), {
      overclockTier: "LV",
      powerEuT: 500,
    }, "2.9");
    expect(report.state).toBe("over-tier");
  });
});
