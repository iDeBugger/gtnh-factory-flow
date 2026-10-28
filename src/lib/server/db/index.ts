/**
 * The database entry: the client (`getDb`, Kysely over `pg`) and what its
 * failures say. Repositories and the live service import the database
 * through here. The breaker (`breaker.ts`) guards every query.
 */
import { sql, type Kysely, type Transaction } from "kysely";
import { createDbClient, type DirectDbClient } from "./client";
import { isRetryableTransactionError } from "./errors";
import type { Database } from "./schema";
import type { DbService } from "./settings";

export { DB_BREAKER_FAILURES, DB_BREAKER_OPEN_MS, resetDbBreaker } from "./breaker";
export {
  COMMUNITY_DB_DOWN_MESSAGE,
  DatabaseDownError,
  isDatabaseDown,
  isDatabaseError,
  isRetryableTransactionError,
  storageErrorMessage,
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

// One per process, not per module copy: a second copy of this module (a bundle
// that splits it, a test's fresh import) shares the pool instead of opening another.
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

/** Whether there is a database: `DATABASE_URL` is set, or a test installed its database. */
export function isDatabaseConfigured(): boolean {
  return Boolean(state().testDb || process.env.DATABASE_URL);
}

/** The client; the pool opens on first use. Throws when no database is configured. */
export function getDb(): Kysely<Database> {
  const current = state();
  if (current.testDb) {
    return current.testDb;
  }
  current.client ??= createDbClient(current.service, process.env);
  return current.client.db;
}

export interface TransactionOptions {
  /**
   * Read only, on one snapshot (`repeatable read`): every statement sees the
   * rows as they stood at the first, such as a page and the count it shows.
   */
  readSnapshot?: boolean;
}

/** Runs of one transaction in all, when a deadlock or a serialization failure rolls it back. */
const TRANSACTION_ATTEMPTS = 3;

/**
 * Runs `work` in one transaction: committed when it resolves, rolled back
 * when it throws. Inside, use only `tx` and await nothing else (no session
 * read, no rate limit, no fetch): on PGlite an outside query waits for the
 * transaction forever, on Postgres it takes a second pool slot. That also
 * makes `work` safe to run again: a deadlock or a serialization failure
 * (`isRetryableTransactionError`) left nothing of it standing, so it runs
 * again, up to `TRANSACTION_ATTEMPTS` in all, before the error goes on.
 */
export async function withTransaction<T>(
  work: (tx: Tx) => Promise<T>,
  options: TransactionOptions = {},
): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await getDb()
        .transaction()
        .execute(async (tx) => {
          if (options.readSnapshot) {
            // A statement of its own rather than the driver's transaction
            // settings, which PGlite's driver drops: the same SQL on both.
            await sql`set transaction isolation level repeatable read, read only`.execute(tx);
          }
          return work(tx);
        });
    } catch (error) {
      if (attempt >= TRANSACTION_ATTEMPTS || !isRetryableTransactionError(error)) {
        throw error;
      }
    }
  }
}

/** Closes the pool (on shutdown). A test database is its owner's to close. */
export async function closeDb(): Promise<void> {
  const current = state();
  const client = current.client;
  current.client = undefined;
  await client?.db.destroy();
}

/** For tests: answer `getDb()` with this database (undefined: back to `DATABASE_URL`). Installing one is refused in production. */
export function setDbForTests(db: Kysely<Database> | undefined): void {
  if (db && process.env.NODE_ENV === "production") {
    throw new Error("setDbForTests is for tests only.");
  }
  state().testDb = db;
}
