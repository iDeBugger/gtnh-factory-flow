import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * The SQL that sets a database up, applied the same way everywhere this code
 * builds one (the deploy's migrate image, tests, the local database, the
 * row-type generator), from the repository's `db/` folder:
 *
 * - `db/migrations/NNNN-name.sql`, each applied once, in name order, in its
 *   own transaction, and recorded with its sha256 in `schema_migrations`.
 *   An applied file is never edited: a change is a new file, and a changed
 *   one is refused by name.
 * - `db/grants.sql`, what the app roles may touch, applied again on every
 *   run by `ensureRoles`, so a new table gets its grants and a grant removed
 *   from the file is gone after the next run.
 *
 * Every database starts empty: a `public` schema that holds tables but no
 * ledger was built some other way, and the runner refuses it rather than
 * guess what it already has.
 */

/** Runs SQL on one session: a script of several statements without params, or one statement with them. */
export type RunSql = (sqlText: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;

/** What `sqlRunner` adapts: PGlite (`exec` for scripts) or a `pg` client (`query` for both). */
export interface SqlSession {
  query(sqlText: string, params?: unknown[]): Promise<unknown>;
  exec?(sqlText: string): Promise<unknown>;
}

/**
 * A `RunSql` over one session. It must be one connection, never a pool: the
 * advisory lock and each file's transaction belong to the session.
 */
export function sqlRunner(session: SqlSession): RunSql {
  return async (sqlText, params) => {
    const result =
      params === undefined && session.exec
        ? await session.exec(sqlText)
        : await session.query(sqlText, params);
    // A script answers one result per statement; the last is the one read.
    const last = Array.isArray(result) ? result.at(-1) : result;
    const rows = (last as { rows?: unknown[] } | undefined)?.rows;
    return { rows: Array.isArray(rows) ? rows : [] };
  };
}

/** The repository's `db/` folder, from the root the process runs in. */
export function dbDir(root: string = process.cwd()): string {
  return path.join(root, "db");
}

/** A migration's file name: four digits, then lowercase words joined by hyphens. */
export const MIGRATION_NAME = /^\d{4}-[a-z0-9-]+\.sql$/;

const LEDGER = "schema_migrations";
/** Held for the whole run, so two deploys never migrate one database at once. */
const LOCK_KEY = 7361;
const APP_ROLES = ["gtnh_site", "gtnh_live"] as const;

export class MigrationError extends Error {
  override name = "MigrationError";
}

/** The migration files in order, each name checked. */
export function migrationFiles(dir: string): string[] {
  const names = readdirSync(path.join(dir, "migrations"))
    .filter((file) => file.endsWith(".sql"))
    .sort();
  for (const name of names) {
    if (!MIGRATION_NAME.test(name)) {
      throw new MigrationError(`${name}: a migration is named NNNN-words.sql (lowercase, hyphens)`);
    }
  }
  return names;
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

async function withLock<T>(run: RunSql, work: () => Promise<T>): Promise<T> {
  await run("select pg_advisory_lock($1)", [LOCK_KEY]);
  try {
    return await work();
  } finally {
    await run("select pg_advisory_unlock($1)", [LOCK_KEY]);
  }
}

/** Refuses a database the runner must not touch; creates the ledger on an empty one. */
async function openLedger(run: RunSql): Promise<void> {
  // Supabase's API serves every table to its public key through these roles,
  // and only row security keeps it out; this schema has none.
  const { rows: apiRoles } = await run(
    "select rolname from pg_roles where rolname in ('anon', 'authenticated')",
    [],
  );
  if (apiRoles.length > 0) {
    throw new MigrationError(
      "this database has Supabase's anon or authenticated role, whose API would read tables without row security: not migrated",
    );
  }
  const { rows: ledger } = await run(
    `select to_regclass('public.${LEDGER}') is not null as found`,
    [],
  );
  if ((ledger[0] as { found?: boolean } | undefined)?.found) {
    return;
  }
  const { rows: existing } = await run(
    "select count(*)::int as n from pg_class where relnamespace = 'public'::regnamespace",
    [],
  );
  if (((existing[0] as { n?: number } | undefined)?.n ?? 0) > 0) {
    throw new MigrationError("this database was not set up by the migration runner");
  }
  await run(
    `create table public.${LEDGER} (
      name text primary key,
      sha256 text not null,
      applied_at timestamptz not null default now()
    )`,
  );
}

/**
 * Applies every migration in `dir/migrations` the ledger does not hold, each
 * in its own transaction with its ledger row, and returns their names. A file
 * that fails rolls back alone and is named in the error; the files before it
 * stay applied.
 */
export async function applyMigrations(
  run: RunSql,
  dir: string,
  options: { onApplied?: (name: string) => void } = {},
): Promise<string[]> {
  const names = migrationFiles(dir);
  return withLock(run, async () => {
    await openLedger(run);
    const { rows } = await run(`select name, sha256 from public.${LEDGER}`, []);
    const applied = new Map(
      (rows as { name: string; sha256: string }[]).map((row) => [row.name, row.sha256]),
    );
    for (const name of applied.keys()) {
      if (!names.includes(name)) {
        throw new MigrationError(`${name}: applied to this database, but no such file`);
      }
    }
    const done: string[] = [];
    for (const name of names) {
      const text = readFileSync(path.join(dir, "migrations", name), "utf8");
      const digest = sha256(text);
      const recorded = applied.get(name);
      if (recorded !== undefined) {
        if (recorded !== digest) {
          throw new MigrationError(
            `${name}: changed since it was applied; put the change in a new migration`,
          );
        }
        continue;
      }
      await run("begin");
      try {
        await run(text);
        await run(`insert into public.${LEDGER} (name, sha256) values ($1, $2)`, [name, digest]);
        await run("commit");
      } catch (error) {
        await run("rollback").catch(() => undefined);
        throw new MigrationError(`${name}: ${(error as Error).message}`, { cause: error });
      }
      done.push(name);
      options.onApplied?.(name);
    }
    return done;
  });
}

/**
 * The site's and the live service's logins, `gtnh_site` and `gtnh_live`,
 * then `dir/grants.sql`, all in one transaction, so nothing sees a role
 * without its rights in between. A password gives the role `login` with it;
 * none leaves it `nologin` (tests enter it with `set role`).
 *
 * A password reaches the server only as a bound parameter, and nothing that
 * holds it is logged: a failing statement is logged with its text by default
 * (log_min_error_statement = error), so for this transaction no statement,
 * duration or parameter is logged, and a failed `alter role` is raised again
 * without the statement it ran.
 */
export async function ensureRoles(
  run: RunSql,
  passwords: { site?: string; live?: string },
  dir: string,
): Promise<void> {
  const grants = readFileSync(path.join(dir, "grants.sql"), "utf8");
  const password: Record<(typeof APP_ROLES)[number], string | undefined> = {
    gtnh_site: passwords.site,
    gtnh_live: passwords.live,
  };
  await withLock(run, async () => {
    await run("begin");
    try {
      await run(`
        set local log_min_error_statement = panic;
        set local log_statement = 'none';
        set local log_min_duration_statement = -1;
        set local log_parameter_max_length_on_error = 0;
      `);
      for (const role of APP_ROLES) {
        await run(`
          do $$
          begin
            if not exists (select 1 from pg_roles where rolname = '${role}') then
              create role ${role} nologin;
            end if;
          end
          $$;
          alter role ${role} nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
        `);
        const secret = password[role];
        if (!secret) {
          await run(`alter role ${role} nologin`);
          continue;
        }
        await run("select set_config('gtnh.role_password', $1, true)", [secret]);
        await run(`
          do $$
          begin
            execute format('alter role ${role} login password %L', current_setting('gtnh.role_password'));
          exception when others then
            raise exception 'could not set the password of ${role}' using errcode = sqlstate;
          end
          $$;
          select set_config('gtnh.role_password', '', true);
        `);
      }
      await run(grants);
      await run("commit");
    } catch (error) {
      await run("rollback").catch(() => undefined);
      throw error;
    }
  });
}
