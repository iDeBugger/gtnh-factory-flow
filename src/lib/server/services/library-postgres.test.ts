import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { LIBRARY_MAX_DESIGNS } from "@/lib/library/sync-types";
import { PROJECT_SCHEMA_VERSION } from "@/lib/model/types";
import { closeDb, resetDbBreaker, useDbForTests } from "../db";
import { createDbClient, type DirectDbClient } from "../db/client";
import { applyMigrations } from "../db/migrations";
import type { SignedIn } from "../http/viewer";
import * as accounts from "../repos/accounts";
import { saveDesign } from "./library";

/**
 * The library's creation cap on a real Postgres, where each request runs on
 * a connection of its own and transactions overlap (on PGlite they never
 * do). Runs only with GTNH_TEST_POSTGRES_URL naming a server this test may
 * make and drop a database on, for example a throwaway container:
 *
 *   docker run -d --name <yours> -e POSTGRES_PASSWORD=race -p 127.0.0.1:<port>:5432 postgres:17
 *   GTNH_TEST_POSTGRES_URL=postgres://postgres:race@127.0.0.1:<port>/postgres npx vitest run <this file>
 */

// The save's rate limit queues one account's requests in this process
// (`serially`), which spaces their transactions out; without it they all
// start at once, as requests from several site processes would.
vi.mock("../limits/rate-limit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../limits/rate-limit")>()),
  checkRateLimit: async () => true,
}));

const serverUrl = process.env.GTNH_TEST_POSTGRES_URL;
const database = `gtnh_library_race_${process.pid}`;
let admin: pg.Client | undefined;
let client: DirectDbClient | undefined;
let viewer: SignedIn;

function plan(name: string) {
  return {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    id: `plan-${name}`,
    name,
    recipes: [],
    nodes: [],
    storages: [],
    edges: [],
    fuelProfiles: [],
  };
}

describe.skipIf(!serverUrl)("the library on Postgres", () => {
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
    viewer = { userId: rows[0]!.id, username: "racer", isAdmin: false, adminToken: false };
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

  it("holds the design cap when twenty creations arrive at once", async () => {
    const free = 10;
    await client!.pool.query(
      `insert into library_designs (user_id, id, name, plan)
       select $1, 'seeded-' || n, 'Seeded', '{}' from generate_series(1, $2::int) as n`,
      [viewer.userId, LIBRARY_MAX_DESIGNS - free],
    );
    const stamp = "2026-10-26T10:00:00.000Z";
    const answers = await Promise.all(
      Array.from({ length: 20 }, (_, n) =>
        saveDesign(viewer, viewer.userId, `race-${n}`, {
          name: `Race ${n}`,
          createdAt: stamp,
          updatedAt: stamp,
          planUpdatedAt: stamp,
          plan: plan(`race-${n}`),
        }),
      ),
    );
    const failures = answers.filter((answer) => !answer.ok);
    expect(answers.length - failures.length).toBe(free);
    for (const failure of failures) {
      expect(failure).toMatchObject({
        ok: false,
        error: { kind: "conflict", message: `Your plans are full (${LIBRARY_MAX_DESIGNS} designs). Delete some first.` },
      });
    }
    const { rows } = await client!.pool.query<{ count: string }>(
      "select count(*) from library_designs where user_id = $1 and deleted_at is null",
      [viewer.userId],
    );
    expect(Number(rows[0]!.count)).toBe(LIBRARY_MAX_DESIGNS);
  }, 60_000);

  it("lets a row naming the account in while a creation holds the account's lock", async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    let locked: () => void = () => undefined;
    const lockTaken = new Promise<void>((resolve) => (locked = resolve));
    const creation = client!.db.transaction().execute(async (tx) => {
      await accounts.lockAccount(viewer.userId, tx);
      locked();
      await held;
    });
    await lockTaken;
    try {
      // A foreign-key check takes a key-share lock on the account row.
      const other = await client!.pool.connect();
      try {
        await other.query("set lock_timeout = 2000");
        await other.query(
          "insert into library_designs (user_id, id, name, plan) values ($1, 'during-lock', 'x', '{}')",
          [viewer.userId],
        );
        // A second creation's lock waits for the first.
        await other.query("begin");
        await expect(
          other.query("select id from community_users where id = $1 for no key update nowait", [viewer.userId]),
        ).rejects.toThrow(/could not obtain lock/);
        await other.query("rollback");
      } finally {
        other.release();
      }
    } finally {
      release();
      await creation;
    }
  }, 60_000);
});
