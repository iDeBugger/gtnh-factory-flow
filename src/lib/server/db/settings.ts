import type { PoolConfig } from "pg";

/** The variables the pool reads: `process.env`, or a test's own. */
export type DbEnv = Readonly<Record<string, string | undefined>>;

/** Which process opens the pool: the site or the live service. */
export type DbService = "site" | "live";

/**
 * Connections per process. The site keeps 10 for its request load; the
 * live service flushes 4 plans at a time plus joins and renewals. Both
 * together stay far under Postgres's 100 connections.
 */
const POOL_MAX: Record<DbService, number> = { site: 10, live: 6 };

/** A full pool fails fast as down instead of queueing a request for the whole query timeout. */
const CONNECT_TIMEOUT_MS = 5_000;
/** The server stops a runaway statement before the client gives up on it. */
const STATEMENT_TIMEOUT_MS = 15_000;
/** The client's cap per query: a stall fails as down rather than holding a request open for minutes. */
const QUERY_TIMEOUT_MS = 20_000;
/** A transaction left open frees its locks. */
const IDLE_IN_TRANSACTION_MS = 10_000;
/** A `for update` read never waits long behind another writer. */
const LOCK_TIMEOUT_MS = 5_000;
const IDLE_MS = 30_000;

function positiveInteger(value: string | undefined, fallback: number): number {
  if (!value || !/^\d+$/.test(value.trim())) {
    return fallback;
  }
  const parsed = Number(value);
  return parsed > 0 ? parsed : fallback;
}

/**
 * The pool's settings for one process, from `DATABASE_URL`.
 * `DATABASE_POOL_MAX` and `DATABASE_POOL_IDLE_MS` override the size and the
 * idle time (`npm run dev:local` sets them for the local database). The
 * session runs in UTC: the timestamp parser reads that form only.
 */
export function dbSettings(service: DbService, env: DbEnv): PoolConfig {
  return {
    connectionString: env.DATABASE_URL,
    max: positiveInteger(env.DATABASE_POOL_MAX, POOL_MAX[service]),
    idleTimeoutMillis: positiveInteger(env.DATABASE_POOL_IDLE_MS, IDLE_MS),
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    query_timeout: QUERY_TIMEOUT_MS,
    application_name: `gtnh-${service}`,
    options: [
      `-c statement_timeout=${STATEMENT_TIMEOUT_MS}`,
      `-c idle_in_transaction_session_timeout=${IDLE_IN_TRANSACTION_MS}`,
      `-c lock_timeout=${LOCK_TIMEOUT_MS}`,
      "-c TimeZone=UTC",
    ].join(" "),
  };
}
