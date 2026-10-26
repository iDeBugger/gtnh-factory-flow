import { PGlite } from "@electric-sql/pglite";
import { Kysely, PGliteDialect } from "kysely";
import { afterAll, afterEach, beforeAll } from "vitest";
import { forgetSessionUsers } from "@/lib/server/auth/sessions";
import { resetDbBreaker, useDbForTests } from "@/lib/server/db";
import { GuardedDialect, setDbFaultForTests } from "@/lib/server/db/guard";
import { applyMigrations } from "@/lib/server/db/migrations";
import { DB_TYPE_PARSERS } from "@/lib/server/db/parsers";
import type { Database } from "@/lib/server/db/schema";

/**
 * One in-memory Postgres (PGlite) for a test file, built by the migrations
 * the deploy applies and reached through Kysely (`getDb`), behind the
 * breaker. Its values parse as the pool's do (`DB_TYPE_PARSERS`), so a row
 * reads the same in tests as in production. Each test starts with the
 * breaker closed, no cached account and no injected fault.
 */

export interface TestDb {
  db: Kysely<Database>;
  pglite: PGlite;
}

/**
 * Fails every query whose SQL matches `match`, until the test ends. The
 * default error is a reset connection: the database is down.
 */
export function withDbFault(
  match: RegExp,
  error: Error = Object.assign(new Error("connection reset"), { code: "ECONNRESET" }),
): void {
  setDbFaultForTests((sqlText) => (match.test(sqlText) ? error : undefined));
}

/** Ends the fault `withDbFault` set, before the test does. */
export function clearDbFault(): void {
  setDbFaultForTests(undefined);
}

/** Registers the hooks; call at the top of a test file, read the database inside tests. */
export function useTestDb(): () => TestDb {
  let testDb: TestDb | undefined;

  beforeAll(async () => {
    const pglite = new PGlite({ parsers: DB_TYPE_PARSERS });
    // The timestamp parser reads UTC only, as every pool session runs.
    await pglite.exec("set time zone 'UTC'");
    await applyMigrations(pglite);
    const db = new Kysely<Database>({
      dialect: new GuardedDialect(new PGliteDialect({ pglite })),
    });
    useDbForTests(db);
    testDb = { db, pglite };
  }, 60_000);

  afterEach(() => {
    resetDbBreaker();
    forgetSessionUsers();
    clearDbFault();
  });

  afterAll(async () => {
    useDbForTests(undefined);
    // Closes the PGlite too.
    await testDb?.db.destroy();
  });

  return () => {
    if (!testDb) {
      throw new Error("The test database opens in beforeAll; read it inside a test.");
    }
    return testDb;
  };
}
