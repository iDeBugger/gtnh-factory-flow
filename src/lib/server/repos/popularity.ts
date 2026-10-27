import { getDb, type Tx } from "../db";
import { sqlRules } from "./visibility";

/**
 * The popularity sweep's read of the public posts (`community_plans`): the
 * plan jsonb and the boundary outputs, page by page. Scoring them is
 * `services/resource-popularity.ts`'s job.
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
  tx?: Tx,
): Promise<PopularityPlanRow[]> {
  return (tx ?? getDb())
    .selectFrom("community_plans")
    .select(["plan", "outputs"])
    .where(sqlRules.publicPlans())
    .orderBy("id", "asc")
    .limit(limit)
    .offset(offset)
    .execute();
}
