import type { FactoryProject, Recipe } from "@/lib/model/types";
import { listNodeSections } from "@/lib/model/shared-machine";
import { revokedSubstituteTwin, type RevokedSubstitute } from "@/lib/model/revoked-substitutes";
import { getRecipeDatasetRecipe } from "./browser-loader";
import { fetchRecipeTwins } from "./recipe-twins";
import type { DatasetVersion } from "./types";

/**
 * Each revoked pick with the recipe it really belongs to, when the dataset has
 * exactly one on the card's map (`revokedSubstituteTwin`). Only a card's own
 * recipe is asked about: a shared machine's sections are never moved. A failed
 * lookup is no twin, so the card stays and the notice names it.
 */
export async function findRevokedSubstituteTwins(
  manifestUrl: string,
  version: DatasetVersion,
  project: FactoryProject,
  revoked: RevokedSubstitute[],
): Promise<Array<{ revoked: RevokedSubstitute; twin?: Recipe }>> {
  return Promise.all(
    revoked.map(async (entry) => {
      const recipe = project.recipes.find((candidate) => candidate.id === entry.recipeId);
      const node = project.nodes.find((candidate) => candidate.id === entry.nodeId);
      if (!recipe || !node || entry.section !== 0 || node.extraRecipes?.length) return { revoked: entry };
      try {
        const view = listNodeSections(node)[0]!.node;
        const candidates = [...new Map((await fetchRecipeTwins(version, recipe, view)).map((twin) => [twin.recipe.id, twin.recipe])).values()];
        const summary = revokedSubstituteTwin(recipe, entry, candidates);
        return summary ? { revoked: entry, twin: await getRecipeDatasetRecipe(manifestUrl, version, summary.id) } : { revoked: entry };
      } catch {
        return { revoked: entry };
      }
    }),
  );
}
