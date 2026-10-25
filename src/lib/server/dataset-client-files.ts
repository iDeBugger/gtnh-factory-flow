import {
  clientFileListing,
  clientFileDirectory,
  clientFilesRoot,
  ensureClientFiles,
  claimClientFilesRoot,
  removeUnservedClientFileDirectories,
  type ClientFileListing,
  type ClientFileSpec,
} from "./client-files";
import {
  getDatasetCatalog,
  getDatasetRecipeIds,
  getDatasetResourceSearchFile,
  getServedDatasetVersion,
  listDatasetCropFarmRecipes,
  listDatasetEecMobs,
  prewarmDatasetVersion,
  servedDatasetVersionOrder,
} from "./dataset-query";
import type { DatasetVersion } from "@/lib/datasets/types";

/**
 * The dataset's static answers (client-files.ts), each the same JSON its API
 * route sends, cheapest first so the listing fills from the catalog up.
 */
function datasetClientFileSpecs(versionId: string): ClientFileSpec[] {
  return [
    {
      kind: "catalog",
      brotli: { quality: 11, window: 22 },
      produce: () => getDatasetCatalog(versionId),
    },
    {
      kind: "mobs",
      brotli: { quality: 11, window: 22 },
      produce: () => listDatasetEecMobs(versionId),
    },
    {
      kind: "crops",
      brotli: { quality: 11, window: 22 },
      produce: () => listDatasetCropFarmRecipes(versionId),
    },
    {
      kind: "recipe-ids",
      produce: async () => ({ recipeIds: await getDatasetRecipeIds(versionId) }),
    },
    // The browser's item search (resource-search-engine.ts), downloaded in the
    // background; until it is there the item panes ask the API.
    {
      kind: "items",
      brotli: { quality: 9, window: 24 },
      produce: () => getDatasetResourceSearchFile(versionId),
    },
  ];
}

/** One key per dataset build: a republished version under the same id writes its own files. */
function stateKey(version: DatasetVersion): string {
  return `${version.id}:${version.checksumSha256 ?? version.publishedAt ?? ""}`;
}

function clientDirectory(versionId: string): string | undefined {
  return clientFileDirectory(versionId);
}

let rootClaim: Promise<boolean> | undefined;

/**
 * Whether the configured root is the site's to write (`claimClientFilesRoot`),
 * asked once per process copy. A root that is not, or cannot be made, is
 * logged once, and the site writes nothing and answers from the API.
 */
function clientFilesRootIsOurs(): Promise<boolean> {
  rootClaim ??= claimClientFilesRoot(clientFilesRoot()).then(
    (ours) => {
      if (!ours) {
        console.error(
          `GTNH client files are off: ${clientFilesRoot()} holds files that are not the site's. Point GTNH_CLIENT_FILES_DIR at an empty or new directory.`,
        );
      }
      return ours;
    },
    (error) => {
      console.error(`GTNH client files are off: ${clientFilesRoot()} cannot be used.`, error);
      return false;
    },
  );
  return rootClaim;
}

/** What a served version has written so far; undefined for a version this site does not serve. */
export async function datasetClientFileListing(
  versionId: string,
): Promise<ClientFileListing | undefined> {
  const version = await getServedDatasetVersion(versionId);
  const directory = version && clientDirectory(version.id);
  if (!version || !directory) {
    return undefined;
  }
  if (!(await clientFilesRootIsOurs())) {
    return { complete: false, files: {} };
  }
  return clientFileListing(
    stateKey(version),
    version.id,
    directory,
    datasetClientFileSpecs(version.id),
  );
}

/**
 * Writes every served version's files after its prewarm, one version at a
 * time, the default first. Started in the background once the default
 * version is warm: the site answers meanwhile, and the client uses the API
 * for any file not written yet.
 */
export async function writeServedDatasetClientFiles(): Promise<void> {
  let served: string[];
  try {
    served = await servedDatasetVersionOrder();
    if (!(await clientFilesRootIsOurs())) {
      return;
    }
    const removed = await removeUnservedClientFileDirectories(clientFilesRoot(), served);
    if (removed.length > 0) {
      console.info(`GTNH client files of unserved versions removed: ${removed.join(", ")}.`);
    }
  } catch (error) {
    console.error("GTNH client files were not prepared.", error);
    return;
  }
  for (const versionId of served) {
    const started = Date.now();
    try {
      // Joins the background prewarm of this version, or finds it done.
      await prewarmDatasetVersion(versionId);
      const version = await getServedDatasetVersion(versionId);
      const directory = version && clientDirectory(version.id);
      if (!version || !directory) {
        continue;
      }
      await ensureClientFiles(
        stateKey(version),
        version.id,
        directory,
        datasetClientFileSpecs(version.id),
      );
      console.info(`GTNH dataset ${versionId} client files ready in ${Date.now() - started} ms.`);
    } catch (error) {
      console.error(`GTNH dataset ${versionId} client files were not written.`, error);
    }
  }
}
