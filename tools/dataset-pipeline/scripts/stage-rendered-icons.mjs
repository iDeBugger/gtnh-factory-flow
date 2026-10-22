// Copies rendered icons into the dataset and gives each one's dominant colour, on worker
// threads. The oracle writes the colours it worked out while rendering to icon-colors.json
// (IconColors.java, the same arithmetic as getDominantOpaqueColor); an icon missing from it,
// as in exports made before that file, is decoded here instead. Decoding about 100,000 PNGs
// one after another took as long as rendering them. Results come back in the order the
// files were given, so the dataset is the same as a serial run's.
import { copyFileSync, existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Worker, isMainThread, parentPort } from "node:worker_threads";
import { PNG } from "pngjs";
import { getDominantOpaqueColor } from "./icon-utils.mjs";

const CHUNK = 256;

/**
 * @param {string[]} files PNG basenames in `sourceDir`
 * @returns {Promise<(string | undefined)[]>} each file's dominant colour, undefined when unreadable
 */
export async function stageRenderedIcons(files, sourceDir, targetDir, threads = defaultThreads()) {
  const colors = new Array(files.length);
  const colorsPath = path.join(sourceDir, "icon-colors.json");
  const known = existsSync(colorsPath) ? JSON.parse(readFileSync(colorsPath, "utf8")) : {};
  const chunks = [];
  for (let start = 0; start < files.length; start += CHUNK) {
    chunks.push(start);
  }
  if (chunks.length === 0) {
    return colors;
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
        worker.on("message", ({ start, colors: chunkColors }) => {
          chunkColors.forEach((color, offset) => {
            colors[start + offset] = color ?? undefined;
          });
          send();
        });
        worker.on("error", reject);
        send();
      }),
    ),
  );
  return colors;
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
    const colors = files.map((file, index) => {
      const targetPath = path.join(targetDir, file);
      copyFileSync(path.join(sourceDir, file), targetPath);
      if (knownColors[index]) {
        return knownColors[index];
      }
      try {
        return getDominantOpaqueColor(PNG.sync.read(readFileSync(targetPath))) ?? null;
      } catch {
        return null;
      }
    });
    parentPort.postMessage({ start, colors });
  });
}
