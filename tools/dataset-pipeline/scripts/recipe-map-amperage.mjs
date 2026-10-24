// A recipe map's amperage (RecipeMapBuilder.amperage), by pack. The game finds a
// recipe for a machine when voltage x map amperage >= recipe EU/t
// (FindRecipeQuery.java:91 at GT5U 5.09.54.205 and 5.09.51.476), so a recipe's
// lowest tier on such a map divides its EU/t by the amps. Maps not listed are 1 A.
// The app keeps the same table in src/lib/machines/recipe-map-amperage.ts; a test
// pins the two together.

// 2.9, GT5U 5.09.54.205 RecipeMaps.java: :168 thermal centrifuge, :1493 mass fab.
const BASE = Object.freeze({
  "gt.recipe.thermalcentrifuge": 2,
  "gt.recipe.massfab": 8,
});

const BY_PACK = Object.freeze({
  // GT5U 5.09.51.476 RecipeMaps.java: :118 thermal centrifuge, :286 arc furnace, :1062 mass fab.
  "2.8.1": Object.freeze({
    "gt.recipe.thermalcentrifuge": 2,
    "gt.recipe.massfab": 8,
    "gt.recipe.arcfurnace": 3,
  }),
});

/** Every map with more than one amp in the pack `gtnhVersion` labels (any 2.9 build reads the base). */
export function recipeMapAmperageTable(gtnhVersion) {
  return BY_PACK[gtnhVersion] ?? BASE;
}

export function recipeMapAmperage(recipeMapId, gtnhVersion) {
  return recipeMapAmperageTable(gtnhVersion)[recipeMapId] ?? 1;
}
