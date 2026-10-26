import { NextResponse } from "next/server";
import { datasetBudgetRefusal } from "@/lib/server/limits/dataset-rate";
import { getResourcePopularity } from "@/lib/server/services/resource-popularity";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The community popularity map, for the browser's item search: the "Most
 * popular" sort (the item column's default) orders by it, and the worker must
 * order by the same map the server's `/resources` route uses. The same cache
 * policy as that route's popular answers: half an hour once a sweep has
 * landed, never stored while the map is still empty.
 */
export async function GET(request: Request) {
  const refusal = datasetBudgetRefusal(request, 1);
  if (refusal) {
    return refusal;
  }
  const popularity = getResourcePopularity();
  return NextResponse.json(
    { entries: [...popularity.entries()] },
    { headers: { "Cache-Control": popularity.size ? "public, max-age=1800" : "no-store" } },
  );
}
