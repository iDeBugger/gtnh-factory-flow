import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { createGunzip } from "node:zlib";
import { NextResponse } from "next/server";

import { CLIENT_FILE_NAME, CLIENT_FILES_DIRECTORY } from "@/lib/server/client-files";
import {
  CLIENT_FILE_CACHE_CONTROL,
  DATASET_FILE_CACHE_CONTROL,
  isSafePathSegment,
  resolveDatasetChildPath,
  serveDatasetFile,
} from "@/lib/server/dataset-static-file";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The dataset files that may be downloaded: the index gzips and the recipe
 * shards. src/proxy.ts sends their public paths here (dataset-path-gate.ts),
 * because Next's own public handler serves everything under
 * public/datasets/gtnh with a cache policy set by path alone (a 404 would
 * carry the same day's cache as the file) and could not refuse the raw
 * recipes.json, about 2 GB per download. Here a file is served for a day,
 * never immutable (gzips and shards are replaced in place on a republish),
 * with ETag and byte ranges, and a refusal or a miss says no-store.
 *
 * The server's own content-addressed answers (`client/<kind>.<hash>.json`,
 * client-files.ts) are served here too: immutable, as brotli or gzip by the
 * request's Accept-Encoding, decompressed for a client that takes neither.
 */
const INDEX_FILES = new Set([
  "recipes.json.gz",
  "recipe-index.json.gz",
  "recipe-lookup-index.json.gz",
  "resource-index.json.gz",
]);
const SHARDS_DIRECTORY = "recipes-shards";
const SHARD_FILE = /^shard-\d{4}\.json\.gz$/;
const uncached = { "Cache-Control": "no-store" };

export async function GET(
  request: Request,
  { params }: { params: Promise<{ versionId: string; assetPath: string[] }> },
) {
  const { versionId, assetPath } = await params;
  const segments = allowedSegments(assetPath);
  if (!isSafePathSegment(versionId) || !segments) {
    return NextResponse.json(
      { error: "Invalid dataset path." },
      { status: 400, headers: uncached },
    );
  }

  if (segments[0] === CLIENT_FILES_DIRECTORY && segments[1] !== undefined) {
    return serveClientFile(request, versionId, segments[1]);
  }

  // Undefined is a file that is not there or a link out of the version's directory: both a miss.
  const filePath = await resolveDatasetChildPath(versionId, ...segments);
  try {
    if (!filePath) {
      throw new Error("Not a dataset file.");
    }
    return await serveDatasetFile(filePath, {
      cacheControl: DATASET_FILE_CACHE_CONTROL,
      contentType: "application/gzip",
      requestHeaders: request.headers,
    });
  } catch {
    return NextResponse.json(
      { error: "Dataset file not found." },
      { status: 404, headers: uncached },
    );
  }
}

function allowedSegments(assetPath: string[]): string[] | undefined {
  const [first, second] = assetPath;
  if (assetPath.length === 1 && first !== undefined && INDEX_FILES.has(first)) {
    return [first];
  }
  if (
    assetPath.length === 2 &&
    first === CLIENT_FILES_DIRECTORY &&
    second !== undefined &&
    CLIENT_FILE_NAME.test(second)
  ) {
    return [first, second];
  }
  if (
    assetPath.length === 2 &&
    first === SHARDS_DIRECTORY &&
    second !== undefined &&
    SHARD_FILE.test(second)
  ) {
    return [first, second];
  }
  return undefined;
}

async function serveClientFile(request: Request, versionId: string, name: string) {
  const accepted = acceptedEncodings(request.headers.get("accept-encoding"));
  const hash = name.split(".")[1];
  for (const [encoding, suffix] of [
    ["br", "br"],
    ["gzip", "gz"],
  ] as const) {
    if (!accepted.has(encoding)) {
      continue;
    }
    const filePath = await resolveDatasetChildPath(
      versionId,
      CLIENT_FILES_DIRECTORY,
      `${name}.${suffix}`,
    );
    if (!filePath) {
      break;
    }
    try {
      return await serveDatasetFile(filePath, {
        cacheControl: CLIENT_FILE_CACHE_CONTROL,
        contentType: "application/json",
        contentEncoding: encoding,
        etag: `"${hash}-${suffix}"`,
        requestHeaders: request.headers,
      });
    } catch {
      // No copy in this encoding (the id list has no brotli one): try the next.
    }
  }
  // A client that takes neither encoding gets the gzip copy unpacked.
  const gzipPath = await resolveDatasetChildPath(versionId, CLIENT_FILES_DIRECTORY, `${name}.gz`);
  const stats = gzipPath ? await stat(gzipPath).catch(() => undefined) : undefined;
  if (!gzipPath || !stats?.isFile()) {
    return NextResponse.json(
      { error: "Dataset file not found." },
      { status: 404, headers: uncached },
    );
  }
  const body = Readable.toWeb(
    createReadStream(gzipPath).pipe(createGunzip()),
  ) as ReadableStream<Uint8Array>;
  return new Response(body, {
    headers: {
      "Cache-Control": CLIENT_FILE_CACHE_CONTROL,
      "Content-Type": "application/json",
      ETag: `"${hash}"`,
      Vary: "Accept-Encoding",
    },
  });
}

/** The encodings a request takes, from Accept-Encoding (a zero q refuses one). */
function acceptedEncodings(header: string | null): Set<string> {
  const accepted = new Set<string>();
  for (const part of (header ?? "").split(",")) {
    const [token = "", ...params] = part.trim().toLowerCase().split(";");
    const q = params.map((param) => param.trim()).find((param) => param.startsWith("q="));
    if (token && !(q && Number(q.slice(2)) === 0)) {
      accepted.add(token === "*" ? "gzip" : token);
    }
  }
  return accepted;
}
