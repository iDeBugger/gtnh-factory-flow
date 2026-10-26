import { Kysely, PostgresDialect } from "kysely";
import pg from "pg";
import { GuardedDialect } from "./guard";
import { DB_TYPE_PARSERS } from "./parsers";
import type { Database } from "./schema";
import { dbSettings, type DbEnv, type DbService } from "./settings";

/**
 * The direct client: Kysely over a `pg` pool at `DATABASE_URL`, behind the
 * breaker (`GuardedDialect`). Only `db/index.ts` makes one; repositories
 * take it from `getDb()`.
 */

export interface DirectDbClient {
  db: Kysely<Database>;
  pool: pg.Pool;
}

/** `pg`'s text parsers with ours over them, so the pool reads values as PGlite does. */
const typeParsers: pg.CustomTypesConfig = {
  getTypeParser: ((oid: number, format?: "text" | "binary") =>
    (format !== "binary" && DB_TYPE_PARSERS[oid]) ||
    pg.types.getTypeParser(oid, format)) as pg.CustomTypesConfig["getTypeParser"],
};

export function createDbClient(service: DbService, env: DbEnv): DirectDbClient {
  const settings = dbSettings(service, env);
  if (!settings.connectionString) {
    throw new Error("The database is not configured: set DATABASE_URL");
  }
  const pool = new pg.Pool({ ...settings, types: typeParsers });
  // An idle connection the server drops (a restart, a network blip) reports
  // here; unheard, it would end the process. The pool discards the
  // connection and opens a fresh one on the next query.
  pool.on("error", (error) => {
    console.error(`[db] idle connection lost: ${error.message}`);
  });
  const db = new Kysely<Database>({
    dialect: new GuardedDialect(new PostgresDialect({ pool })),
  });
  return { db, pool };
}
