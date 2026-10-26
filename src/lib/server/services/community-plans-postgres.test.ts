import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { closeDb, resetDbBreaker, useDbForTests, withTransaction } from "../db";
import { createDbClient, type DirectDbClient } from "../db/client";
import { applyMigrations, dbDir, sqlRunner } from "../db/migrations";
import type { SignedIn, Viewer } from "../http/viewer";
import * as plans from "../repos/plans";
import { addComment } from "./comments";
import { countPlanView } from "./community-plans";

/**
 * Community counters and comment figures on a real Postgres, where each
 * request runs on a connection of its own and transactions overlap (on
 * PGlite they never do). Runs only with GTNH_TEST_POSTGRES_URL naming a
 * server this test may make and drop a database on, for example a throwaway
 * container:
 *
 *   docker run -d --name <yours> -e POSTGRES_PASSWORD=race -p 127.0.0.1:<port>:5432 postgres:17
 *   GTNH_TEST_POSTGRES_URL=postgres://postgres:race@127.0.0.1:<port>/postgres npx vitest run <this file>
 */

// The rate limits queue one key's requests in this process (`serially`),
// which spaces their statements out; without them the requests all start at
// once, as requests from several site processes would.
vi.mock("../limits/rate-limit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../limits/rate-limit")>()),
  checkRateLimit: async () => true,
}));

const serverUrl = process.env.GTNH_TEST_POSTGRES_URL;
const database = `gtnh_community_race_${process.pid}`;
let admin: pg.Client | undefined;
let client: DirectDbClient | undefined;
let poster: SignedIn;

async function makePost(name: string): Promise<string> {
  const { rows } = await client!.pool.query<{ id: string }>(
    `insert into community_plans (user_id, author_name, name, game_version, plan, uploader_key)
     values ($1, 'racer', $2, 'race', '{"nodes":[]}', 'test') returning id`,
    [poster.userId, name],
  );
  return rows[0]!.id;
}

describe.skipIf(!serverUrl)("community posts on Postgres", () => {
  beforeAll(async () => {
    admin = new pg.Client({ connectionString: serverUrl });
    await admin.connect();
    await admin.query(`create database ${database}`);
    const url = new URL(serverUrl!);
    url.pathname = `/${database}`;
    const setup = new pg.Client({ connectionString: url.toString() });
    await setup.connect();
    await applyMigrations(sqlRunner(setup), dbDir());
    const { rows } = await setup.query<{ id: string }>(
      "insert into community_users (username, password_hash) values ('racer', 'h') returning id",
    );
    poster = { userId: rows[0]!.id, username: "racer", isAdmin: false, adminToken: false };
    await setup.end();
    client = createDbClient("site", { DATABASE_URL: url.toString(), DATABASE_POOL_MAX: "12" });
    useDbForTests(client.db);
  }, 60_000);

  afterAll(async () => {
    useDbForTests(undefined);
    await client?.db.destroy();
    await closeDb();
    resetDbBreaker();
    await admin?.query(`drop database if exists ${database} with (force)`);
    await admin?.end();
  });

  it("counts twenty views that arrive at once as twenty", async () => {
    const planId = await makePost("Watched");
    const anonymous: Viewer = { isAdmin: false, adminToken: false };
    const answers = await Promise.all(
      Array.from({ length: 20 }, () =>
        countPlanView(anonymous, planId, new Request("http://localhost/", { headers: { "x-client-ip": "10.9.0.1" } })),
      ),
    );
    expect(answers.every((answer) => answer.ok)).toBe(true);
    const counted = answers.map((answer) => (answer.ok ? answer.value.views : 0)).sort((a, b) => a - b);
    expect(counted).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    const { rows } = await client!.pool.query<{ views: number }>(
      "select views from community_plans where id = $1",
      [planId],
    );
    expect(rows[0]!.views).toBe(20);
  });

  it("keeps a post's comment count equal to its comments when ten land at once", async () => {
    const planId = await makePost("Busy thread");
    const answers = await Promise.all(
      Array.from({ length: 10 }, (_, i) => addComment(poster, planId, poster.userId, { body: `Comment ${i}` })),
    );
    expect(answers.every((answer) => answer.ok)).toBe(true);
    const { rows } = await client!.pool.query<{ comment_count: number; live: number; same_latest: boolean }>(
      `select p.comment_count, count(c.id) as live, p.last_comment_at = max(c.created_at) as same_latest
       from community_plans p join community_comments c on c.plan_id = p.id
       where p.id = $1 group by p.id`,
      [planId],
    );
    expect(rows[0]).toEqual({ comment_count: 10, live: 10, same_latest: true });
  });

  it("reads a page and its count on one snapshot, whatever commits between them", async () => {
    await makePost("Before");
    const query: plans.PlanListQuery = {
      search: { tags: [], author: "", bareAuthor: false, text: "" },
      gameVersion: "race",
      makes: [],
      takes: [],
      shelf: { kind: "public" },
      sort: { column: "created_at", ascending: false, nullsLast: false },
      offset: 0,
      limit: 100,
    };
    const result = await withTransaction(
      async (tx) => {
        const first = await plans.list(query, tx);
        // Committed on another connection while the snapshot is open.
        await makePost("Between");
        const second = await plans.list(query, tx);
        return { first, second };
      },
      { readSnapshot: true },
    );
    expect(result.second).toEqual(result.first);
    expect(result.first.total).toBe(result.first.rows.length);
    expect((await plans.list(query)).total).toBe(result.first.total + 1);
  });
});
