import { datasetBudgetRefusal } from "@/lib/server/limits/dataset-rate";
import { getResourcePopularity } from "@/lib/server/services/resource-popularity";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The community popularity map, for the browser's item search: the "Most
 * popular" sort orders by it, and the worker must order by the same map the
 * server's `/resources` route uses. `?count=1` answers only how many entries
 * it has: the item list offers that sort only when the map is not empty, and a
 * phone should not download the map to learn that. The same cache policy as
 * the route's popular answers: half an hour once a sweep has landed, never
 * stored while the map is still empty.
 */
export async function GET(request: Request) {
  const refusal = datasetBudgetRefusal(request, 1);
  if (refusal) {
    return refusal;
  }
  const popularity = getResourcePopularity();
  const countOnly = new URL(request.url).searchParams.get("count") === "1";
  return Response.json(
    countOnly ? { count: popularity.size } : { entries: [...popularity.entries()] },
    { headers: { "Cache-Control": popularity.size ? "public, max-age=1800" : "no-store" } },
  );
}
