import { getCommunityDb, type Tx } from "../db";

/** The event log behind the rate limits: one row per counted action. */

/** How many times the actor did the action since `since`. Throws when the database does not answer. */
export async function countSince(
  actorKey: string,
  action: string,
  since: Date,
  _tx?: Tx,
): Promise<number> {
  const { count, error } = await getCommunityDb()
    .from("community_events")
    .select("id", { count: "exact", head: true })
    .eq("actor_key", actorKey)
    .eq("action", action)
    .gte("created_at", since.toISOString());
  if (error) {
    throw new Error(`Rate limit check failed: ${error.message}`);
  }
  return count ?? 0;
}

/** Records actions, in one request. Throws when the database does not answer. */
export async function insert(
  rows: Array<{ actorKey: string; action: string }>,
  _tx?: Tx,
): Promise<void> {
  const { error } = await getCommunityDb()
    .from("community_events")
    .insert(rows.map((row) => ({ actor_key: row.actorKey, action: row.action })));
  if (error) {
    throw new Error(`Rate limit record failed: ${error.message}`);
  }
}

/** The ids of the oldest events before `before`, oldest first (the `created_at` index); none when the read fails. */
export async function oldestIdsBefore(before: Date, limit: number, _tx?: Tx): Promise<number[]> {
  const { data } = await getCommunityDb()
    .from("community_events")
    .select("id")
    .lt("created_at", before.toISOString())
    .order("created_at", { ascending: true })
    .limit(limit)
    .returns<Array<{ id: number }>>();
  return (data ?? []).map((row) => row.id);
}

/** Deletes events by id; answers how many went (0 when the delete fails). */
export async function deleteIds(ids: number[], _tx?: Tx): Promise<number> {
  const { count } = await getCommunityDb()
    .from("community_events")
    .delete({ count: "exact" })
    .in("id", ids);
  return count ?? 0;
}
