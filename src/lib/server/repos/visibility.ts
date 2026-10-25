/**
 * The access rules in the form a query applies them, so a list holds only
 * the rows `services/access.ts` would let the viewer see. Only the shapes
 * the PostgREST client can express live here until the direct client.
 */

/** A PostgREST filter builder, which answers itself from `eq`. */
interface EqFilter {
  eq(column: string, value: unknown): unknown;
}

/** Narrows a query of `community_plans` to the published posts: the public shelf. */
export function publicPlans<T extends EqFilter>(query: T): T {
  // PostgREST's builders return themselves; the cast keeps the caller's type
  // without making the compiler expand the builder's generics.
  return query.eq("is_public", true) as T;
}
