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

/** Narrows a query of `blueprints` to the published ones: the public shelf. */
export function publicBlueprints<T extends EqFilter>(query: T): T {
  return query.eq("is_public", true) as T;
}

/**
 * `canReadBlueprint` as a PostgREST `or()` filter: the viewer's own
 * blueprints, and the public ones while the community switch is on. Someone
 * else's published blueprint is the community library's, so with the switch
 * off only the viewer's own are found. Undefined when the viewer may read
 * none. The user id is the session's, never request text.
 */
export function blueprintReadableBy(
  viewer: { userId?: string },
  communityOn: boolean,
): string | undefined {
  const readable = [
    communityOn ? "is_public.eq.true" : undefined,
    viewer.userId ? `user_id.eq.${viewer.userId}` : undefined,
  ].filter(Boolean);
  return readable.length > 0 ? readable.join(",") : undefined;
}
