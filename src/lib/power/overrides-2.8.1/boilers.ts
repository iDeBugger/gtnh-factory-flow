/**
 * Boiler fuel and heat exchanger tables that differ in 2.8.1.
 * Each entry replaces 2.9's whole table, and each row cites its source as `// GT5U@5.09.51.476 <path>:<line>`.
 */
import { fdiv } from "@/lib/machines/java-float";
import rawData from "../data/power-planner-data.json";
import type { PowerFuelEntry, PowerTables } from "../planner-data";

// The JSON itself, not powerTablesFor: planner-data imports this module.
const tables29 = rawData as unknown as PowerTables;

/**
 * 2.8.1's four large boilers run the old MTELargeBoiler. checkProcessing burns ONE fuel at a
 * time: a diesel-map liquid, else a dense-liquid-map liquid, else a solid
 * (MTELargeBoiler.java:275-361). A superheated boiler skips both liquid loops (:275).
 * In boilerFuels, `burnTime` is seconds per 1000 L or per item.
 */
export type LargeBoilerTier = "bronze" | "steel" | "titanium" | "tungstensteel";

/** EUT_GENERATED and runtimeBoost of each subclass, in Java int math. */
export const LARGE_BOILERS_2_8_1: Record<
  LargeBoilerTier,
  { eut: number; superheated: boolean; runtimeBoost: (ticks: number) => number }
> = {
  // GT5U@5.09.51.476 gregtech/common/tileentities/machines/multi/MTELargeBoilerBronze.java:22,90
  bronze: { eut: 400, superheated: false, runtimeBoost: (ticks) => ticks * 2 },
  // GT5U@5.09.51.476 gregtech/common/tileentities/machines/multi/MTELargeBoilerSteel.java:22,90
  steel: { eut: 1000, superheated: false, runtimeBoost: (ticks) => ticks },
  // GT5U@5.09.51.476 gregtech/common/tileentities/machines/multi/MTELargeBoilerTitanium.java:22,90
  titanium: {
    eut: 4000,
    superheated: true,
    runtimeBoost: (ticks) => Math.trunc((ticks * 130) / 400),
  },
  // GT5U@5.09.51.476 gregtech/common/tileentities/machines/multi/MTELargeBoilerTungstenSteel.java:22,90
  tungstensteel: {
    eut: 16000,
    superheated: true,
    runtimeBoost: (ticks) => Math.trunc((ticks * 120) / 750),
  },
};

type LiquidMap = "diesel" | "dense";

/**
 * The liquids a bronze or steel boiler burns: RecipeMaps.dieselFuels, then
 * RecipeMaps.denseLiquidFuels (GTRecipe.java:278-301 files a material by its fuel type). A fluid
 * in both maps burns by the diesel rule, since that loop runs first. `value` is the map's special
 * value. Gas turbine fuels are in neither map, so 2.8.1 burns none of them, nor Nefarious Oil.
 * The first five are diesel entries GT5U does not file itself (read from the 2.8.1 export's
 * gt.recipe.dieselgeneratorfuel); each also sits in the dense map, which the diesel loop shadows.
 */
const LIQUIDS: Record<string, { map: LiquidMap; value: number }> = {
  "Fish Oil": { map: "diesel", value: 2 }, // GT5U@5.09.51.476 gregtech/common/tileentities/machines/multi/MTELargeBoiler.java:276 (export: diesel 2)
  "Short Mead": { map: "diesel", value: 4 }, // GT5U@5.09.51.476 gregtech/common/tileentities/machines/multi/MTELargeBoiler.java:276 (export: diesel 4)
  "Creosote Oil": { map: "diesel", value: 8 }, // GT5U@5.09.51.476 gregtech/common/tileentities/machines/multi/MTELargeBoiler.java:276 (export: diesel 8)
  "Forestry Biomass": { map: "diesel", value: 8 }, // GT5U@5.09.51.476 gregtech/common/tileentities/machines/multi/MTELargeBoiler.java:276 (export: diesel 8, fluid "biomass")
  Oil: { map: "diesel", value: 16 }, // GT5U@5.09.51.476 gregtech/common/tileentities/machines/multi/MTELargeBoiler.java:276 (export: diesel 16)
  "Sulfuric Light Fuel": { map: "diesel", value: 40 }, // GT5U@5.09.51.476 gregtech/loaders/materials/MaterialsInit1.java:598
  Octane: { map: "diesel", value: 80 }, // GT5U@5.09.51.476 gregtech/loaders/materials/MaterialsInit1.java:858
  Methanol: { map: "diesel", value: 84 }, // GT5U@5.09.51.476 gregtech/loaders/materials/MaterialsInit1.java:666
  Ethanol: { map: "diesel", value: 192 }, // GT5U@5.09.51.476 gregtech/loaders/materials/MaterialsInit1.java:453
  "Light Fuel": { map: "diesel", value: 305 }, // GT5U@5.09.51.476 gregtech/loaders/materials/MaterialsInit1.java:601
  "Bio Diesel": { map: "diesel", value: 320 }, // GT5U@5.09.51.476 gregtech/loaders/materials/MaterialsInit1.java:625
  Butanol: { map: "diesel", value: 400 }, // GT5U@5.09.51.476 gregtech/common/tileentities/machines/multi/MTELargeBoiler.java:276 (export: diesel 400, cell "miscutils:butanol")
  "Diesel (Fuel)": { map: "diesel", value: 480 }, // GT5U@5.09.51.476 gregtech/loaders/materials/MaterialsInit1.java:456
  Ether: { map: "diesel", value: 537 }, // GT5U@5.09.51.476 goodgenerator/loader/RecipeLoader.java:502
  Gasoline: { map: "diesel", value: 576 }, // GT5U@5.09.51.476 gregtech/loaders/materials/MaterialsInit1.java:860
  "Cetane-Boosted Diesel": { map: "diesel", value: 1000 }, // GT5U@5.09.51.476 gregtech/loaders/materials/MaterialsInit1.java:769
  "Ethanol Gasoline": { map: "diesel", value: 1100 }, // GT5U@5.09.51.476 goodgenerator/loader/RecipeLoader.java:512
  "Jet Fuel No.3": { map: "diesel", value: 1824 }, // GT5U@5.09.51.476 goodgenerator/loader/RecipeLoader.java:527
  "Jet Fuel A": { map: "diesel", value: 2248 }, // GT5U@5.09.51.476 goodgenerator/loader/RecipeLoader.java:522
  "High Octane Gasoline": { map: "diesel", value: 2500 }, // GT5U@5.09.51.476 gregtech/loaders/materials/MaterialsInit1.java:861
  "Seed Oil": { map: "dense", value: 2 }, // GT5U@5.09.51.476 gregtech/loaders/materials/MaterialsInit1.java:474
  "Light Oil": { map: "dense", value: 20 }, // GT5U@5.09.51.476 gregtech/loaders/materials/MaterialsInit1.java:593
  "Raw Oil": { map: "dense", value: 30 }, // GT5U@5.09.51.476 gregtech/loaders/materials/MaterialsInit1.java:592
  "Heavy Oil": { map: "dense", value: 40 }, // GT5U@5.09.51.476 gregtech/loaders/materials/MaterialsInit1.java:591
  "Sulfuric Heavy Fuel": { map: "dense", value: 40 }, // GT5U@5.09.51.476 gregtech/loaders/materials/MaterialsInit1.java:599
  "Very Heavy Oil": { map: "dense", value: 45 }, // GT5U@5.09.51.476 gregtech/loaders/materials/MaterialsInit1.java:590
  "Naphthenic Acid": { map: "dense", value: 80 }, // GT5U@5.09.51.476 gregtech/api/enums/MaterialsKevlar.java:475
  Glycerol: { map: "dense", value: 164 }, // GT5U@5.09.51.476 gregtech/loaders/materials/MaterialsInit1.java:627
  "Heavy Fuel": { map: "dense", value: 240 }, // GT5U@5.09.51.476 gregtech/loaders/materials/MaterialsInit1.java:602
};

/** The liquid names 2.8.1's two maps list, so a test can check each against 2.9's rows. */
export const LARGE_BOILER_LIQUID_NAMES_2_8_1 = Object.keys(LIQUIDS);

/** A diesel-map liquid needs a special value above 1 (MTELargeBoiler.java:278). */
export function dieselLiquidBurns(specialValue: number): boolean {
  return specialValue > 1;
}

/**
 * Burn ticks per 1000 L: runtimeBoost(value / 2) for a diesel liquid (MTELargeBoiler.java:281),
 * max(1, runtimeBoost(value x 2)) for a dense one (:297-298).
 */
export function liquidBurnTicks(
  tier: LargeBoilerTier,
  map: LiquidMap,
  specialValue: number,
): number {
  const { runtimeBoost } = LARGE_BOILERS_2_8_1[tier];
  return map === "diesel"
    ? runtimeBoost(Math.trunc(specialValue / 2))
    : Math.max(1, runtimeBoost(specialValue * 2));
}

/**
 * A superheated boiler runs only while every stored item is in
 * LargeBoilerFuelBackend.ALLOWED_SOLID_FUELS, the Solid Super Fuel and Magic Solid Super Fuel
 * blocks (gt.blockreinforced:6 and 7, LargeBoilerFuelBackend.java:30-31; MTELargeBoiler.java:232-245).
 */
const SUPERHEATED_SOLIDS = new Set(["Solid Super Fuel", "Magic Solid Super Fuel"]);

/**
 * A bronze or steel boiler takes a solid whose fuel value / 80 is above 0 and whose
 * fuel value x 2 / EUt (long division) is above 1 (MTELargeBoiler.java:341-342).
 *
 * The lava-bucket checks (MTELargeBoiler.java:315,337) compare by reference against a fresh copy
 * from GTOreDictUnificator.get (GTOreDictUnificator.java:119-142), so they never match and filter
 * nothing: a lava bucket stays wherever 2.9's rows list one.
 */
export function solidBurns(tier: LargeBoilerTier, name: string, fuelValue: number): boolean {
  const { eut, superheated } = LARGE_BOILERS_2_8_1[tier];
  if (superheated) {
    return SUPERHEATED_SOLIDS.has(name) && Math.trunc(fuelValue / 80) > 0;
  }
  return Math.trunc(fuelValue / 80) > 0 && Math.trunc((fuelValue * 2) / eut) > 1;
}

/**
 * Burn ticks per item: fuel value / 80 (int); for a bronze or steel boiler, times
 * getLongBurntimeRatio, 1 + log9((float) fuel / 1600) x 0.025, cast to int; then runtimeBoost
 * (MTELargeBoiler.java:317-322 superheated, :341-348 and :368-371 otherwise). Every fuel value in
 * the rows is a multiple of 80, so the carried remainder (excessFuel) never adds a tick.
 */
export function solidBurnTicks(tier: LargeBoilerTier, fuelValue: number): number {
  const { superheated, runtimeBoost } = LARGE_BOILERS_2_8_1[tier];
  const ticks = Math.trunc(fuelValue / 80);
  if (superheated) {
    return runtimeBoost(ticks);
  }
  const ratio = 1 + (Math.log(fdiv(fuelValue, 1600)) / Math.log(9)) * 0.025;
  return runtimeBoost(Math.trunc(ticks * ratio));
}

const TIERS: LargeBoilerTier[] = ["bronze", "steel", "titanium", "tungstensteel"];

function liquidRows(tier: LargeBoilerTier): PowerFuelEntry[] {
  if (LARGE_BOILERS_2_8_1[tier].superheated) {
    return [];
  }
  // 2.9's bronze rows give the order; a row neither map lists is dropped.
  return tables29.boilerFuels.bronzeLiquid.flatMap((row) => {
    const liquid = LIQUIDS[row.name];
    if (!liquid || (liquid.map === "diesel" && !dieselLiquidBurns(liquid.value))) {
      return [];
    }
    return [
      {
        name: row.name,
        euPerLiter: liquid.value,
        burnTime: liquidBurnTicks(tier, liquid.map, liquid.value) / 20,
      },
    ];
  });
}

function solidRows(tier: LargeBoilerTier): PowerFuelEntry[] {
  // Fuel values are 2.9's rows, which the audit finds the same in 2.8.1.
  return tables29.boilerFuels[`${tier}Solid`]
    .filter((row) => solidBurns(tier, row.name, row.euPerItem ?? 0))
    .map((row) => ({ ...row, burnTime: solidBurnTicks(tier, row.euPerItem ?? 0) / 20 }));
}

export const BOILERS_2_8_1: Partial<PowerTables> = {
  boilerFuels: Object.fromEntries(
    TIERS.flatMap((tier) => [
      [`${tier}Liquid`, liquidRows(tier)],
      [`${tier}Solid`, solidRows(tier)],
    ]),
  ),
};
