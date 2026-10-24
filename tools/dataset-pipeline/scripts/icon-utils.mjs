import fs from "node:fs/promises";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { gzipDeterministic } from "./deterministic-gzip.mjs";
import { writeDatasetJson } from "./dataset-json-writer.mjs";

export async function readDataset(filePath) {
  const data = await fs.readFile(filePath);
  const source = filePath.endsWith(".gz")
    ? gunzipSync(data).toString("utf8")
    : data.toString("utf8");
  return JSON.parse(source);
}

export async function writeDataset(filePath, dataset) {
  if (filePath.endsWith(".gz")) {
    const json = `${JSON.stringify(dataset)}\n`;
    await fs.writeFile(filePath, gzipDeterministic(json));
    return;
  }

  await writeDatasetJson(filePath, dataset);
}

export function forEachResource(dataset, callback) {
  for (const resource of dataset.resources ?? []) {
    callback(resource);
  }
  for (const resource of dataset.resourceIndex ?? []) {
    callback(resource);
  }
  for (const recipe of dataset.recipes ?? []) {
    for (const resource of recipe.inputs ?? []) {
      callback(resource);
    }
    for (const resource of recipe.outputs ?? []) {
      callback(resource);
    }
  }
}

export function isRenderedIconPath(iconPath) {
  return typeof iconPath === "string" && iconPath.includes("/textures/rendered/");
}

export function publicPathToFile(publicPath) {
  const normalized = String(publicPath).replace(/^\/+/, "");
  const resolvedRoot = path.resolve(process.cwd(), "public");
  const resolvedFile = path.resolve(resolvedRoot, normalized);

  if (resolvedFile !== resolvedRoot && !resolvedFile.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error(`Public path escapes /public: ${publicPath}`);
  }

  return resolvedFile;
}

export function getDominantOpaqueColor(icon) {
  const buckets = new Map();

  for (let y = 0; y < icon.height; y += 1) {
    for (let x = 0; x < icon.width; x += 1) {
      const index = (y * icon.width + x) * 4;
      const alpha = icon.data[index + 3];
      if (alpha < 24) {
        continue;
      }

      const red = icon.data[index];
      const green = icon.data[index + 1];
      const blue = icon.data[index + 2];
      const { hue, saturation, lightness } = rgbToHsl(red, green, blue);
      if (lightness < 0.05 || lightness > 0.96) {
        continue;
      }

      const bucket = Math.round(hue / 12) * 12;
      const weight = (alpha / 255) * (0.35 + saturation * 1.65);
      const current = buckets.get(bucket) ?? { weight: 0, red: 0, green: 0, blue: 0 };
      current.weight += weight;
      current.red += red * weight;
      current.green += green * weight;
      current.blue += blue * weight;
      buckets.set(bucket, current);
    }
  }

  const dominant = [...buckets.values()].sort((a, b) => b.weight - a.weight)[0];
  if (!dominant || dominant.weight <= 0) {
    return "#6b7280";
  }

  return rgbToHex(
    Math.round(dominant.red / dominant.weight),
    Math.round(dominant.green / dominant.weight),
    Math.round(dominant.blue / dominant.weight),
  );
}

function rgbToHsl(red, green, blue) {
  const r = red / 255;
  const g = green / 255;
  const b = blue / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const lightness = (max + min) / 2;

  if (max === min) {
    return { hue: 0, saturation: 0, lightness };
  }

  const delta = max - min;
  const saturation = lightness > 0.5 ? delta / (2 - max - min) : delta / (max + min);
  let hue = 0;

  if (max === r) {
    hue = (g - b) / delta + (g < b ? 6 : 0);
  } else if (max === g) {
    hue = (b - r) / delta + 2;
  } else {
    hue = (r - g) / delta + 4;
  }

  return { hue: hue * 60, saturation, lightness };
}

function rgbToHex(red, green, blue) {
  return `#${[red, green, blue]
    .map((value) => Math.max(0, Math.min(255, value)).toString(16).padStart(2, "0"))
    .join("")}`;
}
