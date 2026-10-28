import { readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { Kysely, PGliteDialect } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as accounts from "../repos/accounts";
import * as blueprints from "../repos/blueprints";
import * as comments from "../repos/comments";
import * as designMembers from "../repos/design-members";
import * as designs from "../repos/designs";
import * as events from "../repos/events";
import * as folders from "../repos/folders";
import * as plans from "../repos/plans";
import * as popularity from "../repos/popularity";
import { PLAN_SUMMARY_FIELDS } from "../community-rows";
import * as votes from "../repos/votes";
import { setDbForTests, withTransaction } from "./index";
import {
  applyMigrations,
  dbDir,
  ensureRoles,
  migrationFiles,
  sqlRunner,
  type RunSql,
} from "./migrations";
import type { Database } from "./schema";

/**
 * The deploy's roles on a database built as the deploy builds it: the
 * migrations, then the app's roles and `db/grants.sql` (`ensureRoles`).
 * No passwords are given, so the roles stay nologin and are entered with
 * `set role`.
 */

const OWNER = "11111111-1111-4111-8111-111111111111";
const MEMBER = "33333333-3333-4333-8333-333333333333";

let pglite: PGlite;
let run: RunSql;

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
    // Every table but the migration runner's ledger, which no app role reads (migrations.test.ts).
    "select tablename from pg_tables where schemaname = 'public' and tablename <> 'schema_migrations' order by tablename",
  );
  return rows.map((row) => row.tablename);
}

beforeAll(async () => {
  pglite = new PGlite();
  run = sqlRunner(pglite);
  await applyMigrations(run, dbDir());
  await ensureRoles(run, {}, dbDir());
  // A second run converges: the roles and grants are ensured on every deploy.
  await ensureRoles(run, {}, dbDir());
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
  setDbForTests(undefined);
  await pglite.close();
});

describe("the database roles", () => {
  it("has row security off on every table, and no migration turns it on", async () => {
    const { rows } = await pglite.query<{ relname: string }>(
      "select relname from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r' and relrowsecurity",
    );
    expect(rows.map((row) => row.relname)).toEqual([]);
    for (const name of migrationFiles(dbDir())) {
      expect(readFileSync(path.join(dbDir(), "migrations", name), "utf8"), name).not.toMatch(
        /enable row level security/i,
      );
    }
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
    for (const role of ["gtnh_site", "gtnh_live"]) {
      expect(await failureAs(role, "create temp table t (a int)"), role).toMatch(
        /permission denied to create temporary tables/,
      );
    }
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

  it("runs the account and event repositories under the role of each process that calls them", async () => {
    // The repositories' own statements, as Kysely compiles them, on this database.
    setDbForTests(new Kysely<Database>({ dialect: new PGliteDialect({ pglite }) }));
    try {
      await as("gtnh_site", async () => {
        const made = await accounts.createAccount("repo-made", "hash");
        expect(made).toMatchObject({ username: "repo-made" });
        const id = (made as { id: string }).id;
        expect(await accounts.createAccount("repo-made", "hash")).toBe("taken");
        expect(await accounts.readLoginAccount("repo-made")).toMatchObject({ id, password_hash: "hash" });
        expect(await accounts.readSessionAccount(id)).toMatchObject({ id, session_epoch: 0 });
        await accounts.setSessionEpoch(id, 5);
        expect(await accounts.readSessionAccount(id)).toMatchObject({ session_epoch: 5 });
        expect(await accounts.searchByPrefix("repo", OWNER)).toEqual([{ id, username: "repo-made" }]);
        expect(await accounts.accountExists(id)).toBe(true);
        expect((await accounts.usernamesFor([id, OWNER])).size).toBe(2);
        await events.insert([{ actorKey: "repo", action: "probe" }]);
        expect(await events.countSince("repo", "probe", new Date(0))).toBe(1);
        const ids = await events.oldestIdsBefore(new Date(Date.now() + 60_000), 500);
        expect(ids.length).toBeGreaterThan(0);
        expect(await events.deleteIds(ids)).toBe(ids.length);
        await pglite.query("delete from community_users where id = $1", [id]);
      });
      await as("gtnh_live", async () => {
        expect(await accounts.readSessionAccount(OWNER)).toMatchObject({ username: "owner" });
        expect(await accounts.usernamesFor([OWNER, MEMBER])).toEqual(
          new Map([
            [OWNER, "owner"],
            [MEMBER, "member"],
          ]),
        );
      });
    } finally {
      setDbForTests(undefined);
    }
  });

  it("runs every site-side library repository function as the site role, transactions and row locks included", async () => {
    const db = new Kysely<Database>({ dialect: new PGliteDialect({ pglite }) });
    setDbForTests(db);
    const stamp = "2026-10-26T10:00:00.000Z";
    try {
      await as("gtnh_site", async () => {
        await db.transaction().execute(async (tx) => {
          await accounts.lockAccount(OWNER, tx);
          expect(await designs.read(OWNER, "d2", { withPlan: false, forUpdate: true }, tx)).toBeUndefined();
          expect(await designs.countLive(OWNER, tx)).toBeGreaterThan(0);
          await designs.insert(
            {
              user_id: OWNER,
              id: "d2",
              name: "Site",
              icon: null,
              folder_id: null,
              closed: false,
              favorite: false,
              sort_order: null,
              community_plan_id: null,
              created_at: stamp,
              updated_at: stamp,
              plan_updated_at: stamp,
              deleted_at: null,
              plan: { nodes: [] },
            },
            tx,
          );
          expect(await designMembers.lockDesign(OWNER, "d2", tx)).toBe(true);
          expect(await designMembers.add(OWNER, "d2", MEMBER, tx)).toBe("added");
        });
        const saved = await designs.saveAsMember(
          OWNER,
          "d2",
          { name: "Renamed", updated_at: stamp, plan_updated_at: stamp, plan: { nodes: [1] } },
          { requireLeaseFree: true, now: stamp },
        );
        expect(saved).toMatchObject({ name: "Renamed" });
        const byOwner = await designs.saveAsOwner(
          OWNER,
          "d2",
          {
            user_id: OWNER,
            id: "d2",
            name: "Owner's",
            icon: { kind: "item", id: "minecraft:stone" },
            folder_id: null,
            closed: false,
            favorite: true,
            sort_order: 1,
            community_plan_id: null,
            created_at: stamp,
            updated_at: stamp,
            plan_updated_at: stamp,
            deleted_at: null,
            plan: { nodes: [2] },
          },
          { requireLeaseFree: true, now: stamp },
        );
        expect(byOwner).toMatchObject({ name: "Owner's", favorite: true });
        expect(await designs.read(OWNER, "d2", { withPlan: true })).toMatchObject({ plan: { nodes: [2] } });
        expect(await designMembers.isMember(MEMBER, OWNER, "d2")).toBe(true);
        expect(await designMembers.list(OWNER, "d2")).toEqual([{ id: MEMBER, username: "member" }]);
        expect((await designs.listOwn(OWNER, 10)).map((row) => row.id)).toContain("d2");
        expect((await designs.sharedWith(MEMBER)).map((row) => row.id).sort()).toEqual(["d1", "d2"]);
        expect(await designMembers.rowsFor(MEMBER)).toHaveLength(2);
        expect(await designMembers.ofDesigns([{ ownerId: OWNER, designId: "d2" }])).toHaveLength(1);
        expect(await designMembers.remove(OWNER, "d2", MEMBER)).toBe(true);
        await db.transaction().execute(async (tx) => {
          await designs.tombstone(OWNER, "d2", stamp, tx);
          await designMembers.deleteOfDesign(OWNER, "d2", tx);
        });
        await db.transaction().execute(async (tx) => {
          expect(await folders.read(OWNER, "f1", { forUpdate: true }, tx)).toBeUndefined();
          expect(await folders.countLive(OWNER, tx)).toBe(0);
          await folders.upsert(
            { user_id: OWNER, id: "f1", name: "Folder", created_at: stamp, updated_at: stamp },
            tx,
          );
        });
        await folders.tombstone(OWNER, "f1", stamp);
        expect(await folders.listOwn(OWNER, 10)).toEqual([
          expect.objectContaining({ id: "f1", deleted_at: expect.anything() }),
        ]);
      });
    } finally {
      setDbForTests(undefined);
      await pglite.query("delete from library_designs where id = 'd2'");
      await pglite.query("delete from library_folders where id = 'f1'");
    }
  });

  it("runs every direct community post and comment repository function as the site role", async () => {
    const db = new Kysely<Database>({ dialect: new PGliteDialect({ pglite }) });
    setDbForTests(db);
    const owner = { userId: OWNER, isAdmin: false, adminToken: false };
    const stats = {
      needs: [],
      outputs: [{ kind: "item" as const, resourceId: "steel", displayName: "Steel", ratePerSecond: 1 }],
      total_eu_t: 30,
      machine_count: 1,
      node_count: 1,
      storage_count: 0,
      edge_count: 0,
      highest_tier: "LV",
      highest_tier_index: 1,
    };
    let planId: string | undefined;
    try {
      await as("gtnh_site", async () => {
        planId = await plans.insert({
          ...stats,
          user_id: OWNER,
          author_name: "owner",
          name: "Roles",
          description: "",
          game_version: "roles",
          dataset_version: "",
          plan: { nodes: [] },
          tags: ["oil"],
          tags_text: "oil",
          icon: null,
          stats_version: "0",
          uploader_key: "test",
        });
        const id = planId;
        const query: plans.PlanListQuery = {
          search: { tags: ["oil"], author: "owner", bareAuthor: false, text: "rol" },
          gameVersion: "roles",
          maxTierIndex: 5,
          maxEuT: 100,
          makes: [{ kind: "item", resourceId: "steel" }],
          takes: [],
          shelf: { kind: "mine", userId: OWNER },
          sort: { column: "last_activity_at", ascending: false, nullsLast: true },
          offset: 0,
          limit: 10,
        };
        const page = await withTransaction((tx) => plans.list(query, tx), { readSnapshot: true });
        expect(page).toMatchObject({ total: 1, rows: [{ id, name: "Roles" }] });
        await expect(
          withTransaction((tx) => plans.remove(id, tx), { readSnapshot: true }),
        ).rejects.toThrow(/read-only transaction/);
        expect(await plans.readSummary(id)).toMatchObject({ id, tags: ["oil"], outputs: stats.outputs });
        expect(await plans.readAccess(id)).toEqual({ id, user_id: OWNER, is_public: true });
        expect(await plans.readOwner(id)).toEqual({ id, user_id: OWNER });
        expect(await plans.distinctGameVersions()).toContain("roles");
        expect(await plans.update(id, OWNER, { name: "Roles edited", tags: ["oil", "gas"], icon: null })).toBe(true);
        expect(await plans.readStatsVersion(id)).toBe("0");
        expect(await plans.readPlanJson(id)).toEqual({ nodes: [] });
        await plans.writeStats(id, { ...stats, machine_count: 4 }, "1");
        expect(await plans.readStatsVersion(id)).toBe("1");
        expect(await plans.countView(id, owner)).toBe(1);
        expect(await plans.takeDownload(id, owner)).toEqual({ plan: { nodes: [] }, name: "Roles edited" });
        const written = await withTransaction(async (tx) => {
          expect(await plans.lockPost(id, tx)).toBe(true);
          const row = await comments.insert({ plan_id: id, user_id: MEMBER, author_name: "member", body: "Hi" }, tx);
          await comments.recount(id, tx);
          return row;
        });
        expect(await comments.list(id, 10)).toEqual([written]);
        expect(await comments.readAccess(id, written.id)).toEqual({ authorId: MEMBER, planOwnerId: OWNER });
        expect(await plans.readSummary(id)).toMatchObject({ comment_count: 1, last_comment_at: written.created_at });
        await withTransaction(async (tx) => {
          await plans.lockPost(id, tx);
          expect(await comments.softDelete(id, written.id, tx)).toBe(true);
          await comments.recount(id, tx);
        });
        expect(await plans.readSummary(id)).toMatchObject({ comment_count: 0, last_comment_at: null });
        await plans.remove(id);
        expect(await plans.readAccess(id)).toBeUndefined();
      });
    } finally {
      setDbForTests(undefined);
      if (planId) {
        await pglite.query("delete from community_plans where id = $1", [planId]);
      }
    }
  });

  it("runs every direct vote repository function as the site role, on posts and blueprints, row locks included", async () => {
    const db = new Kysely<Database>({ dialect: new PGliteDialect({ pglite }) });
    setDbForTests(db);
    const plan = await pglite.query<{ id: string }>(
      `insert into community_plans (user_id, author_name, name, plan, uploader_key)
       values ($1, 'owner', 'Voted', '{"nodes":[]}', 'test') returning id`,
      [OWNER],
    );
    const ids = { plan: plan.rows[0]!.id };
    try {
      await as("gtnh_site", async () => {
        for (const target of ["plan"] as const) {
          const id = ids[target];
          const counts = await withTransaction(async (tx) => {
            expect(await votes.lockParent(target, id, tx)).toBe(true);
            await votes.upsert(target, id, "voter-a", 1, tx);
            await votes.upsert(target, id, "voter-b", 1, tx);
            await votes.upsert(target, id, "voter-b", -1, tx);
            return votes.recount(target, id, tx);
          });
          expect(counts, target).toEqual({ upvotes: 1, downvotes: 1 });
          expect(await votes.read(target, id, "voter-b")).toBe(-1);
          expect(await votes.byVoter(target, "voter-a")).toEqual(new Map([[id, 1]]));
          expect(await votes.byVoter(target, "voter-a", [id])).toEqual(new Map([[id, 1]]));
          await withTransaction(async (tx) => {
            await votes.lockParent(target, id, tx);
            await votes.remove(target, id, "voter-b", tx);
            expect(await votes.recount(target, id, tx)).toEqual({ upvotes: 1, downvotes: 0 });
          });
          expect(await votes.read(target, id, "voter-b")).toBeUndefined();
          expect(
            await withTransaction((tx) => votes.lockParent(target, "00000000-0000-4000-8000-000000000000", tx)),
          ).toBe(false);
        }
      });
    } finally {
      setDbForTests(undefined);
      await pglite.query("delete from community_plans where id = $1", [ids.plan]);
    }
  });

  it("runs every blueprint repository function as the site role", async () => {
    const db = new Kysely<Database>({ dialect: new PGliteDialect({ pglite }) });
    setDbForTests(db);
    const stat = { kind: "item" as const, resourceId: "steel", displayName: "Steel", ratePerSecond: 1 };
    let blueprintId: string | undefined;
    try {
      await as("gtnh_site", async () => {
        const saved = await blueprints.insert({
          user_id: OWNER,
          name: "Roles",
          payload: { nodes: [] },
          node_count: 1,
          storage_count: 0,
          edge_count: 0,
          pocket_count: 0,
          machine_count: 1,
          needs: [],
          outputs: [stat],
          highest_tier: "LV",
          highest_tier_index: 1,
          tags: ["oil"],
          tags_text: "oil",
          icon: null,
        });
        const id = saved.id;
        blueprintId = id;
        expect(saved).toMatchObject({ name: "Roles", outputs: [stat], tags: ["oil"], is_public: false, score: 0 });
        expect(await blueprints.countOwn(OWNER)).toBe(1);
        expect(await blueprints.listOwn(OWNER, 10)).toMatchObject([{ id }]);
        expect(await blueprints.readOwn(id, OWNER)).toMatchObject({ id, payload: { nodes: [] } });
        expect(await blueprints.readOwn(id, MEMBER)).toBeUndefined();
        expect(
          await blueprints.updateOwn(id, OWNER, { tags: ["oil", "gas"], tags_text: "oil gas", outputs: [] }),
        ).toMatchObject({ tags: ["oil", "gas"], outputs: [] });
        await withTransaction(async (tx) => {
          await accounts.lockAccount(OWNER, tx);
          expect(await blueprints.countOwn(OWNER, tx)).toBe(1);
        });
        expect(await blueprints.updateOwn(id, MEMBER, { name: "Taken" })).toBeUndefined();
        expect(await blueprints.deleteOwn(id, MEMBER)).toBe(false);
        expect(await blueprints.deleteOwn(id, OWNER)).toBe(true);
        expect(await blueprints.readOwn(id, OWNER)).toBeUndefined();
      });
    } finally {
      setDbForTests(undefined);
      if (blueprintId) {
        await pglite.query("delete from blueprints where id = $1", [blueprintId]);
      }
    }
  });

  it("runs the by-score read and the popularity sweep's page as the site role", async () => {
    const db = new Kysely<Database>({ dialect: new PGliteDialect({ pglite }) });
    setDbForTests(db);
    const posted = await pglite.query<{ id: string }>(
      `insert into community_plans (user_id, author_name, name, plan, outputs, uploader_key)
       values ($1, 'owner', 'Ranked', '{"nodes":[]}', '[{"kind":"item","resourceId":"steel"}]', 'test') returning id`,
      [OWNER],
    );
    const id = posted.rows[0]!.id;
    try {
      await as("gtnh_site", async () => {
        const links = await plans.publicByScore<Record<string, unknown>>(10, plans.PLAN_LINK_FIELDS);
        expect(links.map((row) => Object.keys(row).sort())).toEqual([["created_at", "id", "updated_at"]]);
        expect(links[0]!.id).toBe(id);
        expect(await plans.publicByScore(10, PLAN_SUMMARY_FIELDS)).toMatchObject([{ id, name: "Ranked" }]);
        expect(await popularity.publicPlanPage(0, 10)).toEqual([
          { plan: { nodes: [] }, outputs: [{ kind: "item", resourceId: "steel" }] },
        ]);
      });
    } finally {
      setDbForTests(undefined);
      await pglite.query("delete from community_plans where id = $1", [id]);
    }
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
    await ensureRoles(run, {}, dbDir());
    expect(await failureAs("gtnh_live", "select id from community_plans")).toMatch(
      /permission denied/,
    );
    expect(await failureAs("gtnh_live", "select name from library_designs")).toMatch(
      /permission denied/,
    );
  });

  it("gives a role with a password login, and sends the password only as a bound parameter with logging off", async () => {
    const site = "site-password-for-the-test-0123456789";
    const live = "live-password-for-the-test-0123456789";
    const sent: { text: string; params?: unknown[] }[] = [];
    const recording: RunSql = (text, params) => {
      sent.push({ text, params });
      return run(text, params);
    };
    try {
      await ensureRoles(recording, { site, live }, dbDir());
      const { rows } = await pglite.query<{ rolname: string; rolcanlogin: boolean; scram: boolean }>(
        `select rolname, rolcanlogin, rolpassword like 'SCRAM-SHA-256$%' as scram
         from pg_authid where rolname in ('gtnh_site', 'gtnh_live') order by rolname`,
      );
      expect(rows).toEqual([
        { rolname: "gtnh_live", rolcanlogin: true, scram: true },
        { rolname: "gtnh_site", rolcanlogin: true, scram: true },
      ]);
      for (const statement of sent) {
        expect(statement.text).not.toContain(site);
        expect(statement.text).not.toContain(live);
      }
      const holding = sent.flatMap((statement, at) =>
        statement.params?.some((param) => param === site || param === live) ? [at] : [],
      );
      expect(holding).toHaveLength(2);
      const begin = sent.findIndex((statement) => statement.text.trim() === "begin");
      const quiet = sent.findIndex((statement) =>
        statement.text.includes("set local log_min_error_statement = panic;"),
      );
      expect(sent[quiet]?.text).toContain("set local log_statement = 'none';");
      expect(sent[quiet]?.text).toContain("set local log_min_duration_statement = -1;");
      expect(begin).toBeGreaterThanOrEqual(0);
      expect(quiet).toBeGreaterThan(begin);
      const commit = sent.findIndex((statement) => statement.text.trim() === "commit");
      for (const at of holding) {
        expect(at).toBeGreaterThan(quiet);
        expect(at).toBeLessThan(commit);
      }
    } finally {
      // Back to nologin for the cases that enter the roles with set role.
      await ensureRoles(run, {}, dbDir());
    }
    const { rows } = await pglite.query<{ rolcanlogin: boolean }>(
      "select rolcanlogin from pg_roles where rolname in ('gtnh_site', 'gtnh_live')",
    );
    expect(rows).toEqual([{ rolcanlogin: false }, { rolcanlogin: false }]);
  });
});
