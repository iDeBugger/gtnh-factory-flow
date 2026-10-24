import { describe, expect, it, test } from "vitest";
import type { GameVersion } from "@/lib/model/game-version";
import { powerTablesFor } from "../planner-data";
import { buildPowerRecipe } from "../power-recipe";
import { getPowerSource } from "../registry";
import { buildPowerSettingsReader, type PowerSourceDefinition } from "../types";

function compute(sourceId: string, settings: Record<string, string> = {}) {
  const source = getPowerSource(sourceId, "2.9");
  if (!source) {
    throw new Error(`No power source ${sourceId}`);
  }
  return source.compute(buildPowerSettingsReader(source, settings, "2.9"), "2.9");
}

function statValue(model: ReturnType<typeof compute>, label: string) {
  return model.stats.find((line) => line.label === label)?.value;
}

describe("singleblock burns (MTEBasicGenerator)", () => {
  it("floors EU per liter: fish oil in an LV combustion generator makes 1 EU/L", () => {
    // floor(2 x 95 / 100) = 1, so 33 EU per packet needs 33 L.
    const model = compute("combustion-generator", { tier: "LV", fuel: "Fish Oil" });
    expect(statValue(model, "EU per L")).toBe("1");
    expect(model.euPerTick).toBe(32);
    expect(model.inputs[0].perSecond).toBeCloseTo(660, 9);
    expect(model.warnings).toBeUndefined();
  });

  it("caps a 10-tick burn at the 16,000 L tank and derates EU/t", () => {
    // IV fish oil: 1 EU/L, 82,080 L per burn wanted, 16,000 L held.
    const model = compute("combustion-generator", { tier: "IV", fuel: "Fish Oil" });
    expect(model.inputs[0].perSecond).toBe(32_000);
    expect(model.euPerTick).toBeCloseTo(((16_000 * 1) / 10) * (8192 / 8208), 9);
    expect(model.warnings).toEqual([
      "Burns at most 16,000 L per 10 ticks (the tank), so it runs at 1,597 EU/t, not 8,192.",
    ]);
  });

  it("gives the geothermal engine its own 5000 L per tier tank", () => {
    // LuV pahoehoe: floor(24 x 58%) = 13 EU/L, 25,231 L per burn fits 30,000 L.
    const model = compute("geothermal-engine", { tier: "LuV", fuel: "Pahoehoe Lava" });
    expect(model.euPerTick).toBe(32_768);
    expect(model.inputs[0].perSecond).toBeCloseTo((32_800 / 13) * 20, 9);
    expect(model.warnings).toBeUndefined();
  });

  it("burns rocket fuel at the fuel map value, a third of the large engine's", () => {
    // RP-1 is 512 in the map: floor(512 x 80%) = 409 EU/L at EV.
    const model = compute("rocket-fuel-generator", { tier: "EV", fuel: "RP-1 (red)" });
    expect(statValue(model, "EU per L")).toBe("409");
    expect(model.inputs[0].perSecond).toBeCloseTo((2056 / 409) * 20, 9);
  });

  it("burns at most one item per 10 ticks and derates EU/t", () => {
    // LuV pyrotheum: 62 x 10 x 58 = 35,960 EU a dust, 2 dusts a second.
    const model = compute("geothermal-engine", { tier: "LuV", fuel: "Pyrotheum Dust" });
    expect(model.inputs[0]).toMatchObject({ name: "Pyrotheum Dust", perSecond: 2, unit: "item" });
    expect(model.euPerTick).toBeCloseTo(((2 * 35_960) / 20) * (32_768 / 32_800), 9);
    expect(model.warnings).toEqual([
      "Burns at most 1 item per 10 ticks, so it runs at 3,592 EU/t, not 32,768.",
    ]);
    const ev = compute("geothermal-engine", { tier: "EV", fuel: "Pyrotheum Dust" });
    expect(ev.euPerTick).toBe(2048);
    expect(ev.warnings).toBeUndefined();
  });
});

describe("steam turbine (MTESteamTurbine)", () => {
  it("turns 6 + tier liters of steam into 3 EU and shows the exact efficiency", () => {
    const cases = [
      { tier: "LV", liters: 7, packet: 33, efficiency: "85.71%" },
      { tier: "MV", liters: 8, packet: 130, efficiency: "75%" },
      { tier: "HV", liters: 9, packet: 516, efficiency: "66.67%" },
    ];
    for (const { tier, liters, packet, efficiency } of cases) {
      const model = compute("steam-turbine", { tier });
      expect(model.inputs[0].perSecond).toBeCloseTo((packet / 3) * liters * 20, 9);
      expect(statValue(model, "Efficiency")).toBe(efficiency);
      expect(model.outputs).toEqual([]);
    }
  });
});

describe("naquadah reactor marks (MTENaquadahReactor)", () => {
  it("offers only the naquadah or tiberium form; the mark picks the rod", () => {
    const source = getPowerSource("naquadah-reactor", "2.9")!;
    const fuel = source.settings.find((setting) => setting.id === "fuel");
    expect(fuel?.type === "select" && fuel.options.map((option) => option.key)).toEqual([
      "naquadah",
      "tiberium",
    ]);
    const rods = ["EV", "IV", "LuV", "ZPM", "UV"].map((tier) => [
      compute("naquadah-reactor", { tier, fuel: "naquadah" }).inputs[0].name,
      compute("naquadah-reactor", { tier, fuel: "tiberium" }).inputs[0].name,
    ]);
    expect(rods).toEqual([
      ["Enriched Naquadah Bolt (EV)", "Tiberium Bolt (EV)"],
      ["Enriched Naquadah Rod (IV)", "Tiberium Rod (IV)"],
      ["Long Enriched Naquadah Rod (LuV)", "Long Tiberium Rod (LuV)"],
      ["Naquadria Bolt (ZPM)", "Tiberium Rod (ZPM)"],
      ["Naquadria Rod (UV)", "Long Tiberium Rod (UV)"],
    ]);
  });

  it("hands back the naquadah part and nothing for tiberium", () => {
    const naquadria = compute("naquadah-reactor", { tier: "ZPM", fuel: "naquadah" });
    expect(naquadria.outputs).toEqual([
      { name: "Naquadah Bolt", perSecond: naquadria.inputs[0].perSecond, unit: "item" },
    ]);
    expect(compute("naquadah-reactor", { tier: "ZPM", fuel: "tiberium" }).outputs).toEqual([]);
  });

  it("loads a stored rod the mark cannot burn as that mark's naquadah rod", () => {
    const model = compute("naquadah-reactor", { tier: "EV", fuel: "Naquadria Rod (UV)" });
    expect(model.inputs[0].name).toBe("Enriched Naquadah Bolt (EV)");
    // 50,000 x 10 x 80 EU a bolt.
    expect(statValue(model, "EU per item")).toBe("40M");
  });

  it("reads a stored rod key as its form, so saved tiberium stays tiberium", () => {
    const rod = (tier: string, fuel: string) =>
      compute("naquadah-reactor", { tier, fuel }).inputs[0].name;
    expect(rod("IV", "Tiberium Rod (IV)")).toBe("Tiberium Rod (IV)");
    expect(rod("UV", "Tiberium Bolt (EV)")).toBe("Long Tiberium Rod (UV)");
    expect(rod("ZPM", "Long Tiberium Rod (LuV)")).toBe("Tiberium Rod (ZPM)");
    expect(rod("LuV", "Long Enriched Naquadah Rod (LuV)")).toBe("Long Enriched Naquadah Rod (LuV)");
    expect(rod("IV", "Naquadria Bolt (ZPM)")).toBe("Enriched Naquadah Rod (IV)");
    // A key that is neither an option nor a retired one falls back to the default.
    expect(rod("EV", "Something Else")).toBe("Enriched Naquadah Bolt (EV)");
  });
});

describe("magic energy converter byproducts (getEmptyContainer)", () => {
  it("hands back the next slate down where the resource map knows it", () => {
    const imbued = compute("magic-energy-converter", { tier: "LV", fuel: "Imbued Slate" });
    expect(imbued.outputs).toEqual([
      { name: "Reinforced Slate", perSecond: imbued.inputs[0].perSecond, unit: "item" },
    ]);
    const reinforced = compute("magic-energy-converter", { tier: "LV", fuel: "Reinforced Slate" });
    expect(reinforced.outputs).toEqual([
      { name: "Blank Slate", perSecond: reinforced.inputs[0].perSecond, unit: "item" },
    ]);
    // Liveroots hand back four sticks each.
    const liveroots = compute("magic-energy-converter", { tier: "LV", fuel: "Liveroots" });
    expect(liveroots.outputs).toEqual([
      { name: "Stick", perSecond: liveroots.inputs[0].perSecond * 4, unit: "item" },
    ]);
  });
});

describe("RTG pellets (MTERTGenerator)", () => {
  it("caps a pellet at Integer.MAX_VALUE EU and charges the packet loss", () => {
    const days = (key: string) => {
      const model = compute("rtg", { pellet: key });
      return 1 / model.inputs[0].perSecond / 86_400;
    };
    // Am-241 and Pu-238 overflow the cap; the others lose only the packet loss.
    expect(days("am241")).toBeCloseTo((2 ** 31 - 1) / 16 / 20 / 86_400, 9);
    expect(days("pu238")).toBeCloseTo((2 ** 31 - 1) / 62 / 20 / 86_400, 9);
    expect(days("sr90")).toBeCloseTo((29 * 30) / 31, 9);
    expect(days("po210")).toBeCloseTo(480 / 484, 9);
    // roundToClosestInt(2.6f) is 2 days, at 7 EU/t paying 8.
    expect(days("ic2")).toBeCloseTo((2 * 7) / 8, 9);
  });

  it("labels each pellet with its real run time", () => {
    const source = getPowerSource("rtg", "2.9")!;
    const pellet = source.settings.find((setting) => setting.id === "pellet");
    expect(pellet?.type === "select" && pellet.options.map((option) => option.label)).toEqual([
      "Am-241 (15 EU/t, 77.67 days)",
      "Sr-90 (30 EU/t, 28.06 days)",
      "Pu-238 (60 EU/t, 20.04 days)",
      "Po-210 (480 EU/t, 0.99 days)",
      "Pellets of RTG Fuel (7 EU/t, 1.75 days)",
    ]);
    expect(statValue(compute("rtg", { pellet: "pu238" }), "One pellet runs")).toBe(
      "20.04 real days",
    );
  });
});

describe("unlock chips (the controller's own recipe)", () => {
  it("puts the RTG at IV and the plasma generator at LuV", () => {
    expect(getPowerSource("rtg", "2.9")?.unlock).toBe("IV");
    expect(getPowerSource("plasma-generator", "2.9")?.unlock).toBe("LuV");
  });
});

function computeIn(sourceId: string, settings: Record<string, string>, gameVersion: GameVersion) {
  const source = getPowerSource(sourceId, gameVersion);
  if (!source) {
    throw new Error(`No power source ${sourceId} in ${gameVersion}`);
  }
  return source.compute(buildPowerSettingsReader(source, settings, gameVersion), gameVersion);
}

function optionKeys(setting: PowerSourceDefinition["settings"][number] | undefined): string[] {
  return setting?.type === "select" ? setting.options.map((option) => option.key) : [];
}

// bartworks AdditionalRecipes.java:247-271 at GT5U 5.09.51.476, cheapest first.
const CHEM_2_8_1_EXPECTED: Array<[string, number]> = [
  ["Diluted Sulfuric Acid", 9],
  ["Molten Redstone", 10],
  ["Acetic Acid", 11],
  ["Diluted Hydrochloric Acid", 14],
  ["Sulfuric Acid", 18],
  ["Nitric Acid", 24],
  ["Hydrochloric Acid", 28],
  ["Hypochlorous Acid", 30],
  ["Mercury", 32],
  ["Phosphoric Acid", 36],
  ["Hydrofluoric Acid", 40],
  ["Formic Acid", 40],
];

function fuelValue(table: Array<{ name: string; euPerLiter?: number }>, name: string) {
  return table.find((row) => row.name === name)?.euPerLiter;
}

describe("2.8.1 singleblock generators and fuels", () => {
  test("acid-generator 2.8.1 is LV to EV at 97/94/91/88%", () => {
    const tiers = (v: GameVersion) => getPowerSource("acid-generator", v)!.settings.find((s) => s.id === "tier");
    expect(optionKeys(tiers("2.8.1"))).toEqual(["LV", "MV", "HV", "EV"]);
    expect(optionKeys(tiers("2.9"))).toEqual(["LV", "MV", "HV", "EV", "IV"]);
    // EV sulfuric acid: floor(18 x 88 / 100) = 15 EU/L on 2.8.1; floor(28 x 88 / 100) = 24 on 2.9.
    expect(statValue(computeIn("acid-generator", { tier: "EV", fuel: "Sulfuric Acid" }, "2.8.1"), "EU per L")).toBe("15");
    expect(statValue(computeIn("acid-generator", { tier: "EV", fuel: "Sulfuric Acid" }, "2.9"), "EU per L")).toBe("24");
  });

  test("acid-generator 2.8.1 names a saved IV generator and runs it at LV", () => {
    expect(buildPowerRecipe("acid-generator", { tier: "IV" }, "r", "2.8.1")?.power?.warnings).toContain(
      "Not in GTNH 2.8.1: IV. Using LV.",
    );
    expect(buildPowerRecipe("acid-generator", { tier: "IV" }, "r", "2.9")?.power?.warnings ?? []).toEqual([]);
  });

  test("power-planner-data.json: chemFuels 2.8.1 is the 12 old acids", () => {
    expect(powerTablesFor("2.8.1").chemFuels.map((f) => [f.name, f.euPerLiter])).toEqual(CHEM_2_8_1_EXPECTED);
    expect(powerTablesFor("2.9").chemFuels).toHaveLength(20);
    expect(fuelValue(powerTablesFor("2.9").chemFuels, "Sulfuric Acid")).toBe(28);
    expect(fuelValue(powerTablesFor("2.9").chemFuels, "Molten Redstone")).toBe(40);
  });

  test("power-planner-data.json: semifluidFuels 2.8.1 has Nefarious Oil at 572 and the manure fuels", () => {
    const old = powerTablesFor("2.8.1").semifluidFuels;
    const now = powerTablesFor("2.9").semifluidFuels;
    expect(fuelValue(old, "Nefarious Oil")).toBe(572);
    expect(fuelValue(old, "Poop Juice")).toBe(12);
    expect(fuelValue(old, "Manure Slurry")).toBe(24);
    expect(fuelValue(old, "Fertile Manure Slurry")).toBe(32);
    // Every 2.9 row is in 2.8.1 at its 2.9 value except Nefarious Oil.
    for (const row of now) {
      expect([row.name, fuelValue(old, row.name)]).toEqual([
        row.name,
        row.name === "Nefarious Oil" ? 572 : row.euPerLiter,
      ]);
    }
    expect(old).toHaveLength(now.length + 3);
    expect(fuelValue(now, "Nefarious Oil")).toBe(512);
    expect(fuelValue(now, "Poop Juice")).toBeUndefined();
    expect(fuelValue(now, "Hemp Seed Oil")).toBeUndefined();
  });

  test("semifluid-generator 2.8.1 offers neither Hemp Seed Oil nor Lin Seed Oil", () => {
    // Both materials have no fluid: their cells burn only in the semifluid boiler map, and the
    // generator's map copies an item fuel only as the fluid its container holds
    // (GT5U@5.09.51.476 ProcessingCell.java:55, SemiFluidFuelHandler.java:31-38).
    for (const version of ["2.8.1", "2.9"]) {
      const fuel = getPowerSource("semifluid-generator", version)?.settings.find((setting) => setting.id === "fuel");
      const keys = fuel?.type === "select" ? fuel.options.map((option) => option.key) : [];
      expect(keys, version).toContain("Seed Oil");
      expect(keys, version).not.toContain("Hemp Seed Oil");
      expect(keys, version).not.toContain("Lin Seed Oil");
    }
  });

  test("power-planner-data.json: magicSolids 2.8.1 Amber is 3/32 of 2.9 (Chipped Amber 3 / 2 = 1)", () => {
    const old = powerTablesFor("2.8.1").magicSolids;
    const now = powerTablesFor("2.9").magicSolids;
    expect(old).toHaveLength(now.length);
    const amber = now.filter((row) => row.name.includes("Amber"));
    expect(amber.map((row) => row.name).sort()).toEqual(
      ["Amber Dust", "Amber Gem", "Amber Plate", "Chipped Amber", "Exquisite Amber", "Flawed Amber", "Flawless Amber"],
    );
    for (const row of now) {
      const value = old.find((entry) => entry.name === row.name)?.euPerItem;
      // Chipped Amber's FUEL_VALUE is 3 / 2 in Java ints: 1, not 1.5.
      const expected = !row.name.includes("Amber")
        ? row.euPerItem
        : row.name === "Chipped Amber"
          ? 1_000
          : ((row.euPerItem ?? 0) * 3) / 32;
      expect([row.name, value]).toEqual([row.name, expected]);
    }
    expect(old.find((row) => row.name === "Amber Dust")?.euPerItem).toBe(3_000);
    expect(now.find((row) => row.name === "Amber Dust")?.euPerItem).toBe(32_000);
    expect(now.find((row) => row.name === "Chipped Amber")?.euPerItem).toBe(16_000);
  });

  test("power-planner-data.json: singleblockEfficiency 2.8.1 has no IV acid generator", () => {
    expect(powerTablesFor("2.8.1").singleblockEfficiency.chem[4]).toBeNull();
    expect(powerTablesFor("2.8.1").singleblockEfficiency.chem.slice(0, 4)).toEqual([0.97, 0.94, 0.91, 0.88]);
    expect(powerTablesFor("2.9").singleblockEfficiency.chem[4]).toBe(0.5);
    const { chem: _old, ...oldRest } = powerTablesFor("2.8.1").singleblockEfficiency;
    const { chem: _now, ...nowRest } = powerTablesFor("2.9").singleblockEfficiency;
    expect(oldRest).toEqual(nowRest);
  });
});
