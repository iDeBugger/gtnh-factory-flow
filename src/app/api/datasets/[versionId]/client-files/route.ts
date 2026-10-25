import { NextResponse } from "next/server";
import { datasetCacheHeaders } from "@/lib/server/dataset-cache-headers";
import { datasetErrorResponse } from "@/lib/server/error-response";
import { datasetClientFileListing } from "@/lib/server/dataset-client-files";
import { datasetBudgetRefusal } from "@/lib/server/dataset-rate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Where a version's static answers are (client-files.ts): the client reads
 * this first and fetches each listed file instead of its API route. A listing
 * still being written answers no-store, so a browser never keeps one that
 * lacks a file; a complete one is cached like any dataset answer, keyed by the
 * dataset hash and the answer version, which together fix every name.
 */
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
    const listing = await datasetClientFileListing(versionId);
    if (!listing) {
      return NextResponse.json(
        { error: "Dataset not found." },
        { status: 404, headers: { "Cache-Control": "no-store" } },
      );
    }
    return NextResponse.json(listing, {
      headers: listing.complete ? datasetCacheHeaders(request) : { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return datasetErrorResponse(error, "Dataset file listing failed.", {
      "Cache-Control": "no-store",
    });
  }
}
