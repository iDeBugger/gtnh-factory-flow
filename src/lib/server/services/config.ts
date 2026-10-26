import { isDatabaseConfigured as isDbConfigured } from "../db";

/**
 * Whether this server has a database (`DATABASE_URL`). Routes ask here,
 * never `db/` directly, and answer their own sentence when it has none.
 */
export function isDatabaseConfigured(): boolean {
  return isDbConfigured();
}
