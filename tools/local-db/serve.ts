/**
 * The local development database, served over HTTP so the Next.js dev server
 * and the live service (two processes) share one copy: PGlite on
 * `scratch/local-db/pgdata` (or LOCAL_DB_DIR), answering the server's
 * PostgREST requests on 127.0.0.1:54329 (LOCAL_DB_PORT).
 *
 *   npx tsx tools/local-db/serve.ts
 *
 * `npm run dev:local` starts it with everything else. Development only: it
 * checks no keys and listens on this machine alone.
 */
import { createServer } from "node:http";
import path from "node:path";
import { openLocalDatabase } from "../../src/lib/server/local-db/database";
import { BodyTooLargeError, sendWebResponse, toWebRequest } from "@/lib/server/http/node-http";

async function main() {
  const port = Number(process.env.LOCAL_DB_PORT ?? 54329);
  const dir = path.resolve(process.env.LOCAL_DB_DIR ?? path.join("scratch", "local-db", "pgdata"));

  const local = await openLocalDatabase({ dir });

  let closing = false;
  const shutdown = async () => {
    if (closing) {
      return;
    }
    closing = true;
    server.close();
    await local.close();
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
        await sendWebResponse(res, await local.handle(await toWebRequest(req, 64 * 1024 * 1024)));
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
    console.log(`Postgres (PGlite) at ${dir}, serving http://127.0.0.1:${port}`);
  });

  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

void main().catch((error) => {
  console.error("[local-db] could not start:", error);
  process.exit(1);
});
