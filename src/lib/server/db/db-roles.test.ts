import { readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations } from "./migrations";

/**
 * The deploy's roles on a database built as the deploy builds it: the schema
 * and migrations, PostgREST's roles and grants, then the app's roles
 * (`tools/deploy/db/app-roles.sql`). The psql-only lines that set passwords
 * are left out, so the roles stay nologin and are entered with `set role`.
 */

const OWNER = "11111111-1111-4111-8111-111111111111";
const MEMBER = "33333333-3333-4333-8333-333333333333";
const deployDb = path.join(process.cwd(), "tools", "deploy", "db");
const ROW_SECURITY_OFF = "2026-10-26-row-security-off.sql";

/** A psql script without its meta-commands and the statements that read a psql variable. */
function withoutPsql(file: string): string {
  return readFileSync(path.join(deployDb, file), "utf8")
    .split("\n")
    .filter((line) => !line.startsWith("\\") && !line.includes(":'"))
    .join("\n");
}

let pglite: PGlite;

async function as<T>(role: string, work: () => Promise<T>): Promise<T> {
  await pglite.exec(`set role ${role}`);
  try {
    return await work();
  } finally {
    await pglite.exec("reset role");
  }
}

/** The error a statement fails with as `role`, or undefined when it passes. */
async function failureAs(
  role: string,
  sqlText: string,
  params: unknown[] = [],
): Promise<string | undefined> {
  return as(role, async () => {
    try {
      await pglite.query(sqlText, params);
      return undefined;
    } catch (error) {
      return (error as Error).message;
    }
  });
}

async function appTables(): Promise<string[]> {
  const { rows } = await pglite.query<{ tablename: string }>(
    "select tablename from pg_tables where schemaname = 'public' order by tablename",
  );
  return rows.map((row) => row.tablename);
}

beforeAll(async () => {
  pglite = new PGlite();
  await applyMigrations(pglite);
  await pglite.exec(withoutPsql("roles.sql"));
  await pglite.exec(withoutPsql("grants.sql"));
  await pglite.exec(withoutPsql("app-roles.sql"));
  // A second run converges: every file is applied on every deploy.
  await pglite.exec(withoutPsql("app-roles.sql"));
  await pglite.query(
    "insert into community_users (id, username, password_hash) values ($1, 'owner', 'hash'), ($2, 'member', 'hash')",
    [OWNER, MEMBER],
  );
  await pglite.query(
    "insert into library_designs (user_id, id, name, plan, seq) values ($1, 'd1', 'Design', '{\"nodes\":[]}', 7)",
    [OWNER],
  );
  await pglite.query(
    "insert into library_design_members (owner_id, design_id, member_id) values ($1, 'd1', $2)",
    [OWNER, MEMBER],
  );
}, 60_000);

afterAll(async () => {
  await pglite.close();
});

describe("the database roles", () => {
  it("turns row security off on every table, also where an older schema turned it on", async () => {
    const withRowSecurity = async () =>
      (
        await pglite.query<{ relname: string }>(
          "select relname from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r' and relrowsecurity",
        )
      ).rows.map((row) => row.relname);
    expect(await withRowSecurity()).toEqual([]);
    // The stage database was built when every table had it on.
    for (const table of await appTables()) {
      await pglite.exec(`alter table ${table} enable row level security`);
    }
    expect((await withRowSecurity()).length).toBeGreaterThanOrEqual(10);
    await pglite.exec(
      readFileSync(path.join(process.cwd(), "supabase", "migrations", ROW_SECURITY_OFF), "utf8"),
    );
    expect(await withRowSecurity()).toEqual([]);
  });

  it("lets the site role read and write every app table, and nothing more", async () => {
    const tables = await appTables();
    expect(tables.length).toBeGreaterThanOrEqual(10);
    for (const table of tables) {
      for (const privilege of ["SELECT", "INSERT", "UPDATE", "DELETE"]) {
        const { rows } = await pglite.query<{ ok: boolean }>(
          "select has_table_privilege('gtnh_site', $1, $2) as ok",
          [`public.${table}`, privilege],
        );
        expect(rows[0]?.ok, `${privilege} on ${table}`).toBe(true);
      }
      for (const privilege of ["TRUNCATE", "REFERENCES", "TRIGGER"]) {
        const { rows } = await pglite.query<{ ok: boolean }>(
          "select has_table_privilege('gtnh_site', $1, $2) as ok",
          [`public.${table}`, privilege],
        );
        expect(rows[0]?.ok, `${privilege} on ${table}`).toBe(false);
      }
    }
    const user = "44444444-4444-4444-8444-444444444444";
    await as("gtnh_site", async () => {
      await pglite.query(
        "insert into community_users (id, username, password_hash) values ($1, 'site-made', 'h')",
        [user],
      );
      const read = await pglite.query("select password_hash from community_users where id = $1", [
        user,
      ]);
      expect(read.rows).toEqual([{ password_hash: "h" }]);
      await pglite.query("update community_users set session_epoch = 2 where id = $1", [user]);
      await pglite.query("delete from community_users where id = $1", [user]);
      // An identity column: the role uses its sequence.
      await pglite.query("insert into community_events (actor_key, action) values ('a', 'b')");
      await pglite.query("delete from community_events where actor_key = 'a'");
    });
    expect(await failureAs("gtnh_site", "create table x (a int)")).toMatch(
      /permission denied for schema public/,
    );
    expect(await failureAs("gtnh_site", "truncate community_events")).toMatch(/permission denied/);
    expect(await failureAs("gtnh_site", "create role y")).toMatch(/permission denied/);
  });

  it("lets the live role run every statement the live store sends", async () => {
    const until = "2026-10-26T12:00:00.000Z";
    await as("gtnh_live", async () => {
      const account = await pglite.query(
        "select id, username, is_admin, session_epoch from community_users where id = $1",
        [OWNER],
      );
      expect(account.rows).toHaveLength(1);
      const usernames = await pglite.query(
        "select id, username from community_users where id = any($1)",
        [[OWNER, MEMBER]],
      );
      expect(usernames.rows).toHaveLength(2);
      const members = await pglite.query(
        "select member_id, added_at from library_design_members where owner_id = $1 and design_id = 'd1'",
        [OWNER],
      );
      expect(members.rows).toHaveLength(1);
      const size = await pglite.query<{ plan_bytes: number }>(
        "select plan_bytes from library_designs where user_id = $1 and id = 'd1' and deleted_at is null",
        [OWNER],
      );
      // Row security is off: the role sees the seeded design.
      expect(size.rows).toHaveLength(1);
      const taken = await pglite.query(
        `update library_designs set live_lease_until = $2, live_lease_token = 'tok'
         where user_id = $1 and id = 'd1' and deleted_at is null returning plan, seq`,
        [OWNER, until],
      );
      expect(taken.rows).toEqual([{ plan: { nodes: [] }, seq: 7 }]);
      const renewed = await pglite.query(
        `update library_designs set live_lease_until = $2
         where user_id = $1 and id = 'd1' and live_lease_token = 'tok' and deleted_at is null returning id`,
        [OWNER, until],
      );
      expect(renewed.rows).toHaveLength(1);
      const flushed = await pglite.query(
        `update library_designs set plan = $2, seq = 8, plan_updated_at = $3, updated_at = $3,
           live_lease_until = $3, live_lease_token = 'tok'
         where user_id = $1 and id = 'd1' and live_lease_token = 'tok' and deleted_at is null returning id`,
        [OWNER, JSON.stringify({ nodes: [1] }), until],
      );
      expect(flushed.rows).toHaveLength(1);
      const state = await pglite.query(
        "select deleted_at from library_designs where user_id = $1 and id = 'd1'",
        [OWNER],
      );
      expect(state.rows).toHaveLength(1);
      await pglite.query(
        "update library_designs set live_lease_until = null, live_lease_token = null where user_id = $1 and id = 'd1' and live_lease_token = 'tok'",
        [OWNER],
      );
    });
  });

  it("refuses the live role everything else", async () => {
    const refused = [
      "select password_hash from community_users",
      "select * from community_users",
      "update community_users set session_epoch = 9",
      "select * from library_designs",
      "select name from library_designs",
      "update library_designs set name = 'x'",
      "update library_designs set deleted_at = now()",
      "insert into library_designs (user_id, id, name, plan) values ('11111111-1111-4111-8111-111111111111', 'x', 'x', '{}')",
      "delete from library_designs",
      "insert into library_design_members (owner_id, design_id, member_id) values ('11111111-1111-4111-8111-111111111111', 'd1', '11111111-1111-4111-8111-111111111111')",
      "select id from community_plans",
      "select id from blueprints",
      "select id from library_folders",
      "insert into community_events (actor_key, action) values ('a', 'b')",
      "create table x (a int)",
    ];
    for (const statement of refused) {
      expect(await failureAs("gtnh_live", statement), statement).toMatch(/permission denied/);
    }
  });

  it("removes a grant the file no longer gives on the next run", async () => {
    await pglite.exec(
      "grant select on community_plans to gtnh_live; grant select (name) on library_designs to gtnh_live",
    );
    await pglite.exec(withoutPsql("app-roles.sql"));
    expect(await failureAs("gtnh_live", "select id from community_plans")).toMatch(
      /permission denied/,
    );
    expect(await failureAs("gtnh_live", "select name from library_designs")).toMatch(
      /permission denied/,
    );
  });

  it("keeps PostgREST's service role reading and writing every table", async () => {
    // PostgREST logs in as authenticator, which has no rights of its own, and switches to service_role.
    expect(await failureAs("authenticator", "select id from community_users")).toMatch(
      /permission denied/,
    );
    for (const table of await appTables()) {
      expect(
        await failureAs("service_role", `select count(*) from ${table}`),
        table,
      ).toBeUndefined();
    }
    await as("service_role", async () => {
      const designs = await pglite.query(
        "select name, plan from library_designs where user_id = $1",
        [OWNER],
      );
      expect(designs.rows).toHaveLength(1);
      await pglite.query("insert into community_events (actor_key, action) values ('pgrst', 'b')");
      await pglite.query("delete from community_events where actor_key = 'pgrst'");
    });
  });

  it("sets every password with statement logging off for its transaction", () => {
    // A failing statement is logged with its text by default, password included.
    // PGlite has no server log to read; tools/deploy/db/*.sql were checked on the
    // compose's postgres image: a failed alter role leaves no STATEMENT line.
    for (const file of ["roles.sql", "app-roles.sql"]) {
      const lines = readFileSync(path.join(deployDb, file), "utf8").split("\n");
      const passwordLines = lines.flatMap((line, at) => (/password :'/.test(line) ? [at] : []));
      expect(passwordLines.length, file).toBeGreaterThan(0);
      for (const at of passwordLines) {
        const before = lines.slice(0, at);
        const begin = before.findLastIndex((line) => /^begin;/.test(line));
        const commit = before.findLastIndex((line) => /^commit;/.test(line));
        expect(begin, `${file}:${at + 1} is inside a transaction`).toBeGreaterThan(commit);
        const opened = before.slice(begin);
        expect(opened, `${file}:${at + 1}`).toContain("set local log_min_error_statement = panic;");
        expect(opened, `${file}:${at + 1}`).toContain("set local log_statement = 'none';");
      }
    }
  });

  it("refuses to turn row security off where Supabase's API roles exist", async () => {
    const migration = readFileSync(
      path.join(process.cwd(), "supabase", "migrations", ROW_SECURITY_OFF),
      "utf8",
    );
    await pglite.exec("create role anon nologin");
    try {
      await expect(pglite.exec(migration)).rejects.toThrow(/anon or authenticated/);
    } finally {
      await pglite.exec("drop role anon");
    }
  });
});
