import { getDb, type Tx } from "../db";

/** The event log behind the rate limits: one row per counted action. */

/** How many times the actor did the action since `since`. Throws when the database does not answer. */
export async function countSince(
  actorKey: string,
  action: string,
  since: Date,
  tx?: Tx,
): Promise<number> {
  const row = await (tx ?? getDb())
    .selectFrom("community_events")
    .select((eb) => eb.fn.countAll<number>().as("count"))
    .where("actor_key", "=", actorKey)
    .where("action", "=", action)
    .where("created_at", ">=", since.toISOString())
    .executeTakeFirstOrThrow();
  return Number(row.count);
}

/** Records actions, in one statement. Throws when the database does not answer. */
export async function insert(
  rows: Array<{ actorKey: string; action: string }>,
  tx?: Tx,
): Promise<void> {
  if (rows.length === 0) {
    return;
  }
  await (tx ?? getDb())
    .insertInto("community_events")
    .values(rows.map((row) => ({ actor_key: row.actorKey, action: row.action })))
    .execute();
}

/** The ids of the oldest events before `before`, oldest first (the `created_at` index); none when the read fails. */
export async function oldestIdsBefore(before: Date, limit: number, tx?: Tx): Promise<number[]> {
  try {
    const rows = await (tx ?? getDb())
      .selectFrom("community_events")
      .select("id")
      .where("created_at", "<", before.toISOString())
      .orderBy("created_at", "asc")
      .limit(limit)
      .execute();
    return rows.map((row) => row.id);
  } catch {
    return [];
  }
}

/** Deletes events by id; answers how many went (0 when the delete fails). */
export async function deleteIds(ids: number[], tx?: Tx): Promise<number> {
  if (ids.length === 0) {
    return 0;
  }
  try {
    const result = await (tx ?? getDb())
      .deleteFrom("community_events")
      .where("id", "in", ids)
      .executeTakeFirst();
    return Number(result.numDeletedRows);
  } catch {
    return 0;
  }
}
