/**
 * The live service's entry point (systemd unit `gtnh-live` in production,
 * `npm run dev:local` here). Development: `tsx src/live/main.ts`. Production:
 * `npm run build:live` bundles this to `dist-live/live.mjs`, run with plain
 * `node dist-live/live.mjs` from the release directory.
 *
 * Environment:
 * - COMMUNITY_HASH_SALT: the session secret, the same as the website's.
 * - SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY: the database (or LOCAL_DB=1 and
 *   LOCAL_DB_URL for the local one).
 * - LIVE_PORT (3001), LIVE_HOST (127.0.0.1).
 * - LIVE_JOURNAL_DIR: where unflushed batches are kept (required in production).
 * - LIVE_INTERNAL_TOKEN: shared with the website for /internal/*.
 * - LIVE_ALLOWED_ORIGINS: comma-separated browser origins (default: localhost:3000).
 * - LIVE_MAX_ROOMS: plans open at once in the whole service (default 500).
 */
import path from "node:path";
import { isCommunityConfigured } from "@/lib/server/community";
import { assertLocalDbAllowed } from "@/lib/server/local-db/client";
import { sessionSecret } from "@/lib/server/session";
import { LiveService } from "./service";
import { supabasePlanStore } from "./store";

function fatal(message: string): never {
  console.error(`[live] ${message}`);
  process.exit(1);
}

async function main() {
  const production = process.env.NODE_ENV === "production";
  if (!process.env.COMMUNITY_HASH_SALT) {
    fatal("COMMUNITY_HASH_SALT is not set: sessions could not be checked.");
  }
  try {
    // The website's rule: in production a blank or development value refuses every token.
    sessionSecret();
    assertLocalDbAllowed();
  } catch (error) {
    fatal((error as Error).message);
  }
  if (!isCommunityConfigured()) {
    fatal("No database: set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (or LOCAL_DB=1).");
  }
  const journalDir = process.env.LIVE_JOURNAL_DIR;
  if (!journalDir && production) {
    fatal("LIVE_JOURNAL_DIR is not set.");
  }
  const allowedOrigins = (
    process.env.LIVE_ALLOWED_ORIGINS ?? "http://localhost:3000,http://127.0.0.1:3000"
  )
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  const maxRooms = Number(process.env.LIVE_MAX_ROOMS || "");
  let stop: (signal: string, code?: number) => Promise<void> = async () => undefined;
  const service = new LiveService({
    onShutdownRequest: () => void stop("shutdown request"),
    store: supabasePlanStore(),
    journalDir: path.resolve(journalDir ?? path.join("scratch", "local-db", "live-journal")),
    allowedOrigins,
    internalToken: process.env.LIVE_INTERNAL_TOKEN || undefined,
    limits: Number.isInteger(maxRooms) && maxRooms > 0 ? { maxRooms } : undefined,
  });
  const port = await service.start(
    Number(process.env.LIVE_PORT ?? 3001),
    process.env.LIVE_HOST ?? "127.0.0.1",
  );
  console.log(
    `[live] listening on ${process.env.LIVE_HOST ?? "127.0.0.1"}:${port}, origins ${allowedOrigins.join(" ")}`,
  );

  let stopping = false;
  stop = async (signal: string, code = 0) => {
    if (stopping) {
      return;
    }
    stopping = true;
    console.log(`[live] ${signal}: storing open plans`);
    try {
      await service.stop();
      console.log("[live] stopped");
    } finally {
      process.exit(code);
    }
  };
  process.on("SIGINT", () => void stop("SIGINT"));
  process.on("SIGTERM", () => void stop("SIGTERM"));
  // A fault nothing caught: store every open plan and let the leases go, then
  // exit 1 so systemd restarts the service. Exiting without this would leave
  // the plans to journal replay and REST saves refused until the leases lapse.
  // A service too broken to stop must still exit, so the exit is timed as well.
  const bail = (what: string, error: unknown) => {
    console.error(`[live] ${what}: ${String(error)}`);
    setTimeout(() => process.exit(1), 10_000).unref();
    void stop(what, 1);
  };
  process.on("uncaughtException", (error) => bail("uncaught exception", error));
  process.on("unhandledRejection", (reason) => bail("unhandled rejection", reason));
}

void main().catch((error) => fatal(`could not start: ${String(error)}`));
