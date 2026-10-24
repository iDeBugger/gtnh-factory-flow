/**
 * 2.9's fusion table: the workbook rows with the source corrections both versions share, and
 * the half-tier EU/t values 5.09.54 brought in (the workbook still carries the 5.09.51
 * literals). Each row cites its source as `// GT5U@5.09.54.205 <path>:<line>`.
 *
 * 5.09.54.205 also adds FT1 Europium from Neodymium + Promethium (:104), FT2 Americium from
 * Lutetium + Promethium (:120) and Redstone + Ichorium Hexanite (:331). The workbook never
 * listed them and their products have no plasma value, so the fusion card could not pick them.
 */
import rawData from "../data/power-planner-data.json";
import type { PowerTables } from "../planner-data";
import {
  applyFusionChanges,
  FUSION_SOURCE_CORRECTIONS,
  rebillBoth,
  type FusionRowChange,
} from "../fusion-corrections";

const HALF_TIER_2_9: FusionRowChange[] = [
  // GT5U@5.09.54.205 gregtech/loaders/postload/recipes/FusionReactorRecipes.java:40
  // RECIPE_IV / 2 = 3840 EU/t.
  { name: "Helium Plasma", input1: "Deuterium", input2: "Tritium", rebill: rebillBoth(4096, 3840) },
  // GT5U@5.09.54.205 gregtech/loaders/postload/recipes/FusionReactorRecipes.java:64
  // RECIPE_LuV / 2 = 15360 EU/t.
  {
    name: "Nitrogen Plasma",
    input1: "Molten Beryllium",
    input2: "Deuterium",
    rebill: rebillBoth(16384, 15360),
  },
  // GT5U@5.09.54.205 gregtech/loaders/postload/recipes/FusionReactorRecipes.java:209
  // RECIPE_LuV / 2 = 15360 EU/t.
  {
    name: "Molten Duranium",
    input1: "Molten Gallium",
    input2: "Radon",
    rebill: rebillBoth(16384, 15360),
  },
];

export const FUSION_2_9: Pick<PowerTables, "fusionRecipes"> = {
  fusionRecipes: applyFusionChanges((rawData as unknown as PowerTables).fusionRecipes, [
    ...FUSION_SOURCE_CORRECTIONS,
    ...HALF_TIER_2_9,
  ]),
};
