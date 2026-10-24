import { NextResponse } from "next/server";

import {
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

  const filePath = resolveDatasetChildPath(versionId, ...segments);
  if (!filePath) {
    return NextResponse.json(
      { error: "Invalid dataset path." },
      { status: 400, headers: uncached },
    );
  }

  try {
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
    first === SHARDS_DIRECTORY &&
    second !== undefined &&
    SHARD_FILE.test(second)
  ) {
    return [first, second];
  }
  return undefined;
}
