import { COMMUNITY_COMMENT_MAX_LENGTH, type CommunityComment } from "@/lib/community/types";
import { withTransaction } from "../db";
import type { Viewer } from "../http/viewer";
import { checkRateLimit } from "../limits/rate-limit";
import { invalidatePlanListCache } from "../plan-list-cache";
import * as comments from "../repos/comments";
import * as plans from "../repos/plans";
import { canSeePlan, isUuid, ownsPlan } from "./access";
import { fail, ok, type ServiceResult } from "./result";

/**
 * Comment threads on community posts. A thread is readable by whoever may
 * see the post (`canSeePlan`); commenting needs an account. Deleting leaves a
 * tombstone, so the thread keeps its shape server-side. A post or comment
 * id that is no uuid is a missing one, answered before any query.
 */

/** The most comments one thread answers with. */
const COMMENT_LIMIT = 300;

const PLAN_NOT_FOUND = "Plan not found.";

function rowToComment(
  row: comments.CommentRow,
  viewer: Viewer,
  planOwnerId: string | null,
): CommunityComment {
  const signedIn = viewer.userId !== undefined;
  const isMine = signedIn && row.user_id === viewer.userId;
  return {
    id: row.id,
    planId: row.plan_id,
    authorName: row.author_name,
    body: row.body,
    createdAt: row.created_at,
    isMine,
    canDelete: signedIn && (isMine || viewer.isAdmin || viewer.userId === planOwnerId),
  };
}

/**
 * A post's thread, newest last, the way a thread reads. Deleted comments are
 * simply not there. The thread follows the post: whoever `canSeePlan` admits
 * reads it. A failed read throws: an error, never a missing post.
 */
export async function listComments(
  viewer: Viewer,
  planId: string,
): Promise<ServiceResult<{ comments: CommunityComment[] }>> {
  if (!isUuid(planId)) {
    return fail("not-found", PLAN_NOT_FOUND);
  }
  const plan = await plans.readAccess(planId);
  if (!plan || !canSeePlan(viewer, plan)) {
    return fail("not-found", PLAN_NOT_FOUND);
  }
  const rows = await comments.list(planId, COMMENT_LIMIT);
  return ok({ comments: rows.map((row) => rowToComment(row, viewer, plan.user_id)) });
}

/**
 * Whether the viewer may comment on the post: signed in, within the
 * account's pace, and the post public or the viewer's own. Answers the
 * post's owner for the comment that follows. A failed read of the post throws.
 */
export async function commentAccess(
  viewer: Viewer,
  planId: string,
): Promise<ServiceResult<{ planOwnerId: string | null }>> {
  if (!viewer.userId) {
    return fail("unauthorized", "Sign in to comment.");
  }
  // Before the rate limit: a malformed id sends no query at all.
  if (!isUuid(planId)) {
    return fail("not-found", PLAN_NOT_FOUND);
  }
  if (!(await checkRateLimit(`user:${viewer.userId}`, "comment", 40, 60 * 60))) {
    return fail("rate-limited", "Commenting too fast. Try again later.");
  }
  // A failed read throws, as in `listComments`: an error, never a missing post.
  const plan = await plans.readAccess(planId);
  if (!plan || (plan.is_public === false && !ownsPlan(viewer, plan))) {
    return fail("not-found", PLAN_NOT_FOUND);
  }
  return ok({ planOwnerId: plan.user_id });
}

/**
 * Posts a comment on a post `commentAccess` let through, and restamps the
 * post's comment figures in the same transaction: a comment and its count
 * land together or not at all. A failed write throws.
 */
export async function addComment(
  viewer: Viewer,
  planId: string,
  planOwnerId: string | null,
  body: unknown,
): Promise<ServiceResult<{ comment: CommunityComment }>> {
  const { userId, username } = viewer;
  if (!userId || username === undefined) {
    return fail("unauthorized", "Sign in to comment.");
  }
  const sent = ((body ?? {}) as { body?: unknown }).body;
  const text = typeof sent === "string" ? sent.trim() : "";
  if (!text || text.length > COMMUNITY_COMMENT_MAX_LENGTH) {
    return fail("bad-request", `A comment runs 1 to ${COMMUNITY_COMMENT_MAX_LENGTH} characters.`);
  }
  const row = await withTransaction(async (tx) => {
    // A post taken down since `commentAccess` read it is as missing as one
    // that never was.
    if (!(await plans.lockPost(planId, tx))) {
      return undefined;
    }
    const written = await comments.insert(
      { plan_id: planId, user_id: userId, author_name: username, body: text },
      tx,
    );
    await comments.recount(planId, tx);
    return written;
  });
  if (!row) {
    return fail("not-found", PLAN_NOT_FOUND);
  }
  invalidatePlanListCache();
  return ok({ comment: rowToComment(row, viewer, planOwnerId) });
}

/**
 * Takes a comment down: its author, the post's owner or an admin account
 * may. The mark and the post's recount are one transaction. A failed read
 * or write throws: an error, never a missing comment.
 */
export async function deleteComment(
  viewer: Viewer,
  planId: string,
  commentId: string,
): Promise<ServiceResult<{ ok: true }>> {
  if (!viewer.userId) {
    return fail("unauthorized", "Sign in to manage comments.");
  }
  const access =
    isUuid(planId) && isUuid(commentId) ? await comments.readAccess(planId, commentId) : undefined;
  if (!access) {
    return fail("not-found", "Comment not found.");
  }
  const allowed =
    access.authorId === viewer.userId || access.planOwnerId === viewer.userId || viewer.isAdmin;
  if (!allowed) {
    return fail("forbidden", "Not your comment.");
  }
  await withTransaction(async (tx) => {
    await plans.lockPost(planId, tx);
    // A comment already marked by a request just before this one is as gone
    // as this one would make it: the answer is the same.
    if (await comments.softDelete(planId, commentId, tx)) {
      await comments.recount(planId, tx);
    }
  });
  invalidatePlanListCache();
  return ok({ ok: true });
}
