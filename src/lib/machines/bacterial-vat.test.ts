import { describe, expect, it } from "vitest";
import { formulaText } from "./formula-lines";
import {
  radioMaterials,
  applyVatInputs,
  effectiveSievert,
  getVatControls,
  getVatFormulas,
  getVatGateReason,
  getVatMultiplier,
  getVatRequirements,
  getVatSettings,
  radioDecayTicks,
  vatMultiplierAt,
} from "./bacterial-vat";
import { calculateThroughput } from "@/lib/solver/throughput";
import { PROJECT_SCHEMA_VERSION, type FactoryProject, type Recipe } from "@/lib/model/types";

// Values from GT5U 5.09.54.205's MTEBioVat and MTERadioHatch (javap), docs/design/bio-vat-and-tgs.md.

/** The fermenter's Biomass recipe, mirrored into the vat (RecipeMaps.java:701-706): HV glass, no radiation. */
const biomass: Recipe = {
  id: "vat-biomass",
  name: "Bacterial Vat: Fermented Biomass",
  machineType: "Bacterial Vat",
  minimumTier: "ULV",
  durationTicks: 150,
  eut: 2,
  inputs: [
    {
      kind: "item",
      id: "bartworks:biolabparts",
      amount: 1,
      consumed: false,
      tooltip: ['NBT: {Name:"Saccharomyces escherichia"}'],
    },
    { kind: "fluid", id: "biomass", amount: 100 },
  ],
  outputs: [{ kind: "fluid", id: "fermentedbiomass", amount: 100 }],
};

/** An exact-radiation recipe (NHCore BacteriaRegistry): 94 Sv exactly, LuV glass. */
const exact: Recipe = {
  id: "vat-exact",
  name: "Bacterial Vat: Raw Bio Catalyst Medium",
  machineType: "Bacterial Vat",
  minimumTier: "LuV",
  durationTicks: 3600,
  eut: 30720,
  inputs: [
    {
      kind: "item",
      id: "bartworks:biolabparts",
      amount: 1,
      consumed: false,
      tooltip: ['NBT: {Name:"Derivantur Cellula Evolutionis"}'],
    },
    { kind: "fluid", id: "growthmediumraw", amount: 8 },
  ],
  outputs: [{ kind: "fluid", id: "biomediumraw", amount: 2 }],
};

describe("Bacterial Vat", () => {
  it("reads the output hatch's fill as the game does", () => {
    // An IV hatch (256,000 L): 1001x within 1.58% of half full, 1000x just outside.
    expect(vatMultiplierAt(128_000, 256_000)).toBe(1001);
    expect(vatMultiplierAt(123_953, 256_000)).toBe(1001);
    expect(vatMultiplierAt(132_047, 256_000)).toBe(1001);
    expect(vatMultiplierAt(123_952, 256_000)).toBe(1000);
    expect(vatMultiplierAt(132_048, 256_000)).toBe(1000);
    // Any matching fluid gives at least 2x; an empty hatch 1x.
    expect(vatMultiplierAt(1, 256_000)).toBe(2);
    expect(vatMultiplierAt(256_000, 256_000)).toBe(2);
    expect(vatMultiplierAt(0, 256_000)).toBe(1);
    // The ME output hatch keeps nothing.
    expect(vatMultiplierAt(0, 0)).toBe(1);
  });

  it("needs the run to fit on top of what is stored", () => {
    const settings = getVatSettings({ bioVatOutputHatch: "hv", bioVatFill: "50" }, biomass, "2.9");
    // HV: 64,000 L, 32,000 stored; 100,100 L does not fit.
    expect(getVatMultiplier(settings, 100)).toMatchObject({ multiplier: 1001, fits: false, keptOut: 0 });
    expect(getVatMultiplier({ ...settings, voidExcess: true }, 100).keptOut).toBe(32_000);
    expect(getVatGateReason(biomass, { bioVatOutputHatch: "hv" }, "2.9")).toMatch(/does not fit/);
    // By default the smallest hatch that holds a 1001x run at half full: IV.
    expect(getVatSettings(undefined, biomass, "2.9").hatch.key).toBe("iv");
  });

  it("finds a recipe's glass and radiation in the pack's data", () => {
    expect(getVatRequirements(biomass, "2.9")).toMatchObject({ glass: 3, sievert: 0, known: true });
    expect(getVatRequirements(exact, "2.9")).toMatchObject({ glass: 6, sievert: 94, exact: true, known: true });
  });

  it("gates glass and radiation", () => {
    expect(getVatGateReason(exact, { bioVatGlass: "5" }, "2.9")).toMatch(/LuV glass/);
    // Plutonium 94 meets 94 exactly; the shutter takes ceil(s x c / 100) off.
    expect(getVatGateReason(exact, {}, "2.9")).toBeUndefined();
    expect(effectiveSievert(140, 50)).toBe(70);
    expect(effectiveSievert(94, 1)).toBe(93);
    const plutonium = radioMaterials("2.9").find((material) => material.sievert === 94)!;
    expect(getVatGateReason(exact, { bioVatRadio: plutonium.id, bioVatShutter: "1" }, "2.9")).toMatch(/exactly 94/);
  });

  it("burns radio hatch material at the decay rate", () => {
    expect(radioDecayTicks(83)).toBe(3976);
    expect(radioDecayTicks(92)).toBe(1617);
    expect(radioDecayTicks(94)).toBe(1324);
    expect(radioDecayTicks(130)).toBe(288);
    expect(radioDecayTicks(140)).toBe(213);
    expect(radioDecayTicks(150)).toBe(157);
    const inputs = applyVatInputs(exact, {}, 10, "2.9").inputs;
    const burned = inputs.find((input) => input.id === getVatSettings({}, exact, "2.9").radio!.id)!;
    // A 94 Sv stick (mass 1) lasts 1324 ticks: 20/1324 a second, over a 10 s run.
    expect(burned.amount).toBeCloseTo((20 / 1324) * 10);
  });

  it("offers radiation only where the recipe needs it", () => {
    expect(getVatControls(biomass, "2.9").map((control) => control.id)).toEqual([
      "bioVatGlass",
      "bioVatOutputHatch",
      "bioVatFill",
      "bioVatVoid",
    ]);
    expect(getVatControls(exact, "2.9").map((control) => control.id)).toContain("bioVatRadio");
  });

  it("runs the Biomass recipe at 54,108 L/s with one HV hatch kept half full in an IV output hatch", () => {
    const project: FactoryProject = {
      schemaVersion: PROJECT_SCHEMA_VERSION,
      id: "vat-project",
      name: "Vat test",
      recipes: [biomass],
      nodes: [
        {
          id: "vat",
          recipeId: biomass.id,
          machineCount: 1,
          parallel: 1,
          overclockTier: "HV",
          machineConfigTiers: { bioVatOutputHatch: "iv", bioVatFill: "50" },
          enabled: true,
          position: { x: 0, y: 0 },
        },
      ],
      edges: [],
      fuelProfiles: [],
    };
    const node = calculateThroughput(project).nodes.vat;
    // Two overclocks: 37 ticks (150 / 4, truncated) at 32 EU/t; 100,100 L a run.
    expect(node.euT).toBe(32);
    expect(node.outputs["fluid:fermentedbiomass"].amountPerSecond).toBeCloseTo(100_100 / (37 / 20), 1);
    expect(node.inputs["fluid:biomass"].amountPerSecond).toBeCloseTo(100_100 / (37 / 20), 1);
  });

  it("builds a recipe's settings once, however often the solver copies the recipe", () => {
    // A card's every power check reads them, on a fresh copy of the recipe each time: rebuilding the radio hatch's
    // hundred materials per check froze the page when the power panel walked every budget.
    expect(getVatControls({ ...exact }, "2.9")).toBe(getVatControls({ ...exact, inputs: [...exact.inputs] }, "2.9"));
    expect(getVatControls({ ...biomass }, "2.9")).not.toBe(getVatControls({ ...exact }, "2.9"));
  });

  it("shows its working", () => {
    const lines = getVatFormulas(biomass, { bioVatOutputHatch: "iv" }, { durationTicks: 37, eut: 32, overclockSteps: 2 }, "2.9");
    const text = Object.fromEntries(lines.map((line) => [line.label, `${formulaText(line.math)} = ${line.result}`]));
    expect(text.fill).toBe("⌈1000·(1−(2·0.5−1)^2)⌉+1 = 1,001x");
    expect(text.out).toBe("100 L·1,001 = 100,100 L");
    expect(text.room).toBe("100,100 ≤ 256,000−128,000 = fits");
    expect(text.time).toBe("150t ÷ 2^2 = 37t");
    expect(text.power).toBe("2·4^2 = 32 EU/t");
  });
});
