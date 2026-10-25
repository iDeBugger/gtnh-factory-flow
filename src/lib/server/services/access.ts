import type { Viewer } from "../http/viewer";

/**
 * Who may see what, once per rule, as pure functions of the viewer and the
 * row. Every service asks here; a list that must apply a rule inside its
 * query uses the matching form in `repos/visibility.ts`.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Whether `value` can be a row id. A malformed id is a missing row, answered without a query. */
export function isUuid(value: string): boolean {
  return UUID.test(value);
}

/** Whether the signed-in viewer owns the post. Nobody owns a post whose account is gone. */
export function ownsPlan(viewer: Viewer, row: { user_id: string | null }): boolean {
  return viewer.userId !== undefined && row.user_id === viewer.userId;
}

/**
 * An unpublished post exists only for its owner and the site admin (the
 * account's flag or the admin header); everyone else gets the same answer
 * as for an id that was never there. `is_public` is not null in the schema;
 * a null reads as published, as the summary does.
 */
export function canSeePlan(
  viewer: Viewer,
  row: { is_public: boolean | null; user_id: string | null },
): boolean {
  return row.is_public !== false || ownsPlan(viewer, row) || viewer.isAdmin || viewer.adminToken;
}

/** A blueprint is its owner's, or anyone's to read once it is public and the community switch is on. */
export function canReadBlueprint(
  viewer: Viewer,
  row: { is_public: boolean; user_id: string },
  communityOn: boolean,
): boolean {
  return (viewer.userId !== undefined && row.user_id === viewer.userId) || (row.is_public && communityOn);
}
