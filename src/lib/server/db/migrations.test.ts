import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyMigrations,
  blankLiterals,
  checkMigrationText,
  dbDir,
  ensureRoles,
  MIGRATION_NAME,
  sqlRunner,
  type RunSql,
} from "./migrations";

/**
 * The migration runner on in-memory databases: each file once, recorded in
 * the ledger; a changed file, a database it did not build and Supabase's API
 * roles refused; the repository's own files named in order.
 */

const opened: { pglite: PGlite; dirs: string[] }[] = [];

function database(): { pglite: PGlite; run: RunSql } {
  const pglite = new PGlite();
  opened.push({ pglite, dirs: [] });
  return { pglite, run: sqlRunner(pglite) };
}

/** A db/ folder of its own, holding `files` as migrations. */
function folder(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "gtnh-migrations-"));
  opened.at(-1)?.dirs.push(dir);
  mkdirSync(path.join(dir, "migrations"));
  for (const [name, text] of Object.entries(files)) {
    writeFileSync(path.join(dir, "migrations", name), text);
  }
  return dir;
}

async function tables(pglite: PGlite): Promise<string[]> {
  const { rows } = await pglite.query<{ tablename: string }>(
    "select tablename from pg_tables where schemaname = 'public' order by tablename",
  );
  return rows.map((row) => row.tablename);
}

afterEach(async () => {
  for (const { pglite, dirs } of opened.splice(0)) {
    await pglite.close();
    for (const dir of dirs) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("the migration runner", () => {
  it("applies each file once", async () => {
    const { pglite, run } = database();
    const dir = folder({
      "0001-first.sql": "create table a (id int primary key);",
      "0002-second.sql": "create table b (id int primary key);",
    });
    expect(await applyMigrations(run, dir)).toEqual(["0001-first.sql", "0002-second.sql"]);
    expect(await applyMigrations(run, dir)).toEqual([]);
    writeFileSync(
      path.join(dir, "migrations", "0003-third.sql"),
      "alter table a add column n int;",
    );
    const announced: string[] = [];
    expect(await applyMigrations(run, dir, { onApplied: (name) => announced.push(name) })).toEqual([
      "0003-third.sql",
    ]);
    expect(announced).toEqual(["0003-third.sql"]);
    expect(await tables(pglite)).toEqual(["a", "b", "schema_migrations"]);
    const { rows } = await pglite.query<{ name: string; sha256: string }>(
      "select name, sha256 from schema_migrations order by name",
    );
    expect(rows.map((row) => row.name)).toEqual([
      "0001-first.sql",
      "0002-second.sql",
      "0003-third.sql",
    ]);
    for (const row of rows) {
      expect(row.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("builds the repository's schema from db/ and then has nothing left to apply", async () => {
    const { pglite, run } = database();
    expect(await applyMigrations(run, dbDir())).toEqual(
      readdirSync(path.join(dbDir(), "migrations")).sort(),
    );
    expect(await applyMigrations(run, dbDir())).toEqual([]);
    expect(await tables(pglite)).toContain("library_designs");
  });

  it("refuses a changed file by name", async () => {
    const { run } = database();
    const dir = folder({ "0001-first.sql": "create table a (id int primary key);" });
    await applyMigrations(run, dir);
    writeFileSync(
      path.join(dir, "migrations", "0001-first.sql"),
      "create table a (id bigint primary key);",
    );
    await expect(applyMigrations(run, dir)).rejects.toThrow(
      "0001-first.sql: changed since it was applied; put the change in a new migration",
    );
  });

  it("refuses a database it did not set up", async () => {
    const { pglite, run } = database();
    await pglite.exec("create table community_users (id uuid primary key)");
    const dir = folder({ "0001-first.sql": "create table a (id int primary key);" });
    await expect(applyMigrations(run, dir)).rejects.toThrow(
      "this database was not set up by the migration runner",
    );
    expect(await tables(pglite)).toEqual(["community_users"]);
  });

  it("refuses a database that has Supabase's API roles", async () => {
    const { pglite, run } = database();
    await pglite.exec("create role anon nologin");
    try {
      await expect(applyMigrations(run, folder({}))).rejects.toThrow(/anon or authenticated role/);
      expect(await tables(pglite)).toEqual([]);
    } finally {
      await pglite.exec("drop role anon");
    }
  });

  it("rolls a failing file back alone and names it", async () => {
    const { pglite, run } = database();
    const dir = folder({
      "0001-first.sql": "create table a (id int primary key);",
      "0002-broken.sql": "create table b (id int primary key); select no_such_function();",
      "0003-after.sql": "create table c (id int primary key);",
    });
    await expect(applyMigrations(run, dir)).rejects.toThrow(
      /^0002-broken\.sql: .*no_such_function/,
    );
    expect(await tables(pglite)).toEqual(["a", "schema_migrations"]);
    const { rows } = await pglite.query<{ name: string }>("select name from schema_migrations");
    expect(rows).toEqual([{ name: "0001-first.sql" }]);
  });

  it("refuses a file that is not named NNNN-words.sql, and an applied file that is gone", async () => {
    const { run } = database();
    for (const name of [
      "1-first.sql",
      "0001-first.SQL",
      "0001-first.sq",
      "0001_first.sql",
      "0001-First.sql",
    ]) {
      await expect(applyMigrations(run, folder({ [name]: "select 1;" })), name).rejects.toThrow(
        `${name}: a migration is named NNNN-words.sql (lowercase, hyphens)`,
      );
    }
    // An editor's or the OS's hidden file is no migration.
    expect(await applyMigrations(run, folder({ ".DS_Store": "x" }))).toEqual([]);
    const dir = folder({ "0001-first.sql": "create table a (id int primary key);" });
    await applyMigrations(run, dir);
    rmSync(path.join(dir, "migrations", "0001-first.sql"));
    await expect(applyMigrations(run, dir)).rejects.toThrow(
      "0001-first.sql: applied to this database, but no such file",
    );
  });

  it("names are numbered and contiguous", () => {
    const names = readdirSync(path.join(dbDir(), "migrations")).sort();
    expect(names.length).toBeGreaterThan(0);
    names.forEach((name, at) => {
      expect(name).toMatch(MIGRATION_NAME);
      expect(name.slice(0, 4), name).toBe(String(at + 1).padStart(4, "0"));
    });
  });

  it("the site role cannot read the ledger, nor the live role", async () => {
    const { pglite, run } = database();
    await applyMigrations(run, dbDir());
    await ensureRoles(run, {}, dbDir());
    for (const role of ["gtnh_site", "gtnh_live"]) {
      await pglite.exec(`set role ${role}`);
      try {
        await expect(pglite.query("select name from schema_migrations"), role).rejects.toThrow(
          /permission denied for table schema_migrations/,
        );
        await expect(
          pglite.query("insert into schema_migrations (name, sha256) values ('x', 'y')"),
          role,
        ).rejects.toThrow(/permission denied/);
      } finally {
        await pglite.exec("reset role");
      }
    }
  });

  it("refuses a file with its own transaction control or concurrently, by name, before applying any", async () => {
    const refused: Record<string, string> = {
      "begin;\ncreate table a (id int);\ncommit;": "holds no begin, commit, rollback or savepoint",
      "create table a (id int);\nCOMMIT;": "holds no begin, commit, rollback or savepoint",
      "start transaction; create table a (id int);":
        "holds no begin, commit, rollback or savepoint",
      "create table a (id int); savepoint s;": "holds no begin, commit, rollback or savepoint",
      "create table a (id int);\nend;": "holds no begin, commit, rollback or savepoint",
      "create index concurrently a_idx on community_users (username);": "concurrently cannot run",
    };
    // Refused while reading the files, so no database work is needed per case.
    const { pglite, run } = database();
    for (const [text, message] of Object.entries(refused)) {
      const dir = folder({ "0001-fine.sql": "create table fine (id int);", "0002-bad.sql": text });
      const error = await applyMigrations(run, dir).catch((caught: unknown) => caught);
      expect(String(error), text).toContain("0002-bad.sql: runs in the runner's transaction");
      expect(String(error), text).toContain(message);
    }
    expect(await tables(pglite)).toEqual([]);
    // A DO block's begin ... end, and the words inside strings and comments, are not statements.
    const fine = folder({
      "0001-fine.sql": [
        "-- begin; commit; concurrently",
        "/* rollback; */",
        "create table notes (body text default 'commit; begin');",
        'create table "end" (id int);',
        "do $$ begin perform 1; end $$;",
        "do $body$ begin perform 'concurrently'; end $body$;",
      ].join("\n"),
    });
    expect(await applyMigrations(run, fine)).toEqual(["0001-fine.sql"]);
  });

  it("reads comments, strings, quoted names and dollar bodies in one left-to-right pass", () => {
    const transaction = /holds no begin, commit, rollback or savepoint/;
    // An apostrophe in a comment opens no string, so the commit after it is seen.
    expect(() =>
      checkMigrationText(
        "0002-bad.sql",
        "-- the site's flag\ncommit;\nalter table a add column b text default 'x';",
      ),
    ).toThrow(transaction);
    // An E-string's backslash escapes its quote, so the string ends where Postgres ends it.
    expect(() =>
      checkMigrationText("0002-bad.sql", "select E'it\\'s';\ncommit;\nselect 'y';"),
    ).toThrow(transaction);
    expect(() =>
      checkMigrationText("0002-bad.sql", "/* it's /* nested */ still a comment */ rollback;"),
    ).toThrow(transaction);
    expect(() =>
      checkMigrationText("0002-bad.sql", `create table "it's" (id int);\ncommit;`),
    ).toThrow(transaction);
    // What a literal holds stays inside it, whichever kind opened first.
    expect(blankLiterals("select '-- not a comment'; commit")).toBe("select  ; commit");
    expect(blankLiterals("select 'it''s'; x")).toBe("select  ; x");
    expect(blankLiterals("select e'a\\'b'; x")).toBe("select  ; x");
    expect(blankLiterals('select "a""b"; x')).toBe("select  ; x");
    expect(blankLiterals("do $f$ begin; $$ end; $f$; x")).toBe("do  ; x");
    // A $ inside a name or a $1 parameter opens no dollar quote.
    expect(blankLiterals("select a$b$c, $1; x")).toBe("select a$b$c, $1; x");
    // A plain string keeps its backslash: it does not escape the quote.
    expect(blankLiterals("select 'a\\'; commit")).toBe("select  ; commit");
  });

  it("reads a string continued over a line break in the first part's mode", () => {
    const transaction = /holds no begin, commit, rollback or savepoint/;
    // The continued part of an E-string keeps its backslash escapes.
    expect(() =>
      checkMigrationText("0002-bad.sql", "insert into t values (E'a'\n'\\''); commit; select 'x';"),
    ).toThrow(transaction);
    expect(blankLiterals("select E'a'\n'\\''; x")).toBe("select  ; x");
    // A -- comment may sit in the gap; the continued part of a plain string stays plain.
    expect(blankLiterals("select 'a' -- note\n  'b\\'; x")).toBe("select  ; x");
    expect(blankLiterals("select e'a'\r\n\t'b\\''; x")).toBe("select  ; x");
    // Without a line break the next quote opens a string of its own.
    expect(blankLiterals("select E'a' '\\'; x")).toBe("select    ; x");
  });

  it("passes the repository's own migrations", () => {
    const dir = path.join(dbDir(), "migrations");
    for (const name of readdirSync(dir).filter((entry) => MIGRATION_NAME.test(entry))) {
      expect(() =>
        checkMigrationText(name, readFileSync(path.join(dir, name), "utf8")),
      ).not.toThrow();
    }
  });

  it("hashes a file's text with LF line ends, so a CRLF checkout reads as unchanged", async () => {
    const { run } = database();
    const dir = folder({
      "0001-first.sql": "create table a (id int);\ncreate table b (id int);\n",
    });
    await applyMigrations(run, dir);
    writeFileSync(
      path.join(dir, "migrations", "0001-first.sql"),
      "create table a (id int);\r\ncreate table b (id int);\r\n",
    );
    expect(await applyMigrations(run, dir)).toEqual([]);
  });

  it("gives up on a held lock after its wait and says so, and keeps a failed file's error over the unlock's", async () => {
    const { run } = database();
    const held: RunSql = (text, params) =>
      /pg_try_advisory_lock/.test(text)
        ? Promise.resolve({ rows: [{ locked: false }] })
        : run(text, params);
    const started = Date.now();
    await expect(applyMigrations(held, folder({}), { lockWaitMs: 600 })).rejects.toThrow(
      "another migration run holds the lock (pg_advisory_lock 7361); waited 1 s",
    );
    expect(Date.now() - started).toBeGreaterThanOrEqual(600);

    const lost: RunSql = (text, params) =>
      /pg_advisory_unlock/.test(text)
        ? Promise.reject(new Error("Connection terminated"))
        : run(text, params);
    const dir = folder({ "0001-bad.sql": "select no_such_function();" });
    await expect(applyMigrations(lost, dir)).rejects.toThrow(/^0001-bad\.sql: .*no_such_function/);
    // With nothing else failing, the unlock's own error is the run's.
    await expect(applyMigrations(lost, folder({}))).rejects.toThrow("Connection terminated");
  });
});
