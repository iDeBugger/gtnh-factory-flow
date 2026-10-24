import { describe, expect, it } from "vitest";
import type { Recipe } from "@/lib/model/types";
import { getHeatOverclockStats } from "@/lib/solver/heat";
import { powInt } from "./java-float";
import { coefficients } from "./overrides-2.8.1/test-helpers";

/**
 * Where GT5U 5.09.54.205 builds a coefficient with GTUtility.powInt (square-and-multiply in
 * double), the planner does too: Math.pow rounds differently in the last bit from the third or
 * fourth power on.
 */
describe("2.9 coefficients built with GTUtility.powInt", () => {
  const coil = (tier: number) => ({ tier: (id: string) => (id === "heatingCoil" ? tier : 0) });

  it("Mega Oil Cracker bills powInt(0.9, coil tier + 1)", () => {
    // GT5U@5.09.54.205 gregtech/common/tileentities/machines/multi/MTEMegaOilCracker.java:468-469
    expect(Math.pow(0.9, 4)).not.toBe(powInt(0.9, 4));
    expect(coefficients("Mega Oil Cracker", "2.9", coil(3)).power).toBe(powInt(0.9, 4));
  });

  it("Large Thermal Refinery bills 0.8 x powInt(0.95, coil tier)", () => {
    // GT5U@5.09.54.205 gregtech/common/tileentities/machines/multi/MTEIndustrialThermalCentrifuge.java:275-279
    expect(0.8 * Math.pow(0.95, 5)).not.toBe(0.8 * powInt(0.95, 5));
    expect(coefficients("Large Thermal Refinery", "2.9", coil(5)).power).toBe(
      0.8 * powInt(0.95, 5),
    );
  });

  it("Industrial Coke Oven bills powInt(0.98, coil tier + 1)", () => {
    // GT5U@5.09.54.205 gregtech/common/tileentities/machines/multi/MTEIndustrialCokeOven.java:366-367, :379-380
    expect(0.98 ** 5).not.toBe(powInt(0.98, 5));
    expect(coefficients("Industrial Coke Oven", "2.9", coil(4)).power).toBe(powInt(0.98, 5));
  });
});

describe("the heat discount on both versions", () => {
  // OverclockCalculator.calculateHeatDiscountMultiplier: powInt(0.95, excess heat / 900)
  // (GT5U@5.09.54.205 gregtech/api/util/OverclockCalculator.java:346-349;
  // GT5U@5.09.51.476 gregtech/api/util/OverclockCalculator.java:327-330).
  const recipe: Recipe = {
    id: "vacuum-cold",
    name: "Vacuum Furnace",
    machineType: "Vacuum Furnace",
    minimumTier: "LuV",
    durationTicks: 1200,
    eut: 30720,
    source: { recipeMap: "Vacuum Furnace" },
    nei: { additionalInfo: ["Special value: 0"] },
    inputs: [],
    outputs: [],
  };
  for (const gameVersion of ["2.9", "2.8.1"] as const) {
    it(`discounts in powInt on ${gameVersion}`, () => {
      const stats = getHeatOverclockStats(recipe, { coilTier: "trinium" }, "UV", 3, gameVersion);
      const discounts = Math.round(Math.log(stats.heatDiscountMultiplier) / Math.log(0.95));
      expect(discounts).toBeGreaterThanOrEqual(4);
      expect(0.95 ** discounts).not.toBe(powInt(0.95, discounts));
      expect(stats.heatDiscountMultiplier).toBe(powInt(0.95, discounts));
    });
  }
});
