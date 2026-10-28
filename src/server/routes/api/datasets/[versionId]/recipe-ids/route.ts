import { datasetErrorResponse } from "@/lib/server/http/error-response";
import { datasetCacheHeaders } from "@/lib/server/http/dataset-cache-headers";
import { getDatasetRecipeIds } from "@/lib/server/dataset-query";
import {
  datasetBudgetRefusal,
  HEAVY_REQUEST_COST,
  meteredDatasetWork,
} from "@/lib/server/limits/dataset-rate";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ versionId: string }> },
) {
  try {
    const { versionId } = await params;
    // About 15 MB of JSON per answer.
    const refusal = datasetBudgetRefusal(request, HEAVY_REQUEST_COST);
    if (refusal) {
      return refusal;
    }
    return Response.json(
      {
        recipeIds: await meteredDatasetWork(request, () => getDatasetRecipeIds(versionId)),
      },
      {
        headers: datasetCacheHeaders(request),
      },
    );
  } catch (error) {
    return datasetErrorResponse(error, "Recipe id list failed.");
  }
}
