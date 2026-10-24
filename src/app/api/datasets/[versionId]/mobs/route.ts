import { NextResponse } from "next/server";
import { datasetCacheHeaders } from "@/lib/server/dataset-cache-headers";
import { listDatasetEecMobs } from "@/lib/server/dataset-query";
import { datasetBudgetRefusal, meteredDatasetWork } from "@/lib/server/dataset-rate";

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
    const result = await meteredDatasetWork(request, () => listDatasetEecMobs(versionId));
    return NextResponse.json(result, {
      headers: datasetCacheHeaders(request),
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Mob query failed." },
      { status: 500 },
    );
  }
}
