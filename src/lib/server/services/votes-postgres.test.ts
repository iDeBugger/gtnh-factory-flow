import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { closeDb, getDb, resetDbBreaker, useDbForTests } from "../db";
import { createDbClient, type DirectDbClient } from "../db/client";
import { applyMigrations } from "../db/migrations";
import type { Viewer } from "../http/viewer";
import { castVote, type VoteTarget } from "./votes";

/**
 * Votes on a real Postgres, where each request runs on a connection of its
 * own and transactions overlap (on PGlite they never do, so the cases in
 * `plan-access.test.ts` and `blueprints/vote.test.ts` cannot show a race).
 * Runs only with GTNH_TEST_POSTGRES_URL naming a server this test may make
 * and drop a database on, for example a throwaway container:
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
// Blueprints still read through PostgREST, which this file has none of: the
// access read comes from the same database directly.
vi.mock("../repos/blueprints", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../repos/blueprints")>()),
  readAccess: async (id: string) =>
    getDb().selectFrom("blueprints").select(["id", "user_id", "is_public"]).where("id", "=", id).executeTakeFirst(),
}));

const serverUrl = process.env.GTNH_TEST_POSTGRES_URL;
const database = `gtnh_vote_race_${process.pid}`;
let admin: pg.Client | undefined;
let client: DirectDbClient | undefined;
let authorId: string;

const anonymous: Viewer = { isAdmin: false, adminToken: false };
const fromAddress = (address: string) =>
  new Request("http://localhost/", { method: "POST", headers: { "x-client-ip": address } });

async function makeTarget(target: VoteTarget, name: string): Promise<string> {
  const { rows } = await client!.pool.query<{ id: string }>(
    target === "plan"
      ? `insert into community_plans (user_id, author_name, name, game_version, plan, uploader_key)
         values ($1, 'racer', $2, 'race', '{"nodes":[]}', 'test') returning id`
      : `insert into blueprints (user_id, name, payload, is_public) values ($1, $2, '{"nodes":[]}', true) returning id`,
    [authorId, name],
  );
  return rows[0]!.id;
}

/** The row's counters beside a count of its vote rows. */
async function tally(target: VoteTarget, id: string) {
  const [parent, votes, key] =
    target === "plan"
      ? ["community_plans", "community_votes", "plan_id"]
      : ["blueprints", "blueprint_votes", "blueprint_id"];
  const { rows } = await client!.pool.query<{ upvotes: number; downvotes: number; up: number; down: number }>(
    `select p.upvotes, p.downvotes,
       (select count(*)::int from ${votes} v where v.${key} = p.id and v.value = 1) as up,
       (select count(*)::int from ${votes} v where v.${key} = p.id and v.value = -1) as down
     from ${parent} p where p.id = $1`,
    [id],
  );
  return rows[0]!;
}

describe.skipIf(!serverUrl)("votes on Postgres", () => {
  beforeAll(async () => {
    admin = new pg.Client({ connectionString: serverUrl });
    await admin.connect();
    await admin.query(`create database ${database}`);
    const url = new URL(serverUrl!);
    url.pathname = `/${database}`;
    const setup = new pg.Client({ connectionString: url.toString() });
    await setup.connect();
    await applyMigrations({ exec: (text) => setup.query(text) });
    const { rows } = await setup.query<{ id: string }>(
      "insert into community_users (username, password_hash) values ('racer', 'h') returning id",
    );
    authorId = rows[0]!.id;
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

  for (const target of ["plan", "blueprint"] as const) {
    it(`lands ten votes at once from ten addresses on one ${target} as ten`, async () => {
      const id = await makeTarget(target, "Rushed");
      const answers = await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          castVote(target, id, anonymous, { deviceId: `rush-${i}`, value: 1 }, fromAddress(`10.8.0.${i + 1}`)),
        ),
      );
      expect(answers.every((answer) => answer.ok)).toBe(true);
      expect(await tally(target, id)).toEqual({ upvotes: 10, downvotes: 0, up: 10, down: 0 });
    });

    it(`keeps one ${target}'s counters equal to its votes while each voter toggles at once`, async () => {
      const id = await makeTarget(target, "Toggled");
      // Others' votes stand throughout; the togglers cast, switch and retract against them.
      await Promise.all(
        Array.from({ length: 3 }, (_, i) =>
          castVote(target, id, anonymous, { deviceId: `steady-${i}`, value: -1 }, fromAddress(`10.8.1.${i + 1}`)),
        ),
      );
      for (let round = 0; round < 6; round++) {
        // Four voters, each sending four votes at once: the same voter's
        // requests race each other as well as the other voters'.
        const answers = await Promise.all(
          Array.from({ length: 16 }, (_, i) =>
            castVote(
              target,
              id,
              anonymous,
              { deviceId: `toggler-${i % 4}`, value: i % 3 === 0 ? -1 : 1 },
              fromAddress(`10.8.2.${(i % 4) + 1}`),
            ),
          ),
        );
        expect(answers.every((answer) => answer.ok)).toBe(true);
        const counted = await tally(target, id);
        expect(counted.upvotes, `round ${round}`).toBe(counted.up);
        expect(counted.downvotes, `round ${round}`).toBe(counted.down);
        expect(counted.down).toBeGreaterThanOrEqual(3);
      }
    });
  }
});
