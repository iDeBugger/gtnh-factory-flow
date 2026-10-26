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
 *   one is refused by name. The runner's transaction is the file's, so a
 *   file holds no transaction control (`begin`, `commit`, `rollback`,
 *   `savepoint`, ...) and nothing `concurrently`, which cannot run inside
 *   one: a file that commits itself would be applied with no ledger row if
 *   the run stopped before the row.
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
/** How long a run waits for another to finish before it gives up and says so. */
export const LOCK_WAIT_MS = 120_000;
const LOCK_POLL_MS = 500;
const APP_ROLES = ["gtnh_site", "gtnh_live"] as const;

export class MigrationError extends Error {
  override name = "MigrationError";
}

/**
 * The migration files in order. Every entry of `migrations/` is one, so a
 * misnamed file (`0002-x.SQL`, `0002_x.sql`) is refused, never skipped;
 * only hidden files (an editor's or the OS's, `.DS_Store`) are passed over.
 */
export function migrationFiles(dir: string): string[] {
  const names = readdirSync(path.join(dir, "migrations"))
    .filter((file) => !file.startsWith("."))
    .sort();
  for (const name of names) {
    if (!MIGRATION_NAME.test(name)) {
      throw new MigrationError(`${name}: a migration is named NNNN-words.sql (lowercase, hyphens)`);
    }
  }
  return names;
}

/**
 * The file's text as git stores it: a checkout that writes CRLF line ends
 * (core.autocrlf) hashes the same file as the image's copy does.
 */
function sha256(text: string): string {
  return createHash("sha256").update(text.replace(/\r\n/g, "\n")).digest("hex");
}

/** The statements that end or open a transaction, and `concurrently`, outside strings and comments. */
const TRANSACTION_CONTROL =
  /^(begin|commit|rollback|abort|end|start\s+transaction|savepoint|release|prepare\s+transaction)\b/i;

const IDENT_CHAR = /[A-Za-z0-9_$\u0080-\uffff]/;
const DOLLAR_TAG = /\$(?:[A-Za-z_\u0080-\uffff][A-Za-z0-9_\u0080-\uffff]*)?\$/y;

/** The `$tag$` or `$$` that starts at `at`, if one does. */
function dollarTagAt(text: string, at: number): string | undefined {
  DOLLAR_TAG.lastIndex = at;
  return DOLLAR_TAG.exec(text)?.[0];
}

/**
 * Where a string that closed at `at` continues, if it does: Postgres joins
 * `'a'` and `'b'` into one string when only whitespace holding a line break
 * (and `--` comments) lies between them, and the continued part keeps the
 * first part's escapes. Returns the index of the next opening quote.
 */
function continuedStringAt(text: string, at: number): number | undefined {
  let i = at;
  let newline = false;
  while (i < text.length) {
    const c = text[i];
    if (c === "\n" || c === "\r") {
      newline = true;
      i += 1;
    } else if (c === " " || c === "\t" || c === "\f" || c === "\v") {
      i += 1;
    } else if (c === "-" && text[i + 1] === "-") {
      while (i < text.length && text[i] !== "\n" && text[i] !== "\r") i += 1;
    } else {
      break;
    }
  }
  return newline && text[i] === "'" ? i : undefined;
}

/** The index just past the string whose body starts at `at`, continuations included. */
function stringEnd(text: string, at: number, backslashEscapes: boolean): number {
  let i = at;
  for (;;) {
    while (i < text.length) {
      if (backslashEscapes && text[i] === "\\") i += 2;
      else if (text[i] === "'" && text[i + 1] === "'") i += 2;
      else if (text[i] === "'") break;
      else i += 1;
    }
    if (i >= text.length) return text.length;
    const next = continuedStringAt(text, i + 1);
    if (next === undefined) return i + 1;
    i = next + 1;
  }
}

/**
 * The file's text with every comment, string literal, quoted name and
 * dollar-quoted body blanked, read left to right in one pass as Postgres's
 * lexer does: what opens first wins, so an apostrophe inside a `--` comment
 * opens no string and a `--` inside a string starts no comment. A `--`
 * comment ends at a line feed or a carriage return. Plain strings double
 * `''`; `E'...'` strings also escape with a backslash, and so does a part
 * continued from one; block comments nest. An unterminated literal runs to
 * the end, as Postgres would refuse it.
 */
export function blankLiterals(text: string): string {
  let out = "";
  let i = 0;
  const n = text.length;
  const identBefore = () => i > 0 && IDENT_CHAR.test(text[i - 1]);
  while (i < n) {
    const c = text[i];
    const next = text[i + 1];
    if (c === "-" && next === "-") {
      while (i < n && text[i] !== "\n" && text[i] !== "\r") i += 1;
      out += " ";
    } else if (c === "/" && next === "*") {
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (text[i] === "/" && text[i + 1] === "*") {
          depth += 1;
          i += 2;
        } else if (text[i] === "*" && text[i + 1] === "/") {
          depth -= 1;
          i += 2;
        } else {
          i += 1;
        }
      }
      out += " ";
    } else if ((c === "E" || c === "e") && next === "'" && !identBefore()) {
      i = stringEnd(text, i + 2, true);
      out += " ";
    } else if (c === "'") {
      i = stringEnd(text, i + 1, false);
      out += " ";
    } else if (c === '"') {
      i += 1;
      while (i < n) {
        if (text[i] === c && text[i + 1] === c) i += 2;
        else if (text[i] === c) break;
        else i += 1;
      }
      i += 1;
      out += " ";
    } else if (c === "$" && !identBefore() && dollarTagAt(text, i)) {
      const tag = dollarTagAt(text, i)!;
      const end = text.indexOf(tag, i + tag.length);
      i = end === -1 ? n : end + tag.length;
      out += " ";
    } else {
      out += c;
      i += 1;
    }
  }
  return out;
}

/** Refuses a file that would take over the runner's transaction or cannot run inside one. */
export function checkMigrationText(name: string, text: string): void {
  const code = blankLiterals(text);
  const statements = code.split(";").map((statement) => statement.trim());
  if (statements.some((statement) => TRANSACTION_CONTROL.test(statement))) {
    throw new MigrationError(
      `${name}: runs in the runner's transaction, so it holds no begin, commit, rollback or savepoint`,
    );
  }
  if (/\bconcurrently\b/i.test(code)) {
    throw new MigrationError(
      `${name}: runs in the runner's transaction, where concurrently cannot run`,
    );
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Runs `work` holding the advisory lock. A run that cannot have it within
 * `waitMs` fails and says another run holds it, rather than hang a deploy.
 * The unlock never replaces the error `work` failed with (on a lost
 * connection it fails too, and the server drops the lock with the session).
 */
async function withLock<T>(run: RunSql, work: () => Promise<T>, waitMs: number): Promise<T> {
  const until = Date.now() + waitMs;
  for (;;) {
    const { rows } = await run("select pg_try_advisory_lock($1) as locked", [LOCK_KEY]);
    if ((rows[0] as { locked?: boolean } | undefined)?.locked) {
      break;
    }
    if (Date.now() >= until) {
      throw new MigrationError(
        `another migration run holds the lock (pg_advisory_lock ${LOCK_KEY}); waited ${Math.round(waitMs / 1000)} s`,
      );
    }
    await sleep(LOCK_POLL_MS);
  }
  let failed = false;
  try {
    return await work();
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    try {
      await run("select pg_advisory_unlock($1)", [LOCK_KEY]);
    } catch (error) {
      if (!failed) {
        // eslint-disable-next-line no-unsafe-finally
        throw error;
      }
    }
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
  options: { onApplied?: (name: string) => void; lockWaitMs?: number } = {},
): Promise<string[]> {
  const names = migrationFiles(dir);
  const texts = new Map(
    names.map((name) => [name, readFileSync(path.join(dir, "migrations", name), "utf8")]),
  );
  for (const [name, text] of texts) {
    checkMigrationText(name, text);
  }
  return withLock(
    run,
    async () => {
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
        const text = texts.get(name)!;
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
    },
    options.lockWaitMs ?? LOCK_WAIT_MS,
  );
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
  options: { lockWaitMs?: number } = {},
): Promise<void> {
  const grants = readFileSync(path.join(dir, "grants.sql"), "utf8");
  const password: Record<(typeof APP_ROLES)[number], string | undefined> = {
    gtnh_site: passwords.site,
    gtnh_live: passwords.live,
  };
  await withLock(
    run,
    async () => {
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
    },
    options.lockWaitMs ?? LOCK_WAIT_MS,
  );
}
