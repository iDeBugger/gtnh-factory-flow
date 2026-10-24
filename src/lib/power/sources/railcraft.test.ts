import { describe, expect, it } from "vitest";
import { resolvePowerResource } from "../planner-data";
import { getPowerSource } from "../registry";
import { buildPowerSettingsReader } from "../types";
import { boilerWarmUpTicks, waterTankFill } from "./railcraft";

/**
 * Railcraft's Water Tank and boiler against Railcraft's source (GTNH fork,
 * tag 9.17.26). The mod's RailcraftTest pins the same values.
 */
function compute(sourceId: string, settings: Record<string, string> = {}) {
  const source = getPowerSource(sourceId, "2.9");
  if (!source) {
    throw new Error(`No power source ${sourceId}`);
  }
  return source.compute(buildPowerSettingsReader(source, settings, "2.9"), "2.9");
}

function flow(model: ReturnType<typeof compute>, name: string): number | undefined {
  return [...model.inputs, ...model.outputs].find((line) => line.name === name)?.perSecond;
}

describe("Railcraft Water Tank (TileTankWater.updateEntity)", () => {
  it("fills 8 L every 8 ticks in a forest under open sky", () => {
    const model = compute("railcraft-water-tank");
    expect(model.inputs).toEqual([]);
    expect(model.outputs).toEqual([{ name: "Water", perSecond: 20, unit: "L" }]);
    expect(model.euPerTick).toBe(0);
  });

  it("floors each fill in float maths, as the game does", () => {
    // 10 x 0.9 x 0.5 = 4.5 -> 4 L: 10 L/s, not the wiki's 11.25 (or 33.75 with rain).
    expect(waterTankFill(0.9, "roof")).toBe(4);
    expect(flow(compute("railcraft-water-tank", { humidity: "0.9", sky: "roof" }), "Water")).toBe(
      10,
    );
    expect(flow(compute("railcraft-water-tank", { humidity: "1", sky: "rain" }), "Water")).toBe(75);
    expect(flow(compute("railcraft-water-tank", { humidity: "1.2", sky: "rain" }), "Water")).toBe(
      90,
    );
    expect(flow(compute("railcraft-water-tank", { humidity: "0.4", sky: "snow" }), "Water")).toBe(
      5,
    );
  });

  it("never fills less than 1 L outside the Nether, and nothing in it", () => {
    expect(flow(compute("railcraft-water-tank", { humidity: "0" }), "Water")).toBe(2.5);
    expect(flow(compute("railcraft-water-tank", { humidity: "0.05" }), "Water")).toBe(2.5);
    const nether = compute("railcraft-water-tank", { sky: "nether" });
    expect(nether.outputs).toEqual([]);
    expect(nether.warnings).toEqual(["Makes nothing in the Nether."]);
  });

  it("lists under Other and makes the dataset's water", () => {
    expect(getPowerSource("railcraft-water-tank", "2.9")?.group).toBe("other");
    expect(resolvePowerResource("Water", "2.9")?.id).toBe("water");
  });
});

describe("Railcraft Boiler (SteamBoiler at full heat)", () => {
  it("runs a 3x3x5 low pressure boiler on coal at 200 L/s of steam a tank", () => {
    const model = compute("railcraft-boiler");
    expect(flow(model, "Steam")).toBe(7200);
    expect(flow(model, "Water")).toBe(45);
    // 1.25 x 36 x (10.8 - 3.6) = 324 fuel units a second; coal burns 1600.
    expect(flow(model, "Coal")).toBeCloseTo(324 / 1600, 10);
    expect(model.euPerTick).toBe(0);
  });

  it("gives GTNH's doubled steam on high pressure tanks", () => {
    const model = compute("railcraft-boiler", { pressure: "high", size: "1x1x1" });
    expect(flow(model, "Steam")).toBe(800);
    expect(flow(model, "Water")).toBe(5);
    // 2.5 x (12.8 - 0.1) = 31.75 units a second.
    expect(flow(model, "Coal")).toBeCloseTo(31.75 / 1600, 10);
  });

  it("burns liquids at their heat per bucket", () => {
    const creosote = compute("railcraft-boiler", { pressure: "high", fuel: "Creosote Oil" });
    // 2.5 x 36 x (12.8 - 3.6) = 828 units a second.
    expect(flow(creosote, "Creosote Oil")).toBeCloseTo(129.375, 10);
    expect(creosote.stats.find((line) => line.label === "Firebox")?.value).toBe("Liquid Fueled");
    expect(
      flow(
        compute("railcraft-boiler", { pressure: "high", fuel: "Diesel (Fuel)" }),
        "Diesel (Fuel)",
      ),
    ).toBeCloseTo(17.25, 10);
    expect(
      flow(compute("railcraft-boiler", { size: "2x2x2", fuel: "Hootch" }), "Hootch"),
    ).toBeCloseTo(100_000 / 36_000, 10);
  });

  it("counts a blaze rod at Railcraft's 1000, not the furnace's 2400", () => {
    const model = compute("railcraft-boiler", { size: "2x2x2", fuel: "Blaze Rod" });
    expect(flow(model, "Blaze Rod")).toBeCloseTo(0.1, 10);
  });

  it("states warm-up and pollution", () => {
    expect(boilerWarmUpTicks(1, 500)).toBeCloseTo(4519, 0);
    expect(boilerWarmUpTicks(1, 1000)).toBeCloseTo(9141, 0);
    const model = compute("railcraft-boiler");
    expect(model.stats.find((line) => line.label === "Warm-up")?.value).toBe("2 h 16 min");
    expect(model.stats.find((line) => line.label === "Pollution")?.value).toBe("180/s");
  });

  it("resolves every fuel it offers to a dataset resource", () => {
    const source = getPowerSource("railcraft-boiler", "2.9");
    const fuel = source?.settings.find((setting) => setting.id === "fuel");
    expect(fuel?.type).toBe("select");
    for (const option of fuel?.type === "select" ? fuel.options : []) {
      expect(resolvePowerResource(option.key, "2.9"), option.key).toBeDefined();
    }
    expect(source?.group).toBe("steam");
  });
});
