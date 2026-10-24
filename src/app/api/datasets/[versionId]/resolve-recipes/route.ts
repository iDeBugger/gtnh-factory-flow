import { NextResponse } from "next/server";
import { type DatasetRecipeRef, resolveDatasetRecipeRefs } from "@/lib/server/dataset-query";
import {
  datasetBudgetRefusal,
  HEAVY_REQUEST_COST,
  meteredDatasetWork,
} from "@/lib/server/dataset-rate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ versionId: string }> },
) {
  try {
    const { versionId } = await params;
    // A plan's worth of recipe lookups per call.
    const refusal = datasetBudgetRefusal(request, HEAVY_REQUEST_COST);
    if (refusal) {
      return refusal;
    }
    const body = (await request.json()) as { recipes?: DatasetRecipeRef[] };
    return NextResponse.json(
      {
        matches: await meteredDatasetWork(request, () =>
          resolveDatasetRecipeRefs(versionId, body.recipes ?? []),
        ),
      },
      {
        headers: datasetCacheHeaders(),
      },
    );
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Recipe resolution failed." },
      { status: 500 },
    );
  }
}

function datasetCacheHeaders() {
  return {
    "Cache-Control": "no-store",
  };
}
