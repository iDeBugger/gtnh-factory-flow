import { datasetErrorResponse } from "@/lib/server/http/error-response";
import { datasetCacheHeaders } from "@/lib/server/http/dataset-cache-headers";
import { DatasetNotFoundError, getDatasetCatalog, prewarmDatasetVersion } from "@/lib/server/dataset-query";
import { datasetBudgetRefusal, meteredDatasetWork } from "@/lib/server/limits/dataset-rate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ versionId: string }> },
) {
  try {
    const { versionId } = await params;
    const refusal = datasetBudgetRefusal(request, 1);
    if (refusal) {
      return refusal;
    }
    // An unserved id is the request's own text and is not logged; any other failure is, with the id quoted and
    // clipped so it cannot write a line of its own.
    void prewarmDatasetVersion(versionId).catch((error) => {
      if (!(error instanceof DatasetNotFoundError)) {
        console.error(`Dataset ${JSON.stringify(versionId.slice(0, 80))} prewarm failed.`, error);
      }
    });
    const catalog = await meteredDatasetWork(request, () => getDatasetCatalog(versionId));
    return Response.json(catalog, {
      headers: datasetCacheHeaders(request),
    });
  } catch (error) {
    return datasetErrorResponse(error, "Dataset catalog failed.");
  }
}
