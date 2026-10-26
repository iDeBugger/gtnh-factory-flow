import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { gunzipSync } from "node:zlib";
import { gzipDeterministic } from "./deterministic-gzip.mjs";
import { writeDatasetJson } from "./dataset-json-writer.mjs";
import { neiItemOrderFromCatalog, resourceOrderFor } from "./nei-item-order.mjs";

const datasetPath = process.argv[2];

if (!datasetPath) {
  throw new Error("Usage: build-resource-index.mjs <recipes.json|recipes.json.gz>");
}

const dataset = await readDataset(datasetPath);
dataset.resourceIndex = buildResourceIndex(dataset);
// NEI's order of the records, beside them (nei-item-order.mjs); a rerun recomputes it.
delete dataset.resourceOrder;
const carried = dataset.neiItemOrder ? undefined : await carriedNeiItemOrder();
if (carried) {
  dataset.neiItemOrder = carried.order;
}
const resourceOrder = resourceOrderFor(dataset.resourceIndex, dataset.neiItemOrder);
if (resourceOrder) {
  dataset.resourceOrder = resourceOrder;
}
await writeDataset(datasetPath, dataset);

console.log(
  `Wrote resourceIndex with ${dataset.resourceIndex.length} resources${
    resourceOrder
      ? `, ${resourceOrder.filter((place) => place !== null).length} of them in NEI's order${
          carried ? ` (carried from ${carried.from}: this export has no NEI list)` : ""
        }`
      : ", no NEI order in this export"
  }.`,
);
if (!resourceOrder) {
  console.warn(
    "WARNING: this dataset has NO NEI order: its item list sorts As in NEI by the approximation. " +
      "NEI's list comes only from a client export (GTNH_EXPORT_PACK_KIND=client, or GTNH_FORCE_CLIENT_ICON_EXPORT=1).",
  );
}

/**
 * The order of an earlier build, for an export without NEI's list: this version's own last
 * build (its resource-index.json.gz, not yet overwritten), then GTNH_PREVIOUS_DATASET_DIR (the
 * dataset generate-dataset reused icons from). GTNH_NEI_ORDER_CARRY=0 turns it off.
 */
async function carriedNeiItemOrder() {
  if (process.env.GTNH_NEI_ORDER_CARRY === "0") {
    return undefined;
  }
  const dirs = [path.dirname(path.resolve(datasetPath)), process.env.GTNH_PREVIOUS_DATASET_DIR].filter(Boolean);
  for (const dir of dirs) {
    const file = path.join(dir, "resource-index.json.gz");
    let catalog;
    try {
      catalog = JSON.parse(gunzipSync(await fs.readFile(file)).toString("utf8"));
    } catch {
      continue;
    }
    const order = neiItemOrderFromCatalog(catalog);
    if (order) {
      return { order, from: file };
    }
  }
  return undefined;
}

async function readDataset(filePath) {
  if (!filePath.endsWith(".gz")) {
    return readLineDelimitedDataset(filePath);
  }

  const data = await fs.readFile(filePath);
  const source = gunzipSync(data).toString("utf8");
  return JSON.parse(source);
}

async function readLineDelimitedDataset(filePath) {
  const dataset = {};
  const wantedArrays = new Set([
    "resources",
    "recipes",
    "recipeMaps",
    "recipeMapIcons",
    "machineHandlerIcons",
    "neiItemOrder",
  ]);
  let currentArrayKey;
  let skippingArray = false;
  let skippingObject = false;

  const lines = readline.createInterface({
    input: createReadStream(filePath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });

  for await (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line === "{" || line === "}") {
      continue;
    }

    if (currentArrayKey || skippingArray) {
      if (line === "]," || line === "]") {
        currentArrayKey = undefined;
        skippingArray = false;
        continue;
      }

      if (currentArrayKey) {
        dataset[currentArrayKey].push(parseJsonLineValue(line));
      }
      continue;
    }

    if (skippingObject) {
      if (line === "}," || line === "}") {
        skippingObject = false;
      }
      continue;
    }

    const match = /^("(?:(?:\\.)|[^"\\])*"):\s*(.*)$/.exec(line);
    if (!match) {
      continue;
    }

    const key = JSON.parse(match[1]);
    const value = match[2].replace(/,$/, "");
    if (value === "[") {
      if (wantedArrays.has(key)) {
        dataset[key] = [];
        currentArrayKey = key;
      } else {
        skippingArray = true;
      }
      continue;
    }

    if (value === "{") {
      skippingObject = true;
      continue;
    }

    dataset[key] = JSON.parse(value);
  }

  return dataset;
}

function parseJsonLineValue(line) {
  return JSON.parse(line.replace(/,$/, ""));
}

async function writeDataset(filePath, dataset) {
  if (filePath.endsWith(".gz")) {
    const json = `${JSON.stringify(dataset)}\n`;
    await fs.writeFile(filePath, gzipDeterministic(json));
    return;
  }

  await writeDatasetJson(filePath, dataset);
}

function buildResourceIndex(dataset) {
  const resourcesByKey = new Map(
    (dataset.resources ?? []).map((resource) => [resourceKey(resource), resource]),
  );
  const index = new Map();

  for (const recipe of dataset.recipes ?? []) {
    for (const resource of [...(recipe.inputs ?? []), ...(recipe.outputs ?? [])]) {
      const key = resourceKey(resource);
      const existing = index.get(key);
      if (existing) {
        existing.recipeCount += 1;
        mergeResourceIcon(existing, resource, resourcesByKey.get(key));
        continue;
      }

      const indexed = resourcesByKey.get(key);
      index.set(key, {
        kind: resource.kind,
        id: resource.id,
        displayName: resource.displayName ?? indexed?.displayName,
        iconPath: currentIconPath(resource.iconPath, indexed?.iconPath),
        iconAtlas: indexed?.iconAtlas ?? resource.iconAtlas,
        dominantColor:
          indexed?.dominantColor ??
          resource.dominantColor ??
          indexed?.iconAtlas?.dominantColor ??
          resource.iconAtlas?.dominantColor,
        recipeCount: 1,
        tooltip: resource.tooltip ?? indexed?.tooltip,
        oreDictionary: resource.oreDictionary ?? indexed?.oreDictionary,
        // The index entry is the resource itself, shared by every recipe that names it, so it takes only the
        // catalog's item-level choices (an ore dictionary group's members). What one SLOT accepts (GT5U's
        // SubstituteFluidStack, mOreDictAlt and unification) stays on that recipe's input: copied here, the
        // Fertilizer's Water-or-Distilled-Water slot offered Distilled Water in every Water slot the server
        // hydrates, and a machine's unified Steel Plate slot offered Refined Iron Plate in shaped crafting.
        alternatives: indexed?.alternatives,
      });
    }
  }

  return [...index.values()].sort((left, right) => right.recipeCount - left.recipeCount);
}

function mergeResourceIcon(target, resource, indexed) {
  if (!target.displayName) {
    target.displayName = resource.displayName ?? indexed?.displayName;
  }
  if (!target.iconPath) {
    target.iconPath = currentIconPath(resource.iconPath, indexed?.iconPath);
  }
  if (!target.iconAtlas) {
    target.iconAtlas = indexed?.iconAtlas ?? resource.iconAtlas;
  }
  if (!target.dominantColor) {
    target.dominantColor =
      indexed?.dominantColor ??
      resource.dominantColor ??
      indexed?.iconAtlas?.dominantColor ??
      resource.iconAtlas?.dominantColor;
  }
  if (!target.oreDictionary) {
    target.oreDictionary = resource.oreDictionary ?? indexed?.oreDictionary;
  }
  if (!target.tooltip) {
    target.tooltip = resource.tooltip ?? indexed?.tooltip;
  }
  if (!target.alternatives) {
    target.alternatives = indexed?.alternatives;
  }
}

function currentIconPath(resourceIconPath, indexedIconPath) {
  if (isLegacyRenderedIconPath(resourceIconPath)) {
    return indexedIconPath;
  }

  return indexedIconPath ?? resourceIconPath;
}

function isLegacyRenderedIconPath(iconPath) {
  return typeof iconPath === "string" && iconPath.includes("/textures/rendered/");
}

function resourceKey(resource) {
  return `${resource.kind}:${resource.id}`;
}
