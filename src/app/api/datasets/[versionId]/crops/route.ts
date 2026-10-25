import { NextResponse } from "next/server";
import { datasetErrorResponse } from "@/lib/server/error-response";
import { datasetCacheHeaders } from "@/lib/server/dataset-cache-headers";
import { listDatasetCropFarmRecipes } from "@/lib/server/dataset-query";
import {
  datasetBudgetRefusal,
  HEAVY_REQUEST_COST,
  meteredDatasetWork,
} from "@/lib/server/dataset-rate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ versionId: string }> },
) {
  try {
    const { versionId } = await params;
    // About 8 MB of JSON per answer.
    const refusal = datasetBudgetRefusal(request, HEAVY_REQUEST_COST);
    if (refusal) {
      return refusal;
    }
    const result = await meteredDatasetWork(request, () => listDatasetCropFarmRecipes(versionId));
    return NextResponse.json(result, {
      headers: datasetCacheHeaders(request),
    });
  } catch (error) {
    return datasetErrorResponse(error, "Crop query failed.");
  }
}
