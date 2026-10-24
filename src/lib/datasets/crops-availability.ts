import { datasetHasCropsNh } from "@/lib/model/planning-cards";
import { listRecipeDatasetCrops } from "./browser-loader";
import type { DatasetVersion, RecipeSummary } from "./types";

type CropLoader = (manifestUrl: string, version: DatasetVersion) => Promise<{ crops: Array<Partial<RecipeSummary>> }>;

/** One answer per dataset version id; an in-flight load is shared, a failed one is forgotten so the next call retries. */
const byVersion = new Map<string, Promise<boolean>>();
/** The settled answers, so a picker opened again paints its cards at once. */
const settled = new Map<string, boolean>();

/**
 * Whether a dataset carries CropsNH crops, read from the crop picker's own list (`/api/datasets/<id>/crops`). The
 * catalog is never fetched for this: the store holds only the plan's recipes, and one boolean must not cost a
 * catalog download.
 */
export function cropsNhAvailable(
  manifestUrl: string,
  version: DatasetVersion,
  load: CropLoader = listRecipeDatasetCrops,
): Promise<boolean> {
  const cached = byVersion.get(version.id);
  if (cached) return cached;
  const pending = load(manifestUrl, version).then(({ crops }) => {
    const has = datasetHasCropsNh(crops);
    settled.set(version.id, has);
    return has;
  });
  byVersion.set(version.id, pending);
  pending.catch(() => {
    if (byVersion.get(version.id) === pending) byVersion.delete(version.id);
  });
  return pending;
}

/** The answer already loaded for a dataset version, or undefined before it arrives. */
export function knownCropsNhAvailable(versionId: string): boolean | undefined {
  return settled.get(versionId);
}
