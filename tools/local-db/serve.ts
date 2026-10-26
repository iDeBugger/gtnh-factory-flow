/**
 * The local development database, served so the Next.js dev server and the
 * live service (two processes) share one copy over Postgres's wire protocol
 * on 127.0.0.1:54330 (LOCAL_DB_PG_PORT), their `DATABASE_URL`. A small
 * control listener on 127.0.0.1:54329 (LOCAL_DB_PORT) answers
 * `GET /__local-db/ready` once the migrations are applied and stops this
 * process on `POST /__local-db/shutdown` (how dev-local stops it on Windows,
 * where a child gets no signal).
 *
 *   npx tsx tools/local-db/serve.ts
 *
 * `npm run dev:local` starts it with everything else. Development only: it
 * checks no keys and listens on this machine alone.
 *
 * Which Postgres answers on 54330, and why. The isolation probe
 * (scratch/probes/pglite-socket-isolation.mjs) ran `PGLiteSocketServer` over a
 * file PGlite. Its multiplexer (`maxConnections: 4`) keeps one open
 * transaction apart from another client, by holding that client's queries
 * until it ends, but under load (two pools of 2, 200 mixed queries) it
 * interleaves the clients' protocol messages on PGlite's one session: queries
 * failed with "unnamed prepared statement does not exist", and another
 * client's rollback took autocommitted inserts with it (29 rows kept of 75).
 * With `maxConnections: 1` a second client is refused outright (ECONNRESET),
 * so Next and the live service could not both hold a connection. Neither is
 * a database two processes can share, so:
 * - with LOCAL_DB_POSTGRES_URL set (dev-local sets it when Docker answers and
 *   it has started the compose file's pinned `postgres` image on 54330), both
 *   processes use that real Postgres directly: this process applies the
 *   migrations to it and opens no PGlite;
 * - without it, PGlite, data in scratch/local-db/pgdata (or LOCAL_DB_DIR),
 *   and its socket on 54330 through the multiplexer, which serves light
 *   single-player use only. dev-local says so when it starts this way.
 */
import { createServer } from "node:http";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import pg from "pg";
import { hearConnectionErrors } from "../../src/lib/server/db/client";
import { applyMigrations } from "../../src/lib/server/db/migrations";
import { DB_TYPE_PARSERS } from "../../src/lib/server/db/parsers";

interface Served {
  describe: string;
  close(): Promise<void>;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A real Postgres: the migrations, once it takes connections (a fresh container initialises first). */
async function servePostgres(url: string): Promise<Served> {
  const pool = new pg.Pool({ connectionString: url, max: 1, application_name: "gtnh-local-db" });
  hearConnectionErrors(pool, "local-db");
  const until = Date.now() + 90_000;
  for (;;) {
    try {
      await pool.query("select 1");
      break;
    } catch (error) {
      if (Date.now() > until) {
        throw error;
      }
      await sleep(500);
    }
  }
  await applyMigrations({ exec: (text) => pool.query(text) });
  await pool.end();
  return { describe: `Postgres at ${url}`, close: async () => undefined };
}

/** PGlite on disk, with its wire-protocol socket. */
async function servePglite(dir: string, pgPort: number): Promise<Served> {
  mkdirSync(dir, { recursive: true });
  const db = new PGlite({ dataDir: dir, parsers: DB_TYPE_PARSERS });
  // The timestamp parser reads UTC only, as every pool session runs.
  await db.exec("set time zone 'UTC'");
  await applyMigrations(db);
  const socket = new PGLiteSocketServer({ db, host: "127.0.0.1", port: pgPort, maxConnections: 4 });
  await socket.start();
  return {
    describe: `Postgres (PGlite) at ${dir}, its socket on 127.0.0.1:${pgPort}`,
    close: async () => {
      await socket.stop();
      await db.close();
    },
  };
}

async function main() {
  const port = Number(process.env.LOCAL_DB_PORT ?? 54329);
  const pgPort = Number(process.env.LOCAL_DB_PG_PORT ?? 54330);
  const dir = path.resolve(process.env.LOCAL_DB_DIR ?? path.join("scratch", "local-db", "pgdata"));
  const postgresUrl = process.env.LOCAL_DB_POSTGRES_URL;

  const served = postgresUrl ? await servePostgres(postgresUrl) : await servePglite(dir, pgPort);

  let closing = false;
  const shutdown = async () => {
    if (closing) {
      return;
    }
    closing = true;
    server.close();
    await served.close();
    console.log("closed");
    process.exit(0);
  };

  const server = createServer((req, res) => {
    if (req.method === "POST" && req.url === "/__local-db/shutdown") {
      res.writeHead(200).end();
      void shutdown();
      return;
    }
    if (req.method === "GET" && req.url === "/__local-db/ready") {
      res.writeHead(200, { "content-type": "text/plain" }).end("ready");
      return;
    }
    res.writeHead(404).end();
  });

  server.listen(port, "127.0.0.1", () => {
    console.log(`${served.describe}, control on http://127.0.0.1:${port}`);
  });

  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

void main().catch((error) => {
  console.error("[local-db] could not start:", error);
  process.exit(1);
});
