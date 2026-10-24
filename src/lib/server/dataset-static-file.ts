import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";

export const datasetRoot = path.join(process.cwd(), "public", "datasets", "gtnh");

/**
 * What a served dataset file says about caching, the same for every file the
 * dataset-files route serves: a day, never immutable, because gzips and shards
 * are replaced in place under the same names on a republish.
 */
export const DATASET_FILE_CACHE_CONTROL = "public, max-age=86400";

/**
 * Streams a file with the validators a cache or a download tool expects: an
 * ETag from size and mtime (a 304 for If-None-Match, so the edge's
 * revalidation after the day costs no bytes), Last-Modified, and one byte
 * range (a resumed download), the range ignored when If-Range names another
 * version. A miss says no-store: a file missing for a moment during a publish
 * must not be cached as missing.
 */
export async function serveDatasetFile(
  filePath: string,
  options: {
    cacheControl?: string;
    contentType: string;
    requestHeaders?: Headers;
  },
) {
  const stats = await stat(filePath);
  if (!stats.isFile()) {
    return new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });
  }

  const etag = `"${stats.size.toString(16)}-${Math.floor(stats.mtimeMs).toString(16)}"`;
  const headers: Record<string, string> = {
    "Accept-Ranges": "bytes",
    "Cache-Control": options.cacheControl ?? "public, max-age=0",
    "Content-Type": options.contentType,
    ETag: etag,
    "Last-Modified": new Date(stats.mtimeMs).toUTCString(),
  };
  const request = options.requestHeaders;
  if (request?.get("if-none-match") === etag) {
    return new Response(null, { status: 304, headers });
  }

  const ifRange = request?.get("if-range");
  const range =
    ifRange && ifRange !== etag ? undefined : parseByteRange(request?.get("range"), stats.size);
  if (range === "unsatisfiable") {
    return new Response(null, {
      status: 416,
      headers: { ...headers, "Content-Range": `bytes */${stats.size}` },
    });
  }
  const [start, end] = range ?? [0, stats.size - 1];
  const stream = Readable.toWeb(
    createReadStream(filePath, { start, end }),
  ) as ReadableStream<Uint8Array>;
  return new Response(stream, {
    status: range ? 206 : 200,
    headers: {
      ...headers,
      "Content-Length": String(end - start + 1),
      ...(range ? { "Content-Range": `bytes ${start}-${end}/${stats.size}` } : {}),
    },
  });
}

/** One `bytes=` range as [start, end], "unsatisfiable", or undefined for none (or several). */
function parseByteRange(
  header: string | null | undefined,
  size: number,
): [number, number] | "unsatisfiable" | undefined {
  const match = header && /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || size === 0) {
    return undefined;
  }
  const [, from, to] = match;
  if (from === "" && to === "") {
    return undefined;
  }
  if (from === "") {
    const suffix = Number(to);
    return suffix === 0 ? "unsatisfiable" : [Math.max(0, size - suffix), size - 1];
  }
  const start = Number(from);
  const end = to === "" ? size - 1 : Math.min(Number(to), size - 1);
  if (start >= size || start > end) {
    return "unsatisfiable";
  }
  return [start, end];
}

export function isSafePathSegment(value: string) {
  return /^[a-zA-Z0-9._-]+$/.test(value) && value !== "." && value !== "..";
}

export function resolveDatasetChildPath(versionId: string, ...segments: string[]) {
  const versionRoot = path.resolve(datasetRoot, versionId);
  const filePath = path.resolve(versionRoot, ...segments);
  if (!filePath.startsWith(`${versionRoot}${path.sep}`)) {
    return undefined;
  }
  return filePath;
}
