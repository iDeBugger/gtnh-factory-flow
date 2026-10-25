import { NextResponse } from "next/server";
import { datasetErrorResponse } from "@/lib/server/error-response";
import { datasetCacheHeaders } from "@/lib/server/dataset-cache-headers";
import { queryDatasetResources } from "@/lib/server/dataset-query";
import {
  datasetBudgetRefusal,
  meteredDatasetWork,
  searchRequestCost,
} from "@/lib/server/dataset-rate";
import { getResourcePopularity } from "@/lib/server/resource-popularity";
import { normalizeResourceSearchRequest } from "@/lib/search/resource-search";
import { parseSearchQuery } from "@/lib/search/text-search";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ versionId: string }> },
) {
  try {
    const { versionId } = await params;
    const url = new URL(request.url);
    const query = url.searchParams.get("query") ?? "";
    const refusal = datasetBudgetRefusal(request, searchRequestCost(parseSearchQuery(query).terms));
    if (refusal) {
      return refusal;
    }
    const searchRequest = normalizeResourceSearchRequest({
      query,
      offset: url.searchParams.get("offset"),
      limit: url.searchParams.get("limit"),
      kind: url.searchParams.get("kind"),
      mod: url.searchParams.get("mod"),
      sort: url.searchParams.get("sort"),
      source: url.searchParams.get("source"),
    });
    const sortParam = url.searchParams.get("sort");
    // Never awaits the database: the last good ranking, or none yet.
    const popularity = sortParam === "popular" ? getResourcePopularity() : undefined;
    const result = await meteredDatasetWork(request, () =>
      queryDatasetResources(versionId, { ...searchRequest, popularity }),
    );
    return NextResponse.json(result, {
      // Popularity is community data, not dataset bytes: the datasetHash
      // fingerprint doesn't pin it, so it must not ride the immutable policy.
      // Before the first sweep lands the order is plain best match, which
      // must not stick in a browser for half an hour.
      headers:
        sortParam === "popular"
          ? { "Cache-Control": popularity?.size ? "public, max-age=1800" : "no-store" }
          : datasetCacheHeaders(request),
    });
  } catch (error) {
    return datasetErrorResponse(error, "Resource query failed.");
  }
}
