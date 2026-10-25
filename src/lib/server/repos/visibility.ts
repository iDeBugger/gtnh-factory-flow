/**
 * The access rules in the form a query applies them, so a list holds only
 * the rows `services/access.ts` would let the viewer see. Only the shapes
 * the PostgREST client can express live here until the direct client.
 */

/** Narrows a query of `community_plans` to the published posts: the public shelf. */
export function publicPlans<T extends { eq(column: "is_public", value: boolean): T }>(query: T): T {
  return query.eq("is_public", true);
}
