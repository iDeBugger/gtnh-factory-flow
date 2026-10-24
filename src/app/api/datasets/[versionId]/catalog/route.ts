import { NextResponse } from "next/server";
import { datasetCacheHeaders } from "@/lib/server/dataset-cache-headers";
import { getDatasetCatalog, prewarmDatasetVersion } from "@/lib/server/dataset-query";
import { datasetBudgetRefusal } from "@/lib/server/dataset-rate";

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
    void prewarmDatasetVersion(versionId).catch((error) => {
      console.error(`Dataset ${versionId} prewarm failed.`, error);
    });
    const catalog = await getDatasetCatalog(versionId);
    return NextResponse.json(catalog, {
      headers: datasetCacheHeaders(request),
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Dataset catalog failed." },
      { status: 500 },
    );
  }
}

