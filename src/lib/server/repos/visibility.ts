import type { Expression, ExpressionBuilder, SqlBool } from "kysely";
import type { Database } from "../db/schema";

/**
 * The access rules in the form a query applies them, so a list, a read by
 * id or a counter holds only the rows `services/access.ts` would let the
 * viewer see, as Kysely expressions over one table:
 * `.where(sqlRules.planVisibleTo(viewer))`. Every value is a bound parameter
 * from the session or the caller's own arguments, never request text;
 * `visibility.test.ts` holds each to `services/access.ts`'s answer.
 */

/** Who is asking, as `http/viewer.ts` builds it (repositories take its shape, not the module). */
export interface VisibilityViewer {
  userId?: string;
  isAdmin: boolean;
  adminToken: boolean;
}

type Rule<T extends keyof Database> = (eb: ExpressionBuilder<Database, T>) => Expression<SqlBool>;

export const sqlRules = {
  /** The published posts: the public shelf. */
  publicPlans: (): Rule<"community_plans"> => (eb) => eb("community_plans.is_public", "=", true),

  /**
   * `canSeePlan`: a published post is everyone's; an unpublished one is its
   * owner's and the admin's (the account's flag or the admin header). A post
   * whose account is gone is nobody's to own.
   */
  planVisibleTo:
    (viewer: VisibilityViewer): Rule<"community_plans"> =>
    (eb) => {
      if (viewer.isAdmin || viewer.adminToken) {
        return eb.lit(true);
      }
      // `canSeePlan` reads a null as published; the column is not null, so
      // `= true` is the same rule, and the `(is_public, created_at)` index serves it.
      const published = eb("community_plans.is_public", "=", true);
      return viewer.userId === undefined
        ? published
        : eb.or([published, eb("community_plans.user_id", "=", viewer.userId)]);
    },

  /** The designs `userId` was added to: a member row for this owner's design of this id. */
  memberOf:
    (userId: string): Rule<"library_designs"> =>
    (eb) =>
      eb.exists(
        eb
          .selectFrom("library_design_members")
          .select(eb.lit(1).as("one"))
          .whereRef("library_design_members.owner_id", "=", "library_designs.user_id")
          .whereRef("library_design_members.design_id", "=", "library_designs.id")
          .where("library_design_members.member_id", "=", userId),
      ),

  /** One design: its id is unique per owner only, so both name it. */
  designKey:
    (ownerId: string, designId: string): Rule<"library_designs"> =>
    (eb) =>
      eb.and([
        eb("library_designs.user_id", "=", ownerId),
        eb("library_designs.id", "=", designId),
      ]),

  /** Not deleted: a tombstone is never leased, flushed or shown to a member. */
  notTombstoned: (): Rule<"library_designs"> => (eb) =>
    eb("library_designs.deleted_at", "is", null),

  /** No live service holds the lease at `now` (never taken, or run out). */
  leaseFreeAt:
    (now: string): Rule<"library_designs"> =>
    (eb) =>
      eb.or([
        eb("library_designs.live_lease_until", "is", null),
        eb("library_designs.live_lease_until", "<", now),
      ]),

  /** The lease is `token`'s: the condition of every renewal, flush and release. */
  leaseHeldBy:
    (token: string): Rule<"library_designs"> =>
    (eb) =>
      eb("library_designs.live_lease_token", "=", token),
};
