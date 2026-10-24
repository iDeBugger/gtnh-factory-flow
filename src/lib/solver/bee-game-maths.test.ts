import { describe, expect, it } from "vitest";
import type { FactoryNode, Recipe } from "@/lib/model/types";
import { applyMachineHandlerToRecipe } from "@/lib/model/recipe-rules";
import { enrichPassiveProductionRecipe } from "@/lib/model/passive-production";
import {
  beeFinalChance,
  beeIndustrialEuPerTick,
  beeIndustrialRateFraction,
} from "@/lib/model/bee-maths";
import { getOverclockedRecipeStats } from "./overclock";
import { getMachineEutMultiplier, getMachineOutputMultiplier } from "./machine-effects";

/**
 * Worked values from the game's code, as the mod's BeesTest has them: Forestry's Bee.getFinalChance and
 * produceStacks (two rolls a product, one a specialty, each at most certain, once a 550-tick cycle) and GregTech's
 * MTEIndustrialApiary. A honey comb at 30% and a specialty at 15%.
 */
function beeRecipe(): Recipe {
  // The plain Apiary is not one of the site's bee machines: the mod posts its cards with this handler first.
  return enrichPassiveProductionRecipe({
    machineHandlers: [
      {
        id: "apiary",
        label: "Apiary",
        machineType: "Apiary",
        minimumTier: "NONE",
        eut: 0,
        kind: "single",
      },
    ],
    id: "bee-test",
    name: "Bee Produce: Test Bee",
    machineType: "Bee Produce",
    minimumTier: "NONE",
    durationTicks: 550,
    eut: 0,
    inputs: [
      {
        kind: "item",
        id: "factoryflow:bee_species:test",
        amount: 1,
        displayName: "Test Bee",
        consumed: false,
      },
    ],
    outputs: [
      {
        kind: "item",
        id: "forestry:beecombs@0",
        amount: 1,
        displayName: "Honey Comb",
        chance: 0.3,
      },
      {
        kind: "item",
        id: "gregtech:gt.comb@18",
        amount: 1,
        displayName: "Special Comb",
        chance: 0.15,
        byproduct: true,
        tooltip: ["Specialty chance: 15%", "Needs preferred climate"],
      },
    ],
    source: { recipeMap: "Bee Produce" },
  } as Recipe);
}

type NodeLike = Pick<
  FactoryNode,
  "machineConfigTiers" | "machineHandlerId" | "overclockTier" | "coilTier"
>;

/** Items a cycle of one output: the engine's amount times chance times the output multiplier. */
function perCycle(housing: string, tiers: Record<string, string>, index = 0) {
  const base = beeRecipe();
  const node = {
    machineConfigTiers: tiers,
    machineHandlerId: housing,
    overclockTier: "MV",
  } as unknown as NodeLike;
  const recipe = applyMachineHandlerToRecipe(base, node, "2.9");
  const output = recipe.outputs[index]!;
  return (
    (output.amount ?? 1) *
    (output.chance ?? 1) *
    getMachineOutputMultiplier(recipe, node, output, "MV", "2.9")
  );
}

describe("bee maths from the game's code", () => {
  it("getFinalChance as Forestry works it", () => {
    expect(beeFinalChance(0.3, 1, 0.1)).toBeCloseTo(0.0495748, 6);
    expect(beeFinalChance(0.3, 1, 10)).toBeCloseTo(0.543577, 6);
    expect(beeFinalChance(0.3, 1, -8000)).toBe(0);
  });

  it("an Apiary rolls a product twice and a specialty once", () => {
    // F(30%) + F(15%) in a plain Apiary, three Proven Frames, a Fast gene.
    expect(perCycle("apiary", {})).toBeCloseTo(0.0841469, 6);
    expect(perCycle("apiary", {}, 1)).toBeCloseTo(0.0345721, 6);
    expect(
      perCycle("apiary", {
        beeFrameSlot1: "forestry:proven",
        beeFrameSlot2: "forestry:proven",
        beeFrameSlot3: "forestry:proven",
      }),
    ).toBeCloseTo(0.5018179, 6);
    expect(perCycle("apiary", { beeSpeedGene: "fast" })).toBeCloseTo(0.0900192, 6);
  });

  it("a Forestry roll is at most certain", () => {
    const tiers = {
      beeFrameSlot1: "magicbees:magic",
      beeFrameSlot2: "magicbees:resilient",
      beeFrameSlot3: "magicbees:magic",
      beeSpeedGene: "blinding",
    };
    // p + t = 7: F(30%) = 0.45 stays below 1, a 100% product caps at one a roll.
    const sure = beeRecipe();
    sure.outputs[0]!.chance = 1;
    const node = {
      machineConfigTiers: tiers,
      machineHandlerId: "magic-apiary",
    } as unknown as NodeLike;
    const recipe = applyMachineHandlerToRecipe(sure, node, "2.9");
    const multiplier = getMachineOutputMultiplier(recipe, node, recipe.outputs[0]!, "MV", "2.9");
    // F(100%) caps at 1; F(50%) is not capped: 1 + F(0.5).
    expect(multiplier).toBeCloseTo(1 + beeFinalChance(0.5, 2, 6.9), 5);
  });

  it("specialties need a jubilant bee, products only a working one", () => {
    expect(perCycle("apiary", { beeEnvironment: "preferred" }, 1)).toBeGreaterThan(0);
    expect(perCycle("apiary", { beeEnvironment: "tolerated" }, 1)).toBe(0);
    expect(perCycle("apiary", { beeEnvironment: "tolerated" })).toBeCloseTo(0.0841469, 6);
    expect(perCycle("apiary", { beeEnvironment: "wrong" })).toBe(0);
  });

  it("an Industrial Apiary is uncapped with t of 8", () => {
    // (F(30%) + F(15%)) per cycle, t = 8 and p = 2; 55.359138 over a 60-cycle life.
    expect(perCycle("industrial-apiary", {}) * 60).toBeCloseTo(55.359138, 4);
    expect(perCycle("industrial-apiary", {}, 1) * 60).toBeCloseTo(0.3790753 * 60, 4);
    // Four production upgrades: p = 4 * 1.2^4.
    expect(
      perCycle("industrial-apiary", {
        beeIndustrialSpeed: "speed-4",
        beeIndustrialProduction: "4",
      }) * 60,
    ).toBeCloseTo(71.359091, 4);
  });

  it("an Industrial Apiary draws 37 * energy * 2^speed + 32 * 4^(speed - 1)", () => {
    expect(beeIndustrialEuPerTick(0, 1)).toBe(37);
    expect(beeIndustrialEuPerTick(4, 1.4 ** 4)).toBe(4322);
    expect(beeIndustrialEuPerTick(8, 1)).toBe(533760);
    expect(beeIndustrialEuPerTick(8, 14.75)).toBe(664000);

    const base = beeRecipe();
    const node = {
      machineConfigTiers: { beeIndustrialSpeed: "speed-4", beeIndustrialProduction: "4" },
      machineHandlerId: "industrial-apiary",
      overclockTier: "MV",
    } as unknown as NodeLike;
    const recipe = applyMachineHandlerToRecipe(base, node, "2.9");
    expect(getMachineEutMultiplier(recipe, node, "2.9") * 37).toBeCloseTo(4322, 6);
    expect(getOverclockedRecipeStats(recipe, node, "2.9").eut).toBeCloseTo(4322, 6);
  });

  it("a short-lived queen cuts the acceleration", () => {
    // Normal lifespan (40 cycles, 60 on HARD) reaches x256.
    expect(beeIndustrialRateFraction(8)).toBe(1);
    // 10 cycles: 15 cycles of life is 8250 ticks, x256 stops at 82 and outputs come 3 times over: 246 of 256.
    expect(beeIndustrialRateFraction(8, 10)).toBeCloseTo(246 / 256, 10);
    // x16 is never cut.
    expect(beeIndustrialRateFraction(4, 10)).toBe(1);
  });

  it("a recipe's own queen life lowers the output rate", () => {
    const base = beeRecipe();
    const node = {
      machineConfigTiers: { beeIndustrialSpeed: "speed-8" },
      machineHandlerId: "industrial-apiary",
      overclockTier: "MV",
    } as unknown as NodeLike;
    const normal = applyMachineHandlerToRecipe(base, node, "2.9");
    const brief = { ...normal, metadata: { beeLifespan: 10 } };
    const out = normal.outputs[0]!;
    expect(
      getMachineOutputMultiplier(brief, node, out, "MV", "2.9") /
        getMachineOutputMultiplier(normal, node, out, "MV", "2.9"),
    ).toBeCloseTo(246 / 256, 10);
  });
});
