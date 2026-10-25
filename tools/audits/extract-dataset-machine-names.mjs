// node tools/audits/extract-dataset-machine-names.mjs <dataset dir> <game version> <fixture.json>
// Collects every machine name a card of that dataset can carry: each handler's
// machineType, and the recipe's own machineType where a recipe has no handlers
// (a map with one machine family is named after the map). Writes them into the
// fixture under the game version, keeping the other versions already there.
// src/lib/machines/dataset-machine-names.test.ts reads the fixture.
import fs from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";

const [datasetDir, gameVersion, output] = process.argv.slice(2);
if (!datasetDir || !gameVersion || !output) {
  throw new Error("Usage: extract-dataset-machine-names.mjs <dataset dir> <game version> <fixture.json>");
}
const shardDir = path.join(datasetDir, "recipes-shards");
const names = new Set();
for (const file of fs.readdirSync(shardDir).filter((name) => name.endsWith(".json.gz")).sort()) {
  const shard = JSON.parse(gunzipSync(fs.readFileSync(path.join(shardDir, file))).toString("utf8"));
  for (const recipe of shard.recipes) {
    const handlers = recipe.machineHandlers ?? [];
    if (handlers.length === 0 && recipe.machineType) names.add(recipe.machineType);
    for (const handler of handlers) if (handler.machineType) names.add(handler.machineType);
  }
}
const fixture = fs.existsSync(output) ? JSON.parse(fs.readFileSync(output, "utf8")) : {};
fixture[gameVersion] = [...names].sort((a, b) => a.localeCompare(b, "en"));
const sorted = Object.fromEntries(Object.entries(fixture).sort(([a], [b]) => a.localeCompare(b)));
fs.writeFileSync(output, `${JSON.stringify(sorted, null, 2)}\n`);
console.log(`${gameVersion}: ${names.size} machine names`);
