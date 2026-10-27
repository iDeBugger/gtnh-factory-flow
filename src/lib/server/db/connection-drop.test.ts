import net from "node:net";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { useTestDb } from "@/test-support/test-db";
import { createDbClient, type DirectDbClient } from "./client";
import { DatabaseDownError } from "./errors";

/**
 * A connection the server drops while a query holds it (Postgres restarting,
 * the idle-in-transaction timeout ending a stuck transaction) fails that work
 * as down and never reaches the process as an uncaught error; the pool opens
 * a fresh connection for the next query.
 */

const testDb = useTestDb();
let server: PGLiteSocketServer;
let proxy: net.Server;
const sockets: net.Socket[] = [];
let wire: DirectDbClient;
const uncaught: unknown[] = [];
const hear = (error: unknown) => uncaught.push(error);

beforeAll(async () => {
  server = new PGLiteSocketServer({ db: testDb().pglite, port: 0, host: "127.0.0.1" });
  await server.start();
  const [host, port] = server.getServerConn().split(":");
  // A proxy in front of the socket, so a test can cut every connection at once.
  proxy = net.createServer((client) => {
    const upstream = net.connect(Number(port), host);
    sockets.push(client, upstream);
    client.on("error", () => undefined);
    upstream.on("error", () => undefined);
    client.pipe(upstream);
    upstream.pipe(client);
  });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const address = proxy.address() as net.AddressInfo;
  wire = createDbClient("site", {
    DATABASE_URL: `postgres://postgres@127.0.0.1:${address.port}/postgres`,
    DATABASE_POOL_MAX: "1",
  });
  process.on("uncaughtException", hear);
}, 60_000);

afterAll(async () => {
  process.off("uncaughtException", hear);
  await wire?.db.destroy();
  await new Promise((resolve) => proxy?.close(resolve));
  await server?.stop();
});

describe("a dropped connection", () => {
  it("fails the transaction holding it as down, and the next query gets a fresh one", async () => {
    await expect(sql`select 1 as x`.execute(wire.db)).resolves.toMatchObject({ rows: [{ x: 1 }] });
    const failed = await wire.db
      .transaction()
      .execute(async (tx) => {
        await sql`select 1`.execute(tx);
        for (const socket of sockets.splice(0)) socket.destroy();
        await new Promise((resolve) => setTimeout(resolve, 300));
        await sql`select 2`.execute(tx);
      })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(failed).toBeInstanceOf(DatabaseDownError);
    expect(uncaught).toEqual([]);
    await expect(sql`select 3 as y`.execute(wire.db)).resolves.toMatchObject({ rows: [{ y: 3 }] });
  });
});
