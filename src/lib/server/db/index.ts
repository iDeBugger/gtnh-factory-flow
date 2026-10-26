/**
 * The database entry: both clients and what their failures say. Repositories
 * and the live service import the database through here.
 *
 * Two clients reach one database while repositories move across: the
 * PostgREST one (`getCommunityDb`, `rest.ts`) and the direct one (`getDb`,
 * Kysely over `pg`). One breaker (`breaker.ts`) serves both.
 */
import type { Kysely, Transaction } from "kysely";
import { createDbClient, type DirectDbClient } from "./client";
import type { Database } from "./schema";
import type { DbService } from "./settings";

export {
  COMMUNITY_DB_TIMEOUT_MS,
  fetchWithDbTimeout,
  getCommunityDb,
  isCommunityConfigured,
  type DbClient,
} from "./rest";
export { DB_BREAKER_FAILURES, DB_BREAKER_OPEN_MS, resetDbBreaker } from "./breaker";
export {
  blueprintStorageErrorMessage,
  COMMUNITY_DB_DOWN_MESSAGE,
  communityStorageErrorMessage,
  DatabaseDownError,
  DbQueryError,
  isDatabaseDown,
  isMissingColumnError,
  libraryStorageErrorMessage,
} from "./errors";
export { json, type JsonParam } from "./parsers";
export type { Database, JsonValue } from "./schema";

/** A transaction handle, which repositories take as their last argument. */
export type Tx = Transaction<Database>;

interface DbState {
  service: DbService;
  client?: DirectDbClient;
  testDb?: Kysely<Database>;
}

// One per process, not per module copy: Next bundles instrumentation apart
// from the routes, and a dev reload would otherwise open a pool per reload.
const STATE = Symbol.for("gtnh.db");
type WithState = typeof globalThis & { [STATE]?: DbState };

function state(): DbState {
  const holder = globalThis as WithState;
  holder[STATE] ??= { service: "site" };
  return holder[STATE];
}

/**
 * Names the process the pool serves (its size and `application_name`); the
 * live service calls it before its first query. The site needs no call.
 */
export function configureDb(options: { service: DbService }): void {
  const current = state();
  if (current.client && current.service !== options.service) {
    throw new Error(`The database pool is already open for ${current.service}.`);
  }
  current.service = options.service;
}

/** Whether the direct client can be used: `DATABASE_URL` is set, or a test installed its database. */
export function isDatabaseConfigured(): boolean {
  return Boolean(state().testDb || process.env.DATABASE_URL);
}

/** The direct client; the pool opens on first use. Throws when no database is configured. */
export function getDb(): Kysely<Database> {
  const current = state();
  if (current.testDb) {
    return current.testDb;
  }
  current.client ??= createDbClient(current.service, process.env);
  return current.client.db;
}

/**
 * Runs `work` in one transaction: committed when it resolves, rolled back
 * when it throws. Inside, use only `tx` and await nothing else (no session
 * read, no rate limit, no fetch): on PGlite an outside query waits for the
 * transaction forever, on Postgres it takes a second pool slot.
 */
export function withTransaction<T>(work: (tx: Tx) => Promise<T>): Promise<T> {
  return getDb().transaction().execute(work);
}

/** Closes the pool (on shutdown). A test database is its owner's to close. */
export async function closeDb(): Promise<void> {
  const current = state();
  const client = current.client;
  current.client = undefined;
  await client?.db.destroy();
}

/** For tests: answer `getDb()` with this database (undefined: back to `DATABASE_URL`). Installing one is refused in production. */
export function useDbForTests(db: Kysely<Database> | undefined): void {
  if (db && process.env.NODE_ENV === "production") {
    throw new Error("useDbForTests is for tests only.");
  }
  state().testDb = db;
}
