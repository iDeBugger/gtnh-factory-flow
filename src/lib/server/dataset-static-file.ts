import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";

export const datasetRoot = path.join(process.cwd(), "public", "datasets", "gtnh");

/**
 * What a served data file (the index gzips and the shards) says about caching:
 * a day, never immutable, because they are replaced in place under the same
 * names on a republish. The content-named textures the dataset-files route also
 * serves are immutable on a hit instead, since a texture's name changes with its
 * bytes; any miss is no-store.
 */
export const DATASET_FILE_CACHE_CONTROL = "public, max-age=86400";

/**
 * The server's content-addressed answers (client-files.ts): a name holds the
 * hash of its bytes, so it never means other bytes, and is kept a year.
 */
export const CLIENT_FILE_CACHE_CONTROL = "public, max-age=31536000, immutable";

/**
 * Streams a file with the validators a cache or a download tool expects: an
 * ETag from size and mtime (a 304 for If-None-Match, a list, a weak form or
 * "*" included, or for If-Modified-Since at second precision when no ETag is
 * sent, so the edge's revalidation after the day costs no bytes),
 * Last-Modified, and one byte range (a resumed download), the range ignored
 * when If-Range names another version. A miss says no-store: a file missing
 * for a moment during a publish must not be cached as missing.
 */
export async function serveDatasetFile(
  filePath: string,
  options: {
    cacheControl?: string;
    contentType: string;
    requestHeaders?: Headers;
    /** The file is this encoding of the content (a client file's `.br` or `.gz`). */
    contentEncoding?: string;
    /** A validator that outlives the file's mtime (a content-addressed name's hash). */
    etag?: string;
  },
) {
  const stats = await stat(filePath);
  if (!stats.isFile()) {
    return new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });
  }

  const etag =
    options.etag ?? `"${stats.size.toString(16)}-${Math.floor(stats.mtimeMs).toString(16)}"`;
  const headers: Record<string, string> = {
    "Accept-Ranges": "bytes",
    "Cache-Control": options.cacheControl ?? "public, max-age=0",
    "Content-Type": options.contentType,
    ETag: etag,
    "Last-Modified": new Date(stats.mtimeMs).toUTCString(),
    ...(options.contentEncoding
      ? { "Content-Encoding": options.contentEncoding, Vary: "Accept-Encoding" }
      : {}),
  };
  const request = options.requestHeaders;
  if (isFresh(request, etag, stats.mtimeMs)) {
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

/** Whether the client's copy is the file: by ETag when it sends one, else by date. */
function isFresh(request: Headers | undefined, etag: string, mtimeMs: number): boolean {
  const noneMatch = request?.get("if-none-match");
  if (noneMatch) {
    return noneMatch
      .split(",")
      .map((tag) => tag.trim().replace(/^W\//, ""))
      .some((tag) => tag === "*" || tag === etag);
  }
  const since = Date.parse(request?.get("if-modified-since") ?? "");
  return Number.isFinite(since) && Math.floor(mtimeMs / 1000) * 1000 <= since;
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

/**
 * A file under one dataset version, or undefined when the path leaves the
 * version's directory or names nothing. Checked twice: lexically, then by
 * the real path, so a symlink inside the tree (rsync -a keeps them) cannot
 * point a read outside it. The real file is compared with the real version
 * directory, not the lexical one: the dataset root itself may be a symlink
 * (a deployment's link to its shared datasets).
 */
export function resolveDatasetChildPath(versionId: string, ...segments: string[]) {
  return resolveDatasetChildPathIn(datasetRoot, versionId, ...segments);
}

export async function resolveDatasetChildPathIn(
  root: string,
  versionId: string,
  ...segments: string[]
): Promise<string | undefined> {
  const versionRoot = path.resolve(root, versionId);
  const filePath = path.resolve(versionRoot, ...segments);
  if (!filePath.startsWith(`${versionRoot}${path.sep}`)) {
    return undefined;
  }
  try {
    const [real, rootReal] = await Promise.all([realpath(filePath), realpath(versionRoot)]);
    return real.startsWith(`${rootReal}${path.sep}`) ? real : undefined;
  } catch {
    return undefined;
  }
}
