import { getCommunityDb, type Tx } from "../db";

/**
 * The popularity sweep's read of the public posts (`community_plans`): the
 * plan jsonb and the boundary outputs, page by page. Scoring them is
 * `resource-popularity.ts`'s job.
 */

export interface PopularityPlanRow {
  plan: unknown;
  outputs: unknown;
}

/**
 * One page of the public posts, ordered by id so the pages never overlap.
 * Callers keep pages small: a plan jsonb can run to megabytes, and a large
 * page hits Postgres's statement timeout. Throws when the database does not
 * answer.
 */
export async function publicPlanPage(
  offset: number,
  limit: number,
  _tx?: Tx,
): Promise<PopularityPlanRow[]> {
  // The null branch is dead (the column is not null) and goes with the direct client.
  const { data, error } = await getCommunityDb()
    .from("community_plans")
    .select("plan, outputs")
    .or("is_public.eq.true,is_public.is.null")
    .order("id", { ascending: true })
    .range(offset, offset + limit - 1);
  if (error) {
    throw new Error(error.message || "Reading the public posts failed.", { cause: error });
  }
  return (data ?? []) as PopularityPlanRow[];
}
