import { parseDatasetManifestJson } from "../import-export";
import { gameVersionOfDataset, type GameVersion } from "../model/game-version";
import { HIDDEN_DATASET_VERSION_IDS } from "./hidden-versions";
import type { DatasetManifest, DatasetVersion } from "./types";

export { HIDDEN_DATASET_VERSION_IDS };

export const DEFAULT_DATASET_MANIFEST_URL =
  process.env.NEXT_PUBLIC_GTNH_DATASET_MANIFEST_URL ?? "/datasets/gtnh/datasets.manifest.json";

export async function fetchDatasetManifest(
  manifestUrl = DEFAULT_DATASET_MANIFEST_URL,
): Promise<DatasetManifest> {
  const response = await fetch(withCacheBust(manifestUrl), {
    headers: {
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`Could not load dataset manifest (${response.status}).`);
  }

  return parseDatasetManifestJson(await response.text());
}

export function listSelectableDatasetVersions(manifest: DatasetManifest): DatasetVersion[] {
  const selectable = manifest.versions.filter(
    (version) => !HIDDEN_DATASET_VERSION_IDS.has(version.id),
  );
  // A manifest holding only hidden versions still needs to offer something.
  return selectable.length > 0 ? selectable : manifest.versions;
}

export function pickDefaultDatasetVersion(manifest: DatasetManifest): DatasetVersion | undefined {
  const selectable = listSelectableDatasetVersions(manifest);
  const preferredId = manifest.latestStableVersion ?? manifest.latestDailyVersion;
  if (preferredId) {
    const preferred = selectable.find((version) => version.id === preferredId);
    if (preferred) {
      return preferred;
    }
  }

  return selectable[0];
}

/**
 * The dataset that serves plans of `gameVersion`, or undefined when this site
 * serves no such version. Hidden versions never serve a plan. For 2.9 the
 * manifest's stable version wins when it is a 2.9 build; otherwise, and for
 * every other family, the newest build of that family.
 */
export function pickDatasetVersionFor(
  manifest: DatasetManifest,
  gameVersion: GameVersion,
): DatasetVersion | undefined {
  const family = manifest.versions.filter(
    (version) => !HIDDEN_DATASET_VERSION_IDS.has(version.id) && gameVersionOfDataset(version) === gameVersion,
  );
  if (gameVersion === "2.9") {
    const stable = family.find((version) => version.id === manifest.latestStableVersion);
    if (stable) {
      return stable;
    }
  }
  return family.reduce<DatasetVersion | undefined>(
    (newest, version) =>
      !newest || Date.parse(version.publishedAt) > Date.parse(newest.publishedAt) ? version : newest,
    undefined,
  );
}

function withCacheBust(url: string): string {
  const resolvedUrl = new URL(url, window.location.origin);
  resolvedUrl.searchParams.set("t", String(Date.now()));
  return resolvedUrl.toString();
}
