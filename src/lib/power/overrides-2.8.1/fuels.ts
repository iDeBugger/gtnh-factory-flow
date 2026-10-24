/**
 * Fuel tables (generator, turbine and engine fuels) that differ in 2.8.1.
 * Each entry replaces 2.9's whole table, and each row cites its source as `// GT5U@5.09.51.476 <path>:<line>`.
 */
import rawData from "../data/power-planner-data.json";
import type { PowerFuelEntry, PowerTables } from "../planner-data";

// The JSON itself, not powerTablesFor: planner-data imports this module.
const tables29 = rawData as unknown as PowerTables;

/**
 * The acid generator's map (BartWorksRecipeMaps.acidGenFuels). `euPerLiter` is the map's
 * FUEL_VALUE as written, in both versions: Mercury is 32 in each
 * (GT5U@5.09.54.205 AdditionalRecipes.java:257, GT5U@5.09.51.476 AdditionalRecipes.java:254).
 * 2.8.1 has only these 12; the eight newer acids came after it (GT5U@5.09.54.205 AdditionalRecipes.java:251-280).
 */
const CHEM_FUELS: PowerFuelEntry[] = [
  { name: "Diluted Sulfuric Acid", euPerLiter: 9 }, // GT5U@5.09.51.476 bartworks/system/material/processingLoaders/AdditionalRecipes.java:255
  { name: "Molten Redstone", euPerLiter: 10 }, // GT5U@5.09.51.476 bartworks/system/material/processingLoaders/AdditionalRecipes.java:271
  { name: "Acetic Acid", euPerLiter: 11 }, // GT5U@5.09.51.476 bartworks/system/material/processingLoaders/AdditionalRecipes.java:257
  { name: "Diluted Hydrochloric Acid", euPerLiter: 14 }, // GT5U@5.09.51.476 bartworks/system/material/processingLoaders/AdditionalRecipes.java:249
  { name: "Sulfuric Acid", euPerLiter: 18 }, // GT5U@5.09.51.476 bartworks/system/material/processingLoaders/AdditionalRecipes.java:256
  { name: "Nitric Acid", euPerLiter: 24 }, // GT5U@5.09.51.476 bartworks/system/material/processingLoaders/AdditionalRecipes.java:253
  { name: "Hydrochloric Acid", euPerLiter: 28 }, // GT5U@5.09.51.476 bartworks/system/material/processingLoaders/AdditionalRecipes.java:252
  { name: "Hypochlorous Acid", euPerLiter: 30 }, // GT5U@5.09.51.476 bartworks/system/material/processingLoaders/AdditionalRecipes.java:250
  { name: "Mercury", euPerLiter: 32 }, // GT5U@5.09.51.476 bartworks/system/material/processingLoaders/AdditionalRecipes.java:254
  { name: "Phosphoric Acid", euPerLiter: 36 }, // GT5U@5.09.51.476 bartworks/system/material/processingLoaders/AdditionalRecipes.java:248
  { name: "Hydrofluoric Acid", euPerLiter: 40 }, // GT5U@5.09.51.476 bartworks/system/material/processingLoaders/AdditionalRecipes.java:251
  { name: "Formic Acid", euPerLiter: 40 }, // GT5U@5.09.51.476 bartworks/system/material/processingLoaders/AdditionalRecipes.java:258
];

/**
 * The semifluid generator's map (GTPPRecipeMaps.semiFluidFuels). `euPerLiter` is the map's
 * FUEL_VALUE. A fuel the map copies from a material's semifluid (type 3) fuel power is that power
 * times 6 for Creosote, 1.5 for Heavy Fuel and Heavy Oil, 2 for the rest (SemiFluidFuelHandler):
 * Creosote 8 x 6 = 48, Heavy Oil 40 x 1.5 = 60, the same in both versions
 * (GT5U@5.09.51.476 SemiFluidFuelHandler.java:63,68; GT5U@5.09.54.205 SemiFluidFuelHandler.java:57,62).
 * 2.8.1 drops a copied value above 128 x 3 = 384 (GT5U@5.09.51.476 SemiFluidFuelHandler.java:73; 2.9:
 * 128 x 4 = 512, GT5U@5.09.54.205 :67) and gives Nefarious Oil no material fuel, so its 572 is written straight into the map (2.9 copies
 * 256 x 2 = 512, GT5U@5.09.54.205 MaterialsInit.java:14163). A fuel the map lists directly keeps
 * its value as written. 2.9 dropped the manure fuels.
 *
 * Hemp Seed Oil and Lin Seed Oil are semifluid fuel materials with no fluid: their cells burn in the
 * semifluid boiler map only, cell in and empty cell out (GT5U@5.09.51.476
 * gregtech/loaders/oreprocessing/ProcessingCell.java:55). The handler copies an item fuel into
 * this map only as the fluid its container holds, and skips it when there is none
 * (GT5U@5.09.51.476 gregtech/api/util/SemiFluidFuelHandler.java:31-38), so the generator takes neither.
 */
const SEMIFLUID_FUELS: PowerFuelEntry[] = [
  { name: "Fish Oil", euPerLiter: 4 }, // GT5U@5.09.51.476 gregtech/loaders/materials/MaterialsInit1.java:454 (2 x 2)
  { name: "Seed Oil", euPerLiter: 4 }, // GT5U@5.09.51.476 gregtech/loaders/materials/MaterialsInit1.java:474 (2 x 2)
  { name: "Poop Juice", euPerLiter: 12 }, // GT5U@5.09.51.476 gtPlusPlus/core/item/chemistry/RecipeLoaderAgriculturalChem.java:402
  { name: "Coal Tar", euPerLiter: 16 }, // GT5U@5.09.51.476 gtPlusPlus/core/item/chemistry/RecipeLoaderCoalTar.java:311
  { name: "Biomass", euPerLiter: 16 }, // GT5U@5.09.51.476 gregtech/loaders/materials/MaterialsInit1.java:443 (8 x 2)
  { name: "Manure Slurry", euPerLiter: 24 }, // GT5U@5.09.51.476 gtPlusPlus/core/item/chemistry/RecipeLoaderAgriculturalChem.java:409
  { name: "Coal Tar Oil", euPerLiter: 32 }, // GT5U@5.09.51.476 gtPlusPlus/core/item/chemistry/RecipeLoaderCoalTar.java:304
  { name: "Fertile Manure Slurry", euPerLiter: 32 }, // GT5U@5.09.51.476 gtPlusPlus/core/item/chemistry/RecipeLoaderAgriculturalChem.java:416
  { name: "Light Oil", euPerLiter: 40 }, // GT5U@5.09.51.476 gregtech/loaders/materials/MaterialsInit1.java:593 (20 x 2)
  { name: "Oil", euPerLiter: 40 }, // GT5U@5.09.51.476 gregtech/loaders/materials/MaterialsInit1.java:468 (20 x 2)
  { name: "Creosote Oil", euPerLiter: 48 }, // GT5U@5.09.51.476 gregtech/loaders/materials/MaterialsInit1.java:452 (8 x 6)
  { name: "Heavy Oil", euPerLiter: 60 }, // GT5U@5.09.51.476 gregtech/loaders/materials/MaterialsInit1.java:591 (40 x 1.5)
  { name: "Raw Oil", euPerLiter: 60 }, // GT5U@5.09.51.476 gregtech/loaders/materials/MaterialsInit1.java:592 (30 x 2)
  { name: "Sulfuric Coal Tar Oil", euPerLiter: 64 }, // GT5U@5.09.51.476 gtPlusPlus/core/item/chemistry/RecipeLoaderCoalTar.java:297
  { name: "Sulfuric Heavy Fuel", euPerLiter: 80 }, // GT5U@5.09.51.476 gregtech/loaders/materials/MaterialsInit1.java:599 (40 x 2)
  { name: "Very Heavy Oil", euPerLiter: 90 }, // GT5U@5.09.51.476 gregtech/loaders/materials/MaterialsInit1.java:590 (45 x 2)
  { name: "Naphthenic Acid", euPerLiter: 160 }, // GT5U@5.09.51.476 gregtech/api/enums/MaterialsKevlar.java:475 (80 x 2)
  { name: "Glycerol", euPerLiter: 328 }, // GT5U@5.09.51.476 gregtech/loaders/materials/MaterialsInit1.java:627 (164 x 2)
  { name: "Heavy Fuel", euPerLiter: 360 }, // GT5U@5.09.51.476 gregtech/loaders/materials/MaterialsInit1.java:602 (240 x 1.5)
  { name: "Nefarious Oil", euPerLiter: 572 }, // GT5U@5.09.51.476 gregtech/loaders/postload/chains/NetheriteRecipes.java:287
];

/**
 * 2.8.1's Amber is magic fuel 3, not 32 (GT5U@5.09.51.476 MaterialsInit1.java:307;
 * GT5U@5.09.54.205 MaterialsInit.java:2855). Each form's FUEL_VALUE is an integer expression of
 * the power, times 1000 EU per item, so every row is 3/32 of 2.9's except Chipped Amber: its
 * 3 / 2 floors to 1, so it is 1,000 EU, not 1,500. Every other row is 2.9's.
 */
const AMBER_2_8_1: Record<string, number> = {
  "Chipped Amber": 1_000, // GT5U@5.09.51.476 gregtech/loaders/oreprocessing/ProcessingGem.java:254 (3 / 2)
  "Flawed Amber": 3_000, // GT5U@5.09.51.476 gregtech/loaders/oreprocessing/ProcessingGem.java:355 (3)
  "Amber Plate": 3_000, // GT5U@5.09.51.476 gregtech/loaders/oreprocessing/ProcessingPlate.java:110 (3)
  "Amber Dust": 3_000, // GT5U@5.09.51.476 gregtech/loaders/oreprocessing/ProcessingDust.java:60 (3)
  "Amber Gem": 6_000, // GT5U@5.09.51.476 gregtech/loaders/oreprocessing/ProcessingGem.java:62 (3 x 2)
  "Flawless Amber": 12_000, // GT5U@5.09.51.476 gregtech/loaders/oreprocessing/ProcessingGem.java:431 (3 x 4)
  "Exquisite Amber": 24_000, // GT5U@5.09.51.476 gregtech/loaders/oreprocessing/ProcessingGem.java:321 (3 x 8)
};

function magicSolids2_8_1(): PowerFuelEntry[] {
  const rows = tables29.magicSolids.map((row) =>
    row.name in AMBER_2_8_1 ? { ...row, euPerItem: AMBER_2_8_1[row.name] } : row,
  );
  const found = rows.filter((row) => row.name in AMBER_2_8_1).length;
  if (found !== Object.keys(AMBER_2_8_1).length) {
    throw new Error(
      `2.8.1 magicSolids: found ${found} of the ${Object.keys(AMBER_2_8_1).length} Amber rows in 2.9's table.`,
    );
  }
  // The table runs cheapest first; a stable sort keeps 2.9's order among equal values.
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => (a.row.euPerItem ?? 0) - (b.row.euPerItem ?? 0) || a.index - b.index)
    .map(({ row }) => row);
}

/**
 * 2.8.1 has no IV acid generator: LV to EV only (GT5U@5.09.51.476
 * bartworks/common/loaders/ItemRegistry.java:457-477), each at 100 - 3 x tier percent
 * (GT5U@5.09.51.476 bartworks/common/tileentities/tiered/MTEAcidGenerator.java:53). 2.9 adds the
 * IV one at 50% (GT5U@5.09.54.205 bartworks/common/loaders/ItemRegistry.java:332). Every other
 * ladder is 2.9's.
 */
const SINGLEBLOCK_EFFICIENCY: Record<string, Array<number | null>> = {
  ...tables29.singleblockEfficiency,
  chem: [0.97, 0.94, 0.91, 0.88, null, null, null, null, null, null, null, null],
};

export const FUELS_2_8_1: Partial<PowerTables> = {
  chemFuels: CHEM_FUELS,
  semifluidFuels: SEMIFLUID_FUELS,
  magicSolids: magicSolids2_8_1(),
  singleblockEfficiency: SINGLEBLOCK_EFFICIENCY,
};
