import { isCommunityConfigured, isDatabaseConfigured as isDirectDbConfigured } from "../db";

/**
 * Whether this server has a database. Routes ask here, never `db/`
 * directly, and answer their own sentence when it has none. Both clients
 * must be set while repositories move across: PostgREST (`POSTGREST_URL`
 * or the local database) and the direct one (`DATABASE_URL`).
 */
export function isDatabaseConfigured(): boolean {
  return isCommunityConfigured() && isDirectDbConfigured();
}
