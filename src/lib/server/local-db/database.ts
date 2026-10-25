import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { createPostgrestHandler, type PostgrestHandler, type SqlDatabase } from "./postgrest";

/**
 * The local development database: real Postgres in this process (PGlite),
 * loaded from `supabase/schema.sql` and every file in `supabase/migrations/`
 * on each open (both are idempotent, as they are for the hosted project),
 * answering the server's PostgREST client through the stand-in. Never imported by
 * Next.js: the dev server reaches it over HTTP (`tools/local-db/serve.ts`),
 * tests and the live service's tests open it in-process.
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

/** The SQL that sets a database up, in order: the schema, then each migration by name. */
export function schemaFiles(supabaseDir: string): string[] {
  const files = [path.join(supabaseDir, "schema.sql")];
  const migrations = path.join(supabaseDir, "migrations");
  try {
    for (const name of readdirSync(migrations)
      .filter((file) => file.endsWith(".sql"))
      .sort()) {
      files.push(path.join(migrations, name));
    }
  } catch {
    // No migrations folder: the schema alone.
  }
  return files;
}

export async function openLocalDatabase(
  options: OpenLocalDatabaseOptions = {},
): Promise<LocalDatabase> {
  if (options.dir) {
    mkdirSync(options.dir, { recursive: true });
  }
  const db = options.dir ? new PGlite(options.dir) : new PGlite();
  await db.exec("set time zone 'UTC'");
  for (const file of schemaFiles(options.supabaseDir ?? path.join(process.cwd(), "supabase"))) {
    await db.exec(readFileSync(file, "utf8"));
  }
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
