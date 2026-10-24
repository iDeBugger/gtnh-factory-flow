import { describe, expect, it, test } from "vitest";
import { powerSettingsSelectModel } from "@/components/flow/clean/special/power-settings";
import type { GameVersion } from "@/lib/model/game-version";
import {
  LARGE_BOILER_LIQUID_NAMES_2_8_1,
  dieselLiquidBurns,
  solidBurns,
} from "../overrides-2.8.1/boilers";
import { powerPlannerData, powerTablesFor } from "../planner-data";
import { buildPowerRecipe } from "../power-recipe";
import { getPowerSource } from "../registry";
import { dumpSources } from "../power-dump";
import { buildPowerSettingsReader, type PowerSetting, type PowerSelectSetting } from "../types";

/**
 * Steam makers against the pack's Java (GT5U 5.09.54.20). Each case names
 * the class whose rule it pins.
 */
function compute(sourceId: string, settings: Record<string, string> = {}) {
  const source = getPowerSource(sourceId, "2.9");
  if (!source) {
    throw new Error(`No power source ${sourceId}`);
  }
  return source.compute(buildPowerSettingsReader(source, settings, "2.9"), "2.9");
}

function setting(sourceId: string, settingId: string): PowerSetting | undefined {
  return getPowerSource(sourceId, "2.9")?.settings.find((entry) => entry.id === settingId);
}

function optionKeys(sourceId: string, settingId: string): string[] {
  const found = setting(sourceId, settingId);
  return found?.type === "select" ? found.options.map((option) => option.key) : [];
}

function flow(model: ReturnType<typeof compute>, name: string): number | undefined {
  return [...model.inputs, ...model.outputs].find((line) => line.name === name)?.perSecond;
}

describe("Thermal Boiler (RecipesGregTech.thermalBoilerRecipes)", () => {
  it("turns 1000 L/s of lava into 16,000 L/s of plain Steam and pahoehoe lava", () => {
    const model = compute("thermal-boiler", { fluid: "Lava", intake: "1000" });
    expect(model.outputs).toEqual([
      { name: "Steam", perSecond: 16_000, unit: "L" },
      { name: "Pahoehoe Lava", perSecond: 1000, unit: "L" },
    ]);
    expect(flow(model, "Water")).toBe(100);
  });

  it("turns pahoehoe lava into plain Steam at the same 16 per L", () => {
    const model = compute("thermal-boiler", { fluid: "Pahoehoe Lava", intake: "1000" });
    expect(model.outputs).toEqual([{ name: "Steam", perSecond: 16_000, unit: "L" }]);
  });

  it("keeps hot coolant and hot solar salt on superheated steam", () => {
    const coolant = compute("thermal-boiler", { fluid: "Hot Coolant", intake: "500" });
    expect(coolant.outputs[0]).toEqual({ name: "SH Steam", perSecond: 100_000, unit: "L" });
    const salt = compute("thermal-boiler", { fluid: "Hot Solar Salt", intake: "100" });
    expect(salt.outputs[0]).toEqual({ name: "SH Steam", perSecond: 100_000, unit: "L" });
  });

  it("has no circuit setting: MTEThermalBoiler reads none", () => {
    expect(setting("thermal-boiler", "tier")).toBeUndefined();
  });
});

describe("heat exchanger circuit (MTEHeatExchanger, MTEAdvHeatExchanger, MTEExtremeHeatExchanger)", () => {
  it("is a programmed circuit from 1 to 25", () => {
    for (const id of ["large-heat-exchanger", "whakawhiti-wera-xl", "extreme-heat-exchanger"]) {
      expect(setting(id, "tier")).toMatchObject({
        type: "number",
        label: "Circuit",
        min: 1,
        max: 25,
      });
    }
  });

  it("computes a saved circuit 5 exactly as before", () => {
    // Lava: threshold 1000 - 4 x 37.5 = 850, cap 1700, SH at 80 per L, 94% efficiency.
    const model = compute("large-heat-exchanger", { fluid: "Lava", intake: "2000", tier: "5" });
    expect(model.outputs[0].name).toBe("SH Steam");
    expect(model.outputs[0].perSecond).toBeCloseTo(1700 * 80 * 0.94, 6);
    expect(flow(model, "Lava")).toBe(1700);
  });

  it("lowers the LHE threshold down to circuit 25", () => {
    // Hot coolant: 800 - 24 x 30 = 80 L/s, so 100 L/s is over it.
    const model = compute("large-heat-exchanger", {
      fluid: "Hot Coolant",
      intake: "100",
      tier: "25",
    });
    expect(model.outputs[0].name).toBe("SH Steam");
    expect(model.outputs[0].perSecond).toBeCloseTo(100 * 200 * (1 - 0.015 * 24), 6);
  });

  it("never lets the EHE threshold fall below 1", () => {
    // Hot solar salt: 1600 - 24 x 150 is negative; the Java clamps it to 1.
    const model = compute("extreme-heat-exchanger", {
      fluid: "Hot Solar Salt",
      intake: "1",
      tier: "25",
    });
    expect(model.outputs[0].name).toBe("SC Steam");
    expect(model.stats.find((line) => line.label === "Threshold")?.value).toBe("1 L/s");
  });

  it("caps the Whakawhiti Wera XL at twice its lowered threshold", () => {
    // Lava at circuit 10: threshold 32,000 - 9 x 1,200 = 21,200, so at most 42,400 L/s.
    const model = compute("whakawhiti-wera-xl", { fluid: "Lava", intake: "64000", tier: "10" });
    expect(flow(model, "Lava")).toBe(42_400);
    expect(flow(model, "Pahoehoe Lava")).toBe(42_400);
    expect(model.outputs[0].perSecond).toBeCloseTo(42_400 * 80 * (1 - 0.015 * 9), 6);
    expect(model.warnings).toEqual(["Intake is capped at 42,400 L/s for this fluid."]);
  });

  it("keeps the XL at its full 64,000 L/s on circuit 1", () => {
    const model = compute("whakawhiti-wera-xl", { fluid: "Lava", intake: "64000", tier: "1" });
    expect(flow(model, "Lava")).toBe(64_000);
  });
});

describe("large boilers (MTELargeBoilerBase, LargeBoilerFuelBackend)", () => {
  it("offers the superheated boilers only the ALLOWED_FUELS fluids", () => {
    const allowed = [
      "Ether",
      "Gasoline",
      "Cetane-Boosted Diesel",
      "Ethanol Gasoline",
      "Jet Fuel No.3",
      "Jet Fuel A",
      "High Octane Gasoline",
    ];
    for (const id of ["large-titanium-boiler", "large-tungstensteel-boiler"]) {
      expect(
        optionKeys(id, "liquidFuel")
          .filter((key) => key !== "None")
          .sort(),
      ).toEqual([...allowed].sort());
    }
  });

  // GT5U@5.09.54.205 MTELargeBoilerBase.java:339 runs the burn ticks through
  // LargeBoilerFuelBackend.getBurntimeRatioTicks (LargeBoilerFuelBackend.java:143-149), then
  // runtimeBoost (:369): s = (fuel / 80) / 20 seconds, s x max(1, 1 + ln(s / 10) x 0.025)
  // rounded half up to 2 places, x 20 ticks.
  it("burns a solid for the log-boosted burn time times the tier's runtimeBoost", () => {
    const ticks = (table: string, name: string) => {
      const row = powerTablesFor("2.9").boilerFuels[table].find((entry) => entry.name === name);
      return row?.burnTime === undefined ? undefined : Math.round(row.burnTime * 20);
    };
    const moved: Array<[string, string, number]> = [
      ["bronzeSolid", "Block of Coal Coke", 814],
      ["bronzeSolid", "Solid Super Fuel", 2614],
      ["bronzeSolid", "Diamond", 2678],
      ["bronzeSolid", "Magic Solid Super Fuel", 3960],
      ["bronzeSolid", "Block of Diamond", 28260],
      ["steelSolid", "Block of Coal Coke", 407],
      ["steelSolid", "Solid Super Fuel", 1307],
      ["steelSolid", "Diamond", 1339],
      ["steelSolid", "Magic Solid Super Fuel", 1980],
      ["steelSolid", "Block of Diamond", 14130],
      ["titaniumSolid", "Solid Super Fuel", 392],
      ["titaniumSolid", "Magic Solid Super Fuel", 594],
      ["tungstensteelSolid", "Solid Super Fuel", 196],
      ["tungstensteelSolid", "Magic Solid Super Fuel", 297],
    ];
    for (const [table, name, expected] of moved) {
      expect([table, name, ticks(table, name)]).toEqual([table, name, expected]);
    }
    // Under 10 s the max(1, ...) holds the ratio at 1: Block of Coal is 200 ticks, x 2 in bronze.
    expect(ticks("bronzeSolid", "Block of Coal")).toBe(400);
    expect(ticks("steelSolid", "Block of Coal")).toBe(200);
    expect(ticks("bronzeSolid", "Coal")).toBe(40);
    // The superheated boilers take only the two super fuel blocks, and both move.
    expect(powerTablesFor("2.9").boilerFuels.titaniumSolid.map((row) => row.name)).toEqual([
      "Solid Super Fuel",
      "Magic Solid Super Fuel",
    ]);
    expect(powerTablesFor("2.9").boilerFuels.tungstensteelSolid.map((row) => row.name)).toEqual([
      "Solid Super Fuel",
      "Magic Solid Super Fuel",
    ]);
  });

  it("burns Solid Super Fuel for 130.7s in bronze and 19.6s in titanium", () => {
    const bronze = compute("large-bronze-boiler", {
      liquidFuel: "None",
      solidFuel: "Solid Super Fuel",
    });
    expect(flow(bronze, "Solid Super Fuel")).toBeCloseTo(1 / 130.7, 12);
    const titanium = compute("large-titanium-boiler", {
      liquidFuel: "None",
      solidFuel: "Solid Super Fuel",
    });
    expect(flow(titanium, "Solid Super Fuel")).toBeCloseTo(1 / 19.6, 12);
    const steel = compute("large-steel-boiler", {
      liquidFuel: "None",
      solidFuel: "Block of Diamond",
    });
    expect(flow(steel, "Block of Diamond")).toBeCloseTo(1 / 706.5, 12);
  });
});

describe("singleblock boilers (MTEBoiler)", () => {
  it("refuses sulfur dust in the coal boilers but not the GT++ Advanced Boiler", () => {
    expect(optionKeys("small-coal-boiler", "solidFuel")).not.toContain("Sulfur Dust");
    expect(optionKeys("large-coal-boiler", "solidFuel")).not.toContain("Sulfur Dust");
    expect(optionKeys("small-coal-boiler", "solidFuel")).toContain("Lithium Dust");
    expect(optionKeys("advanced-boiler", "solidFuel")).toContain("Sulfur Dust");
  });

  it("gives the Advanced Boiler the same item time on every tier", () => {
    // Solid Super Fuel: (10,000 / 2 + 200) degrees x 41/20.
    for (const tier of ["LV", "MV", "HV"]) {
      const model = compute("advanced-boiler", { tier, solidFuel: "Solid Super Fuel" });
      expect(model.inputs[0].perSecond).toBeCloseTo(1 / 10_660, 12);
    }
  });

  it("leaves one obsidian per 1000 L of lava", () => {
    const model = compute("lava-boiler");
    expect(flow(model, "Obsidian")).toBeCloseTo(flow(model, "Lava")! / 1000, 12);
  });

  it("states when the solar boiler calcifies on regular water", () => {
    const model = compute("solar-boiler", { model: "bronze", waterKind: "Water" });
    expect(model.warnings).toEqual([
      "Regular water calcifies this boiler: full 120 L/s for 15 hours of run time, then down to 40 L/s by 25 hours. Distilled water does not.",
    ]);
  });
});

describe("unlock chips (the controller's own recipe)", () => {
  it("tiers the exchangers by their controller recipes", () => {
    expect(getPowerSource("thermal-boiler", "2.9")?.unlock).toBe("IV");
    expect(getPowerSource("large-heat-exchanger", "2.9")?.unlock).toBe("EV");
    expect(getPowerSource("whakawhiti-wera-xl", "2.9")?.unlock).toBe("LuV");
    expect(getPowerSource("extreme-heat-exchanger", "2.9")?.unlock).toBe("IV");
  });
});

/**
 * 2.8.1 runs the old MTELargeBoiler (GT5U 5.09.51.476): one fuel at a time at 2 x EUt steam a
 * tick. Each test pins 2.8.1 and its 2.9 twin, MTELargeBoilerBase at 5.09.54.205: 2 x EUt on
 * one fuel, 1.25x with both (getMaxEfficiency 12500).
 */
describe("large boilers by game version", () => {
  function model(sourceId: string, settings: Record<string, string>, gameVersion: GameVersion) {
    const source = getPowerSource(sourceId, gameVersion)!;
    return source.compute(buildPowerSettingsReader(source, settings, gameVersion), gameVersion);
  }
  function steamOut(sourceId: string, settings: Record<string, string>, gameVersion: GameVersion) {
    return model(sourceId, settings, gameVersion).outputs[0]?.perSecond;
  }
  function fuelSetting(sourceId: string, gameVersion: GameVersion): PowerSelectSetting {
    const id = gameVersion === "2.8.1" ? "fuel" : "liquidFuel";
    const found = getPowerSource(sourceId, gameVersion)?.settings.find((entry) => entry.id === id);
    if (found?.type !== "select") throw new Error(`No ${id} on ${sourceId}`);
    return found;
  }
  function keysOf(setting: PowerSelectSetting): string[] {
    return setting.options.map((option) => option.key);
  }
  function burnTicks(table: string, name: string, gameVersion: GameVersion): number | undefined {
    const row = powerTablesFor(gameVersion).boilerFuels[table].find((entry) => entry.name === name);
    return row?.burnTime === undefined ? undefined : Math.round(row.burnTime * 20);
  }
  function flowOf(m: ReturnType<typeof model>, name: string): number | undefined {
    return [...m.inputs, ...m.outputs].find((line) => line.name === name)?.perSecond;
  }

  test("large-bronze-boiler 2.8.1 makes 800 L/t on one fuel", () => {
    // EUT_GENERATED 400 (MTELargeBoilerBronze.java:22); coal burns 20 x 2 ticks.
    const coal = model("large-bronze-boiler", { fuel: "Coal" }, "2.8.1");
    expect(coal.outputs).toEqual([{ name: "Steam", perSecond: 800 * 20, unit: "L" }]);
    expect(flowOf(coal, "Coal")).toBe(1 / 2);
    expect(flowOf(coal, "Water")).toBe(5 * 20);
    expect(coal.stats.map((line) => line.label)).not.toContain("Firebox");
    // 2.9: 480 base, 960 L/t alone, 1200 L/t with both.
    expect(
      steamOut("large-bronze-boiler", { liquidFuel: "Creosote Oil", solidFuel: "Coal" }, "2.9"),
    ).toBe(1200 * 20);
    expect(steamOut("large-bronze-boiler", { liquidFuel: "None", solidFuel: "Coal" }, "2.9")).toBe(
      960 * 20,
    );
  });

  test("large-steel-boiler 2.8.1 makes 2000 L/t", () => {
    const coal = model("large-steel-boiler", { fuel: "Coal" }, "2.8.1");
    expect(coal.outputs).toEqual([{ name: "Steam", perSecond: 2000 * 20, unit: "L" }]);
    expect(flowOf(coal, "Water")).toBe(12.5 * 20);
    expect(steamOut("large-steel-boiler", { liquidFuel: "None", solidFuel: "Coal" }, "2.9")).toBe(
      2400 * 20,
    );
  });

  test("large-titanium-boiler 2.8.1 makes 2666 L/t SH steam and burns no liquid", () => {
    // 4000 x 2 / 3 as an int; water is (50 L) / 3 as an int each tick (MTELargeBoiler.java:396).
    const fuel = model("large-titanium-boiler", { fuel: "Solid Super Fuel" }, "2.8.1");
    expect(fuel.outputs).toEqual([{ name: "SH Steam", perSecond: 2666 * 20, unit: "L" }]);
    expect(flowOf(fuel, "Water")).toBe(16 * 20);
    expect(keysOf(fuelSetting("large-titanium-boiler", "2.8.1"))).toEqual([
      "None",
      "Solid Super Fuel",
      "Magic Solid Super Fuel",
    ]);
    // 2.9 burns the ALLOWED_FUELS liquids in a superheated boiler: 3200 L/t on one fuel.
    expect(keysOf(fuelSetting("large-titanium-boiler", "2.9"))).toContain("Ether");
    expect(steamOut("large-titanium-boiler", { liquidFuel: "Ether" }, "2.9")).toBe(3200 * 20);
  });

  test("large-tungstensteel-boiler 2.8.1 makes 10666 L/t SH steam", () => {
    const fuel = model("large-tungstensteel-boiler", { fuel: "Solid Super Fuel" }, "2.8.1");
    expect(fuel.outputs).toEqual([{ name: "SH Steam", perSecond: 10666 * 20, unit: "L" }]);
    expect(flowOf(fuel, "Water")).toBe(66 * 20);
    expect(flowOf(fuel, "Solid Super Fuel")).toBe(1 / 10);
    expect(steamOut("large-tungstensteel-boiler", { liquidFuel: "Ether" }, "2.9")).toBe(12800 * 20);
    expect(
      steamOut(
        "large-tungstensteel-boiler",
        { liquidFuel: "Ether", solidFuel: "Solid Super Fuel" },
        "2.9",
      ),
    ).toBe(16000 * 20);
  });

  test("power-planner-data.json: boilerFuels 2.8.1 coal burns 40/20 ticks and super fuel 406/200", () => {
    expect(burnTicks("bronzeSolid", "Coal", "2.8.1")).toBe(40);
    expect(burnTicks("steelSolid", "Coal", "2.8.1")).toBe(20);
    // Superheated boilers take only the ALLOWED_SOLID_FUELS blocks (MTELargeBoiler.java:232-245).
    expect(burnTicks("titaniumSolid", "Coal", "2.8.1")).toBeUndefined();
    expect(burnTicks("tungstensteelSolid", "Coal", "2.8.1")).toBeUndefined();
    // 100,000 / 80 = 1250 ticks: x 130 / 400 = 406, x 120 / 750 = 200.
    expect(burnTicks("titaniumSolid", "Solid Super Fuel", "2.8.1")).toBe(406);
    expect(burnTicks("tungstensteelSolid", "Solid Super Fuel", "2.8.1")).toBe(200);
    // The log bonus: Block of Coal is 200 x (1 + log9(10) x 0.025) = 205 ticks, x 2 in bronze.
    expect(burnTicks("bronzeSolid", "Block of Coal", "2.8.1")).toBe(410);
    expect(burnTicks("bronzeSolid", "Lignite Coal", "2.8.1")).toBe(28);
    // Liquids: Creosote is a diesel fuel of 8 (runtimeBoost(4)), Heavy Oil dense only (40 x 2).
    expect(burnTicks("bronzeLiquid", "Creosote Oil", "2.8.1")).toBe(8);
    expect(burnTicks("steelLiquid", "Creosote Oil", "2.8.1")).toBe(4);
    expect(burnTicks("bronzeLiquid", "Heavy Oil", "2.8.1")).toBe(160);
    expect(burnTicks("steelLiquid", "Heavy Oil", "2.8.1")).toBe(80);
    expect(powerTablesFor("2.8.1").boilerFuels.titaniumLiquid).toEqual([]);
    // 2.9 twin (MTELargeBoilerBase at 5.09.54.205): coal 20 ticks before runtimeBoost.
    expect(burnTicks("bronzeSolid", "Coal", "2.9")).toBe(40);
    expect(burnTicks("steelSolid", "Coal", "2.9")).toBe(20);
    expect(burnTicks("titaniumSolid", "Coal", "2.9")).toBeUndefined();
  });

  test("large-bronze-boiler 2.8.1 reads a 2.9 dual-fuel setting as the liquid", () => {
    const stored = { liquidFuel: "Creosote Oil", solidFuel: "Coal" };
    const m = model("large-bronze-boiler", stored, "2.8.1");
    expect(m.inputs.map((line) => line.name)).toEqual(["Creosote Oil", "Water"]);
    expect(flowOf(m, "Creosote Oil")).toBe(1000 / 0.4);
    // One fuel at a time: the card says which of the two it burns.
    expect(buildPowerRecipe("large-bronze-boiler", stored, "r", "2.8.1")?.power?.warnings ?? []).toEqual([
      "GTNH 2.8.1 boilers burn one fuel at a time. Using Creosote Oil.",
    ]);
    // A stored fuel 2.8.1 lacks is named with the one burned, not hidden behind "one at a time".
    expect(
      buildPowerRecipe("large-bronze-boiler", { liquidFuel: "Hydrogen", solidFuel: "Coal" }, "r", "2.8.1")?.power?.warnings,
    ).toEqual(["Not in GTNH 2.8.1: Hydrogen. GTNH 2.8.1 boilers burn one fuel at a time. Using Coal."]);
    // A superheated boiler burns the solid of the same pair (it skips liquids).
    const ti = model(
      "large-titanium-boiler",
      { liquidFuel: "Ether", solidFuel: "Solid Super Fuel" },
      "2.8.1",
    );
    expect(ti.inputs.map((line) => line.name)).toEqual(["Solid Super Fuel", "Water"]);
    // 2.9 burns both at half rate each.
    expect(model("large-bronze-boiler", stored, "2.9").inputs.map((line) => line.name)).toEqual([
      "Creosote Oil",
      "Coal",
      "Water",
    ]);
  });

  test("large-bronze-boiler 2.8.1 converted card shows and computes the same fuel", () => {
    const stored = { liquidFuel: "Creosote Oil" };
    expect(
      powerSettingsSelectModel(getPowerSource("large-bronze-boiler", "2.8.1")!, stored, "fuel")
        ?.current,
    ).toBe("Creosote Oil");
    expect(model("large-bronze-boiler", stored, "2.8.1").inputs[0].name).toBe("Creosote Oil");
    expect(
      powerSettingsSelectModel(getPowerSource("large-bronze-boiler", "2.9")!, stored, "liquidFuel")
        ?.current,
    ).toBe("Creosote Oil");
  });

  test("large-bronze-boiler 2.8.1 with no fuel stored burns nothing", () => {
    // A 2.9 card saved with no liquid and no solid makes no steam; 2.8.1 reads "None" too.
    const stored = { liquidFuel: "None" };
    const card = powerSettingsSelectModel(
      getPowerSource("large-bronze-boiler", "2.8.1")!,
      stored,
      "fuel",
    );
    expect(card?.current).toBe("None");
    const m = model("large-bronze-boiler", stored, "2.8.1");
    expect(m.outputs).toEqual([]);
    expect(m.warnings).toEqual(["Pick a fuel to make steam."]);
    expect(buildPowerRecipe("large-bronze-boiler", stored, "r", "2.8.1")?.power?.warnings).toEqual([
      "Pick a fuel to make steam.",
    ]);
    expect(
      model("large-titanium-boiler", { liquidFuel: "None", solidFuel: "None" }, "2.8.1").outputs,
    ).toEqual([]);
    expect(model("large-bronze-boiler", stored, "2.9").outputs).toEqual([]);
    expect(model("large-bronze-boiler", stored, "2.9").warnings).toEqual([
      "Pick a fuel to make steam.",
    ]);
  });

  test("large-bronze-boiler 2.8.1 offers only fuels the boiler accepts", () => {
    const keys = keysOf(fuelSetting("large-bronze-boiler", "2.8.1"));
    // Gas turbine fuels are in neither the diesel nor the dense map; Nefarious Oil is in neither.
    for (const name of ["Hydrogen", "Methane", "Benzene", "LPG", "Nitrobenzene", "Nefarious Oil"]) {
      expect(keys).not.toContain(name);
    }
    for (const name of [
      "Creosote Oil",
      "Heavy Oil",
      "High Octane Gasoline",
      "Coal",
      "Block of Diamond",
    ]) {
      expect(keys).toContain(name);
    }
    // The two filters: a diesel liquid at special value 1, a solid at fuel value x 2 / EUt of 1.
    expect(dieselLiquidBurns(1)).toBe(false);
    expect(dieselLiquidBurns(2)).toBe(true);
    expect(solidBurns("bronze", "Stick", 199)).toBe(false);
    expect(solidBurns("bronze", "Stick", 400)).toBe(true);
    expect(
      powerPlannerData.boilerFuels.bronzeSolid
        .filter((row) => !solidBurns("steel", row.name, row.euPerItem ?? 0))
        .map((row) => row.name),
    ).toEqual(["Cactus Coke", "Sugar Coke"]);
    // Every 2.8.1 liquid is a 2.9 row name, so none is lost to a spelling.
    const names29 = powerPlannerData.boilerFuels.bronzeLiquid.map((row) => row.name);
    for (const name of LARGE_BOILER_LIQUID_NAMES_2_8_1) expect(names29).toContain(name);
    expect(powerTablesFor("2.8.1").boilerFuels.bronzeLiquid).toHaveLength(29);
    // 2.9 keeps the gas fuels its MTELargeBoilerBase takes through largeBoilerFakeFuels.
    expect(keysOf(fuelSetting("large-bronze-boiler", "2.9"))).toContain("Hydrogen");
  });

  test("large-bronze-boiler 2.8.1 names a stored liquid it cannot burn", () => {
    const warnings = buildPowerRecipe(
      "large-bronze-boiler",
      { liquidFuel: "Hydrogen" },
      "r",
      "2.8.1",
    )?.power?.warnings;
    expect(warnings).toEqual(["Not in GTNH 2.8.1: Hydrogen. Using Fish Oil."]);
    expect(
      buildPowerRecipe("large-bronze-boiler", { liquidFuel: "Hydrogen" }, "r", "2.9")?.power
        ?.warnings ?? [],
    ).toEqual([]);
  });

  test("small-coal-boiler 2.8.1 and the other bronze-table readers are unchanged by the boiler table", () => {
    // They read only bronzeSolid's names and fuel values, which 2.8.1 keeps.
    const ids = ["small-coal-boiler", "large-coal-boiler", "advanced-boiler", "railcraft-boiler"];
    const pick = (v: GameVersion) =>
      dumpSources(
        ids.map((id) => getPowerSource(id, v)!),
        v,
      );
    expect(pick("2.8.1")).toEqual(pick("2.9"));
  });
});
