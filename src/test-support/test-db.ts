import type { PGlite } from "@electric-sql/pglite";
import { Kysely, PGliteDialect } from "kysely";
import { afterAll, afterEach, beforeAll } from "vitest";
import { forgetSessionUsers } from "@/lib/server/auth/sessions";
import { resetDbBreaker, useDbForTests } from "@/lib/server/db";
import { GuardedDialect, setDbFaultForTests } from "@/lib/server/db/guard";
import type { Database } from "@/lib/server/db/schema";
import { useInProcessLocalDb } from "@/lib/server/local-db/client";
import { openLocalDatabase, type LocalDatabase } from "@/lib/server/local-db/database";

/**
 * One in-memory database for a test file, reached through both clients: the
 * PostgREST stand-in (`getCommunityDb`, with `LOCAL_DB=1`) and Kysely
 * (`getDb`) share one PGlite, so a row one writes the other reads. Both go
 * through the breaker; each test starts with it closed, no cached account
 * and no injected fault.
 */

export interface TestDb {
  db: Kysely<Database>;
  pglite: PGlite;
}

type Fault = { match: RegExp; error: Error };
let fault: Fault | undefined;

/** A 502 with a text body: the PostgREST client reads it as the database being down. */
const standInDown = (): Response =>
  new Response("connection reset", { status: 502, headers: { "content-type": "text/plain" } });

/**
 * Fails every query whose SQL matches `match` (Kysely) and every stand-in
 * request whose path and query match it (PostgREST), until the test ends.
 * The default error is a reset connection: the database is down.
 */
export function withDbFault(
  match: RegExp,
  error: Error = Object.assign(new Error("connection reset"), { code: "ECONNRESET" }),
): void {
  fault = { match, error };
  setDbFaultForTests((sqlText) => (match.test(sqlText) ? error : undefined));
}

/** Registers the hooks; call at the top of a test file, read the database inside tests. */
export function useTestDb(): () => TestDb {
  let local: LocalDatabase | undefined;
  let testDb: TestDb | undefined;
  let savedLocalDb: string | undefined;

  beforeAll(async () => {
    savedLocalDb = process.env.LOCAL_DB;
    process.env.LOCAL_DB = "1";
    local = await openLocalDatabase();
    const handle = local.handle;
    useInProcessLocalDb(async (request) => {
      const url = new URL(request.url);
      if (fault?.match.test(`${url.pathname}${url.search}`)) {
        return standInDown();
      }
      return handle(request);
    });
    const db = new Kysely<Database>({
      dialect: new GuardedDialect(new PGliteDialect({ pglite: local.db })),
    });
    useDbForTests(db);
    testDb = { db, pglite: local.db };
  }, 60_000);

  afterEach(() => {
    resetDbBreaker();
    forgetSessionUsers();
    fault = undefined;
    setDbFaultForTests(undefined);
  });

  afterAll(async () => {
    useDbForTests(undefined);
    useInProcessLocalDb(undefined);
    // Kysely's destroy would close the PGlite; the local database owns it.
    await local?.close();
    if (savedLocalDb === undefined) {
      delete process.env.LOCAL_DB;
    } else {
      process.env.LOCAL_DB = savedLocalDb;
    }
  });

  return () => {
    if (!testDb) {
      throw new Error("The test database opens in beforeAll; read it inside a test.");
    }
    return testDb;
  };
}
