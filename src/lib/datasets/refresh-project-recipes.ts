import type { DatasetManifest, DatasetVersion, RecipeDataset } from "./types";
import type { FactoryProject, Recipe } from "@/lib/model/types";
import { datasetServesPlan } from "./dataset-cache";
import { isPowerRecipe } from "@/lib/power/power-recipe";
import { isCustomRateRecipe } from "@/lib/model/custom-rate";
import { FLUID_TANK_EMPTY_MAP } from "@/lib/model/fluid-tank";
import { CROP_FARM_PLACEHOLDER_RECIPE_ID } from "@/lib/model/passive-production";
import { recipeContentRef } from "@/lib/import-export/recipe-ref-match";
import { getRecipeDatasetRecipe, resolveRecipeDatasetRecipes } from "./browser-loader";
import { noteRestorableRecipes } from "./restorable-recipes";

/**
 * Which of a plan's recipes to fetch fresh from the dataset: each id once per
 * dataset version, and AGAIN when a recipe whose dataset body carries a
 * runtime table arrives without one. Synced and copied plans travel without
 * their GregTech tables (`withoutRuntimeTables`), and may bring recipes this
 * page already refreshed for another plan; keying on the id alone would leave
 * those bare, solving on fallback math.
 *
 * `checked` maps `version|id` to whether the dataset's body had a table;
 * `requested` holds recipe objects already sent, so none is fetched twice.
 */
export function recipesToRefresh(
  recipes: Recipe[],
  versionId: string,
  checked: Map<string, boolean>,
  requested: WeakSet<Recipe>,
): Recipe[] {
  return recipes.filter((recipe) => {
    if (requested.has(recipe)) {
      return false;
    }
    const key = `${versionId}|${recipe.id}`;
    return !checked.has(key) || (checked.get(key) === true && !recipe.runtimeCalculation);
  });
}

/**
 * The page's landing refresh memory: what was checked against which dataset
 * version, and which recipe objects were sent. One per page, so a step outside
 * the board (a plan file import) can ask for a recipe again.
 */
export const landingRefreshMemory = {
  checked: new Map<string, boolean>(),
  requested: new WeakSet<Recipe>(),
};

/**
 * Forgets that these stored bodies were checked against `versionId`, so the next
 * landing refresh asks for them again: a revoked pick whose settling could not
 * finish (a failed twin lookup, a plan no longer on the board) keeps its stored
 * body, and is found and settled at that next landing.
 */
export function forgetRecipeChecks(
  versionId: string,
  recipes: Recipe[],
  memory: Pick<typeof landingRefreshMemory, "checked" | "requested"> = landingRefreshMemory,
): void {
  for (const recipe of recipes) {
    memory.checked.delete(`${versionId}|${recipe.id}`);
    memory.requested.delete(recipe);
  }
}

/** Marks `recipes` as sent, then what the dataset answered for them. */
export function noteRecipesRequested(
  recipes: Recipe[],
  versionId: string,
  checked: Map<string, boolean>,
  requested: WeakSet<Recipe>,
): void {
  for (const recipe of recipes) {
    requested.add(recipe);
    const key = `${versionId}|${recipe.id}`;
    if (!checked.has(key)) {
      checked.set(key, false);
    }
  }
}

export function noteRecipesRefreshed(
  refreshed: Recipe[],
  versionId: string,
  checked: Map<string, boolean>,
): void {
  noteRestorableRecipes(refreshed, versionId);
  for (const recipe of refreshed) {
    checked.set(`${versionId}|${recipe.id}`, Boolean(recipe.runtimeCalculation));
  }
}

/**
 * The dataset's current bodies for a plan's stored recipes.
 *
 * By id first. A stored id the dataset no longer has (a rebuild can re-key
 * recipes) is matched by what it takes and makes, the way import does, and
 * comes back with a `migration` entry from the stored id to the current one,
 * so old cards still pick up the dataset's current handlers. Power cards are
 * synthesized on the way in and are skipped. Once `dropped()` says the answer is no
 * longer wanted, nothing more is asked.
 */
export async function resolveProjectRecipes(
  manifestUrl: string,
  version: DatasetVersion,
  recipes: Recipe[],
  dropped: () => boolean = () => false,
): Promise<{ refreshed: Recipe[]; migration: Record<string, string> }> {
  // A demo recipe is the plan's own data: the dataset never has it, so asking only fills the console with 404s.
  // Custom rate cards, empty fluid tanks and the empty crop farm are the plan's own cards too.
  const asked = recipes.filter(
    (recipe) =>
      !recipe.isDemo &&
      !isPowerRecipe(recipe) &&
      !isCustomRateRecipe(recipe) &&
      recipe.source?.recipeMap !== FLUID_TANK_EMPTY_MAP &&
      recipe.id !== CROP_FARM_PLACEHOLDER_RECIPE_ID,
  );
  const byId = await Promise.allSettled(
    asked.map((recipe) => getRecipeDatasetRecipe(manifestUrl, version, recipe.id)),
  );
  const refreshed = byId
    .filter((result): result is PromiseFulfilledResult<Recipe> => result.status === "fulfilled")
    .map((result) => result.value);
  const stale = asked.filter(
    (recipe, index) => byId[index]?.status === "rejected" && !isPowerRecipe(recipe),
  );
  const migration: Record<string, string> = {};
  if (stale.length > 0 && !dropped()) {
    try {
      const resolved = await resolveRecipeDatasetRecipes(manifestUrl, version, stale.map(recipeContentRef));
      const fetched = await Promise.allSettled(
        (dropped() ? [] : resolved.matches).map(async (match) => ({
          importedId: match.importedId,
          recipe: await getRecipeDatasetRecipe(manifestUrl, version, match.recipeId),
        })),
      );
      for (const result of fetched) {
        if (result.status === "fulfilled") {
          migration[result.value.importedId] = result.value.recipe.id;
          refreshed.push(result.value.recipe);
        }
      }
    } catch {
      // No match service: the stored bodies keep working as they are.
    }
  }
  return { refreshed, migration };
}

/**
 * The landing refresh (FactoryPlannerApp): the active dataset's bodies for the open plan's
 * recipes not yet checked against it. It runs only while the dataset serves the plan's game
 * version, and `apply` runs only if the answer lands while the board still holds a plan the
 * same dataset serves (`stillServes`): a refresh never crosses versions. A dropped answer is
 * forgotten: dropped by an edit, it is asked again at once (`retry`); dropped by a switch to
 * another version's tab, when its plan is back on the board. Returns the cancel
 * for an effect's cleanup, or undefined when nothing was asked.
 */
export function startLandingRefresh(options: {
  dataset: Pick<RecipeDataset, "datasetVersionId" | "gtnhVersion"> | undefined;
  manifest: DatasetManifest | undefined;
  manifestUrl: string;
  project: Pick<FactoryProject, "gameVersion" | "recipes">;
  checked: Map<string, boolean>;
  requested: WeakSet<Recipe>;
  stillServes: () => boolean;
  apply: (refreshed: Recipe[], migration: Record<string, string>) => void;
  /** Asks for another run: an answer dropped by an edit on the same plan is asked again at once. */
  retry?: () => void;
}): (() => void) | undefined {
  const { dataset, manifest, project, checked, requested } = options;
  if (!dataset || !datasetServesPlan(dataset, project)) {
    return undefined;
  }
  const version = manifest?.versions.find((entry) => entry.id === dataset.datasetVersionId);
  if (!version) {
    return undefined;
  }
  const pending = recipesToRefresh(project.recipes, version.id, checked, requested);
  if (pending.length === 0) {
    return undefined;
  }
  const unchecked = pending.filter((recipe) => !checked.has(`${version.id}|${recipe.id}`));
  noteRecipesRequested(pending, version.id, checked, requested);
  let cancelled = false;
  const dropped = () => cancelled || !options.stillServes();
  void resolveProjectRecipes(options.manifestUrl, version, pending, dropped).then(({ refreshed, migration }) => {
    if (dropped()) {
      // Dropped (the board moved on): these recipes are asked again when their plan is back.
      for (const recipe of pending) requested.delete(recipe);
      for (const recipe of unchecked) checked.delete(`${version.id}|${recipe.id}`);
      if (options.stillServes()) options.retry?.();
      return;
    }
    noteRecipesRefreshed(refreshed, version.id, checked);
    if (refreshed.length > 0) {
      options.apply(refreshed, migration);
    }
  });
  return () => {
    cancelled = true;
  };
}
