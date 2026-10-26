import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { useTestDb } from "@/test-support/test-db";
import { createDbClient, type DirectDbClient } from "./client";
import { json } from "./parsers";
import type { Database } from "./schema";

/**
 * The pool (`pg` over the wire) and the tests' PGlite (in process) read the
 * same row as the same values: one parser table, one SQL, so a suite green on
 * PGlite says the same of production.
 */

const testDb = useTestDb();
let server: PGLiteSocketServer;
let wire: DirectDbClient;

beforeAll(async () => {
  server = new PGLiteSocketServer({ db: testDb().pglite, port: 0, host: "127.0.0.1" });
  await server.start();
  const url = `postgres://postgres@${server.getServerConn()}/postgres`;
  // One connection: the socket's multiplexer is not under test here.
  wire = createDbClient("site", { DATABASE_URL: url, DATABASE_POOL_MAX: "1" });
}, 60_000);

afterAll(async () => {
  await wire?.db.destroy();
  await server?.stop();
});

const both = (): [string, Kysely<Database>][] => [
  ["pg", wire.db],
  ["PGlite", testDb().db],
];

async function seedDesign(): Promise<string> {
  const { db } = testDb();
  const user = await db
    .insertInto("community_users")
    .values({ username: `u${Math.random().toString(36).slice(2, 10)}`, password_hash: "x" })
    .returning("id")
    .executeTakeFirstOrThrow();
  await db
    .insertInto("library_designs")
    .values({
      user_id: user.id,
      id: "d1",
      name: "Steel",
      plan: json({ nodes: [] }),
      icon: json([{ kind: "item", id: "minecraft:iron_ingot" }]),
      seq: 7,
      created_at: "2026-10-25T17:33:50.431+00:00",
      updated_at: "2026-10-25T17:33:51+00:00",
    })
    .execute();
  return user.id;
}

describe("the two drivers", () => {
  it("pg and PGlite read a row the same", async () => {
    const userId = await seedDesign();
    const read = (db: Kysely<Database>) =>
      db
        .selectFrom("library_designs")
        .select(["id", "name", "seq", "icon", "plan", "created_at", "updated_at", "plan_bytes"])
        .where("user_id", "=", userId)
        .executeTakeFirstOrThrow();
    const [viaPg, viaPglite] = [await read(wire.db), await read(testDb().db)];
    expect(viaPg).toStrictEqual(viaPglite);
    expect(viaPg).toMatchObject({
      seq: 7,
      icon: [{ kind: "item", id: "minecraft:iron_ingot" }],
      created_at: "2026-10-25T17:33:50.431+00:00",
      updated_at: "2026-10-25T17:33:51+00:00",
    });
    expect(typeof viaPg.plan_bytes).toBe("number");
  });

  it("a jsonb array written through json() reads back as JSON", async () => {
    const userId = await seedDesign();
    for (const [name, db] of both()) {
      const tags = [name, "steel", { tier: 2 }];
      await db
        .updateTable("library_designs")
        .set({ icon: json(tags), plan: json({}) })
        .where("user_id", "=", userId)
        .execute();
      const row = await db
        .selectFrom("library_designs")
        .select(["icon", "plan"])
        .where("user_id", "=", userId)
        .executeTakeFirstOrThrow();
      expect(row, name).toStrictEqual({ icon: tags, plan: {} });
    }
  });
});
