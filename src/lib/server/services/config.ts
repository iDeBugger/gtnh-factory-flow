import { isCommunityConfigured } from "../db";

/**
 * Whether this server has a database. Routes ask here, never `db/`
 * directly, and answer their own sentence when it has none.
 */
export function isDatabaseConfigured(): boolean {
  return isCommunityConfigured();
}
