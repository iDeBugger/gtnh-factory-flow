/**
 * The local development database, served so the Next.js dev server and the
 * live service (two processes) share one copy, through both clients:
 * - the PostgREST stand-in over HTTP on 127.0.0.1:54329 (LOCAL_DB_PORT), for
 *   `getCommunityDb`;
 * - Postgres's wire protocol on 127.0.0.1:54330 (LOCAL_DB_PG_PORT), for the
 *   direct client (`getDb`, `DATABASE_URL`).
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
 *   clients use that real Postgres: the stand-in runs over a `pg` pool to it
 *   and this process opens no PGlite;
 * - without it, PGlite as before, data in scratch/local-db/pgdata (or
 *   LOCAL_DB_DIR), and its socket on 54330 through the multiplexer, which
 *   serves light single-player use only. dev-local says so when it starts
 *   this way.
 */
import { createServer } from "node:http";
import path from "node:path";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import pg from "pg";
import { applyMigrations } from "../../src/lib/server/db/migrations";
import { DB_TYPE_PARSERS } from "../../src/lib/server/db/parsers";
import { openLocalDatabase } from "../../src/lib/server/local-db/database";
import {
  createPostgrestHandler,
  type PostgrestHandler,
} from "../../src/lib/server/local-db/postgrest";
import { BodyTooLargeError, sendWebResponse, toWebRequest } from "@/lib/server/http/node-http";

interface Served {
  handle: PostgrestHandler;
  describe: string;
  close(): Promise<void>;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The stand-in over a real Postgres, once it takes connections (a fresh container initialises first). */
async function servePostgres(url: string): Promise<Served> {
  const pool = new pg.Pool({
    connectionString: url,
    max: 4,
    application_name: "gtnh-local-db",
    options: "-c TimeZone=UTC",
    types: {
      getTypeParser: ((oid: number, format?: "text" | "binary") =>
        (format !== "binary" && DB_TYPE_PARSERS[oid]) ||
        pg.types.getTypeParser(oid, format)) as pg.CustomTypesConfig["getTypeParser"],
    },
  });
  pool.on("error", (error) => console.error(`[local-db] idle connection lost: ${error.message}`));
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
  const handle = createPostgrestHandler({
    query: async (text, params) => ({
      rows: (await pool.query(text, params)).rows as Record<string, unknown>[],
    }),
    exec: (text) => pool.query(text),
  });
  await handle.reloadSchema();
  return { handle, describe: `Postgres at ${url}`, close: () => pool.end() };
}

/** PGlite on disk, with its wire-protocol socket for the direct client. */
async function servePglite(dir: string, pgPort: number): Promise<Served> {
  const local = await openLocalDatabase({ dir });
  const socket = new PGLiteSocketServer({
    db: local.db,
    host: "127.0.0.1",
    port: pgPort,
    maxConnections: 4,
  });
  await socket.start();
  return {
    handle: local.handle,
    describe: `Postgres (PGlite) at ${dir}, its socket on 127.0.0.1:${pgPort}`,
    close: async () => {
      await socket.stop();
      await local.close();
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
    void (async () => {
      // How dev-local stops it on Windows, where a child gets no signal.
      if (req.method === "POST" && req.url === "/__local-db/shutdown") {
        res.writeHead(200).end();
        await shutdown();
        return;
      }
      try {
        await sendWebResponse(res, await served.handle(await toWebRequest(req, 64 * 1024 * 1024)));
      } catch (error) {
        const status = error instanceof BodyTooLargeError ? 413 : 500;
        res.writeHead(status, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            code: "PGRST000",
            message: error instanceof Error ? error.message : "error",
          }),
        );
      }
    })();
  });

  server.listen(port, "127.0.0.1", () => {
    console.log(`${served.describe}, serving http://127.0.0.1:${port}`);
  });

  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

void main().catch((error) => {
  console.error("[local-db] could not start:", error);
  process.exit(1);
});
