import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { writeDatasetJson } from "./dataset-json-writer.mjs";
import { applyIcon, clearUnresolvedIconPathTextureHint, resourceKey } from "./icon-hints.mjs";

const instanceRoot = process.argv[2];
const datasetPath = process.argv[3];
const outDir = process.argv[4];

if (!instanceRoot || !datasetPath || !outDir) {
  throw new Error(
    "Usage: apply-texture-icons.mjs <gtnh-instance-root> <recipes.json> <dataset-output-dir>",
  );
}

if (!existsSync(datasetPath)) {
  throw new Error(`Dataset not found: ${datasetPath}`);
}

const maxDatasetBytes = positiveIntEnv("GTNH_TEXTURE_ICON_MAX_DATASET_BYTES", 450_000_000);
const datasetSizeBytes = (await fs.stat(datasetPath)).size;
// Above the limit only the name matching below is skipped: resolve-icon-hints.mjs has already
// resolved the export's `asset:` hints line by line, whatever the size, and its report stays.
if (datasetSizeBytes > maxDatasetBytes) {
  const versionId = path.basename(outDir);
  await mergeIconReport(path.join(outDir, "textures"), {
    textureMatching: {
      skipped: true,
      reason: `Dataset is ${datasetSizeBytes} bytes, above GTNH_TEXTURE_ICON_MAX_DATASET_BYTES=${maxDatasetBytes}.`,
    },
  });
  console.log(
    `Skipping texture name matching for ${versionId}: dataset is ${datasetSizeBytes} bytes.`,
  );
  process.exit(0);
}

const dataset = JSON.parse(await fs.readFile(datasetPath, "utf8"));
const versionId = dataset.datasetVersionId;
const textureOutDir = path.join(outDir, "textures");
const publicTextureBase = `/datasets/gtnh/${versionId}/textures`;
const bundledAspectIcons = await readBundledAspectIconNames();

console.log("Indexing real GTNH texture assets from mod jars.");
const textureIndex = await buildTextureIndex(instanceRoot);
console.log(`Indexed ${textureIndex.byPath.size} texture PNGs from ${textureIndex.jarCount} jars.`);

await fs.mkdir(textureOutDir, { recursive: true });
await fs.rm(path.join(textureOutDir, "item"), { recursive: true, force: true });
await fs.rm(path.join(textureOutDir, "fluid"), { recursive: true, force: true });

const resourcesByKey = new Map();
for (const resource of dataset.resources ?? []) {
  resourcesByKey.set(resourceKey(resource), resource);
}
for (const recipe of dataset.recipes ?? []) {
  for (const resource of [...(recipe.inputs ?? []), ...(recipe.outputs ?? [])]) {
    const key = resourceKey(resource);
    if (!resourcesByKey.has(key)) {
      resourcesByKey.set(key, resource);
    }
  }
}
for (const entry of dataset.recipeMapIcons ?? []) {
  if (!entry?.resource) {
    continue;
  }
  const key = resourceKey(entry.resource);
  if (!resourcesByKey.has(key)) {
    resourcesByKey.set(key, entry.resource);
  }
}

const iconsByKey = new Map();
let matched = 0;
let missing = 0;
let preservedRendered = 0;

for (const [key, resource] of resourcesByKey) {
  clearMissingBundledAspectIcon(resource, bundledAspectIcons);
  const hintedTexture = findIconPathTextureHint(resource, textureIndex);
  if (hintedTexture) {
    const iconPath = await extractTexture(
      resource,
      hintedTexture,
      textureOutDir,
      publicTextureBase,
    );
    iconsByKey.set(key, iconPath);
    matched += 1;
    continue;
  }
  clearUnresolvedIconPathTextureHint(resource);
  if (resource.iconPath) {
    preservedRendered += 1;
    continue;
  }

  const match = findTexture(resource, textureIndex);
  if (!match) {
    missing += 1;
    continue;
  }

  const iconPath = await extractTexture(resource, match, textureOutDir, publicTextureBase);
  iconsByKey.set(key, iconPath);
  matched += 1;
}

for (const resource of dataset.resources ?? []) {
  applyIcon(resource, iconsByKey);
}
for (const recipe of dataset.recipes ?? []) {
  for (const resource of [...(recipe.inputs ?? []), ...(recipe.outputs ?? [])]) {
    applyIcon(resource, iconsByKey);
  }
}
for (const entry of dataset.recipeMapIcons ?? []) {
  if (entry?.resource) {
    applyIcon(entry.resource, iconsByKey);
  }
}

await writeDatasetJson(datasetPath, dataset);
await mergeIconReport(textureOutDir, {
  datasetVersionId: versionId,
  textureMatching: {
    matchedResources: matched,
    missingResources: missing,
    preservedRenderedIcons: preservedRendered,
    notes:
      "Only real PNG files extracted from the GTNH instance/mod jars or rendered by the GTNH client from real ItemStacks are used. Missing icons are intentionally left blank; no generated or guessed item art is published.",
  },
});

console.log(
  `Applied ${matched} real texture icons and preserved ${preservedRendered} rendered stack icons. ${missing} resources remain iconless.`,
);

// The report resolve-icon-hints.mjs wrote, with this step's fields added. A top-level `skipped`
// is never written: the publish refuses a version whose report says it.
async function mergeIconReport(textureDir, fields) {
  const reportPath = path.join(textureDir, "icon-report.json");
  let report = { schemaVersion: 1, source: "minecraft-asset-pngs" };
  try {
    report = JSON.parse(await fs.readFile(reportPath, "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
  delete report.skipped;
  delete report.reason;
  await fs.mkdir(textureDir, { recursive: true });
  await fs.writeFile(reportPath, `${JSON.stringify({ ...report, ...fields }, null, 2)}\n`);
}

async function buildTextureIndex(root) {
  const jars = (await findFiles(path.join(root, "mods"), ".jar")).sort();
  const byPath = new Map();
  const byStem = new Map();
  const byLooseStem = new Map();

  for (const jar of jars) {
    const list = spawnSync("unzip", ["-Z", "-1", jar], {
      encoding: "utf8",
      maxBuffer: 50 * 1024 * 1024,
    });

    if (list.status !== 0) {
      continue;
    }

    for (const entry of list.stdout.split(/\r?\n/)) {
      if (!isTextureEntry(entry)) {
        continue;
      }

      const lowerEntry = entry.toLowerCase();
      const asset = parseAssetTexturePath(lowerEntry);
      if (!asset) {
        continue;
      }

      const texture = { jar, entry, namespace: asset.namespace, stem: asset.stem };
      byPath.set(lowerEntry, texture);
      addFirst(byStem, `${asset.namespace}:${asset.stem}`, texture);
      addFirst(byLooseStem, asset.stem, texture);
    }
  }

  return { byPath, byStem, byLooseStem, jarCount: jars.length };
}

function findTexture(resource, textureIndex) {
  if (requiresRenderedStackIcon(resource)) {
    return undefined;
  }

  const parsed = parseResourceId(resource.id);
  const candidates = textureCandidates(resource, parsed);

  for (const candidate of candidates.fullPaths) {
    const match = textureIndex.byPath.get(candidate.toLowerCase());
    if (match) {
      return match;
    }
  }

  if (parsed.namespace) {
    for (const stem of candidates.stems) {
      const match = textureIndex.byStem.get(`${parsed.namespace}:${stem.toLowerCase()}`);
      if (match) {
        return match;
      }
    }
  }

  for (const stem of candidates.looseStems) {
    const match = textureIndex.byLooseStem.get(stem.toLowerCase());
    if (match) {
      return match;
    }
  }

  return undefined;
}

function findIconPathTextureHint(resource, textureIndex) {
  if (typeof resource.iconPath !== "string" || !resource.iconPath.startsWith("asset:")) {
    return undefined;
  }

  const hint = resource.iconPath.slice("asset:".length);
  const separatorIndex = hint.indexOf(":");
  if (separatorIndex <= 0) {
    return undefined;
  }

  const namespace = hint.slice(0, separatorIndex).toLowerCase();
  const resourcePath = hint
    .slice(separatorIndex + 1)
    .replace(/^\/+/, "")
    .toLowerCase();
  return textureIndex.byPath.get(`assets/${namespace}/${resourcePath}`);
}

function requiresRenderedStackIcon(resource) {
  const id = String(resource.id ?? "").toLowerCase();
  return resource.kind === "item" && id.includes("@") && /^gregtech:gt\.metaitem\./.test(id);
}

function textureCandidates(resource, parsed) {
  const namespace = parsed.namespace;
  const name = parsed.name;
  const stems = unique([
    name,
    name.replace(/^item\./i, ""),
    name.replace(/^tile\./i, ""),
    name.replace(/\./g, "_"),
    name.replace(/\./g, "/"),
    name.split(".").at(-1),
    resource.displayName ? slug(resource.displayName) : "",
  ]).filter(Boolean);

  const fullPaths = [];
  if (namespace) {
    const textureFolders =
      resource.kind === "aspect"
        ? ["aspects", "aspect", "items", "item"]
        : resource.kind === "fluid"
          ? ["fluids", "fluid", "items", "blocks"]
          : ["items", "item", "blocks", "block"];

    for (const folder of textureFolders) {
      for (const stem of stems) {
        fullPaths.push(`assets/${namespace}/textures/${folder}/${stem}.png`);
      }
    }
  }

  const fluidStems =
    resource.kind === "fluid"
      ? stems.flatMap((stem) => [stem, `${stem}_still`, `still_${stem}`, `${stem}.still`])
      : [];

  const looseStems =
    resource.kind === "fluid" || resource.kind === "aspect"
      ? unique([...stems, ...fluidStems])
      : [];

  return {
    fullPaths,
    stems: unique([...stems, ...fluidStems]),
    looseStems,
  };
}

// Named by a hash of the bytes, like rendered icons (stage-rendered-icons.mjs): texture URLs
// are served immutable, so changed pixels must get a new name.
async function extractTexture(resource, texture, textureOutDir, publicTextureBase) {
  const extract = spawnSync("unzip", ["-p", texture.jar, texture.entry], {
    encoding: "buffer",
    maxBuffer: 10 * 1024 * 1024,
  });
  if (extract.status !== 0 || extract.stdout.length === 0) {
    throw new Error(`Failed to extract ${texture.entry} from ${texture.jar}`);
  }

  const contentHash = crypto.createHash("sha1").update(extract.stdout).digest("hex").slice(0, 12);
  const filename = `${safeFileName(resource.id)}-${contentHash}.png`;
  const relativePath = path.posix.join(resource.kind, filename);
  const outputPath = path.join(textureOutDir, resource.kind, filename);
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, extract.stdout);
  return `${publicTextureBase}/${relativePath}`;
}

async function findFiles(root, extension) {
  if (!existsSync(root)) {
    return [];
  }

  const found = [];
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      found.push(...(await findFiles(fullPath, extension)));
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(extension)) {
      found.push(fullPath);
    }
  }
  return found;
}

function isTextureEntry(entry) {
  const lower = entry.toLowerCase();
  return lower.startsWith("assets/") && lower.includes("/textures/") && lower.endsWith(".png");
}

function parseAssetTexturePath(entry) {
  const match = entry.match(
    /^assets\/([^/]+)\/textures\/(?:items?|blocks?|fluids?|aspects?)\/(.+)\.png$/,
  );
  if (!match) {
    return undefined;
  }
  return {
    namespace: match[1],
    stem: match[2],
  };
}

function parseResourceId(id) {
  const withoutMeta = String(id).split("@")[0];
  const separator = withoutMeta.indexOf(":");
  if (separator === -1) {
    return { namespace: undefined, name: withoutMeta.toLowerCase() };
  }
  return {
    namespace: withoutMeta.slice(0, separator).toLowerCase(),
    name: withoutMeta.slice(separator + 1).toLowerCase(),
  };
}

async function readBundledAspectIconNames() {
  const aspectDir = path.resolve("public", "nei", "thaumcraft", "aspects");
  if (!existsSync(aspectDir)) {
    return new Set();
  }

  const entries = await fs.readdir(aspectDir);
  return new Set(
    entries
      .filter((entry) => entry.toLowerCase().endsWith(".png"))
      .map((entry) => entry.toLowerCase()),
  );
}

function clearMissingBundledAspectIcon(resource, bundledAspectIcons) {
  if (resource.kind !== "aspect" || typeof resource.iconPath !== "string") {
    return;
  }

  const prefix = "/nei/thaumcraft/aspects/";
  if (!resource.iconPath.toLowerCase().startsWith(prefix)) {
    return;
  }

  const fileName = path.posix.basename(resource.iconPath).toLowerCase();
  if (!bundledAspectIcons.has(fileName)) {
    delete resource.iconPath;
  }
}

function addFirst(map, key, value) {
  if (!map.has(key)) {
    map.set(key, value);
  }
}

function positiveIntEnv(name, defaultValue) {
  const rawValue = process.env[name];
  if (!rawValue) {
    return defaultValue;
  }

  const parsed = Number.parseInt(rawValue, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }

  return parsed;
}

function unique(values) {
  return [...new Set(values.map((value) => String(value ?? "").trim()).filter(Boolean))];
}

function slug(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9./_-]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function safeFileName(value) {
  return (
    slug(value)
      .replace(/[/:@]+/g, "_")
      .slice(0, 90) || "resource"
  );
}
