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
 * The dataset files a request may download when Next's public handler did not
 * answer first (it serves everything under public/datasets/gtnh itself). The
 * raw recipes.json is not one: about 2 GB per download, nothing reads it over
 * HTTP, and next.config.ts rewrites it here so this list refuses it.
 */
const datasetFiles = new Set([
  "recipes.json.gz",
  "recipe-index.json.gz",
  "recipe-lookup-index.json.gz",
  "resource-index.json.gz",
]);

// The day's cache in next.config.ts applies by path, so a refusal or a file
// missing for a moment during a publish must say no-store itself, or the edge
// and a browser would keep the miss for a day.
const uncached = { "Cache-Control": "no-store" };

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ versionId: string; assetFile: string }> },
) {
  const { versionId, assetFile } = await params;
  if (!isSafePathSegment(versionId) || !datasetFiles.has(assetFile)) {
    return NextResponse.json(
      { error: "Invalid dataset path." },
      { status: 400, headers: uncached },
    );
  }

  const filePath = resolveDatasetChildPath(versionId, assetFile);
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
    });
  } catch {
    return NextResponse.json(
      { error: "Dataset file not found." },
      { status: 404, headers: uncached },
    );
  }
}
