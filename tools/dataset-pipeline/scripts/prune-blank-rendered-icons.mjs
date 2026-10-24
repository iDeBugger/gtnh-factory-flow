import fs from "node:fs/promises";
import path from "node:path";
import zlib from "node:zlib";
import { writeDatasetJson } from "./dataset-json-writer.mjs";
import { gzipDeterministic } from "./deterministic-gzip.mjs";

const datasetPath = process.argv[2];
const renderedDir = process.argv[3];

if (!datasetPath || !renderedDir) {
  throw new Error("Usage: prune-blank-rendered-icons.mjs <recipes.json|recipes.json.gz> <rendered-dir>");
}

const datasetBuffer = await fs.readFile(datasetPath);
const dataset = JSON.parse(
  datasetPath.endsWith(".gz") ? zlib.gunzipSync(datasetBuffer).toString("utf8") : datasetBuffer,
);
const pruneAtlasLikeIcons = process.env.PRUNE_ATLAS_LIKE_ICONS === "true";

const blankFiles = new Set();
let scanned = 0;
let removedAtlasLikeIcons = 0;
let removedMissingTextureIcons = 0;

for (const entry of await fs.readdir(renderedDir, { withFileTypes: true })) {
  if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".png")) {
    continue;
  }

  scanned += 1;
  const filePath = path.join(renderedDir, entry.name);
  const png = await fs.readFile(filePath);
  const analysis = analyzePngVisibility(png);
  const isAtlasLike = pruneAtlasLikeIcons && analysis.visibleCorners === 4;
  const isMissingTexture = analysis.missingTextureRatio > 0.5;
  if (analysis.hasVisiblePixel && !isAtlasLike && !isMissingTexture) {
    continue;
  }

  blankFiles.add(entry.name);
  await fs.rm(filePath, { force: true });
  if (isAtlasLike) {
    removedAtlasLikeIcons += 1;
  }
  if (isMissingTexture) {
    removedMissingTextureIcons += 1;
  }
}

let clearedIconPaths = 0;
for (const resource of dataset.resources ?? []) {
  if (clearBlankIconPath(resource, blankFiles)) {
    clearedIconPaths += 1;
  }
}
for (const recipe of dataset.recipes ?? []) {
  for (const resource of [...(recipe.inputs ?? []), ...(recipe.outputs ?? [])]) {
    if (clearBlankIconPath(resource, blankFiles)) {
      clearedIconPaths += 1;
    }
  }
}

if (datasetPath.endsWith(".gz")) {
  await fs.writeFile(datasetPath, gzipDeterministic(`${JSON.stringify(dataset)}\n`));
} else {
  await writeDatasetJson(datasetPath, dataset);
}

console.log(
  JSON.stringify({
    scanned,
    removedBlankIcons: blankFiles.size,
    removedAtlasLikeIcons,
    removedMissingTextureIcons,
    clearedIconPaths,
  }),
);

function clearBlankIconPath(resource, blankFiles) {
  if (!resource?.iconPath || !String(resource.iconPath).includes("/textures/rendered/")) {
    return false;
  }

  const fileName = path.basename(String(resource.iconPath));
  if (!blankFiles.has(fileName)) {
    return false;
  }

  delete resource.iconPath;
  return true;
}

function analyzePngVisibility(buffer) {
  const png = parsePng(buffer);
  if (!png || png.bitDepth !== 8 || ![2, 6].includes(png.colorType)) {
    return { hasVisiblePixel: true, visibleCorners: 0, missingTextureRatio: 0 };
  }

  const bytesPerPixel = png.colorType === 6 ? 4 : 3;
  const inflated = zlib.inflateSync(Buffer.concat(png.idatChunks));
  const stride = png.width * bytesPerPixel;
  let previous = Buffer.alloc(stride);
  let offset = 0;
  let hasVisiblePixel = false;
  let visibleCorners = 0;
  let visiblePixels = 0;
  let missingTexturePixels = 0;

  for (let y = 0; y < png.height; y++) {
    const filter = inflated[offset];
    offset += 1;
    const current = Buffer.from(inflated.subarray(offset, offset + stride));
    offset += stride;
    unfilterScanline(current, previous, filter, bytesPerPixel);

    for (let x = 0; x < png.width; x++) {
      const index = x * bytesPerPixel;
      const alpha = png.colorType === 6 ? current[index + 3] : 255;
      if (alpha > 0 && (current[index] > 0 || current[index + 1] > 0 || current[index + 2] > 0)) {
        hasVisiblePixel = true;
        visiblePixels += 1;
        if (isMissingTexturePixel(current[index], current[index + 1], current[index + 2])) {
          missingTexturePixels += 1;
        }
      }
      if (
        alpha > 0 &&
        ((x === 0 && y === 0) ||
          (x === png.width - 1 && y === 0) ||
          (x === 0 && y === png.height - 1) ||
          (x === png.width - 1 && y === png.height - 1))
      ) {
        visibleCorners += 1;
      }
    }

    previous = current;
  }

  return {
    hasVisiblePixel,
    visibleCorners,
    missingTextureRatio: visiblePixels > 0 ? missingTexturePixels / visiblePixels : 0,
  };
}

function isMissingTexturePixel(red, green, blue) {
  return red >= 220 && green <= 40 && blue >= 220;
}

function parsePng(buffer) {
  if (!buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return undefined;
  }

  let offset = 8;
  const idatChunks = [];
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;

  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;

    if (type === "IHDR") {
      width = buffer.readUInt32BE(dataStart);
      height = buffer.readUInt32BE(dataStart + 4);
      bitDepth = buffer[dataStart + 8];
      colorType = buffer[dataStart + 9];
    } else if (type === "IDAT") {
      idatChunks.push(buffer.subarray(dataStart, dataEnd));
    } else if (type === "IEND") {
      break;
    }

    offset = dataEnd + 4;
  }

  return { width, height, bitDepth, colorType, idatChunks };
}

function unfilterScanline(current, previous, filter, bytesPerPixel) {
  for (let i = 0; i < current.length; i++) {
    const left = i >= bytesPerPixel ? current[i - bytesPerPixel] : 0;
    const up = previous[i] ?? 0;
    const upLeft = i >= bytesPerPixel ? (previous[i - bytesPerPixel] ?? 0) : 0;

    if (filter === 1) {
      current[i] = (current[i] + left) & 255;
    } else if (filter === 2) {
      current[i] = (current[i] + up) & 255;
    } else if (filter === 3) {
      current[i] = (current[i] + Math.floor((left + up) / 2)) & 255;
    } else if (filter === 4) {
      current[i] = (current[i] + paethPredictor(left, up, upLeft)) & 255;
    } else if (filter !== 0) {
      throw new Error(`Unsupported PNG filter ${filter}.`);
    }
  }
}

function paethPredictor(left, up, upLeft) {
  const p = left + up - upLeft;
  const pa = Math.abs(p - left);
  const pb = Math.abs(p - up);
  const pc = Math.abs(p - upLeft);
  if (pa <= pb && pa <= pc) {
    return left;
  }
  return pb <= pc ? up : upLeft;
}
