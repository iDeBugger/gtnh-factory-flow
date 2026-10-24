import { planGameVersion, type GameVersion } from "@/lib/model/game-version";
import { PROJECT_SCHEMA_VERSION, type FactoryNode, type FactoryProject, type Recipe, type UnconvertedRecipe } from "@/lib/model/types";
import { isPowerRecipe } from "@/lib/power/power-recipe";
import { useFactoryStore, type BoardClipboardPayload } from "@/store/factory-store";
import { convertProjectToVersion, isPlanOwnRecipe } from "./convert-plan-version";
import { DEFAULT_DATASET_MANIFEST_URL, pickDatasetVersionFor } from "./remote";
import type { DatasetManifest } from "./types";

/** Where the plan's recipes are served from: the manifest the page loaded, and its address. */
export interface PayloadDatasetSource {
  manifest?: DatasetManifest;
  manifestUrl?: string;
}

function storeSource(): PayloadDatasetSource {
  const state = useFactoryStore.getState();
  return { manifest: state.datasetManifest, manifestUrl: state.datasetManifestUrl };
}

/**
 * Every dataset recipe of the payload marked, for a plan whose version this site serves no recipes for: nothing
 * can be matched there, and a body from the payload's version must not land. Plan-own recipes and power cards stay.
 * A body no unmarked card uses is dropped. Wire handles are left as they were, as a conversion leaves a marked
 * section's.
 */
function markEveryDatasetRecipe(payload: BoardClipboardPayload, fromGameVersion: GameVersion): BoardClipboardPayload {
  const byId = new Map(payload.recipes.map((recipe) => [recipe.id, recipe] as const));
  const stays = (recipeId: string) => {
    const recipe = byId.get(recipeId);
    return recipe !== undefined && (isPlanOwnRecipe(recipe) || isPowerRecipe(recipe));
  };
  const markerFor = (recipeId: string): UnconvertedRecipe => {
    const stored = byId.get(recipeId);
    return {
      fromGameVersion,
      recipeId,
      recipeName: stored?.name ?? recipeId,
      machineType: stored?.machineType ?? "",
    };
  };
  const used = new Set<string>();
  const nodes = payload.nodes.map((node): FactoryNode => {
    let marked = node;
    if (stays(node.recipeId)) used.add(node.recipeId);
    else if (!node.unconverted) marked = { ...marked, unconverted: markerFor(node.recipeId) };
    if (node.extraRecipes?.length) {
      marked = {
        ...marked,
        extraRecipes: node.extraRecipes.map((extra) => {
          if (stays(extra.recipeId)) {
            used.add(extra.recipeId);
            return extra;
          }
          return extra.unconverted ? extra : { ...extra, unconverted: markerFor(extra.recipeId) };
        }),
      };
    }
    return marked;
  });
  const recipes: Recipe[] = payload.recipes.filter((recipe) => used.has(recipe.id));
  return { ...payload, nodes, recipes };
}

/**
 * The payload ready to paste into `project` (a copy, a blueprint, a duplicated board). A payload of the plan's own
 * game version comes back as it is. One from another version (absent reads 2.9) is converted the way a plan is
 * (`convertProjectToVersion`): matched recipes take the plan's version's body, unmatched cards are marked
 * `unconverted` and lose their body, and the payload is stamped with the plan's version. When this site serves no
 * dataset for the plan's version, every dataset recipe card is marked: nothing can be matched, and no body from
 * the payload's version may land. Throws when the match service cannot be reached, so a dropped network never
 * pastes marked cards.
 */
export async function preparePayloadForPlan(
  payload: BoardClipboardPayload,
  project: FactoryProject,
  source: PayloadDatasetSource = storeSource(),
): Promise<BoardClipboardPayload> {
  const fromGameVersion = planGameVersion(payload);
  const toGameVersion = planGameVersion(project);
  if (fromGameVersion === toGameVersion) {
    return payload;
  }
  const version = source.manifest && pickDatasetVersionFor(source.manifest, toGameVersion);
  if (!version) {
    return { ...markEveryDatasetRecipe(payload, fromGameVersion), gameVersion: toGameVersion };
  }
  const { project: converted } = await convertProjectToVersion(
    {
      schemaVersion: PROJECT_SCHEMA_VERSION,
      id: "board-payload",
      name: "Board payload",
      gameVersion: fromGameVersion,
      fuelProfiles: project.fuelProfiles,
      recipes: payload.recipes,
      nodes: payload.nodes,
      edges: payload.edges,
    },
    { manifestUrl: source.manifestUrl ?? DEFAULT_DATASET_MANIFEST_URL, version },
  );
  return {
    ...payload,
    gameVersion: toGameVersion,
    recipes: converted.recipes,
    nodes: converted.nodes,
    edges: converted.edges,
  };
}
