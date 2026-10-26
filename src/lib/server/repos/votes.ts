import { DbQueryError, getCommunityDb, type Tx } from "../db";

/**
 * Votes on posts (`community_votes`) and on blueprints (`blueprint_votes`),
 * one module for both: a target names its vote table, the column that holds
 * the voted row's id, and the parent table whose counters the recount
 * writes. The map is closed, so no table or column name comes from a
 * request. Whether a vote may land is the services' rule
 * (`services/votes.ts`); these only read and write rows. Repositories take
 * an optional transaction last; until the direct client lands there is none
 * and `tx` is unused.
 */

export type VoteTarget = "plan" | "blueprint";

const TABLES = {
  plan: { votes: "community_votes", key: "plan_id", parent: "community_plans" },
  blueprint: { votes: "blueprint_votes", key: "blueprint_id", parent: "blueprints" },
} as const satisfies Record<VoteTarget, { votes: string; key: string; parent: string }>;

/** The voter's vote on one row; none when there is none or the read fails, so a failed read never refuses a vote. */
export async function read(
  target: VoteTarget,
  id: string,
  voterKey: string,
  _tx?: Tx,
): Promise<1 | -1 | undefined> {
  const { votes, key } = TABLES[target];
  const { data } = await getCommunityDb()
    .from(votes)
    .select("value")
    .eq(key, id)
    .eq("voter_key", voterKey)
    .maybeSingle<{ value: 1 | -1 }>();
  return data?.value;
}

/** Casts or switches the voter's vote. */
export async function upsert(
  target: VoteTarget,
  id: string,
  voterKey: string,
  value: 1 | -1,
  _tx?: Tx,
): Promise<void> {
  const { votes, key } = TABLES[target];
  const { error } = await getCommunityDb()
    .from(votes)
    .upsert({ [key]: id, voter_key: voterKey, value });
  if (error) {
    throw new DbQueryError(error);
  }
}

/** Retracts the voter's vote. A failed delete is not reported: the recount after it answers what stands. */
export async function remove(target: VoteTarget, id: string, voterKey: string, _tx?: Tx): Promise<void> {
  const { votes, key } = TABLES[target];
  await getCommunityDb().from(votes).delete().eq(key, id).eq("voter_key", voterKey);
}

/**
 * Counts the row's up and down votes and writes them to its counters.
 * Recounted, never incremented: idempotent under races and self-healing.
 * A count that fails reads as none.
 */
export async function recount(
  target: VoteTarget,
  id: string,
  _tx?: Tx,
): Promise<{ upvotes: number; downvotes: number }> {
  const { votes, key, parent } = TABLES[target];
  const db = getCommunityDb();
  const [{ count: up }, { count: down }] = await Promise.all([
    db.from(votes).select(key, { count: "exact", head: true }).eq(key, id).eq("value", 1),
    db.from(votes).select(key, { count: "exact", head: true }).eq(key, id).eq("value", -1),
  ]);
  const counts = { upvotes: up ?? 0, downvotes: down ?? 0 };
  const { error } = await db.from(parent).update(counts).eq("id", id);
  if (error) {
    throw new DbQueryError(error);
  }
  return counts;
}

/**
 * The voter's votes by row id: on the rows `ids` names, or on every row of
 * the target when `ids` is left out.
 */
export async function byVoter(
  target: VoteTarget,
  voterKey: string,
  ids?: readonly string[],
  _tx?: Tx,
): Promise<Map<string, 1 | -1>> {
  const { votes, key } = TABLES[target];
  let builder = getCommunityDb().from(votes).select(`${key},value`).eq("voter_key", voterKey);
  if (ids) {
    builder = builder.in(key, [...ids]);
  }
  const { data, error } = await builder.returns<Array<Record<string, unknown>>>();
  if (error) {
    throw new DbQueryError(error);
  }
  return new Map((data ?? []).map((vote) => [vote[key] as string, vote.value as 1 | -1]));
}
