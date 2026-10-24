/**
 * Fusion recipe tables that differ in 2.8.1.
 * Each entry replaces 2.9's whole table, and each row cites its source as `// GT5U@5.09.51.476 <path>:<line>`.
 *
 * Built on 2.9's corrected table (overrides-2.9/fusion.ts), so the source corrections both
 * versions share apply here too. 2.8.1 runs every one of the 65 rows (its export lists all of
 * them) and lacks only the three recipes 5.09.54 added, which the table never had. What
 * remains is the three EU/t literals 5.09.54 turned into half-tier values.
 */
import type { PowerTables } from "../planner-data";
import { applyFusionChanges, rebillBoth, type FusionRowChange } from "../fusion-corrections";
import { FUSION_2_9 } from "../overrides-2.9/fusion";

const LITERALS_2_8_1: FusionRowChange[] = [
  // GT5U@5.09.51.476 gregtech/loaders/postload/recipes/FusionReactorRecipes.java:39
  { name: "Helium Plasma", input1: "Deuterium", input2: "Tritium", rebill: rebillBoth(3840, 4096) },
  // GT5U@5.09.51.476 gregtech/loaders/postload/recipes/FusionReactorRecipes.java:63
  {
    name: "Nitrogen Plasma",
    input1: "Molten Beryllium",
    input2: "Deuterium",
    rebill: rebillBoth(15360, 16384),
  },
  // GT5U@5.09.51.476 gregtech/loaders/postload/recipes/FusionReactorRecipes.java:192
  {
    name: "Molten Duranium",
    input1: "Molten Gallium",
    input2: "Radon",
    rebill: rebillBoth(15360, 16384),
  },
];

export const FUSION_2_8_1: Partial<PowerTables> = {
  fusionRecipes: applyFusionChanges(FUSION_2_9.fusionRecipes, LITERALS_2_8_1),
};
