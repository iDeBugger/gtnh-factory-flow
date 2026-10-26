/**
 * The deploy's database setup (the migrate image's command), and the same by
 * hand: every migration in `<dir>/migrations` the database has not applied,
 * then the app roles and `<dir>/grants.sql`.
 *
 *   npm run db:migrate                      # this checkout's db/
 *   node dist-db/migrate.mjs <dir>          # npm run build:db; the image runs /deploy/db
 *
 * Connection: PGHOST, PGPORT, PGUSER, PGPASSWORD, PGDATABASE (default
 * `postgres`), read by `pg`. The app roles' passwords: GTNH_SITE_DB_PASSWORD
 * and GTNH_LIVE_DB_PASSWORD, from the environment, never a command line (a
 * container's argv shows in the host's process list to every local account).
 * Prints `migrate: <name>` per file it applies and `migrate: done`; on a
 * failure prints what failed, the file named, and exits 1.
 */
import path from "node:path";
import pg from "pg";
import { applyMigrations, ensureRoles, sqlRunner } from "../../src/lib/server/db/migrations";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not set`);
  }
  return value;
}

async function main(): Promise<void> {
  const dir = path.resolve(process.argv[2] ?? "db");
  const passwords = {
    site: required("GTNH_SITE_DB_PASSWORD"),
    live: required("GTNH_LIVE_DB_PASSWORD"),
  };
  const client = new pg.Client({
    database: process.env.PGDATABASE || "postgres",
    application_name: "gtnh-migrate",
  });
  // A rerun's notices are the runner working, not news.
  client.on("notice", () => undefined);
  await client.connect();
  try {
    const run = sqlRunner(client);
    await applyMigrations(run, dir, { onApplied: (name) => console.log(`migrate: ${name}`) });
    await ensureRoles(run, passwords, dir);
  } finally {
    await client.end();
  }
  console.log("migrate: done");
}

main().catch((error: unknown) => {
  console.error(`migrate: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
