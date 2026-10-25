// Resolves the export's `asset:<mod>:textures/...` icon hints from the pack's mod jars, on a
// dataset of any size.
//
//   node resolve-icon-hints.mjs <gtnh-instance-root | mods-dir> <recipes.json> <dataset-output-dir>
//
// The oracle leaves a hint in `iconPath` where it knew a texture's name but drew no pixels
// (Thaumcraft aspects other mods add: GregTech's Radio and Electrum, Forbidden Magic's sins,
// Avaritia's Terminus). A browser cannot load `asset:`, so the app would draw `?`. Each hint's
// PNG is copied out of the jar into `textures/rendered/<mod>_<name>-<sha1(bytes)[:12]>.png`:
// texture URLs are served immutable for a year, so the name follows the bytes like every
// rendered icon (stage-rendered-icons.mjs), and `textures/rendered/` is a root the textures
// route serves. A hint no jar holds is cleared, so the app draws the kind's fallback art.
//
// recipes.json is read and written line by line (dataset-json-writer.mjs puts each array
// element on its own line): only lines holding `"asset:` are parsed. The real datasets are
// 1.5 to 1.9 GB, too big for one JSON.parse; apply-texture-icons.mjs, which does parse it
// whole, skips itself above GTNH_TEXTURE_ICON_MAX_DATASET_BYTES, and that skip is how the
// hints shipped. Run this after the normalizer and before the index builds.
//
// Writes `textures/icon-report.json` with what it resolved and cleared; the publish refuses
// a version with no report, one that says `skipped`, or any file still holding `"asset:`
// (tools/deploy/publish-datasets.sh).
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createReadStream, createWriteStream, existsSync, readdirSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { once } from "node:events";
import { pathToFileURL } from "node:url";

export const ASSET_HINT_PREFIX = "asset:";
const ASSET_HINT_MARKER = `"${ASSET_HINT_PREFIX}`;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** `asset:gregtech:textures/aspects/RADIO.png` as its jar entry, or undefined when malformed. */
export function parseIconHint(iconPath) {
  if (typeof iconPath !== "string" || !iconPath.startsWith(ASSET_HINT_PREFIX)) {
    return undefined;
  }
  const hint = iconPath.slice(ASSET_HINT_PREFIX.length);
  const separator = hint.indexOf(":");
  if (separator <= 0) {
    return undefined;
  }
  const namespace = hint.slice(0, separator).toLowerCase();
  const resourcePath = hint.slice(separator + 1).replace(/^\/+/, "");
  if (!resourcePath.toLowerCase().endsWith(".png") || resourcePath.split("/").includes("..")) {
    return undefined;
  }
  return { namespace, resourcePath, entry: `assets/${namespace}/${resourcePath}` };
}

/** The published name of a hint's PNG: `<mod>_<file stem>-<sha1(bytes)[:12]>.png`, publishable characters only. */
export function hintFileName(hint, bytes) {
  const stem = path.posix.basename(hint.resourcePath).replace(/\.png$/i, "");
  const slug = `${hint.namespace}_${stem}`
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 90);
  const digest = createHash("sha1").update(bytes).digest("hex").slice(0, 12);
  return `${slug || "texture"}-${digest}.png`;
}

/** Every `iconPath` hint under `value`, objects and arrays at any depth. */
export function collectHints(value, found = new Set()) {
  visitIconPaths(value, (holder) => {
    found.add(holder.iconPath);
  });
  return found;
}

/**
 * Replaces each hint under `value` with its resolved URL, or deletes the `iconPath` when the
 * hint has none. Returns how many were replaced and cleared.
 */
export function rewriteHints(value, resolvedByHint) {
  const counts = { replaced: 0, cleared: 0 };
  visitIconPaths(value, (holder) => {
    const resolved = resolvedByHint.get(holder.iconPath);
    if (resolved) {
      holder.iconPath = resolved;
      counts.replaced += 1;
    } else {
      delete holder.iconPath;
      counts.cleared += 1;
    }
  });
  return counts;
}

function visitIconPaths(value, visit) {
  if (Array.isArray(value)) {
    for (const item of value) {
      visitIconPaths(item, visit);
    }
    return;
  }
  if (!value || typeof value !== "object") {
    return;
  }
  if (typeof value.iconPath === "string" && value.iconPath.startsWith(ASSET_HINT_PREFIX)) {
    visit(value);
  }
  for (const [key, child] of Object.entries(value)) {
    if (key !== "iconPath" && child && typeof child === "object") {
      visitIconPaths(child, visit);
    }
  }
}

/**
 * One line of a dataset file as `{ prefix, value, suffix }`: an array element (`    {...},`) or
 * a property (`  "key": value,`). Returns undefined for a line that is not a whole JSON value.
 */
export function parseDatasetLine(line) {
  const suffix = line.endsWith(",") ? "," : "";
  const body = suffix ? line.slice(0, -1) : line;
  const match = /^(\s*(?:"(?:[^"\\]|\\.)*"\s*:\s*)?)(.*)$/s.exec(body);
  if (!match) {
    return undefined;
  }
  try {
    return { prefix: match[1], value: JSON.parse(match[2]), suffix };
  } catch {
    return undefined;
  }
}

async function* datasetLines(datasetPath) {
  const lines = readline.createInterface({
    input: createReadStream(datasetPath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  let number = 0;
  for await (const line of lines) {
    number += 1;
    yield { line, number };
  }
}

function hintLine(line, number, datasetPath) {
  const parsed = parseDatasetLine(line);
  if (!parsed) {
    throw new Error(
      `${datasetPath}:${number} holds "asset:" but is not one JSON value per line; cannot rewrite it.`,
    );
  }
  return parsed;
}

/** Jar entries under `assets/`, ending in .png: exact name first, then one per lowercase name. */
export function buildJarTextureIndex(modsRoot) {
  const jars = findJars(modsRoot);
  const byEntry = new Map();
  const byLowerEntry = new Map();
  for (const jar of jars) {
    const list = spawnSync("unzip", ["-Z", "-1", jar], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    if (list.status !== 0) {
      continue;
    }
    for (const entry of list.stdout.split(/\r?\n/)) {
      if (!entry.startsWith("assets/") || !entry.toLowerCase().endsWith(".png")) {
        continue;
      }
      const texture = { jar, entry };
      if (!byEntry.has(entry)) {
        byEntry.set(entry, texture);
      }
      const lower = entry.toLowerCase();
      if (!byLowerEntry.has(lower)) {
        byLowerEntry.set(lower, texture);
      }
    }
  }
  return { jars, byEntry, byLowerEntry };
}

// The mods directory itself when given, else `<instance>/mods`. Jars in the top directory come
// before those in subdirectories (1.7.10/, the export's disabled set), each level by name.
function findJars(root) {
  const modsDir = existsSync(path.join(root, "mods")) ? path.join(root, "mods") : root;
  const found = [];
  const walk = (dir, depth) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, depth + 1);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".jar")) {
        found.push({ full, depth });
      }
    }
  };
  walk(modsDir, 0);
  return found
    .sort((a, b) => a.depth - b.depth || (a.full < b.full ? -1 : a.full > b.full ? 1 : 0))
    .map((jar) => jar.full);
}

function readJarEntry(texture) {
  const extract = spawnSync("unzip", ["-p", texture.jar, texture.entry], {
    encoding: "buffer",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (extract.status !== 0 || extract.stdout.length === 0) {
    return undefined;
  }
  return extract.stdout;
}

/**
 * Resolves every hint in `datasetPath` from the jars under `modsRoot`, writes the PNGs under
 * `<outDir>/textures/rendered/`, rewrites the dataset in place and writes the icon report.
 */
export async function resolveIconHints({ modsRoot, datasetPath, outDir, log = console.log }) {
  if (!existsSync(datasetPath)) {
    throw new Error(`Dataset not found: ${datasetPath}`);
  }

  let datasetVersionId;
  const hints = new Set();
  for await (const { line, number } of datasetLines(datasetPath)) {
    if (datasetVersionId === undefined) {
      const version = /^\s*"datasetVersionId":\s*("(?:[^"\\]|\\.)*")/.exec(line);
      if (version) {
        datasetVersionId = JSON.parse(version[1]);
      }
    }
    if (line.includes(ASSET_HINT_MARKER)) {
      collectHints(hintLine(line, number, datasetPath).value, hints);
    }
  }
  datasetVersionId ??= path.basename(outDir);

  const textureDir = path.join(outDir, "textures");
  const renderedDir = path.join(textureDir, "rendered");
  const publicBase = `/datasets/gtnh/${datasetVersionId}/textures/rendered`;
  const resolvedByHint = new Map();
  const resolved = [];
  const unresolved = [];
  let jarCount = 0;

  if (hints.size > 0) {
    const index = buildJarTextureIndex(modsRoot);
    jarCount = index.jars.length;
    if (jarCount === 0) {
      throw new Error(
        `No mod jars under ${modsRoot}: the ${hints.size} icon hints need the pack's mods directory.`,
      );
    }
    await fs.mkdir(renderedDir, { recursive: true });
    const namespaces = new Set([...index.byLowerEntry.keys()].map((entry) => entry.split("/")[1]));
    for (const hint of [...hints].sort()) {
      const parsed = parseIconHint(hint);
      if (!parsed) {
        unresolved.push({ hint, reason: "not an asset texture path" });
        continue;
      }
      const texture =
        index.byEntry.get(parsed.entry) ?? index.byLowerEntry.get(parsed.entry.toLowerCase());
      if (!texture) {
        unresolved.push({
          hint,
          reason: namespaces.has(parsed.namespace)
            ? `no ${parsed.entry} in the jars that hold assets/${parsed.namespace}/`
            : `no jar holds assets/${parsed.namespace}/ (the mod's jar is missing)`,
        });
        continue;
      }
      const bytes = readJarEntry(texture);
      if (!bytes || !bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
        unresolved.push({ hint, reason: `${texture.entry} in ${path.basename(texture.jar)} is not a PNG` });
        continue;
      }
      const file = hintFileName(parsed, bytes);
      await fs.writeFile(path.join(renderedDir, file), bytes);
      resolvedByHint.set(hint, `${publicBase}/${file}`);
      resolved.push({ hint, file, jar: path.basename(texture.jar), entry: texture.entry });
    }
  }

  let replaced = 0;
  let cleared = 0;
  if (hints.size > 0) {
    const partialPath = `${datasetPath}.hints-partial`;
    const out = createWriteStream(partialPath, { encoding: "utf8" });
    const write = async (text) => {
      if (!out.write(text)) {
        await once(out, "drain");
      }
    };
    let first = true;
    for await (const { line, number } of datasetLines(datasetPath)) {
      let text = line;
      if (line.includes(ASSET_HINT_MARKER)) {
        const parsed = hintLine(line, number, datasetPath);
        const counts = rewriteHints(parsed.value, resolvedByHint);
        replaced += counts.replaced;
        cleared += counts.cleared;
        text = `${parsed.prefix}${JSON.stringify(parsed.value)}${parsed.suffix}`;
      }
      await write(first ? text : `\n${text}`);
      first = false;
    }
    await write("\n");
    out.end();
    await once(out, "finish");
    await fs.rename(partialPath, datasetPath);
  }

  const report = {
    schemaVersion: 1,
    datasetVersionId,
    generatedAt: new Date().toISOString(),
    source: "minecraft-asset-pngs",
    textureHints: {
      jarCount,
      hints: hints.size,
      slotsResolved: replaced,
      slotsCleared: cleared,
      resolved,
      unresolved,
    },
  };
  await fs.mkdir(textureDir, { recursive: true });
  await fs.writeFile(path.join(textureDir, "icon-report.json"), `${JSON.stringify(report, null, 2)}\n`);

  log(
    `Icon hints for ${datasetVersionId}: ${resolved.length} of ${hints.size} resolved from ${jarCount} jars (${replaced} copies), ${cleared} copies cleared.`,
  );
  for (const miss of unresolved) {
    log(`  unresolved ${miss.hint}: ${miss.reason}`);
  }
  return report;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [modsRoot, datasetPath, outDir] = process.argv.slice(2);
  if (!modsRoot || !datasetPath || !outDir) {
    throw new Error(
      "Usage: resolve-icon-hints.mjs <gtnh-instance-root|mods-dir> <recipes.json> <dataset-output-dir>",
    );
  }
  await resolveIconHints({ modsRoot, datasetPath, outDir });
}
