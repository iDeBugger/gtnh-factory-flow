import { DEFAULT_DATASET_MANIFEST_URL, pickDatasetVersionFor } from "@/lib/datasets";
import {
  getRecipeDatasetRecipe,
  getRecipeDatasetRecipeIds,
  queryRecipeDatasetRecipes,
  resolveRecipeDatasetRecipes,
} from "@/lib/datasets/browser-loader";
import type { DatasetVersion } from "@/lib/datasets";
import type { FactoryProject, Recipe } from "@/lib/model/types";
import {
  refreshImportedProjectEdges,
  remapMigratedRecipeReferences,
} from "@/lib/import-export/recipe-migration";
import {
  extractProjectJsonFromPng,
  extractProjectJsonFromSvg,
} from "@/lib/import-export/plan-image";
import { isPowerRecipe } from "@/lib/power/power-recipe";
import { pickRecipeRefMatch, recipeContentRef } from "@/lib/import-export/recipe-ref-match";
import {
  cloneImportedProject,
  parseFactoryProjectJson,
  serializeFactoryProject,
} from "@/lib/import-export";
import { untagCommunityPlan } from "@/lib/community/client";
import { useFactoryStore } from "@/store/factory-store";

export { refreshImportedProjectEdges };
import { planGameVersion } from "@/lib/model/game-version";
import { useDesignStore } from "@/store/design-store";
import { flashNotice } from "@/components/flow/clean/rail/NoticeBar";

export async function readProjectFile(file: File): Promise<string> {
  const extension = file.name.split(".").pop()?.toLowerCase();

  if (extension === "svg" || file.type === "image/svg+xml") {
    const projectJson = extractProjectJsonFromSvg(await file.text());
    if (!projectJson) {
      throw new Error("This SVG does not contain a GTNH Planner plan.");
    }
    return projectJson;
  }

  if (extension === "png" || file.type === "image/png") {
    const projectJson = await extractProjectJsonFromPng(file);
    if (!projectJson) {
      throw new Error("This PNG does not contain a GTNH Planner plan.");
    }
    return projectJson;
  }

  return file.text();
}

export async function hydrateImportedProjectRecipes(
  project: FactoryProject,
  version: DatasetVersion,
): Promise<{
  project: FactoryProject;
  missingRecipes: Array<Pick<FactoryProject["recipes"][number], "id" | "name">>;
  migratedRecipes: Array<{
    fromId: string;
    toId: string;
    name: string;
    exact: boolean;
  }>;
}> {
  const availableRecipeIds = new Set(
    await getRecipeDatasetRecipeIds(DEFAULT_DATASET_MANIFEST_URL, version),
  );
  const importRecipesToResolve = project.recipes.filter(
    // Power cards own locally synthesized recipes (src/lib/power) that the
    // dataset can never answer for - and must never replace by name-match.
    (recipe) => !availableRecipeIds.has(recipe.id) && !isPowerRecipe(recipe) && !recipe.isDemo,
  );
  const resolvedRecipeIds = new Map(
    importRecipesToResolve.length
      ? (
          await resolveRecipeDatasetRecipes(
            DEFAULT_DATASET_MANIFEST_URL,
            version,
            importRecipesToResolve.map(recipeContentRef),
          )
        ).matches.map((match) => [match.importedId, match] as const)
      : [],
  );
  const missingRecipes: Array<Pick<FactoryProject["recipes"][number], "id" | "name">> = [];
  const migratedRecipes: Array<{ fromId: string; toId: string; name: string; exact: boolean }> = [];
  const recipeIdMigration = new Map<string, string>();

  const hydratedRecipes = await Promise.all(
    project.recipes.map(async (recipe) => {
      // A demo recipe is the plan's own data (nothing in the dataset can stand for it: a content match once turned
      // a demo methane source into the Underground Fluid map).
      if (recipe.isDemo) return recipe;
      if (isPowerRecipe(recipe)) {
        // Survives verbatim; normalizeLoadedProject resynthesizes it from
        // the node's settings on the way in.
        return recipe;
      }
      if (!availableRecipeIds.has(recipe.id)) {
        const contentMatch = resolvedRecipeIds.get(recipe.id);
        const migratedRecipe = contentMatch
          ? await getRecipeDatasetRecipe(
              DEFAULT_DATASET_MANIFEST_URL,
              version,
              contentMatch.recipeId,
            )
          : await resolveImportedRecipe(version, recipe);
        if (migratedRecipe) {
          migratedRecipes.push({
            fromId: recipe.id,
            toId: migratedRecipe.id,
            name: recipe.name,
            exact: contentMatch?.exact ?? false,
          });
          recipeIdMigration.set(recipe.id, migratedRecipe.id);
          return migratedRecipe;
        }

        // Nothing in the dataset is close enough to stand in for it: the
        // plan's own embedded body keeps working, so it stays.
        missingRecipes.push({ id: recipe.id, name: recipe.name });
        return recipe;
      }

      return getRecipeDatasetRecipe(DEFAULT_DATASET_MANIFEST_URL, version, recipe.id);
    }),
  );
  const hydratedProject = {
    ...project,
    recipes: hydratedRecipes,
  };

  return {
    project: remapMigratedRecipeReferences(hydratedProject, recipeIdMigration),
    missingRecipes,
    migratedRecipes,
  };
}

async function resolveImportedRecipe(
  version: DatasetVersion,
  importedRecipe: Recipe,
): Promise<Recipe | undefined> {
  const candidates = await queryRecipeDatasetRecipes(DEFAULT_DATASET_MANIFEST_URL, version, {
    query: importedRecipe.name,
    mode: "recipes",
    maxTier: "all",
    offset: 0,
    limit: 40,
  });
  // A name search is the last resort, and it only ever hands back a recipe
  // that takes and makes the same things: a same-named recipe with other
  // inputs (the second Steel Ingot blast furnace recipe) is not this one.
  const match = pickRecipeRefMatch(
    recipeContentRef(importedRecipe),
    candidates.recipes.map((candidate) => ({
      ...candidate,
      source: candidate.source ?? { recipeMap: candidate.recipeMap },
    })),
  );

  return match && match.score >= RECIPE_MIGRATION_SCORE
    ? getRecipeDatasetRecipe(DEFAULT_DATASET_MANIFEST_URL, version, match.candidate.id)
    : undefined;
}

/** Below this the likeness is too loose to swap a plan's recipe for. */
const RECIPE_MIGRATION_SCORE = 300;

/** True when pasted text is a plan file (JSON) rather than a link or code. */
export function looksLikePlanJson(text: string): boolean {
  return /^\s*\{/.test(text);
}

/**
 * Open plan JSON (an exported file's text, or the same pasted) as a NEW design tab, never over the plan on the
 * board. Recipes are hydrated against the dataset of the plan's own game version, whatever the open tab is on; ones it
 * lacks keep the plan's embedded body. A plan whose version this site does not serve opens as it was written.
 */
export async function openPlanJsonText(
  text: string,
  fallbackName = "Imported plan",
): Promise<void> {
  // The board shows its loading overlay while the recipes are fetched, which can take a while when the
  // server asks the browser to wait: for a pasted plan as much as for a file.
  const { setProjectImporting } = useFactoryStore.getState();
  setProjectImporting(true);
  try {
    await openPlanJson(text, fallbackName);
  } finally {
    setProjectImporting(false);
  }
}

async function openPlanJson(text: string, fallbackName: string): Promise<void> {
  const importedProject = refreshImportedProjectEdges(
    cloneImportedProject(untagCommunityPlan(parseFactoryProjectJson(text)) as FactoryProject),
  );
  const name = importedProject.name || fallbackName;
  const { importProjectAsDesign } = useDesignStore.getState();
  const gameVersion = planGameVersion(importedProject);
  const factory = useFactoryStore.getState();
  // Hydration asks the recipe endpoints by version and needs no catalog; the catalog only
  // warms in the cache so the new tab opens ready.
  const datasetVersion =
    factory.datasetManifest && pickDatasetVersionFor(factory.datasetManifest, gameVersion);
  if (datasetVersion) {
    void factory.ensureDatasetFor(gameVersion);
  }
  // A new tab has no camera of its own yet, so it lands framed on the imported cards.
  if (!datasetVersion) {
    await importProjectAsDesign(importedProject, name);
    return;
  }
  const hydration = await hydrateImportedProjectRecipes(importedProject, datasetVersion);
  await importProjectAsDesign(refreshImportedProjectEdges(hydration.project), name);
}

/** Open a plan file (.json, or a .png / .svg picture that carries the plan) as a new design tab. */
export async function openPlanFile(file: File): Promise<void> {
  await openPlanJsonText(await readProjectFile(file), file.name.replace(/\.[^.]+$/, ""));
}

/**
 * Files dropped on a plan board: a plan file (.json, or a picture that carries a plan) opens as a new plan. Any other
 * picture is ignored with a short notice, since plan boards have no image annotations.
 */
export async function dropFilesOnPlanBoard(files: File[]): Promise<void> {
  const planFile = files.find(
    (file) => /\.json$/i.test(file.name) || file.type === "application/json",
  );
  const picture = files.find((file) => file.type.startsWith("image/"));
  try {
    if (planFile) {
      await openPlanFile(planFile);
    } else if (picture) {
      // A screenshot the planner saved carries its plan; any other picture does not.
      try {
        await openPlanFile(picture);
      } catch {
        flashNotice("info", "Pictures can't go on a plan board. Sticky notes hold text.");
      }
    } else {
      flashNotice("info", "That file is not a plan. Drop a .json plan file.");
    }
  } catch (error) {
    flashNotice(
      "warn",
      error instanceof Error ? error.message : "That plan file could not be opened.",
    );
  }
}

/** Save the open plan as a .json file the browser downloads (Open plan file... reads it back). */
export function downloadPlanFile(project: FactoryProject): void {
  const blob = new Blob([serializeFactoryProject(project)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${project.name.toLowerCase().replace(/[^a-z0-9]+/g, "-") || "factory"}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}
