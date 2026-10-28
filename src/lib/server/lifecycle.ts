import { closeDb } from "@/lib/server/db";

/**
 * What a stopping site server releases once its last request has finished: the database pool, so Postgres sees
 * the connections end instead of finding them gone. Here in `src/lib/server`, so the server entry never imports
 * the database layer itself.
 */
export async function closeServerResources(): Promise<void> {
  await closeDb();
}
