import { getDb, type Tx } from "../db";

/**
 * Comments on community posts (`community_comments`). Deleting sets
 * `deleted_at`, so a thread keeps its shape; a deleted comment is never
 * read back. Who may read, post or delete is the services' rule.
 * Repositories take an optional transaction last; a failure throws (a down
 * database as `DatabaseDownError`).
 */

export interface CommentRow {
  id: string;
  plan_id: string;
  user_id: string;
  author_name: string;
  body: string;
  created_at: string;
}

const COMMENT_COLUMNS = ["id", "plan_id", "user_id", "author_name", "body", "created_at"] as const;

/** A post's live comments, oldest first (the way a thread reads), up to `limit`. */
export async function list(planId: string, limit: number, tx?: Tx): Promise<CommentRow[]> {
  return (tx ?? getDb())
    .selectFrom("community_comments")
    .select(COMMENT_COLUMNS)
    .where("plan_id", "=", planId)
    .where("deleted_at", "is", null)
    .orderBy("created_at", "asc")
    .limit(limit)
    .execute();
}

/** Stores a comment and answers its row. */
export async function insert(
  comment: { plan_id: string; user_id: string; author_name: string; body: string },
  tx?: Tx,
): Promise<CommentRow> {
  return (tx ?? getDb())
    .insertInto("community_comments")
    .values(comment)
    .returning(COMMENT_COLUMNS)
    .executeTakeFirstOrThrow();
}

/**
 * Who wrote a live comment on the post and who owns the post, or undefined
 * when either is missing. A failed read throws: an error, never a missing
 * comment.
 */
export async function readAccess(
  planId: string,
  commentId: string,
  tx?: Tx,
): Promise<{ authorId: string; planOwnerId: string | null } | undefined> {
  return (tx ?? getDb())
    .selectFrom("community_comments")
    .innerJoin("community_plans", "community_plans.id", "community_comments.plan_id")
    .select([
      "community_comments.user_id as authorId",
      "community_plans.user_id as planOwnerId",
    ])
    .where("community_comments.id", "=", commentId)
    .where("community_comments.plan_id", "=", planId)
    .where("community_comments.deleted_at", "is", null)
    .executeTakeFirst();
}

/**
 * Marks a post's live comment deleted: only under that post, so an id paired
 * with another post's changes nothing. Answers whether a comment was marked.
 */
export async function softDelete(planId: string, commentId: string, tx?: Tx): Promise<boolean> {
  const result = await (tx ?? getDb())
    .updateTable("community_comments")
    .set({ deleted_at: new Date().toISOString() })
    .where("id", "=", commentId)
    .where("plan_id", "=", planId)
    .where("deleted_at", "is", null)
    .executeTakeFirst();
  return Number(result.numUpdatedRows) > 0;
}

/**
 * Restamps a post's comment figures in one statement after a comment lands
 * or goes: the live count, the latest comment's time, and the post's last
 * activity (the later of its last edit and that comment). Run it in the
 * comment's transaction, after `plans.lockPost`, so it counts every comment
 * committed before it.
 */
export async function recount(planId: string, tx?: Tx): Promise<void> {
  const db = tx ?? getDb();
  await db
    .updateTable("community_plans")
    .from(
      db
        .selectFrom("community_comments")
        .select((eb) => [eb.fn.countAll<number>().as("live"), eb.fn.max("created_at").as("latest")])
        .where("plan_id", "=", planId)
        .where("deleted_at", "is", null)
        .as("thread"),
    )
    .set((eb) => ({
      comment_count: eb.ref("thread.live"),
      last_comment_at: eb.ref("thread.latest"),
      // greatest() skips a null: no comment leaves the last edit.
      last_activity_at: eb.fn("greatest", [
        eb.fn.coalesce("community_plans.updated_at", "community_plans.created_at"),
        eb.ref("thread.latest"),
      ]),
    }))
    .where("community_plans.id", "=", planId)
    .execute();
}
