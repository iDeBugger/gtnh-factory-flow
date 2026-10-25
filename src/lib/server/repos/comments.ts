import { communityStorageErrorMessage, getCommunityDb, type Tx } from "../db";

/**
 * Comments on community posts (`community_comments`). Deleting sets
 * `deleted_at`, so a thread keeps its shape; a deleted comment is never
 * read back. Who may read, post or delete is the services' rule.
 */

export interface CommentRow {
  id: string;
  plan_id: string;
  user_id: string;
  author_name: string;
  body: string;
  created_at: string;
}

const COMMENT_COLUMNS = "id,plan_id,user_id,author_name,body,created_at";

/**
 * A post's live comments, oldest first (the way a thread reads), up to
 * `limit`. Throws when the read fails, with the sentence the player reads
 * as its message.
 */
export async function list(planId: string, limit: number, _tx?: Tx): Promise<CommentRow[]> {
  const { data, error } = await getCommunityDb()
    .from("community_comments")
    .select(COMMENT_COLUMNS)
    .eq("plan_id", planId)
    .is("deleted_at", null)
    .order("created_at", { ascending: true })
    .limit(limit)
    .returns<CommentRow[]>();
  if (error) {
    throw new Error(communityStorageErrorMessage(error, "Comments could not be loaded."), {
      cause: error,
    });
  }
  return data ?? [];
}

/** Stores a comment and answers its row. Throws when the insert fails, with the sentence the player reads. */
export async function insert(
  comment: { plan_id: string; user_id: string; author_name: string; body: string },
  _tx?: Tx,
): Promise<CommentRow> {
  const { data, error } = await getCommunityDb()
    .from("community_comments")
    .insert(comment)
    .select(COMMENT_COLUMNS)
    .single<CommentRow>();
  if (error || !data) {
    throw new Error(communityStorageErrorMessage(error, "The comment could not be posted."), {
      cause: error,
    });
  }
  return data;
}

/**
 * Who wrote a live comment on the post and who owns the post, or undefined
 * when either is missing. A failed read answers undefined too, as a missing
 * comment.
 */
export async function readAccess(
  planId: string,
  commentId: string,
  _tx?: Tx,
): Promise<{ authorId: string; planOwnerId: string | null } | undefined> {
  const db = getCommunityDb();
  const [{ data: comment }, { data: plan }] = await Promise.all([
    db
      .from("community_comments")
      .select("id,user_id")
      .eq("id", commentId)
      .eq("plan_id", planId)
      .is("deleted_at", null)
      .maybeSingle<{ id: string; user_id: string }>(),
    db
      .from("community_plans")
      .select("user_id")
      .eq("id", planId)
      .maybeSingle<{ user_id: string | null }>(),
  ]);
  if (!comment || !plan) {
    return undefined;
  }
  return { authorId: comment.user_id, planOwnerId: plan.user_id };
}

/** Marks a comment deleted. Throws when the update fails, with the sentence the player reads. */
export async function softDelete(_planId: string, commentId: string, _tx?: Tx): Promise<boolean> {
  const { error } = await getCommunityDb()
    .from("community_comments")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", commentId);
  if (error) {
    throw new Error(communityStorageErrorMessage(error, "The comment could not be deleted."), {
      cause: error,
    });
  }
  return true;
}

/**
 * Restamps a post's comment figures after a comment lands or goes: the live
 * count, the latest comment's time, and the post's last activity (the later
 * of its last edit and that comment).
 */
export async function recount(planId: string, _tx?: Tx): Promise<void> {
  const db = getCommunityDb();
  const { data: rows } = await db
    .from("community_comments")
    .select("created_at")
    .eq("plan_id", planId)
    .is("deleted_at", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .returns<Array<{ created_at: string }>>();
  const { count } = await db
    .from("community_comments")
    .select("id", { count: "exact", head: true })
    .eq("plan_id", planId)
    .is("deleted_at", null);
  const { data: plan } = await db
    .from("community_plans")
    .select("created_at,updated_at")
    .eq("id", planId)
    .single<{ created_at: string; updated_at: string | null }>();
  const lastCommentAt = rows?.[0]?.created_at ?? null;
  const edited = plan?.updated_at ?? plan?.created_at ?? null;
  const lastActivityAt =
    lastCommentAt && edited ? (lastCommentAt > edited ? lastCommentAt : edited) : (lastCommentAt ?? edited);
  await db
    .from("community_plans")
    .update({
      comment_count: count ?? 0,
      last_comment_at: lastCommentAt,
      last_activity_at: lastActivityAt,
    })
    .eq("id", planId);
}
