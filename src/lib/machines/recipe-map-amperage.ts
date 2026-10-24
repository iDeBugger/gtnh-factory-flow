import type { GameVersion } from "@/lib/model/game-version";

/*
 * A recipe map's amperage (`RecipeMapBuilder.amperage`). Recipes on such a map
 * store EU/t with the amps included, and the game finds a recipe for a machine
 * when `voltage x map amperage >= recipe EU/t` (FindRecipeQuery.java:91 at both
 * GT5U@5.09.54.205 and GT5U@5.09.51.476). A singleblock queries with its own
 * tier's voltage (MTEBasicMachine.checkRecipe: `.voltage(V[mTier])`,
 * GT5U@5.09.54.205 :1103, GT5U@5.09.51.476 :1060), so on a 2 A map an LV
 * machine runs a 48 EU/t recipe. Maps not listed are 1 A.
 *
 * The dataset pipeline keeps the same table
 * (tools/dataset-pipeline/scripts/recipe-map-amperage.mjs); a test pins the two
 * together.
 */

/** 2.9, GT5U@5.09.54.205 gregtech/api/recipe/RecipeMaps.java. */
const BASE: Readonly<Record<string, number>> = {
  // :168 thermalCentrifugeRecipes `.amperage(2)`.
  "gt.recipe.thermalcentrifuge": 2,
  // :1493 massFabFakeRecipes `.amperage(8)`.
  "gt.recipe.massfab": 8,
};

const BY_VERSION: Partial<Record<GameVersion, Readonly<Record<string, number>>>> = {
  // GT5U@5.09.51.476 gregtech/api/recipe/RecipeMaps.java: :118 thermal centrifuge 2, :1062 mass fab 8, and
  // :286 arcFurnaceRecipes `.amperage(3)` (2.9's arc map has none; its machines carry the 3 A themselves).
  "2.8.1": {
    "gt.recipe.thermalcentrifuge": 2,
    "gt.recipe.massfab": 8,
    "gt.recipe.arcfurnace": 3,
  },
};

/** Every map with more than one amp, as `gameVersion` has them. */
export function recipeMapAmperageTable(gameVersion: GameVersion): Readonly<Record<string, number>> {
  return BY_VERSION[gameVersion] ?? BASE;
}

/** The amperage of the recipe map `recipeMapId` names (a dataset recipe's `metadata.recipeMapId`); 1 when unlisted. */
export function getRecipeMapAmperage(recipeMapId: unknown, gameVersion: GameVersion): number {
  if (typeof recipeMapId !== "string") return 1;
  return recipeMapAmperageTable(gameVersion)[recipeMapId] ?? 1;
}
