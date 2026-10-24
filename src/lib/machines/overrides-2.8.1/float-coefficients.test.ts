import { expect, test } from "vitest";
import type { MachineConfigControl } from "@/lib/model/types";
import { getOverclockedRecipeStats } from "@/lib/solver/overclock";
import { f32, fdiv, floatBonus, powInt, rampCeiling, speedFromBonus } from "../java-float";
import { coefficients } from "./test-helpers";

// 2.8.1 is GT5U 5.09.51.476, 2.9 is GT5U 5.09.54.205. Every 2.8.1 float below has
// a 2.9 twin that pins the .205 value: a double where .205 passes a double, the
// same float where .205 still computes in float.

/** The coefficients' duration multiplier and EU multiplier in a version, with knobs set. */
function at(name: string, gameVersion: "2.8.1" | "2.9", tiers: Record<string, number> = {}) {
  const c = coefficients(name, gameVersion, { tier: (id) => tiers[id] ?? 0 });
  return { duration: c.durationMultiplier, power: c.power };
}

/** Flat machines: the 2.8.1 float literals against .205's doubles. */
const FLAT: { name: string; duration281: number; power281: number; duration29: number; power29: number }[] = [
  // MTEAdvEBF.java:255-256 (.476) / :270-271 (.205)
  { name: "Volcanus", duration281: floatBonus(2.2), power281: f32(0.9), duration29: 1 / 2.2, power29: 0.9 },
  // MTEIndustrialFluidHeater.java:166-167 / :172-173
  { name: "Thermic Heating Device", duration281: floatBonus(2.2), power281: f32(0.9), duration29: 1 / 2.2, power29: 0.9 },
  // MTEIndustrialDehydrator.java:245-246 / :261-262
  { name: "Multiblock Dehydrator", duration281: floatBonus(2.2), power281: 0.5, duration29: 1 / 2.2, power29: 0.5 },
  // MTEIndustrialBrewery.java:187 / :177
  { name: "Big Barrel Brewery", duration281: floatBonus(1.5), power281: 1, duration29: 1 / 1.5, power29: 1 },
  // MTENuclearSaltProcessingPlant.java:205 / :206 (DURATION_MULTIPLIER = 2.5D, :48)
  { name: "Nuclear Salt Processing Plant", duration281: floatBonus(2.5), power281: 1, duration29: 1 / 2.5, power29: 1 },
  // MTEIndustrialWashPlant.java:240 / MTEOreWashingPlant.java:229
  { name: "Ore Washing Plant", duration281: floatBonus(5), power281: 1, duration29: 1 / 5, power29: 1 },
  // MTEIndustrialExtractor.java:205, :207 / :193, :195
  { name: "Dissection Apparatus", duration281: floatBonus(3), power281: f32(0.85), duration29: 1 / 3, power29: 0.85 },
  // MTEMultiLathe.java:260-261 / :259-260
  { name: "Industrial Precision Lathe", duration281: 0.25, power281: f32(0.8), duration29: 0.25, power29: 0.8 },
  // MTEIndustrialLaserEngraver.java:360-361 / :371-372
  { name: "Hyper-Intensity Laser Engraver", duration281: floatBonus(3.5), power281: f32(0.8), duration29: 1 / 3.5, power29: 0.8 },
  // MTEIndustrialCompressor.java:192, :194 / :181, :183
  { name: "Large Electric Compressor", duration281: 0.5, power281: f32(0.9), duration29: 0.5, power29: 0.9 },
  // MTEHIPCompressor.java:364-365 / :340-341
  { name: "Hot Isostatic Pressurization Unit", duration281: floatBonus(3.5), power281: 0.75, duration29: 1 / 3.5, power29: 0.75 },
  // MTEIndustrialSifter.java:189-190 (gtPlusPlus) / :209-210 (gregtech)
  { name: "Large Sifter", duration281: floatBonus(5), power281: 0.75, duration29: 1 / 5, power29: 0.75 },
  // MTEIndustrialPlatePress.java:184 / MTEIndustrialFormingPress.java:196
  { name: "Industrial Forming Press", duration281: floatBonus(6), power281: 1, duration29: 1 / 6, power29: 1 },
  // MTEMassFabricator.java:294 / :275
  { name: "Matter Fabricator", duration281: 1, power281: f32(0.8), duration29: 1, power29: 0.8 },
  // MTEBlackHoleCompressor.java:636-637 / :633-634
  {
    name: "Pseudostable Black Hole Containment Field",
    duration281: f32(0.2),
    power281: f32(0.7),
    duration29: 0.2,
    power29: 0.7,
  },
  // MTEIndustrialChisel.java:291-292 (gtPlusPlus) / :222-223 (gregtech)
  { name: "Industrial 3D Copying Machine", duration281: floatBonus(3), power281: 0.75, duration29: 1 / 3, power29: 0.75 },
];

for (const row of FLAT) {
  test(`${row.name} 2.8.1 coefficients are Java floats`, () => {
    expect(at(row.name, "2.8.1")).toEqual({ duration: row.duration281, power: row.power281 });
    expect(at(row.name, "2.9")).toEqual({ duration: row.duration29, power: row.power29 });
  });
}

test("float modifiers 2.8.1 run a 22-tick Volcanus recipe in 9 ticks", () => {
  // 22 x (1F / 2.2F) = 9.9999996 truncates to 9 (GT5U@5.09.51.476 OverclockCalculator.java:335, :409);
  // 22 x (1.0D / 2.2D) = 10 (GT5U@5.09.54.205). 7680 EU/t at 0.9 fits one parallel and no step on IV.
  const coil: MachineConfigControl = {
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
  const volcanus22t = {
    machineType: "Volcanus",
    minimumTier: "IV" as const,
    durationTicks: 22,
    eut: 7680,
    nei: { additionalInfo: ["Special value: 1800"] },
    machineConfigControls: [coil],
  };
  const ivNoSpareVoltage = { overclockTier: "IV" as const, energyHatches: 1, coilTier: "cupronickel" };
  const v281 = getOverclockedRecipeStats(volcanus22t, ivNoSpareVoltage, "2.8.1");
  const v29 = getOverclockedRecipeStats(volcanus22t, ivNoSpareVoltage, "2.9");
  expect([v281.overclockSteps, v29.overclockSteps]).toEqual([0, 0]);
  expect(v281.durationTicks).toBe(9);
  expect(v29.durationTicks).toBe(10);
});

test("Chemical Plant 2.8.1 coefficients are Java floats", () => {
  // GT5U@5.09.51.476 MTEChemicalPlant.java:655 setSpeedBonus(2F / (1 + coil));
  // GT5U@5.09.54.205 :637 2.0D / (1.0D + coil).
  for (let coil = 0; coil <= 13; coil++) {
    expect(at("Chemical Plant", "2.8.1", { heatingCoil: coil }).duration).toBe(fdiv(2, 1 + coil));
    expect(at("Chemical Plant", "2.9", { heatingCoil: coil }).duration).toBe(2 / (1 + coil));
  }
  expect(at("Chemical Plant", "2.8.1", { heatingCoil: 2 }).duration).not.toBe(2 / 3);
});

test("Pyrolyse Oven 2.8.1 coefficients are Java floats", () => {
  // GT5U@5.09.51.476 MTEPyrolyseOven.java:157 setSpeedBonus(2f / (1 + coil));
  // GT5U@5.09.54.205 :175 2.0D / (1.0D + coil).
  for (let coil = 0; coil <= 13; coil++) {
    expect(at("Pyrolyse Oven", "2.8.1", { heatingCoil: coil }).duration).toBe(fdiv(2, 1 + coil));
    expect(at("Pyrolyse Oven", "2.9", { heatingCoil: coil }).duration).toBe(2 / (1 + coil));
  }
});

test("Oil Cracker 2.8.1 coefficients are Java floats", () => {
  // 1.0F - min(0.1F x (coil + 1), 0.5F) in both versions: GT5U@5.09.51.476 MTEOilCracker.java:186,
  // GT5U@5.09.54.205 :197. The float, not the double 0.9, is .205's value too.
  for (let coil = 0; coil <= 13; coil++) {
    const float = f32(1 - Math.min(f32(f32(0.1) * (coil + 1)), f32(0.5)));
    expect(at("Oil Cracker", "2.8.1", { heatingCoil: coil }).power).toBe(float);
    expect(at("Oil Cracker", "2.9", { heatingCoil: coil }).power).toBe(float);
  }
  expect(at("Oil Cracker", "2.9").power).toBe(0.8999999761581421);
});

test("Large Scale Auto-Assembler v1.01 2.8.1 coefficients are Java floats", () => {
  // setSpeedBonus(1F / 3F) in both versions: GT5U@5.09.51.476 MTEAutoCrafter.java:154,
  // GT5U@5.09.54.205 :162.
  expect(at("Large Scale Auto-Assembler v1.01", "2.8.1").duration).toBe(floatBonus(3));
  expect(at("Large Scale Auto-Assembler v1.01", "2.9").duration).toBe(floatBonus(3));
});

test("Mega Alloy Blast Smelter 2.8.1 coefficients are Java floats", () => {
  // speedBonus = 1 - 0.05f x bonusTier and energyDiscount = powInt(0.95, n) in both versions:
  // GT5U@5.09.51.476 MTEMegaAlloyBlastSmelter.java:238, :248; GT5U@5.09.54.205 :245, :255.
  for (const gameVersion of ["2.8.1", "2.9"] as const) {
    for (let coil = 0; coil <= 13; coil++) {
      const c = coefficients("Mega Alloy Blast Smelter", gameVersion, {
        tier: () => coil,
        recipeVoltageTier: 1,
      });
      expect(c.durationMultiplier).toBe(f32(1 - f32(f32(0.05) * Math.max(0, coil - 3))));
      expect(c.power).toBe(powInt(0.95, coil));
    }
  }
  // 0.95^4 by squaring is 0.81450625; Math.pow gives 0.8145062499999999.
  expect(coefficients("Mega Alloy Blast Smelter", "2.9", { tier: () => 4, recipeVoltageTier: 1 }).power).toBe(
    0.81450625,
  );
});

test("Fluid Shaper 2.8.1 coefficients are Java floats", () => {
  // GT5U@5.09.51.476 MTEMultiSolidifier.java:314, :318, :324-326: a float ramp that stops at 3.0000029,
  // setSpeedBonus(1F / speedup), setEuModifier(0.8F). GT5U@5.09.54.205 MTEFluidShaper.java:303, :308,
  // :314-316: a double ramp that stops at 3.025 and setEuModifier(0.8D).
  expect(rampCeiling(1, 0.025, 3, true)).toBe(f32(3.000002861022949));
  expect(rampCeiling(1, 0.025, 3, false)).toBe(3.024999999999993);
  expect(at("Fluid Shaper", "2.8.1")).toEqual({ duration: fdiv(1, f32(3.000002861022949)), power: f32(0.8) });
  expect(at("Fluid Shaper", "2.9")).toEqual({ duration: 1 / 3.024999999999993, power: 0.8 });
  // A 30-tick recipe runs 9 ticks on both: 9.99999 on 2.8.1, 9.917 on 2.9.
  const recipe = {
    machineType: "Fluid Shaper",
    minimumTier: "LV" as const,
    durationTicks: 30,
    eut: 30,
    source: { recipeMap: "Fluid Shaper" },
    machineConfigControls: [],
  };
  const lv = { overclockTier: "LV" as const, energyHatches: 1, machineConfigTiers: {} };
  expect(getOverclockedRecipeStats(recipe, lv, "2.8.1").durationTicks).toBe(9);
  expect(getOverclockedRecipeStats(recipe, lv, "2.9").durationTicks).toBe(9);
});

test("Mass Solidifier 2.9 runs at the double ramp's 3.025", () => {
  // GT5U@5.09.54.205 MTEMassSolidifier.java:199-201, :326: 1.0D / speedup at 3.025. Absent in 2.8.1.
  expect(at("Mass Solidifier", "2.9")).toEqual({ duration: 1 / 3.024999999999993, power: 0.8 });
});

test("Endothermic Fridge 2.9 runs at the float 1f / 1.5f", () => {
  // GT5U@5.09.54.205 MTEEndothermicFridge.java:402, :430, :447: a float speedBoost capped at 1.5f.
  // Absent in 2.8.1.
  expect(at("Endothermic Fridge", "2.9").duration).toBe(floatBonus(1.5));
});

test("Magnetic Flux Exhibitor 2.8.1 coefficients are Java floats", () => {
  // GT5U@5.09.51.476 MTEIndustrialElectromagneticSeparator.java:67-81 float magnets;
  // GT5U@5.09.54.205 :72-86 double magnets.
  const magnets = [
    [0.8, 1.1],
    [0.75, 1.25],
    [0.7, 1.5],
    [0.6, 2],
    [0.5, 2.5],
  ];
  magnets.forEach(([power, speed], tier) => {
    expect(at("Magnetic Flux Exhibitor", "2.8.1", { electromagnet: tier })).toEqual({
      duration: floatBonus(speed),
      power: f32(power),
    });
    expect(at("Magnetic Flux Exhibitor", "2.9", { electromagnet: tier })).toEqual({ duration: 1 / speed, power });
  });
});

test("Industrial Autoclave 2.8.1 coefficients are Java floats", () => {
  // GT5U@5.09.51.476 MTEMultiAutoclave.java:311-316 (float); GT5U@5.09.54.205 :295-300 (double).
  // Fluid pipe and coil count from 1 in the Java.
  for (let coil = 0; coil <= 13; coil++) {
    for (let pipe = 0; pipe <= 3; pipe++) {
      const tiers = { heatingCoil: coil, pipeCasing: pipe };
      expect(at("Industrial Autoclave", "2.8.1", tiers)).toEqual({
        duration: fdiv(1, 1 + f32(0.25) * (coil + 1)),
        power: fdiv(12 - (pipe + 1), 12),
      });
      expect(at("Industrial Autoclave", "2.9", tiers)).toEqual({
        duration: 1 / (1 + 0.25 * (coil + 1)),
        power: (12 - (pipe + 1)) / 12,
      });
    }
  }
});

test("Large Fluid Extractor 2.8.1 coefficients are Java floats", () => {
  // GT5U@5.09.51.476 MTELargeFluidExtractor.java:204-205, :399-412: floats.
  // GT5U@5.09.54.205 :366-379: doubles, the discount by GTUtility.powInt.
  for (let coil = 0; coil <= 13; coil++) {
    const tiers = { heatingCoil: coil };
    expect(at("Large Fluid Extractor", "2.8.1", tiers)).toEqual({
      duration: fdiv(1, f32(1.5 + f32(0.1 * coil))),
      power: f32(0.8 * powInt(0.9, coil)),
    });
    expect(at("Large Fluid Extractor", "2.9", tiers)).toEqual({
      duration: 1 / (1.5 + 0.1 * coil),
      power: 0.8 * powInt(0.9, coil),
    });
  }
  expect(at("Large Fluid Extractor", "2.9", { heatingCoil: 4 }).power).toBe(0.8 * 0.6561000000000001);
});

test("float modifiers 2.8.1 speeds give back the Java duration multiplier", () => {
  // The table states throughput; the duration is 1 / speed, which must read the Java's float back.
  for (const d of [1.1, 1.25, 1.5, 2.2, 2.5, 3, 3.5, 5, 6]) {
    expect(1 / speedFromBonus(floatBonus(d))).toBe(floatBonus(d));
  }
});
