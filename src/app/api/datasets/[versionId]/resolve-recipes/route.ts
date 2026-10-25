import { NextResponse } from "next/server";
import { datasetErrorResponse } from "@/lib/server/error-response";
import {
  RESOLVE_RECIPES_MAX_BYTES,
  RESOLVE_RECIPES_MAX_REFS,
} from "@/lib/datasets/resolve-recipes-limits";
import { type DatasetRecipeRef, resolveDatasetRecipeRefs } from "@/lib/server/dataset-query";
import {
  datasetBudgetRefusal,
  HEAVY_REQUEST_COST,
  meteredDatasetWork,
} from "@/lib/server/limits/dataset-rate";
import { checkRecipeRefs } from "@/lib/server/recipe-ref-schema";
import { readJsonCapped } from "@/lib/server/request-body";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * A plan import's stale recipes, matched to the dataset's by content. The
 * body is capped and the refs are shape-checked and counted before the
 * resolver sweeps the index for them; the browser sends a long plan in
 * chunks under the count cap (`browser-loader.ts`).
 */
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
    const read = await readJsonCapped(request, RESOLVE_RECIPES_MAX_BYTES);
    if (!read.ok) {
      return read.status === 413
        ? NextResponse.json({ error: "The request is too big." }, { status: 413 })
        : NextResponse.json({ error: "The request could not be read." }, { status: 400 });
    }
    const checked = checkRecipeRefs(read.value);
    if ("refusal" in checked) {
      return checked.refusal === "too-many"
        ? NextResponse.json(
            { error: `Too many recipes in one request. The limit is ${RESOLVE_RECIPES_MAX_REFS}.` },
            { status: 400 },
          )
        : NextResponse.json({ error: "A recipe reference is not valid." }, { status: 400 });
    }
    return NextResponse.json(
      {
        matches: await meteredDatasetWork(request, () =>
          resolveDatasetRecipeRefs(versionId, checked.refs as DatasetRecipeRef[]),
        ),
      },
      {
        headers: datasetCacheHeaders(),
      },
    );
  } catch (error) {
    return datasetErrorResponse(error, "Recipe resolution failed.");
  }
}

function datasetCacheHeaders() {
  return {
    "Cache-Control": "no-store",
  };
}
