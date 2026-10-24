/**
 * Railcraft's Water Tank and its steam boiler, from Railcraft's source at the
 * version GTNH 2.9 ships (GTNewHorizons/Railcraft tag 9.17.26; the mod's
 * research/railcraft-water-tank-and-boilers.md has the links). Both are
 * modelled at steady state: the tank as it fills, the boiler at full heat.
 */
import type { PowerFuelEntry, PowerTables } from "../planner-data";
import type { PowerModel, PowerSourceDefinition } from "../types";
import { formatAmount, items, liters, stat, type PowerSourceBuilder } from "./helpers";

/** Seconds as "45 s", "12 min" or "2 h 15 min". */
function duration(seconds: number): string {
  if (!Number.isFinite(seconds)) return "-";
  if (seconds < 60) return `${Math.round(seconds)} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const rest = minutes % 60;
  return rest === 0 ? `${Math.floor(minutes / 60)} h` : `${Math.floor(minutes / 60)} h ${rest} min`;
}

/**
 * TileTankWater.updateEntity: every 8 ticks the master adds
 * max(1, floor(10 x rainfall x m)) L, in float maths, nothing in the Nether.
 * m is 1 under open sky, 3 in rain, 0.5 in snow (a snowy biome's rain) and
 * 0.5 under a roof in any weather (GTNH's sky check: any of the 9 blocks
 * above the top sees the sky). Two tanks may not touch.
 */
const WATER_TANK_SKY = [
  { key: "clear", label: "Open sky, clear", multiplier: 1 },
  { key: "rain", label: "Open sky, raining", multiplier: 3 },
  { key: "snow", label: "Open sky, snowing", multiplier: 0.5 },
  { key: "roof", label: "Under a roof", multiplier: 0.5 },
  { key: "nether", label: "In the Nether", multiplier: 0 },
];
const WATER_TANK_CAPACITY = 400_000;
const WATER_TANK_INTERVAL_TICKS = 8;

/** Litres one fill adds: Java float steps, so the floor lands where the game's does. */
export function waterTankFill(humidity: number, sky: string): number {
  const entry = WATER_TANK_SKY.find((row) => row.key === sky) ?? WATER_TANK_SKY[0];
  if (entry.multiplier === 0) return 0;
  const rate = Math.fround(Math.fround(10 * Math.fround(humidity)) * entry.multiplier);
  return Math.max(1, Math.floor(rate));
}

const waterTank: PowerSourceDefinition = {
  id: "railcraft-water-tank",
  name: "Railcraft Water Tank",
  group: "other",
  blurb: "A 3x3x3 tank that fills itself with water from the sky.",
  settings: [
    {
      type: "number",
      id: "humidity",
      label: "Biome humidity",
      min: 0,
      max: 2,
      step: 0.05,
      defaultValue: 0.8,
    },
    {
      type: "select",
      id: "sky",
      label: "Sky",
      options: WATER_TANK_SKY.map(({ key, label }) => ({ key, label })),
      defaultKey: "clear",
    },
  ],
  compute(read): PowerModel {
    const fill = waterTankFill(read.number("humidity"), read.select("sky"));
    const perSecond = (fill * 20) / WATER_TANK_INTERVAL_TICKS;
    return {
      euPerTick: 0,
      inputs: [],
      outputs: perSecond > 0 ? [liters("Water", perSecond)] : [],
      stats: [
        stat("Fill", `${fill} L every 8 ticks`),
        stat("Stores", `${formatAmount(WATER_TANK_CAPACITY)} L`),
        stat("Full in", perSecond > 0 ? duration(WATER_TANK_CAPACITY / perSecond) : "-"),
      ],
      warnings: perSecond > 0 ? undefined : ["Makes nothing in the Nether."],
    };
  },
};

/**
 * SteamBoiler at full heat. A cycle is 16 ticks on low pressure tanks, 8 on
 * high; each burns N x (8 - 0.1N + 0.8 x min(heatLevel, 1) + 4 x maxHeat/1000)
 * fuel units and turns N x heatLevel litres of water into 160 L of steam each.
 * GTNH reads heatLevel as heat / 500 on both pressures (Railcraft a0dc844e),
 * so high pressure at 1000 C makes twice upstream's steam for the same fuel.
 * A fuel unit is a furnace burn tick, or a liquid's heat per 1000 L. Plain
 * water only, and water poured into a hot empty boiler blows it up.
 */
const BOILER_SIZES = [
  { key: "1x1x1", label: "1x1x2, 1 tank", width: 1, tanks: 1 },
  { key: "2x2x2", label: "2x2x3, 8 tanks", width: 2, tanks: 8 },
  { key: "2x2x3", label: "2x2x4, 12 tanks", width: 2, tanks: 12 },
  { key: "3x3x2", label: "3x3x3, 18 tanks", width: 3, tanks: 18 },
  { key: "3x3x3", label: "3x3x4, 27 tanks", width: 3, tanks: 27 },
  { key: "3x3x4", label: "3x3x5, 36 tanks", width: 3, tanks: 36 },
];

const BOILER_PRESSURES = [
  { key: "low", label: "Low pressure", cycleTicks: 16, maxHeat: 500 },
  { key: "high", label: "High pressure", cycleTicks: 8, maxHeat: 1000 },
];

/**
 * The solid firebox burns whatever a furnace burns, at its furnace value
 * (FuelPlugin): the workbook's furnace table, with Railcraft's own 1000 for
 * a blaze rod. Lava containers (1000 a bucket, worse than coal, leaving the
 * container) and wood are left out.
 */
function boilerSolids(tables: PowerTables): Array<{ name: string; burnTicks: number }> {
  return tables.boilerFuels.bronzeSolid.map((entry: PowerFuelEntry) => ({
    name: entry.name,
    burnTicks: entry.name === "Blaze Rod" ? 1000 : (entry.euPerItem ?? 0),
  }));
}

/**
 * FuelManager's boiler fuels in the pack, heat per 1000 L: Railcraft's own
 * (creosote raised to 6400 by GTNH), GT++'s bio diesel and EnderIO's IMC.
 * Liquified coal is registered only if a "coal" fluid exists; GTNH has none.
 */
const BOILER_LIQUIDS: Array<{ name: string; label: string; heat: number }> = [
  { name: "Creosote Oil", label: "Creosote Oil", heat: 6400 },
  { name: "Ethanol", label: "Bio Ethanol", heat: 16_000 },
  { name: "Biofuel", label: "Biofuel", heat: 16_000 },
  { name: "Bio Diesel", label: "Bio Diesel", heat: 16_000 },
  { name: "Hootch", label: "Hootch", heat: 36_000 },
  { name: "Diesel (Fuel)", label: "Diesel (Fuel)", heat: 48_000 },
  { name: "Blazing Pyrotheum", label: "Blazing Pyrotheum", heat: 64_000 },
  { name: "EIO Rocket Fuel", label: "Rocket Fuel", heat: 112_000 },
  { name: "Fire Water", label: "Fire Water", heat: 120_000 },
];

/** Pollution a second per firebox block while burning (GT's MixinRailcraftBoilerPollution, Pollution.cfg). */
const BOILER_POLLUTION_PER_FIREBOX = 20;

/** Ticks from 20 C to full heat while burning: dH/dt = 0.15 (4max/3 - H) / (N max). */
export function boilerWarmUpTicks(tanks: number, maxHeat: number): number {
  const ceiling = (maxHeat * 4) / 3;
  return ((maxHeat * tanks) / 0.15) * Math.log((ceiling - 20) / (ceiling - maxHeat));
}

const railcraftBoiler = (solids: ReturnType<typeof boilerSolids>): PowerSourceDefinition => ({
  id: "railcraft-boiler",
  name: "Railcraft Boiler",
  group: "steam",
  unlock: "ULV",
  blurb: "Up to 28,800 L/s of steam, after a long warm-up.",
  settings: [
    {
      type: "select",
      id: "size",
      label: "Size",
      options: BOILER_SIZES.map(({ key, label }) => ({ key, label })),
      defaultKey: "3x3x4",
    },
    {
      type: "select",
      id: "pressure",
      label: "Tanks",
      options: BOILER_PRESSURES.map(({ key, label }) => ({ key, label })),
      defaultKey: "low",
    },
    // One fuel list: a solid needs the Solid Fueled Firebox, a liquid the Liquid Fueled one.
    {
      type: "select",
      id: "fuel",
      label: "Fuel",
      options: [
        ...solids.map(({ name }) => ({ key: name, label: name })),
        ...BOILER_LIQUIDS.map(({ name, label }) => ({ key: name, label })),
      ],
      defaultKey: "Coal",
    },
  ],
  compute(read): PowerModel {
    const size = BOILER_SIZES.find((row) => row.key === read.select("size")) ?? BOILER_SIZES[0];
    const pressure =
      BOILER_PRESSURES.find((row) => row.key === read.select("pressure")) ?? BOILER_PRESSURES[0];
    const n = size.tanks;
    const cyclesPerSecond = 20 / pressure.cycleTicks;
    const heatLevel = pressure.maxHeat / 500;
    const fuelPerCycle =
      n * (8 - 0.1 * n + 0.8 * Math.min(heatLevel, 1) + (4 * pressure.maxHeat) / 1000);
    const fuelPerSecond = fuelPerCycle * cyclesPerSecond;
    const waterPerSecond = n * heatLevel * cyclesPerSecond;
    const steamPerSecond = waterPerSecond * 160;

    const fuelName = read.select("fuel");
    const liquid = BOILER_LIQUIDS.find((row) => row.name === fuelName);
    const solid = liquid ? undefined : (solids.find((row) => row.name === fuelName) ?? solids[0]);
    const inputs: PowerModel["inputs"] = [];
    if (liquid) {
      inputs.push(liters(liquid.name, (fuelPerSecond * 1000) / liquid.heat));
    } else if (solid && solid.burnTicks > 0) {
      inputs.push(items(solid.name, fuelPerSecond / solid.burnTicks));
    }
    inputs.push(liters("Water", waterPerSecond));

    const stats = [
      stat("Steam", `${formatAmount(steamPerSecond / 20)} L/t`),
      stat("Firebox", liquid ? "Liquid Fueled" : "Solid Fueled"),
      stat("Warm-up", duration(boilerWarmUpTicks(n, pressure.maxHeat) / 20)),
      stat(
        "Pollution",
        `${formatAmount(BOILER_POLLUTION_PER_FIREBOX * size.width * size.width)}/s`,
      ),
    ];
    if (solid && solid.burnTicks > 0) {
      stats.push(stat("One item burns", `${formatAmount(solid.burnTicks / fuelPerSecond)}s`));
    }
    return {
      euPerTick: 0,
      inputs,
      outputs: [liters("Steam", steamPerSecond)],
      stats,
    };
  },
});

export const buildRailcraftOtherSources: PowerSourceBuilder = () => {
  return [waterTank];
};

export const buildRailcraftSteamSources: PowerSourceBuilder = (tables) => {
  return [railcraftBoiler(boilerSolids(tables))];
};
