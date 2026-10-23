import type { Recipe } from "@/lib/model/types";

/**
 * Recipes whose dataset body carries a runtime table, as learned from the
 * refreshes this page has made (FactoryPlannerApp), keyed by the dataset
 * version and the recipe id.
 *
 * A plan may leave a GregTech table out when it travels (account sync, Copy
 * plan) ONLY if the dataset will put it back on landing. For a recipe the
 * dataset no longer knows, the stored table is the only copy, so stripping it
 * would lose it for good. Unknown means keep. The version is part of the key
 * because one id can name a recipe in both 2.9 and 2.8.1: a table one dataset
 * puts back says nothing about the other's.
 */
const restorable = new Set<string>();

const keyOf = (datasetVersionId: string, recipeId: string) => `${datasetVersionId}|${recipeId}`;

export function noteRestorableRecipes(refreshed: Recipe[], datasetVersionId: string): void {
  for (const recipe of refreshed) {
    if (recipe.runtimeCalculation) {
      restorable.add(keyOf(datasetVersionId, recipe.id));
    }
  }
}

/** Whether the dataset the recipe's body came from (`source.datasetVersionId`) puts its table back. */
export function isRestorableRecipe(recipe: Pick<Recipe, "id" | "source">): boolean {
  const datasetVersionId = recipe.source?.datasetVersionId;
  return datasetVersionId !== undefined && restorable.has(keyOf(datasetVersionId, recipe.id));
}
