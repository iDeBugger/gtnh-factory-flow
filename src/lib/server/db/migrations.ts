import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * The SQL that sets a database up, applied the same way everywhere this code
 * builds one (tests, the local database, the row-type generator): the schema,
 * then each migration by name. Both are idempotent, as they are for a
 * deployed database, so the local database applies them on every open.
 */

/** Where the schema and its migrations live, from the repository root the process runs in. */
export function schemaDir(): string {
  return path.join(process.cwd(), "supabase");
}

/** Runs one script of several statements (PGlite's `exec`, or `pg`'s simple query). */
export interface MigrationTarget {
  exec(sqlText: string): Promise<unknown>;
}

/** The files in order: `schema.sql`, then `migrations/*.sql` sorted by name. */
export function schemaFiles(dir: string = schemaDir()): string[] {
  const files = [path.join(dir, "schema.sql")];
  const migrations = path.join(dir, "migrations");
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

export async function applyMigrations(
  target: MigrationTarget,
  dir: string = schemaDir(),
): Promise<void> {
  for (const file of schemaFiles(dir)) {
    await target.exec(readFileSync(file, "utf8"));
  }
}
