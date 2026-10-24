// Copies rendered icons into the dataset under content-addressed names and gives each one's
// dominant colour, on worker threads.
//
// Textures are served immutable for a year with no dataset checksum in the URL, so a name
// must change whenever the bytes do. The oracle names a file after its stack key
// (`<slug>-<sha1(key)[:12]>.png`); staging swaps that suffix for the first 12 hex of the
// bytes' sha1 (`contentAddressedName`). The name keeps its length, so
// normalize-fluid-icon-alpha's same-length byte patch still applies, and a fluid that pass
// does not repaint keeps its name there. Two stacks with the same slug and the same pixels
// share one file.
//
// The oracle writes the colours it worked out while rendering to icon-colors.json
// (IconColors.java, the same arithmetic as getDominantOpaqueColor); an icon missing from it,
// as in exports made before that file, is decoded here instead. Decoding about 100,000 PNGs
// one after another took as long as rendering them. Results come back in the order the
// files were given, so the dataset is the same as a serial run's.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Worker, isMainThread, parentPort, threadId } from "node:worker_threads";
import { PNG } from "pngjs";
import { getDominantOpaqueColor } from "./icon-utils.mjs";

const CHUNK = 256;

const HASH_SUFFIX = /-[0-9a-f]{12}\.png$/i;

/**
 * The dataset name of an icon: the export's name with its 12-hex suffix replaced by the
 * first 12 hex of the sha1 of `bytes` (appended when the export's name has none).
 */
export function contentAddressedName(file, bytes) {
  const digest = createHash("sha1").update(bytes).digest("hex").slice(0, 12);
  const stem = HASH_SUFFIX.test(file) ? file.replace(HASH_SUFFIX, "") : file.replace(/\.png$/i, "");
  return `${stem}-${digest}.png`;
}

/**
 * @param {string[]} files PNG basenames in `sourceDir`
 * @returns {Promise<{ colors: (string | undefined)[], names: string[] }>} each file's dominant
 *   colour (undefined when unreadable) and its content-addressed name in `targetDir`
 */
export async function stageRenderedIcons(files, sourceDir, targetDir, threads = defaultThreads()) {
  const colors = new Array(files.length);
  const names = new Array(files.length);
  const colorsPath = path.join(sourceDir, "icon-colors.json");
  const known = existsSync(colorsPath) ? JSON.parse(readFileSync(colorsPath, "utf8")) : {};
  const chunks = [];
  for (let start = 0; start < files.length; start += CHUNK) {
    chunks.push(start);
  }
  if (chunks.length === 0) {
    return { colors, names };
  }

  const workerCount = Math.max(1, Math.min(threads, chunks.length));
  let next = 0;
  await Promise.all(
    Array.from({ length: workerCount }, () =>
      new Promise((resolve, reject) => {
        const worker = new Worker(new URL(import.meta.url));
        const send = () => {
          if (next >= chunks.length) {
            worker.terminate().then(resolve, reject);
            return;
          }
          const start = chunks[next++];
          const chunk = files.slice(start, start + CHUNK);
          const knownColors = chunk.map((file) => known[file] ?? null);
          worker.postMessage({ start, files: chunk, knownColors, sourceDir, targetDir });
        };
        worker.on("message", ({ start, colors: chunkColors, names: chunkNames }) => {
          chunkColors.forEach((color, offset) => {
            colors[start + offset] = color ?? undefined;
            names[start + offset] = chunkNames[offset];
          });
          send();
        });
        worker.on("error", reject);
        send();
      }),
    ),
  );
  return { colors, names };
}

function defaultThreads() {
  const env = Number(process.env.GTNH_ICON_STAGE_THREADS);
  if (Number.isInteger(env) && env > 0) {
    return env;
  }
  return Math.max(1, (os.availableParallelism?.() ?? os.cpus().length) - 1);
}

if (!isMainThread) {
  parentPort.on("message", ({ start, files, knownColors, sourceDir, targetDir }) => {
    const names = [];
    const colors = files.map((file, index) => {
      const bytes = readFileSync(path.join(sourceDir, file));
      const name = contentAddressedName(file, bytes);
      names.push(name);
      writeOnce(path.join(targetDir, name), bytes);
      if (knownColors[index]) {
        return knownColors[index];
      }
      try {
        return getDominantOpaqueColor(PNG.sync.read(bytes)) ?? null;
      } catch {
        return null;
      }
    });
    parentPort.postMessage({ start, colors, names });
  });
}

/**
 * Writes a content-addressed file unless another stack with the same pixels already did.
 * The bytes go to a temporary name first and are renamed into place, so a file under its
 * real name is always whole when another worker compares against it. A name already taken
 * by other bytes would be a 48-bit hash collision under one slug: refused, not overwritten.
 */
function writeOnce(targetPath, bytes) {
  if (existsSync(targetPath)) {
    if (!readFileSync(targetPath).equals(bytes)) {
      throw new Error(`Two different icons hash to ${path.basename(targetPath)}`);
    }
    return;
  }
  const temporary = `${targetPath}.${threadId}.partial`;
  writeFileSync(temporary, bytes);
  renameSync(temporary, targetPath);
}
