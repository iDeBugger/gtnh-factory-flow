import { expect, test, vi } from "vitest";
import { getOverclockedRecipeStats, overclockTiersAbove } from "./overclock";
import { getMachineParallelMultiplier } from "./machine-effects";

// Both versions ceil the bill and the parallel divisor (GT5U@5.09.54.205 and
// GT5U@5.09.51.476); the versions differ here only by the coefficient. The Fluid
// Shaper's 2.8.1 EU discount as the Java computes it is setEuModifier(0.8F) widened to
// double. 6.8b owns the real entry; this file only needs a float coefficient. The Mass
// Solidifier's 0.95 is a test coefficient for the operand-order case.
vi.mock("@/lib/machines/overrides-2.8.1/index", () => ({
  MACHINE_OVERRIDES_2_8_1: {
    "Fluid Shaper": { power: Math.fround(0.8) },
    "Mass Solidifier": { power: 0.95 },
  },
}));

const recipeOn = (machineType: string, eut: number, durationTicks = 200) => ({
  machineType,
  eut,
  durationTicks,
  minimumTier: "LV" as const,
  source: { recipeMap: machineType },
  machineConfigControls: [],
});
const shaper = (eut: number, durationTicks = 200) => recipeOn("Fluid Shaper", eut, durationTicks);
const shaper30 = shaper(30);
const shaper40 = shaper(40);

/** One 1 A hatch at the tier: no width expansions, so 2 parallels per voltage tier. */
const oneHatch = (tier: "LV" | "MV" | "LuV") => ({ overclockTier: tier, energyHatches: 1, machineConfigTiers: {} });
const lvOneHatch = oneHatch("LV");
const mvOneHatch = oneHatch("MV");

test("float modifiers 2.8.1 bill a 30 EU/t Fluid Shaper recipe at 25", () => {
  // GT5U@5.09.51.476 OverclockCalculator.java:341, :406: ceil(30 x 0.8F) = ceil(24.00000036) = 25.
  // 2.9 bills the double 0.8: 24.
  expect(getOverclockedRecipeStats(shaper30, lvOneHatch, "2.8.1").eut).toBe(25);
  expect(getOverclockedRecipeStats(shaper30, lvOneHatch, "2.9").eut).toBe(24);
});

test("float modifiers 2.8.1 cost a 40 EU/t Fluid Shaper recipe a parallel on one MV hatch", () => {
  // GT5U@5.09.51.476 ParallelHelper.java:399, :476: 128 / ceil(40 x 0.8F) = 128 / 33 = 3.
  // 2.9 (GT5U@5.09.54.205 :399, :479) divides by ceil(40 x 0.8) = 32: 4, the structure's MV limit.
  expect(getMachineParallelMultiplier(shaper40, mvOneHatch, "2.8.1")).toBe(3);
  expect(getMachineParallelMultiplier(shaper40, mvOneHatch, "2.9")).toBe(4);
});

test("float modifiers 2.8.1 divide the hatch by the ceiled draw of one parallel", () => {
  // 53 x 0.8 = 42.4: 128 / 42.4 fits 3, but the game divides by ceil(42.4) = 43 and fits 2
  // (GT5U@5.09.51.476 ParallelHelper.java:399, :476; GT5U@5.09.54.205 :399, :479).
  expect(getMachineParallelMultiplier(shaper(53), mvOneHatch, "2.8.1")).toBe(2);
  expect(getMachineParallelMultiplier(shaper(53), mvOneHatch, "2.9")).toBe(2);
});

test("float modifiers 2.8.1 ceil the whole draw of every parallel, then share it", () => {
  // 3 parallels on MV bill ceil(40 x 0.8F x 3) = ceil(96.0000014) = 97 for the three,
  // 97 / 3 per recipe. 2.9 bills 32 each.
  const v281 = getOverclockedRecipeStats(shaper40, mvOneHatch, "2.8.1");
  expect(v281.overclockSteps).toBe(0);
  expect(v281.eut * 3).toBeCloseTo(97, 10);
  expect(getOverclockedRecipeStats(shaper40, mvOneHatch, "2.9").eut).toBe(32);
});

test("float modifiers 2.8.1 ceil after the overclock steps", () => {
  // A 10 EU/t recipe on MV: 4 parallels draw 32.0000005, truncated to 32, and 128 / 32
  // buys one step (OverclockCalculator.java:343). The bill is ceil(32.0000005 x 4) = 129
  // for the four (:406). 2.9: 32 x 4 = 128.
  const r = shaper(10);
  const v281 = getOverclockedRecipeStats(r, mvOneHatch, "2.8.1");
  expect(v281.overclockSteps).toBe(1);
  expect(getMachineParallelMultiplier(r, mvOneHatch, "2.8.1")).toBe(4);
  expect(v281.eut * 4).toBeCloseTo(129, 10);
  const v29 = getOverclockedRecipeStats(r, mvOneHatch, "2.9");
  expect(v29.overclockSteps).toBe(1);
  expect(v29.eut * 4).toBe(128);
});

test("float modifiers 2.8.1 ceil the sub-tick bill as the game runs it", () => {
  // A 1 t Oil Cracker recipe, 143 EU/t at cupronickel's 0.9 = 128.7 on one HV hatch.
  // 2.8.1 takes one step (OverclockCalculator.java:433) and runs two recipes a tick, but
  // the bill counts only the machine's own parallel: setCurrentParallel keeps
  // min(parallel, currentParallel) (:274), so it is ceil(128.7 x 4) = 515 (:406), not
  // a 2-parallel recalculation. 2.9 takes no step there (6.6) and bills ceil(128.7) = 129
  // (GT5U@5.09.54.205 OverclockCalculator.java:382, :421).
  const cracker = {
    machineType: "Oil Cracker",
    eut: 143,
    durationTicks: 1,
    minimumTier: "HV" as const,
    machineConfigControls: [
      {
        id: "heatingCoil",
        label: "Heating Coil",
        minimumKey: "cupronickel",
        tiers: [
          {
            key: "cupronickel",
            label: "Cupronickel",
            heat: 1801,
            resource: { kind: "item" as const, id: "gregtech:gt.blockcasings5", amount: 1 },
          },
        ],
      },
    ],
  };
  const hv = { overclockTier: "HV" as const, coilTier: "cupronickel", energyHatches: 1, machineConfigTiers: {} };
  expect(getOverclockedRecipeStats(cracker, hv, "2.8.1")).toMatchObject({ overclockSteps: 1, durationTicks: 0.5, eut: 515 });
  expect(getOverclockedRecipeStats(cracker, hv, "2.9")).toMatchObject({
    overclockSteps: 0,
    durationTicks: 1,
    eut: 129,
    machineEuT: 129,
  });
});

test("float modifiers 2.8.1 multiply the step-count draw in Java's order", () => {
  // 9 EU/t x 60 parallels x 0.95 is 513 in Java's order (OverclockCalculator.java:341 at
  // GT5U@5.09.51.476, :382 at GT5U@5.09.54.205) but 512.99999 as 9 x 0.95 x 60. 2.8.1
  // truncates the draw (:343), so the order decides the step: 32768 / 513 buys 2, 32768 / 512
  // buys 3. 2.9 rounds to 0.01 EU/t (:513), so the order cannot move its count. Mass Solidifier on one
  // LuV hatch: 10 parallels per voltage tier, 60.
  const r = recipeOn("Mass Solidifier", 9);
  const luvOneHatch = oneHatch("LuV");
  expect(getMachineParallelMultiplier(r, luvOneHatch, "2.8.1")).toBe(60);
  expect(getOverclockedRecipeStats(r, luvOneHatch, "2.8.1")).toMatchObject({ overclockSteps: 2, machineEuT: 8208 });
  // 2.9's Mass Solidifier is the table's 0.8: 432 EU/t buys 3 steps. At 0.95 its rounding
  // gives 2 in either order.
  expect(getOverclockedRecipeStats(r, luvOneHatch, "2.9").overclockSteps).toBe(3);
  expect(overclockTiersAbove(32768, 9 * 60 * 0.95, "2.9")).toBe(2);
  expect(overclockTiersAbove(32768, 9 * 0.95 * 60, "2.9")).toBe(2);
  expect(overclockTiersAbove(32768, 9 * 0.95 * 60, "2.8.1")).toBe(3);
});
