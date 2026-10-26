import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, resetDbBreaker, useDbForTests } from "../db";
import { createDbClient, type DirectDbClient } from "../db/client";
import { applyMigrations } from "../db/migrations";
import type { Viewer } from "../http/viewer";
import { downloadBlueprint } from "./blueprints";

/**
 * Blueprint downloads on a real Postgres, where each request runs on a
 * connection of its own (on PGlite statements never overlap). Runs only
 * with GTNH_TEST_POSTGRES_URL naming a server this test may make and drop a
 * database on, for example a throwaway container:
 *
 *   docker run -d --name <yours> -e POSTGRES_PASSWORD=race -p 127.0.0.1:<port>:5432 postgres:17
 *   GTNH_TEST_POSTGRES_URL=postgres://postgres:race@127.0.0.1:<port>/postgres npx vitest run <this file>
 */

const serverUrl = process.env.GTNH_TEST_POSTGRES_URL;
const database = `gtnh_blueprint_race_${process.pid}`;
let admin: pg.Client | undefined;
let client: DirectDbClient | undefined;
let author: Viewer;

async function makeBlueprint(name: string): Promise<string> {
  const { rows } = await client!.pool.query<{ id: string }>(
    `insert into blueprints (user_id, name, payload, is_public, author_name, published_at)
     values ($1, $2, '{"nodes":[]}', true, 'racer', now()) returning id`,
    [author.userId, name],
  );
  return rows[0]!.id;
}

async function storedDownloads(blueprintId: string): Promise<number> {
  const { rows } = await client!.pool.query<{ downloads: number }>(
    "select downloads from blueprints where id = $1",
    [blueprintId],
  );
  return rows[0]!.downloads;
}

describe.skipIf(!serverUrl)("blueprint downloads on Postgres", () => {
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
    author = { userId: rows[0]!.id, username: "racer", isAdmin: false, adminToken: false };
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

  it("counts twenty downloads that arrive at once as twenty", async () => {
    const blueprintId = await makeBlueprint("Wanted");
    const anonymous: Viewer = { isAdmin: false, adminToken: false };
    const answers = await Promise.all(Array.from({ length: 20 }, () => downloadBlueprint(anonymous, blueprintId)));
    const counted = answers.map((answer) => (answer.ok ? answer.value.blueprint.downloads : 0)).sort((a, b) => a - b);
    expect(counted).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    expect(await storedDownloads(blueprintId)).toBe(20);
  });

  it("counts the readers among the author's own downloads at the same moment, and only them", async () => {
    const blueprintId = await makeBlueprint("Shared");
    const reader: Viewer = { userId: "00000000-0000-4000-8000-000000000001", isAdmin: false, adminToken: false };
    const answers = await Promise.all(
      Array.from({ length: 20 }, (_, i) => downloadBlueprint(i % 2 === 0 ? author : reader, blueprintId)),
    );
    expect(answers.every((answer) => answer.ok)).toBe(true);
    expect(await storedDownloads(blueprintId)).toBe(10);
  });
});
