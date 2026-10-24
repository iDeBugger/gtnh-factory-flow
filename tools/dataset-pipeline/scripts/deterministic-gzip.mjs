import fs from "node:fs";
import { pipeline } from "node:stream/promises";
import { constants, createGzip, gzipSync } from "node:zlib";

/**
 * Dataset gzips are hashed into the manifest checksum, so the same JSON must give the same bytes on every machine.
 * zlib already writes no file name and a zero mtime; the one header byte that varies is the OS code (19 from Node on
 * macOS, 3 on Linux), so it is pinned to 3 (Unix), what the pipeline image writes anyway. The level is fixed at 9.
 */
export const GZIP_LEVEL = constants.Z_BEST_COMPRESSION;
const GZIP_OS_OFFSET = 9;
const GZIP_OS_UNIX = 3;

export function gzipDeterministic(data) {
  const out = gzipSync(data, { level: GZIP_LEVEL });
  out[GZIP_OS_OFFSET] = GZIP_OS_UNIX;
  return out;
}

/** Streams a file of any size into a deterministic gzip, written beside the target and renamed into place. */
export async function gzipFileDeterministic(inputPath, outputPath) {
  const partial = `${outputPath}.partial`;
  await pipeline(
    fs.createReadStream(inputPath),
    createGzip({ level: GZIP_LEVEL }),
    fs.createWriteStream(partial),
  );
  const handle = await fs.promises.open(partial, "r+");
  try {
    await handle.write(Buffer.from([GZIP_OS_UNIX]), 0, 1, GZIP_OS_OFFSET);
  } finally {
    await handle.close();
  }
  await fs.promises.rename(partial, outputPath);
}
