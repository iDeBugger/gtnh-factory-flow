import fs from "node:fs/promises";
import { createReadStream, existsSync, statSync } from "node:fs";
import path from "node:path";
import { computeDatasetChecksum } from "./dataset-checksum.mjs";
import { assertPublishableNames } from "./publishable-names.mjs";
import readline from "node:readline";
import { createGunzip } from "node:zlib";

const rootDir = process.env.GTNH_DATASETS_ROOT ?? path.join("public", "datasets", "gtnh");
const entries = existsSync(rootDir) ? await fs.readdir(rootDir, { withFileTypes: true }) : [];
const discoveredVersions = [];

for (const entry of entries) {
  if (!entry.isDirectory()) {
    continue;
  }

  await removeIfExists(path.join(rootDir, entry.name, ".pipeline-status.json"));

  const datasetFiles = getCompleteDatasetFiles(entry.name);
  if (!datasetFiles) {
    console.warn(`Skipping incomplete dataset ${entry.name}; required compressed dataset indexes are missing.`);
    continue;
  }

  // A name the site's request gate would refuse must never reach the manifest.
  await assertPublishableNames(path.join(rootDir, entry.name));

  const { recipeIndexPath, recipeLookupIndexPath, recipesPath, resourceIndexPath } = datasetFiles;
  const dataset = await readRecipeDatasetMetadata(recipesPath);
  const checksumSha256 = await computeDatasetChecksum(path.dirname(recipesPath));

  discoveredVersions.push({
    id: dataset.datasetVersionId,
    gtnhVersion: dataset.gtnhVersion,
    channel: inferChannel(dataset.datasetVersionId),
    publishedAt: dataset.generatedAt,
    manifestPath: "/datasets/gtnh/datasets.manifest.json",
    recipeDatasetPath: `/datasets/gtnh/${dataset.datasetVersionId}/${path.basename(recipesPath)}`,
    resourceIndexPath: `/datasets/gtnh/${dataset.datasetVersionId}/${path.basename(resourceIndexPath)}`,
    recipeIndexPath: `/datasets/gtnh/${dataset.datasetVersionId}/${path.basename(recipeIndexPath)}`,
    recipeLookupIndexPath: `/datasets/gtnh/${dataset.datasetVersionId}/${path.basename(recipeLookupIndexPath)}`,
    checksumSha256,
    sourceInfo: dataset.sourceInfo,
  });
}

const latestDailyVersion = newestVersion(discoveredVersions, "daily")?.id;

for (const version of discoveredVersions) {
  if (version.channel === "daily" && version.id !== latestDailyVersion) {
    await fs.rm(path.join(rootDir, version.id), { recursive: true, force: true });
  }
}

const versions = discoveredVersions.filter(
  (version) => version.channel !== "daily" || version.id === latestDailyVersion,
);

// Newest PACK first, not newest publish: the app defaults to versions[0], and
// sorting by publishedAt once handed everyone 2.8.4 because it happened to be
// re-normalized a few minutes after 2.9.
versions.sort(
  (a, b) =>
    b.gtnhVersion.localeCompare(a.gtnhVersion, undefined, { numeric: true }) ||
    b.publishedAt.localeCompare(a.publishedAt),
);

const latestStableVersion = chooseLatestStableVersion(
  versions,
  process.env.GTNH_LATEST_STABLE_VERSION,
  await readPreviousManifest(),
);
const manifest = {
  schemaVersion: 1,
  ...(latestStableVersion ? { latestStableVersion } : {}),
  ...(latestDailyVersion ? { latestDailyVersion } : {}),
  versions,
};

await fs.mkdir(rootDir, { recursive: true });
await fs.writeFile(
  path.join(rootDir, "datasets.manifest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
);

/**
 * The app's default dataset. An explicit GTNH_LATEST_STABLE_VERSION wins (it
 * must name a dataset here). Otherwise a rebuild keeps the previous manifest's
 * choice while that dataset is still here: local builds are all "experimental",
 * so the channel rule alone would drop a hand-picked default on every rebuild.
 */
function chooseLatestStableVersion(versions, requestedId, previousManifest) {
  const present = (id) => Boolean(id) && versions.some((version) => version.id === id);
  if (requestedId) {
    if (!present(requestedId)) {
      throw new Error(`GTNH_LATEST_STABLE_VERSION=${requestedId} names no dataset in ${rootDir}.`);
    }
    return requestedId;
  }
  if (present(previousManifest?.latestStableVersion)) {
    return previousManifest.latestStableVersion;
  }
  return versions.find((version) => version.channel === "stable")?.id;
}

async function readPreviousManifest() {
  try {
    return JSON.parse(await fs.readFile(path.join(rootDir, "datasets.manifest.json"), "utf8"));
  } catch {
    return undefined;
  }
}

function inferChannel(versionId) {
  if (versionId.startsWith("daily-")) {
    return "daily";
  }
  if (versionId.startsWith("stable-")) {
    return "stable";
  }
  return "experimental";
}

async function removeIfExists(filePath) {
  if (existsSync(filePath)) {
    await fs.rm(filePath, { force: true });
  }
}

function getCompleteDatasetFiles(versionId) {
  const datasetDir = path.join(rootDir, versionId);
  const files = {
    recipesPath: path.join(datasetDir, "recipes.json.gz"),
    resourceIndexPath: path.join(datasetDir, "resource-index.json.gz"),
    recipeIndexPath: path.join(datasetDir, "recipe-index.json.gz"),
    recipeLookupIndexPath: path.join(datasetDir, "recipe-lookup-index.json.gz"),
  };

  if (!Object.values(files).every((filePath) => existsSync(filePath) && statSync(filePath).size > 0)) {
    return undefined;
  }

  return files;
}

async function readRecipeDatasetMetadata(filePath) {
  const dataset = {};
  const fileStream = createReadStream(filePath, { encoding: filePath.endsWith(".gz") ? undefined : "utf8" });
  const input = filePath.endsWith(".gz") ? fileStream.pipe(createGunzip()) : fileStream;
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  const wantedKeys = new Set(["datasetVersionId", "gtnhVersion", "generatedAt", "sourceInfo"]);

  try {
    for await (const rawLine of lines) {
      const line = String(rawLine).trim();
      const match = /^("(?:(?:\\.)|[^"\\])*"):\s*(.*?)(,)?$/.exec(line);
      if (!match) {
        continue;
      }

      const key = JSON.parse(match[1]);
      if (!wantedKeys.has(key)) {
        continue;
      }

      dataset[key] = JSON.parse(match[2]);
      if ([...wantedKeys].every((wantedKey) => dataset[wantedKey] !== undefined)) {
        break;
      }
    }
  } finally {
    lines.close();
    input.destroy();
    fileStream.destroy();
  }

  for (const key of wantedKeys) {
    if (dataset[key] === undefined) {
      throw new Error(`Missing ${key} in ${filePath}.`);
    }
  }

  return dataset;
}

function newestVersion(versions, channel) {
  return versions
    .filter((version) => version.channel === channel)
    .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))[0];
}
