import { describe, expect, it } from "vitest";
import {
  ENERGY_HATCH_TYPES,
  energyHatchTypeExistsAtTier,
  energyHatchTypesForTier,
  getEnergyHatchType,
} from "./energy-hatches";

describe("energy hatch families", () => {
  it("offers only the plain pair below EV", () => {
    expect(energyHatchTypesForTier("ULV").map((type) => type.id)).toEqual(["standard"]);
    expect(energyHatchTypesForTier("HV").map((type) => type.id)).toEqual(["standard"]);
  });

  it("opens the multi-amp hatches at EV and the first laser at IV", () => {
    expect(energyHatchTypesForTier("EV").map((type) => type.id)).toEqual([
      "standard",
      "amp4",
      "amp16",
      "amp64",
    ]);
    expect(energyHatchTypesForTier("IV").map((type) => type.id)).toContain("laser256");
    expect(energyHatchTypesForTier("IV").map((type) => type.id)).not.toContain("laser1k");
  });

  it("offers every family at UXV", () => {
    expect(energyHatchTypesForTier("UXV")).toHaveLength(ENERGY_HATCH_TYPES.length);
  });

  it("says whether a stored family survives a tier change", () => {
    expect(energyHatchTypeExistsAtTier("laser256", "IV")).toBe(true);
    expect(energyHatchTypeExistsAtTier("laser256", "EV")).toBe(false);
    expect(energyHatchTypeExistsAtTier(undefined, "ULV")).toBe(true);
  });

  it("falls back to the plain pair for unknown ids", () => {
    expect(getEnergyHatchType("not-a-hatch").id).toBe("standard");
    expect(getEnergyHatchType(undefined).amps).toBe(2);
  });
});

describe("energy-hatches.ts by game version", () => {
  // The rating each laser family first appears at in the craftable ladder.
  const LADDER = {
    laser256: "IV",
    laser1k: "LuV",
    laser4k: "ZPM",
    laser16k: "UV",
    laser65k: "UHV",
    laser262k: "UEV",
    laser1m: "UIV",
    laser4m: "UMV",
    laser16m: "UXV",
  };

  it("energy-hatches.ts 2.8.1 keeps the craftable laser ladder: its IV ratings above 256 A are hidden and have no recipe", () => {
    // GT5U@5.09.51.476 tectech/loader/thing/MachineLoader.java:1088-1141 registers
    // eM_energyTunnel2_IV ... eM_energyTunnel7_IV, each `.hidden()`; no recipe in
    // tectech/loader/recipe/ outputs them, and the 2.8.1 export has no such item.
    const ladder = Object.fromEntries(
      ENERGY_HATCH_TYPES.filter((type) => type.id.startsWith("laser")).map((type) => [type.id, type.minTier]),
    );
    expect(ladder).toEqual(LADDER);
    expect(energyHatchTypesForTier("IV").map((type) => type.id).filter((id) => id.startsWith("laser"))).toEqual([
      "laser256",
    ]);
    expect(energyHatchTypeExistsAtTier("laser1k", "IV")).toBe(false);
    expect(energyHatchTypeExistsAtTier("laser4m", "UIV")).toBe(false);
  });

  it("energy-hatches.ts 2.9 matches GT5U 5.09.54.205's laser ladder", () => {
    // GT5U@5.09.54.205 tectech/loader/thing/MachineLoader.java:889 (2_LuV), 895 (2_ZPM),
    // 898 (3_ZPM), 910 (4_UV), 925 (5_UHV), 943 (6_UEV), 964 (7_UIV), 988 (8_UMV), 1023 (9_UXV).
    for (const [id, tier] of Object.entries(LADDER)) {
      expect(getEnergyHatchType(id).minTier).toBe(tier);
    }
    expect(energyHatchTypesForTier("EV").map((type) => type.id)).toEqual(["standard", "amp4", "amp16", "amp64"]);
  });
});
