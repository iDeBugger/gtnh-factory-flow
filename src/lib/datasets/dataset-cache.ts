import { gameVersionOfDataset, planGameVersion, type GameVersion } from "@/lib/model/game-version";
import type { FactoryProject, Recipe } from "@/lib/model/types";
import { initRecipeDatasetVersion } from "./browser-loader";
import { HIDDEN_DATASET_VERSION_IDS, pickDatasetVersionFor } from "./remote";
import type { DatasetManifest, DatasetVersion, RecipeDataset } from "./types";

/**
 * True when the dataset holds the recipes of the plan's game version. Everything that
 * reads recipes into a plan (the landing refresh, a recipe add, the icon refresh, a paste)
 * waits while this is false: a 2.8.1 plan must never take a 2.9 body, or the reverse.
 */
export function datasetServesPlan(
  dataset: Pick<RecipeDataset, "gtnhVersion"> | undefined,
  project: Pick<FactoryProject, "gameVersion">,
): boolean {
  return dataset !== undefined && gameVersionOfDataset(dataset) === planGameVersion(project);
}

/** What the version checks read off the factory store. */
export interface DatasetSelection {
  datasetManifest?: DatasetManifest;
  selectedDatasetVersionId?: string;
  project: Pick<FactoryProject, "gameVersion">;
}

/**
 * True when the selected dataset version (the manifest entry; its catalog need not have
 * landed) is the open plan's game version. The recipe browser, the item list and the
 * store's add guard all ask this one question, so they cannot disagree. A 2.9 boot is
 * served as soon as the manifest arrives; a tab on the other version is not served until
 * its dataset becomes the active one.
 */
export function activeVersionServesPlan(state: DatasetSelection): boolean {
  const selected = state.datasetManifest?.versions.find(
    (version) => version.id === state.selectedDatasetVersionId,
  );
  return datasetServesPlan(selected, state.project);
}

/**
 * The open plan's version when this site has no dataset for it (a file from a site that serves
 * another version), else undefined. Undefined too until the manifest arrives: nothing is known
 * to be missing yet. Such a plan keeps its stored recipe bodies and is never refreshed.
 */
export function unservedPlanVersion(state: Pick<DatasetSelection, "datasetManifest" | "project">): GameVersion | undefined {
  if (!state.datasetManifest) {
    return undefined;
  }
  const version = planGameVersion(state.project);
  return pickDatasetVersionFor(state.datasetManifest, version) ? undefined : version;
}

/** The pending add's line when a pick is refused for its version. */
export const OTHER_VERSION_RECIPE_MESSAGE = "This recipe is from another GTNH version.";

/**
 * Whether a recipe must not land on the open plan. A recipe names the dataset its body
 * came from (`source.datasetVersionId`); when the manifest lists that dataset, the body
 * lands only on a plan of the same game version, whatever dataset is active (a pick fetched
 * on one tab can resolve after a switch to the other). A dataset id the manifest does not
 * list, or lists but never serves (a hidden one: an older build's body already on a board),
 * lands only while the selected version serves the plan. Recipes the plan makes itself (power, tanks, notes) name no dataset and
 * always land.
 */
export function refusesRecipeOnPlan(state: DatasetSelection, recipe: Pick<Recipe, "source">): boolean {
  const datasetVersionId = recipe.source?.datasetVersionId;
  if (!datasetVersionId) {
    return false;
  }
  const own = HIDDEN_DATASET_VERSION_IDS.has(datasetVersionId)
    ? undefined
    : state.datasetManifest?.versions.find((version) => version.id === datasetVersionId);
  return own ? !datasetServesPlan(own, state.project) : !activeVersionServesPlan(state);
}

type DatasetLoader = (manifestUrl: string, version: DatasetVersion) => Promise<RecipeDataset>;

/**
 * Every dataset catalog this page has loaded, by version id, so switching back to a tab on
 * the other version is instant. Two versions are served, so nothing is evicted. One load is
 * in flight per id: a second ask shares the first's promise. A failed load is forgotten so
 * the next ask tries again.
 */
export class DatasetCache {
  private readonly loaded = new Map<string, RecipeDataset>();
  private readonly inFlight = new Map<string, Promise<RecipeDataset>>();

  /** Without a loader the catalog is fetched from the dataset API (`initRecipeDatasetVersion`). */
  constructor(private readonly loader?: DatasetLoader) {}

  get(versionId: string): RecipeDataset | undefined {
    return this.loaded.get(versionId);
  }

  isLoading(versionId: string): boolean {
    return this.inFlight.has(versionId);
  }

  load(manifestUrl: string, version: DatasetVersion): Promise<RecipeDataset> {
    const cached = this.loaded.get(version.id);
    if (cached) {
      return Promise.resolve(cached);
    }
    const pending = this.inFlight.get(version.id);
    if (pending) {
      return pending;
    }
    const promise = (this.loader ?? initRecipeDatasetVersion)(manifestUrl, version).then(
      (dataset) => {
        this.loaded.set(version.id, dataset);
        this.inFlight.delete(version.id);
        return dataset;
      },
      (error: unknown) => {
        this.inFlight.delete(version.id);
        throw error;
      },
    );
    this.inFlight.set(version.id, promise);
    return promise;
  }
}
