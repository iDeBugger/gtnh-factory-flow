import { NextResponse } from "next/server";
import { prewarmDatasetVersion } from "@/lib/server/dataset-query";
import { getResourcePopularity } from "@/lib/server/resource-popularity";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * A readiness wait for a unit's ExecStartPost: loads the version's indexes, or
 * joins the startup load, and answers when they are in memory. It never reads
 * the recipe shards: a shard sweep reads about 2 GB from disk and flushes the
 * shard cache every player's browse depends on, and this route is open to
 * anyone. `GTNH_PREWARM_FULL_DATASETS=1` at start is the only shard warm.
 * `includeShards` stays in the answer so a caller parsing it is unaffected.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ versionId: string }> },
) {
  const startedAt = Date.now();

  try {
    const { versionId } = await params;

    // The item list's default sort reads the community ranking and never
    // waits for it, so start the first sweep at boot rather than on the
    // first visitor's request. Fire and forget: a stalled database must not
    // hold up the prewarm.
    getResourcePopularity();
    await prewarmDatasetVersion(versionId);

    return NextResponse.json(
      {
        ok: true,
        datasetVersionId: versionId,
        includeShards: false,
        durationMs: Date.now() - startedAt,
      },
      { headers: datasetCacheHeaders() },
    );
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Dataset prewarm failed." },
      { status: 500, headers: datasetCacheHeaders() },
    );
  }
}

function datasetCacheHeaders() {
  return {
    "Cache-Control": "no-store",
  };
}
