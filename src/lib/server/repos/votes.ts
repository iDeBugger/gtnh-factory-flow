import { getDb, type Tx } from "../db";

/**
 * Votes on posts (`community_votes`): a target names its vote table, the
 * column that holds the voted row's id, and the parent table whose counters
 * the recount writes. The map is closed, so no table or column name comes
 * from a request. Whether a vote may land is the services' rule
 * (`services/votes.ts`); these only read and write rows. Repositories take
 * an optional transaction last; a failure throws (a down database as
 * `DatabaseDownError`).
 */

export type VoteTarget = "plan";

const TABLES = {
  plan: { votes: "community_votes", key: "plan_id", parent: "community_plans" },
} as const satisfies Record<VoteTarget, { votes: string; key: string; parent: string }>;

/** The voter's vote on one row, or undefined when there is none. */
export async function read(
  target: VoteTarget,
  id: string,
  voterKey: string,
  tx?: Tx,
): Promise<1 | -1 | undefined> {
  const { votes, key } = TABLES[target];
  const row = await (tx ?? getDb())
    .selectFrom(votes)
    .select("value")
    .where(key, "=", id)
    .where("voter_key", "=", voterKey)
    .executeTakeFirst();
  return row ? (row.value as 1 | -1) : undefined;
}

/**
 * Locks the voted row (the post) until the transaction ends and
 * answers whether it is there. A vote takes it before writing its vote row,
 * so the casts on one row run one at a time and each recount sees every vote
 * committed before it; the post comes first, as a comment's does
 * (`plans.lockPost`), so the two never wait on each other in a circle.
 * `for no key update`: a vote row's foreign-key check never waits for it.
 */
export async function lockParent(target: VoteTarget, id: string, tx: Tx): Promise<boolean> {
  const { parent } = TABLES[target];
  const row = await tx.selectFrom(parent).select("id").where("id", "=", id).forNoKeyUpdate().executeTakeFirst();
  return row !== undefined;
}

/** Casts or switches the voter's vote. */
export async function upsert(
  target: VoteTarget,
  id: string,
  voterKey: string,
  value: 1 | -1,
  tx?: Tx,
): Promise<void> {
  const { votes, key } = TABLES[target];
  await (tx ?? getDb())
    .insertInto(votes)
    .values({ [key]: id, voter_key: voterKey, value })
    .onConflict((oc) => oc.columns([key, "voter_key"]).doUpdateSet({ value }))
    .execute();
}

/** Retracts the voter's vote. */
export async function remove(target: VoteTarget, id: string, voterKey: string, tx?: Tx): Promise<void> {
  const { votes, key } = TABLES[target];
  await (tx ?? getDb()).deleteFrom(votes).where(key, "=", id).where("voter_key", "=", voterKey).execute();
}

/**
 * Counts the row's up and down votes into its counters in one statement and
 * answers them. Recounted, never incremented: idempotent and self-healing.
 * Run it after `lockParent` in the vote's transaction, so it counts every
 * vote committed before it. Throws when the row is gone.
 */
export async function recount(
  target: VoteTarget,
  id: string,
  tx?: Tx,
): Promise<{ upvotes: number; downvotes: number }> {
  const { votes, key, parent } = TABLES[target];
  const db = tx ?? getDb();
  const counted = (value: 1 | -1) =>
    db
      .selectFrom(votes)
      .select((eb) => eb.fn.countAll<number>().as("n"))
      .where(key, "=", id)
      .where("value", "=", value);
  return db
    .updateTable(parent)
    .set({ upvotes: counted(1), downvotes: counted(-1) })
    .where("id", "=", id)
    .returning(["upvotes", "downvotes"])
    .executeTakeFirstOrThrow();
}

/**
 * The voter's votes by row id: on the rows `ids` names, or on every row of
 * the target when `ids` is left out.
 */
export async function byVoter(
  target: VoteTarget,
  voterKey: string,
  ids?: readonly string[],
  tx?: Tx,
): Promise<Map<string, 1 | -1>> {
  if (ids && ids.length === 0) {
    return new Map();
  }
  const { votes, key } = TABLES[target];
  let query = (tx ?? getDb())
    .selectFrom(votes)
    .select([`${key} as id`, "value"])
    .where("voter_key", "=", voterKey);
  if (ids) {
    query = query.where(key, "in", [...ids]);
  }
  const rows = await query.execute();
  return new Map(rows.map((vote) => [vote.id as string, vote.value as 1 | -1]));
}
