import { mkdirSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { applyMigrations } from "../db/migrations";
import { DB_TYPE_PARSERS } from "../db/parsers";
import { createPostgrestHandler, type PostgrestHandler, type SqlDatabase } from "./postgrest";

/**
 * The local development database: real Postgres in this process (PGlite),
 * loaded from `supabase/schema.sql` and every file in `supabase/migrations/`
 * on each open (`applyMigrations`; both are idempotent, as they are for a
 * deployed database), answering the server's PostgREST client through the
 * stand-in and the direct client through Kysely's PGlite dialect or the
 * socket `tools/local-db/serve.ts` opens. Never imported by Next.js: the dev
 * server reaches it over HTTP and the socket, tests and the live service's
 * tests open it in-process.
 *
 * Its values parse as the pool's do (`DB_TYPE_PARSERS`), so a row reads the
 * same in tests as in production. The stand-in is unaffected: it reads rows
 * as Postgres's own JSON text.
 */

export interface LocalDatabase {
  db: PGlite;
  /** Answers PostgREST requests: `/rest/v1/...`. */
  handle: PostgrestHandler;
  close(): Promise<void>;
}

export interface OpenLocalDatabaseOptions {
  /** Where the data lives; absent, in memory (gone when the process ends). */
  dir?: string;
  /** The folder holding schema.sql and migrations/; default `<cwd>/supabase`. */
  supabaseDir?: string;
}

export async function openLocalDatabase(
  options: OpenLocalDatabaseOptions = {},
): Promise<LocalDatabase> {
  if (options.dir) {
    mkdirSync(options.dir, { recursive: true });
  }
  const db = new PGlite({ dataDir: options.dir, parsers: DB_TYPE_PARSERS });
  // The timestamp parser reads UTC only; one session serves every client.
  await db.exec("set time zone 'UTC'");
  await applyMigrations(db, options.supabaseDir);
  const sql: SqlDatabase = {
    query: (text, params) => db.query<Record<string, unknown>>(text, params),
    exec: (text) => db.exec(text),
  };
  const handle = createPostgrestHandler(sql);
  await handle.reloadSchema();
  return {
    db,
    handle,
    close: () => db.close(),
  };
}
