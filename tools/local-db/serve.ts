/**
 * The local development database, served so the site's dev server and the
 * live service (two processes) share one copy over Postgres's wire protocol
 * on 127.0.0.1:54330 (LOCAL_DB_PG_PORT), their `DATABASE_URL`. A small
 * control listener on 127.0.0.1:54329 (LOCAL_DB_PORT) answers
 * `GET /__local-db/ready` once the migrations are applied and stops this
 * process on `POST /__local-db/shutdown` with dev-local's control header
 * (`control.mjs`; how dev-local stops it on Windows, where a child gets no
 * signal).
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
import {
  applyMigrations,
  dbDir,
  MigrationError,
  sqlRunner,
} from "../../src/lib/server/db/migrations";
import { DB_TYPE_PARSERS } from "../../src/lib/server/db/parsers";
import { controlHandler } from "./control.mjs";

interface Served {
  describe: string;
  close(): Promise<void>;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function announce(name: string): void {
  console.log(`[local-db] migrate: ${name}`);
}

/** A database the runner refuses for having no ledger says how to start it fresh. */
function withResetHint(error: unknown, what: string): unknown {
  if (error instanceof MigrationError && /not set up by the migration runner/.test(error.message)) {
    return new Error(`${error.message}. Development data only: remove ${what} and start again.`, {
      cause: error,
    });
  }
  return error;
}

/** A real Postgres: the migrations, once it takes connections (a fresh container initialises first). */
async function servePostgres(url: string): Promise<Served> {
  const until = Date.now() + 90_000;
  for (;;) {
    // One session: the runner's lock and each file's transaction belong to it.
    const client = new pg.Client({ connectionString: url, application_name: "gtnh-local-db" });
    client.on("error", (error) => console.error(`[local-db] connection lost: ${error.message}`));
    try {
      await client.connect();
    } catch (error) {
      await client.end().catch(() => undefined);
      if (Date.now() > until) {
        throw error;
      }
      await sleep(500);
      continue;
    }
    try {
      await applyMigrations(sqlRunner(client), dbDir(), { onApplied: announce });
    } catch (error) {
      throw withResetHint(
        error,
        "the container's volume (docker rm -f gtnh-local-db; docker volume rm gtnh-local-db)",
      );
    } finally {
      await client.end();
    }
    break;
  }
  return { describe: `Postgres at ${url}`, close: async () => undefined };
}

/** PGlite on disk, with its wire-protocol socket. */
async function servePglite(dir: string, pgPort: number): Promise<Served> {
  mkdirSync(dir, { recursive: true });
  const db = new PGlite({ dataDir: dir, parsers: DB_TYPE_PARSERS });
  // The timestamp parser reads UTC only, as every pool session runs.
  await db.exec("set time zone 'UTC'");
  try {
    await applyMigrations(sqlRunner(db), dbDir(), { onApplied: announce });
  } catch (error) {
    await db.close();
    throw withResetHint(error, dir);
  }
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

  const server = createServer(controlHandler({ onShutdown: () => void shutdown() }));

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
