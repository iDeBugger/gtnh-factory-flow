// Points the power maps (src/lib/power/data) at a built dataset version:
//
//   node tools/dataset-pipeline/scripts/refresh-power-maps.mjs <dataset version dir> [--id <id>] [--data <dir>] [--check]
//
// Each map names a resource by kind and id (tools/power-machine-icons.mjs and
// tools/power-resource-map.mjs choose them); its icon, colour and name are the build's record for
// that id. build-datasets.mjs checks a build with --check before installing it and writes the maps
// after, so a map never cites an icon its dataset does not draw. A map for another version is left
// alone. An id the build lacks fails the run and writes nothing: the map's choice needs the tools again.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const MAP_FILES = ["machine-icons.json", "resource-map.json", "2.8.1/machine-icons.json", "2.8.1/resource-map.json"];

/** Some names wear private-use glyph prefixes in the game; the maps keep them stripped. */
function cleanName(name) {
  return String(name ?? "").replace(/[-]/g, "").trim();
}

/**
 * Rewrites one map object against `records` (kind:id -> resourceIndex record). Returns
 * { map, missing, changed } and leaves the input alone.
 */
export function refreshPowerMap(map, records) {
  const key = map.machines ? "machines" : "resources";
  const missing = [];
  let changed = 0;
  const entries = {};
  for (const [name, entry] of Object.entries(map[key] ?? {})) {
    const record = records.get(`${entry.kind ?? "item"}:${entry.id}`);
    if (!record) {
      missing.push(name);
      entries[name] = entry;
      continue;
    }
    const next = { ...entry };
    if (record.displayName) next.displayName = key === "resources" ? cleanName(record.displayName) : record.displayName;
    if (record.iconPath) next.iconPath = record.iconPath;
    else delete next.iconPath;
    if (record.dominantColor) next.dominantColor = record.dominantColor;
    else delete next.dominantColor;
    if (JSON.stringify(next) !== JSON.stringify(entry)) changed += 1;
    entries[name] = next;
  }
  return { map: { ...map, [key]: entries }, missing, changed };
}

/** The version's records by kind:id, from its resource-index.json.gz. */
export function readRecords(versionDir) {
  const catalog = JSON.parse(gunzipSync(fs.readFileSync(path.join(versionDir, "resource-index.json.gz"))).toString("utf8"));
  return new Map((catalog.resourceIndex ?? catalog.resources).map((record) => [`${record.kind}:${record.id}`, record]));
}

/**
 * Refreshes every map made for the version against its records. With `write`, the maps are written only when no
 * map names an id the build lacks: a failing refresh changes nothing. `id` names the version when the directory
 * does not (a build checked before it is installed).
 */
export function refreshPowerMaps(versionDir, dataDir = path.join(repoRoot, "src", "lib", "power", "data"), { id, write = true } = {}) {
  const versionId = id ?? path.basename(path.resolve(versionDir));
  const records = readRecords(versionDir);
  const report = [];
  for (const file of MAP_FILES) {
    const full = path.join(dataDir, file);
    if (!fs.existsSync(full)) continue;
    const map = JSON.parse(fs.readFileSync(full, "utf8"));
    if (map.datasetVersionId !== versionId) continue;
    report.push({ file, full, ...refreshPowerMap(map, records) });
  }
  if (write && report.every((entry) => entry.missing.length === 0)) {
    for (const entry of report) {
      if (entry.changed > 0) fs.writeFileSync(entry.full, `${JSON.stringify(entry.map, null, 1)}\n`);
    }
  }
  return report.map(({ full, ...entry }) => entry);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const args = process.argv.slice(2);
  const value = (flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
  const versionDir = args[0];
  const dataDir = value("--data") ? path.resolve(value("--data")) : undefined;
  const check = args.includes("--check");
  if (!versionDir || versionDir.startsWith("--")) {
    console.error("Usage: refresh-power-maps.mjs <dataset version dir> [--id <version id>] [--data <power data dir>] [--check]");
    process.exit(2);
  }
  const report = refreshPowerMaps(versionDir, dataDir, { id: value("--id"), write: !check });
  const failed = report.some((entry) => entry.missing.length > 0);
  for (const { file, missing, changed } of report) {
    console.log(`power map ${file}: ${changed} entr${changed === 1 ? "y" : "ies"} ${check || failed ? "to update" : "updated"}`);
    if (missing.length > 0) {
      console.error(`power map ${file}: ${missing.length} id(s) not in ${versionDir}: ${missing.join(", ")}`);
    }
  }
  if (failed) console.error("No power map was written: run tools/power-machine-icons.mjs or tools/power-resource-map.mjs for the missing ids.");
  process.exit(failed ? 1 : 0);
}
