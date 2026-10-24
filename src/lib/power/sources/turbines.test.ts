import { describe, expect, it } from "vitest";
import type { GameVersion } from "@/lib/model/game-version";
import { buildPowerRecipe } from "../power-recipe";
import { getPowerSource } from "../registry";
import { buildPowerSettingsReader } from "../types";

/**
 * Golden values follow the pack's GT5U Java (tag 5.09.54.20): MTELargeTurbine*,
 * MTEXLTurbine* and MTEMultiBlockBase.doRandomMaintenanceDamage.
 */
function compute(sourceId: string, settings: Record<string, string>) {
  const source = getPowerSource(sourceId, "2.9");
  if (!source) {
    throw new Error(`No power source ${sourceId}`);
  }
  return source.compute(buildPowerSettingsReader(source, settings, "2.9"), "2.9");
}

function statValue(model: ReturnType<typeof compute>, label: string) {
  return model.stats.find((line) => line.label === label)?.value;
}

describe("turbine formulas", () => {
  it("gives a rotor too weak for its gas one rotor's optimal EU/t at 1 L/t, XL included", () => {
    // Stainless Steel Large: 1,050 L/t x 145% = 1,522 EU/t, under one litre of nitrobenzene.
    const rotor = { rotor: "Stainless Steel", size: "Large", fuel: "Nitrobenzene" };
    const xl = compute("xl-turbo-gas-turbine", rotor);
    expect(xl.euPerTick).toBe(1_522);
    expect(xl.inputs[0]).toMatchObject({ name: "Nitrobenzene", perSecond: 20 });
    expect(xl.warnings?.[0]).toMatch(/1 L\/t for one rotor's 1,522 EU\/t/);
    // The check reads the tight stats, so the fitting changes nothing.
    const loose = compute("xl-turbo-gas-turbine", { ...rotor, fitting: "loose" });
    expect(loose.euPerTick).toBe(1_522);
    expect(loose.inputs[0].perSecond).toBe(20);
    const large = compute("large-gas-turbine", rotor);
    expect(large.euPerTick).toBe(1_522);
    expect(large.inputs[0].perSecond).toBe(20);
  });

  it("makes nothing when the Large gas optimum truncates to 0 L/t", () => {
    // Carbon Large: 150 EU/t / 160 EU/L truncates to 0 L/t, while 150 x 125% clears the weak-rotor check.
    const model = compute("large-gas-turbine", {
      rotor: "Carbon",
      size: "Large",
      fuel: "Refinery Gas",
    });
    expect(model.euPerTick).toBe(0);
    expect(model.inputs[0].perSecond).toBe(0);
    expect(model.warnings?.[0]).toMatch(/0 L\/t/);
  });

  it("truncates the XL plasma optimum and keeps the Large plasma's ceil", () => {
    const rotor = { rotor: "Naquadah Alloy", size: "Huge", fuel: "Americium Plasma" };
    // 16 x 67,200 x 20 / 501,760 = 42.9 L/s: the XL takes 42.
    const xl = compute("xl-turbo-plasma-turbine", rotor);
    expect(xl.inputs[0].perSecond).toBe(42);
    expect(xl.euPerTick).toBe(1_896_652);
    expect(statValue(xl, "Optimal flow")).toBe("42 L/s");
    // 2.68 L/s on the Large rounds up to 3.
    const large = compute("large-plasma-generator", rotor);
    expect(large.inputs[0].perSecond).toBe(3);
    // Under 1 L/s the XL takes nothing.
    const none = compute("xl-turbo-plasma-turbine", {
      rotor: "Carbon",
      size: "Small",
      fuel: "Celestial Tungsten Plasma",
    });
    expect(none.euPerTick).toBe(0);
    expect(none.outputs).toEqual([]);
  });

  it("feeds dense steam in whole litres and scores them against the unrounded optimum", () => {
    const rotor = { rotor: "Duranium", size: "Large", grade: "Dense SC Steam" };
    // 16 x 76,800 = 1,228,800 L/t of steam, 1,228.8 dense litres.
    const best = compute("xl-turbo-sc-steam-turbine", rotor);
    expect(best.inputs[0].perSecond).toBe(1_229 * 20);
    expect(best.euPerTick).toBe(2_641_920);
    expect(best.outputs[0]).toMatchObject({ name: "Dense SH Steam", perSecond: 1_229 * 20 });
    const short = compute("xl-turbo-sc-steam-turbine", {
      ...rotor,
      flowMode: "custom",
      customFlow: "1228",
    });
    expect(short.euPerTick).toBe(2_638_480);
    // HSS-E Small: 25.6 dense litres, fed 26.
    const small = compute("xl-turbo-sc-steam-turbine", { ...rotor, rotor: "HSS-E", size: "Small" });
    expect(small.inputs[0].perSecond).toBe(26 * 20);
    expect(small.euPerTick).toBe(31_991);
  });

  it("does not run rotors under 100% base efficiency in the Large SC turbine", () => {
    const weak = compute("large-sc-steam-turbine", { rotor: "Carbon", size: "Small" });
    expect(weak.euPerTick).toBe(0);
    expect(weak.inputs[0].perSecond).toBe(0);
    expect(weak.warnings?.[0]).toMatch(/under 100%/);
    // Exactly 100% runs.
    const even = compute("large-sc-steam-turbine", { rotor: "Carbon", size: "Normal" });
    expect(even.euPerTick).toBe(100);
  });

  it("wears rotors at the Java's damage rolls", () => {
    // One roll per 1002 ticks landing half the time, per rotor on the XL.
    const lifespan = (id: string, settings: Record<string, string>) =>
      statValue(compute(id, settings), "Rotor lifespan");
    const hssE = { rotor: "HSS-E", size: "Huge" };
    expect(lifespan("large-plasma-generator", { ...hssE, fuel: "Helium Plasma" })).toBe("41.43h");
    expect(lifespan("xl-turbo-steam-turbine", { ...hssE, grade: "Steam" })).toBe("295h");
    // MTEXLTurbineGas skips 1 roll in 4 in either fitting.
    expect(lifespan("xl-turbo-gas-turbine", { ...hssE, fuel: "Nitrobenzene" })).toBe("260h");
    // SC: 2 per roll tight, a coin flip of 0 or 1 loose.
    const scRotor = { rotor: "MAR-Ce-M200 Steel", size: "Large" };
    expect(lifespan("large-sc-steam-turbine", scRotor)).toBe("1677h");
    expect(lifespan("large-sc-steam-turbine", { ...scRotor, fitting: "loose" })).toBe("2155h");
    // Steam: a loose rotor skips 1 roll in 4.
    const steamRotor = { rotor: "Shadow Metal", size: "Small" };
    expect(lifespan("large-steam-turbine", steamRotor)).toBe("430h");
    expect(lifespan("large-steam-turbine", { ...steamRotor, fitting: "loose" })).toBe("345h");
  });

  it("clamps XL output at the int limit", () => {
    const model = compute("xl-turbo-hp-steam-turbine", {
      rotor: "Shirabon",
      size: "Huge",
      grade: "SH Steam",
      fitting: "loose",
    });
    expect(model.euPerTick).toBe(2_147_483_640);
  });
});

/**
 * 2.8.1 follows GT5U 5.09.51.476 (goodgenerator MTESupercriticalFluidTurbine, GT++
 * MTELargeTurbineSteam / SHSteam / SCSteam); 2.9 follows 5.09.54.205
 * (turbines/MTELargeTurbineSCSteam, xlturbines/MTEXLTurbine*Steam).
 */
describe("turbines on 2.8.1 and 2.9", () => {
  const f32 = Math.fround;
  const at = (sourceId: string, gameVersion: GameVersion, settings: Record<string, string>) => {
    const source = getPowerSource(sourceId, gameVersion);
    if (!source) {
      throw new Error(`No power source ${sourceId}`);
    }
    return source.compute(buildPowerSettingsReader(source, settings, gameVersion), gameVersion);
  };

  it("large-sc-steam-turbine 2.8.1 truncates twice off optimal flow, 1 EU/t under 2.9", () => {
    // Carbon Large: 150 L/t optimal, 125% rotor efficiency. The first rotor and the first
    // flow in [75, 150) where the two rules differ: 76 L/t.
    const settings = { rotor: "Carbon", size: "Large", flowMode: "custom", customFlow: "76" };
    const loss = f32(1 - f32(Math.abs((76 - 150) / 150)));
    const rotorEff = f32(1.25);
    // MTESupercriticalFluidTurbine.java:77-82: tEU *= efficiency on an int, then x rotor efficiency.
    const java281 = Math.max(1, Math.trunc(f32(Math.trunc(f32(f32(76) * loss)) * rotorEff)));
    // MTELargeTurbineSCSteam.java:108-109 (5.09.54.205): one float product, one truncation.
    const java29 = Math.max(1, Math.trunc(f32(f32(f32(76) * loss) * rotorEff)));
    expect(java281).toBe(47);
    expect(java29).toBe(48);
    const old = at("large-sc-steam-turbine", "2.8.1", settings);
    const now = at("large-sc-steam-turbine", "2.9", settings);
    expect(old.euPerTick).toBe(java281);
    expect(now.euPerTick).toBe(java29);
    expect(old.euPerTick).toBe(now.euPerTick - 1);
    // On optimal flow both versions truncate once.
    const optimal = { rotor: "Carbon", size: "Large" };
    expect(at("large-sc-steam-turbine", "2.8.1", optimal).euPerTick).toBe(187);
    expect(at("large-sc-steam-turbine", "2.9", optimal).euPerTick).toBe(187);
  });

  it("large-sc-steam-turbine subtracts the optimum as each version's Java does above 2^24 L/t", () => {
    // Chrysotile Huge, loose: 24,702,584 L/t optimal, where a float holds only even integers.
    const base = { rotor: "Chrysotile", size: "Huge", fitting: "loose", flowMode: "custom" };
    const opt = f32(24_702_584);
    // The loose ladder's float efficiency, 104.4%.
    const rotorEff = f32(1.0439999103546143);
    expect(
      at("large-sc-steam-turbine", "2.9", { rotor: "Chrysotile", size: "Huge", fitting: "loose" })
        .euPerTick,
    ).toBe(Math.trunc(f32(opt * rotorEff)));
    // MTELargeTurbineSCSteam.java:108-109 (5.09.54.205): `totalFlow - (float) realOptFlow`, so
    // 24,702,587 L/t is 24,702,588 before the subtraction: a loss of 4 L/t, not 3.
    const flow = 24_702_587;
    const loss29 = f32(1 - Math.abs(f32(f32(f32(flow) - opt) / opt)));
    const loss3 = f32(1 - f32((flow - opt) / opt));
    expect(loss29).not.toBe(loss3);
    const java29 = Math.max(1, Math.trunc(f32(f32(f32(flow) * loss29) * rotorEff)));
    expect(java29).toBe(25_789_496);
    expect(
      at("large-sc-steam-turbine", "2.9", { ...base, customFlow: String(flow) }).euPerTick,
    ).toBe(java29);
    // MTESupercriticalFluidTurbine.java:76 (5.09.51.476): `totalFlow - realOptFlow` on the double
    // field, exact, then cast to float. Shirabon Huge loose, 141,474,592 L/t optimal, 60,000,001 L/t:
    // the float rule would round the flow to 60,000,000 first.
    const shirabon = { rotor: "Shirabon", size: "Huge", fitting: "loose", flowMode: "custom" };
    const big = 60_000_001;
    const opt281 = f32(141_474_592);
    const loss281 = f32(1 - f32(Math.abs((big - opt281) / opt281)));
    expect(loss281).not.toBe(f32(1 - Math.abs(f32(f32(f32(big) - opt281) / opt281))));
    const shirabonEff = f32(2.807999849319458);
    const java281 = Math.max(1, Math.trunc(f32(Math.trunc(f32(f32(big) * loss281)) * shirabonEff)));
    expect(
      at("large-sc-steam-turbine", "2.8.1", { ...shirabon, customFlow: String(big) }).euPerTick,
    ).toBe(java281);
  });

  // Tin Alloy Small, tight: 16 x 325 = 5,200 L/t optimal, a 6,500 L/t cap (1.25x), so
  // 6.5 dense litres fill it. Offering 10 L/t is more than either version takes.
  const denseCases = [
    { id: "xl-turbo-steam-turbine", grade: "Dense Steam", exhaust: "Distilled Water", eu: 1_827 },
    { id: "xl-turbo-hp-steam-turbine", grade: "Dense SH Steam", exhaust: "Dense Steam", eu: 3_656 },
    {
      id: "xl-turbo-sc-steam-turbine",
      grade: "Dense SC Steam",
      exhaust: "Dense SH Steam",
      eu: 3_656,
    },
  ];
  for (const { id, grade, exhaust, eu } of denseCases) {
    it(`${id} 2.8.1 drains whole dense litres and credits the fraction`, () => {
      const settings = {
        rotor: "Tin Alloy",
        size: "Small",
        grade,
        flowMode: "custom",
        customFlow: "10",
      };
      // MTELargeTurbineSteam.java:124-130 (5.09.51.476): the float share of the cap.
      const share = Math.min(f32(10), f32(f32(6_500) / 1000));
      expect(Math.trunc(share)).toBe(6);
      expect(Math.trunc(f32(share * 1000))).toBe(6_500);
      const old = at(id, "2.8.1", settings);
      expect(old.inputs[0]).toMatchObject({ name: grade, perSecond: 6 * 20 });
      expect(old.euPerTick).toBe(eu);
      expect(old.warnings?.[0]).toBe("Flow is capped at 6; the turbine will not take more.");
      // MTEXLTurbineSteam.java:125-135 (5.09.54.205): ceil(6,500 / 1000) = 7 litres drained,
      // 6,500 L credited, so the EU is the same.
      const now = at(id, "2.9", settings);
      expect(now.inputs[0]).toMatchObject({ name: grade, perSecond: 7 * 20 });
      expect(now.euPerTick).toBe(eu);
      if (exhaust === "Distilled Water") {
        // Both return water on the 6,500 L credited, at 160.1 L of steam per litre.
        for (const model of [old, now]) {
          expect(model.outputs[0].name).toBe(exhaust);
          expect(model.outputs[0].perSecond).toBeCloseTo((6_500 * 20) / 160.1, 9);
        }
      } else {
        // One dense litre of the next grade per dense litre drained.
        expect(old.outputs[0]).toMatchObject({ name: exhaust, perSecond: 6 * 20 });
        expect(now.outputs[0]).toMatchObject({ name: exhaust, perSecond: 7 * 20 });
      }
    });
  }

  it("xl-turbo-steam-turbine 2.8.1 runs plain steam as 2.9 does", () => {
    const runs: Record<string, string>[] = [
      { rotor: "Tin Alloy", size: "Small", grade: "Steam" },
      { rotor: "Tin Alloy", size: "Small", grade: "Steam", flowMode: "custom", customFlow: "6000" },
    ];
    for (const settings of runs) {
      expect(at("xl-turbo-steam-turbine", "2.8.1", settings)).toEqual(
        at("xl-turbo-steam-turbine", "2.9", settings),
      );
    }
  });
});

/**
 * A Large turbine clamps fluidIntoPower at its dynamo hatch, V x amps (5.09.54.205
 * turbines/MTELargeTurbine*.java, `tEU > getMaximumOutput()` / `tEU > maxPower`; 5.09.51.476
 * MTELargeTurbine*.java and goodgenerator MTESupercriticalFluidTurbine.java:84). The fuel is
 * drained before the clamp, so a small dynamo wastes EU, not fuel.
 */
describe("Large turbine dynamo hatch", () => {
  const at = (sourceId: string, gameVersion: GameVersion, settings: Record<string, string>) => {
    const source = getPowerSource(sourceId, gameVersion);
    if (!source) {
      throw new Error(`No power source ${sourceId}`);
    }
    return source.compute(buildPowerSettingsReader(source, settings, gameVersion), gameVersion);
  };
  const dynamoKeys = (sourceId: string, gameVersion: GameVersion) => {
    const found = getPowerSource(sourceId, gameVersion)?.settings.find((s) => s.id === "dynamo");
    return found?.type === "select" ? found.options.map((option) => option.key) : [];
  };
  const carbon = { rotor: "Carbon", size: "Large" };

  for (const gameVersion of ["2.9", "2.8.1"] as const) {
    it(`large-sc-steam-turbine ${gameVersion} caps output at the dynamo and still drains the steam`, () => {
      // Carbon Large: 150 L/t of SC steam makes 187 EU/t; an MV dynamo passes 128.
      const free = at("large-sc-steam-turbine", gameVersion, carbon);
      expect(free.euPerTick).toBe(187);
      expect(free.warnings).toBeUndefined();
      const capped = at("large-sc-steam-turbine", gameVersion, { ...carbon, dynamo: "MV" });
      expect(capped.euPerTick).toBe(128);
      expect(capped.inputs).toEqual(free.inputs);
      expect(capped.outputs).toEqual(free.outputs);
      expect(capped.warnings).toEqual([
        "The MV dynamo hatch caps output at 128 EU/t; the rotor makes 187 EU/t.",
      ]);
      // A dynamo that holds the output changes nothing.
      expect(at("large-sc-steam-turbine", gameVersion, { ...carbon, dynamo: "HV" })).toEqual(free);
    });
  }

  it("offers each version's dynamo hatches", () => {
    // addDynamoToMachineList takes any MTEHatchDynamo (5.09.51.476 MTEMultiBlockBase.java:2042),
    // of up to 4A on 5.09.54.205 (:2284). GT's own run ULV to UXV at 1A (Hatch_Dynamo_*); GT++'s
    // buffered dynamos ULV to UHV at 4A on both (MTEHatchDynamoBuffer.maxAmperesOut,
    // GregtechBufferDynamos); 2.8.1's wireless dynamos ULV to MAX at 2A (MTEWirelessDynamo.java:75-77);
    // 2.9's TecTech 4A dynamos HV to UXV (MTEHatchDynamoMulti extends MTEHatchDynamo there).
    const tiers = [
      "ULV",
      "LV",
      "MV",
      "HV",
      "EV",
      "IV",
      "LuV",
      "ZPM",
      "UV",
      "UHV",
      "UEV",
      "UIV",
      "UMV",
      "UXV",
    ];
    const upTo = (last: string) => tiers.slice(0, tiers.indexOf(last) + 1);
    expect(dynamoKeys("large-steam-turbine", "2.8.1")).toEqual([
      "auto",
      ...tiers,
      ...[...tiers, "MAX"].map((tier) => `${tier} 2A`),
      ...upTo("UHV").map((tier) => `${tier} 4A`),
    ]);
    expect(dynamoKeys("large-steam-turbine", "2.9")).toEqual([
      "auto",
      ...tiers,
      ...tiers.map((tier) => `${tier} 4A`),
    ]);
    for (const id of [
      "large-steam-turbine",
      "large-hp-steam-turbine",
      "large-sc-steam-turbine",
      "large-gas-turbine",
      "large-plasma-generator",
    ]) {
      expect(dynamoKeys(id, "2.9")).toEqual(dynamoKeys("large-steam-turbine", "2.9"));
      expect(dynamoKeys(id, "2.8.1")).toEqual(dynamoKeys("large-steam-turbine", "2.8.1"));
    }
    // 2.8.1's 2A wireless dynamo caps at 2 x V.
    expect(at("large-sc-steam-turbine", "2.8.1", { ...carbon, dynamo: "LV 2A" }).euPerTick).toBe(
      64,
    );
    const hp = at("large-hp-steam-turbine", "2.9", { ...carbon, dynamo: "HV 4A" });
    expect(at("large-hp-steam-turbine", "2.9", carbon).euPerTick).toBeGreaterThan(0);
    expect(hp.euPerTick).toBe(
      Math.min(2048, at("large-hp-steam-turbine", "2.9", carbon).euPerTick),
    );
    // The XL turbines have no clamp in fluidIntoPower.
    expect(dynamoKeys("xl-turbo-steam-turbine", "2.9")).toEqual([]);
  });

  it("falls back to Large enough, and says so, for a 2.9-only dynamo on a 2.8.1 plan", () => {
    const recipe = buildPowerRecipe(
      "large-sc-steam-turbine",
      { ...carbon, dynamo: "UEV 4A" },
      "r",
      "2.8.1",
    );
    expect(recipe?.power?.warnings).toContain("Not in GTNH 2.8.1: UEV 4A. Using Large enough.");
    expect(recipe?.power?.euPerTick).toBe(187);
  });

  it("caps every Large turbine class on both versions", () => {
    for (const gameVersion of ["2.9", "2.8.1"] as const) {
      const steam = at("large-steam-turbine", gameVersion, { ...carbon, dynamo: "LV" });
      expect(steam.euPerTick).toBe(32);
      const gas = at("large-gas-turbine", gameVersion, {
        rotor: "HSS-E",
        size: "Huge",
        fuel: "Benzene",
        dynamo: "ULV",
      });
      expect(gas.euPerTick).toBe(8);
      const plasma = at("large-plasma-generator", gameVersion, {
        rotor: "Naquadah Alloy",
        size: "Huge",
        fuel: "Americium Plasma",
        dynamo: "IV",
      });
      expect(plasma.euPerTick).toBe(8192);
    }
  });

  it("leaves a rotor too weak for its gas uncapped, as the Java returns before the clamp", () => {
    // MTELargeTurbineGas.java (5.09.54.205): getOptimalGasEUt() < fuelValue returns early.
    const weak = { rotor: "Stainless Steel", size: "Large", fuel: "Nitrobenzene", dynamo: "LV" };
    expect(at("large-gas-turbine", "2.9", weak).euPerTick).toBe(1_522);
  });
});
