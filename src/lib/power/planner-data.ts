/**
 * Typed access to the tables extracted from the Power Planner workbook
 * (tools/power-planner-extract.mjs -> data/power-planner-data.json) and the
 * fuel-name -> dataset-resource map (tools/power-resource-map.mjs).
 */
import rawData from "./data/power-planner-data.json";
import rawResourceMap from "./data/resource-map.json";
import rawMachineIcons from "./data/machine-icons.json";
import rawResourceMap281 from "./data/2.8.1/resource-map.json";
import rawMachineIcons281 from "./data/2.8.1/machine-icons.json";
import type { GameVersion } from "@/lib/model/game-version";
import { POWER_DATA_OVERRIDES_2_8_1 } from "./overrides-2.8.1";
import { POWER_DATA_OVERRIDES_2_9 } from "./overrides-2.9";

export interface PowerFuelEntry {
  name: string;
  euPerLiter?: number;
  euPerItem?: number;
  burnTime?: number;
  eheMaxLps?: number;
  promoterCoefficient?: number;
}

export interface RotorClassData {
  efficiencyTight: Array<number | null>;
  efficiencyLoose: Array<number | null>;
  optimalTight: Array<number | null>;
  optimalLoose: Array<number | null>;
  euAtOptimalTight?: Array<number | null>;
}

export interface RotorEntry {
  name: string;
  unlock: string;
  durability: number;
  overflowTier: number;
  steam: RotorClassData;
  gas: RotorClassData;
  plasma: RotorClassData;
}

export interface HeatExchangerFluidRule {
  threshold: number;
  max: number;
  throttle: number;
  underRatio: number;
  overRatio: number;
}

export interface FusionRecipeEntry {
  name: string;
  minMark: number;
  euPerLiter: number;
  startupEu: number;
  input1: string | null;
  ratio1: number | null;
  input2: string | null;
  ratio2: number | null;
  decayOutput: string | null;
  outputLpsByMark: Array<number | null>;
  drainEutByMark: Array<number | null>;
  compactOutputLpsByMark: Array<number | null>;
  compactDrainEutByMark: Array<number | null>;
}

/** The workbook's tables in their declared shape; one version's whole set. */
export interface PowerTables {
  steamGrades: PowerFuelEntry[];
  gasFuels: PowerFuelEntry[];
  gasFuelsXl: PowerFuelEntry[];
  plasmas: PowerFuelEntry[];
  combustionFuels: PowerFuelEntry[];
  eceFuels: PowerFuelEntry[];
  semifluidFuels: PowerFuelEntry[];
  ucfeFuels: PowerFuelEntry[];
  chemFuels: PowerFuelEntry[];
  frostFuels: PowerFuelEntry[];
  lneBases: Array<{ name: string; multiplier: number; boostTicks: number }>;
  lneStructureTiers: Array<{ name: string; residueCapacity: number; baseDecay: number }>;
  lneRobotArms: Array<{ name: string; tier: number }>;
  magicSolids: PowerFuelEntry[];
  naquadahRods: PowerFuelEntry[];
  rocketFuels: PowerFuelEntry[];
  lnrFuels: Array<{ name: string; euPerTick: number; secondsPerCell: number }>;
  lnrCoolants: Array<{ name: string; efficiency: number; litersPerSecond: number }>;
  lnrBoosters: Array<{ name: string; multiplier: number; litersPerSecond: number }>;
  lftrFuels: Array<{
    name: string;
    euPerLiter: number;
    powerLabel: string;
    uSalt: number;
    tSalt: number;
    tbSalt: number;
    uf6: number;
    uranium233PerSecond: number;
  }>;
  htgrPebbles: Array<{ name: string; base: number; mult: number; exp: number }>;
  boilerFuels: Record<string, PowerFuelEntry[]>;
  heatExchangers: Array<{ name: string; fluids: Record<string, HeatExchangerFluidRule> }>;
  fusionRecipes: FusionRecipeEntry[];
  rotors: RotorEntry[];
  rotorSizes: Array<{ name: string; durabilityMult: number }>;
  singleblockTiers: Array<{ tier: string; voltage: number; ampLoss: number }>;
  singleblockEfficiency: Record<string, Array<number | null>>;
  eohStars: Array<{
    name: string;
    tier: number;
    durationSeconds: number;
    baseSuccess: number;
    efficiency: number;
    euInput: number;
    euOutput: number;
    starMatter: number;
  }>;
}

/** The tables that are plain fuel lists, so a spec can name its fuel table. */
export type PowerFuelTableName = {
  [K in keyof PowerTables]: PowerTables[K] extends PowerFuelEntry[] ? K : never;
}[keyof PowerTables];

/**
 * The extracted workbook itself. 2.9's tables are this with 2.9's source corrections swapped
 * in (`powerTablesFor("2.9")`); read the workbook directly only to test the extract.
 */
export const powerPlannerData = rawData as unknown as PowerTables;

/**
 * Power tables that differ by game version: each named table replaces the workbook's whole,
 * never merged row by row, so a fuel 2.8.1 lacks is simply not in its table. "2.9" holds the
 * corrections where the workbook disagrees with 5.09.54.205; every other version builds on
 * those before its own.
 */
export const POWER_DATA_OVERRIDES: Partial<Record<GameVersion, Partial<PowerTables>>> = {
  "2.9": POWER_DATA_OVERRIDES_2_9,
  "2.8.1": POWER_DATA_OVERRIDES_2_8_1,
};

const tablesByVersion = new Map<GameVersion, PowerTables>();

function buildTables(
  gameVersion: GameVersion,
  overrides: Partial<Record<GameVersion, Partial<PowerTables>>>,
): PowerTables {
  const base = { ...powerPlannerData, ...overrides["2.9"] };
  return gameVersion === "2.9" ? base : { ...base, ...overrides[gameVersion] };
}

/**
 * One version's power tables: 2.9 is the workbook with 2.9's corrections; another version is
 * 2.9's with its own override tables swapped in. Memoized per version for the shipped
 * overrides only, so a test passing its own overrides never sees or seeds the cache.
 */
export function powerTablesFor(
  gameVersion: GameVersion,
  overrides: Partial<Record<GameVersion, Partial<PowerTables>>> = POWER_DATA_OVERRIDES,
): PowerTables {
  if (overrides !== POWER_DATA_OVERRIDES) {
    return buildTables(gameVersion, overrides);
  }
  let tables = tablesByVersion.get(gameVersion);
  if (!tables) {
    tables = buildTables(gameVersion, overrides);
    tablesByVersion.set(gameVersion, tables);
  }
  return tables;
}

export interface PowerResourceRef {
  kind: "item" | "fluid";
  id: string;
  displayName: string;
  iconPath?: string;
  dominantColor?: string;
}

type ResourceMap = Record<string, PowerResourceRef>;

/**
 * Each pack's fuel-name map, resolved against that pack's own catalog (tools/power-resource-map.mjs):
 * ids, names and icon files differ between packs. 2.9's map serves every version with none of its own.
 */
const RESOURCE_MAPS: Partial<Record<GameVersion, ResourceMap>> = {
  "2.9": (rawResourceMap as { resources: ResourceMap }).resources,
  "2.8.1": (rawResourceMap281 as { resources: ResourceMap }).resources,
};

/** Dataset resource for a spreadsheet fuel name in this version's pack; undefined = show as a stat. */
export function resolvePowerResource(name: string, gameVersion: GameVersion): PowerResourceRef | undefined {
  return (RESOURCE_MAPS[gameVersion] ?? RESOURCE_MAPS["2.9"])?.[name];
}

export interface PowerMachineIcon {
  id: string;
  displayName: string;
  iconPath?: string;
  dominantColor?: string;
}

type MachineIconMap = Record<string, PowerMachineIcon>;

/** Each pack's machine faces (tools/power-machine-icons.mjs): 2.8.1's controllers sit at other ids. */
const MACHINE_ICONS: Partial<Record<GameVersion, MachineIconMap>> = {
  "2.9": (rawMachineIcons as { machines: MachineIconMap }).machines,
  "2.8.1": (rawMachineIcons281 as { machines: MachineIconMap }).machines,
};

/** The in-game machine item this source is drawn as in this version's pack. */
export function getPowerMachineIcon(sourceId: string, gameVersion: GameVersion): PowerMachineIcon | undefined {
  return (MACHINE_ICONS[gameVersion] ?? MACHINE_ICONS["2.9"])?.[sourceId];
}

export function findFuel(table: PowerFuelEntry[], name: string): PowerFuelEntry {
  return table.find((entry) => entry.name === name) ?? table[0];
}

export function fuelOptions(table: PowerFuelEntry[]): Array<{ key: string; label: string }> {
  return table.map((entry) => ({ key: entry.name, label: entry.name }));
}

export const ROTOR_SIZE_NAMES = ["Small", "Normal", "Large", "Huge"] as const;

export function findRotor(name: string, tables: PowerTables): RotorEntry {
  return tables.rotors.find((entry) => entry.name === name) ?? tables.rotors[0];
}

export function rotorDurability(
  rotor: RotorEntry,
  sizeIndex: number,
  tables: PowerTables,
): number {
  const mult = tables.rotorSizes[sizeIndex]?.durabilityMult ?? 1;
  return rotor.durability * mult;
}
