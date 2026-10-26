import {
  CompiledQuery,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type DatabaseConnection,
  type Dialect,
  type Driver,
  type QueryResult,
} from "kysely";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useTestDb, withDbFault } from "@/test-support/test-db";
import { dbBreakerOpen, DB_BREAKER_FAILURES, DB_BREAKER_OPEN_MS, resetDbBreaker } from "./breaker";
import { DatabaseDownError, isDatabaseDown } from "./errors";
import { GuardedDialect, setDbFaultForTests } from "./guard";
import { getCommunityDb } from "./rest";
import type { Database } from "./schema";

const testDb = useTestDb();

const withCode = (code: string) => Object.assign(new Error(`failed ${code}`), { code });

/** Postgres's SQL, with one connection at a time as PGlite has: Kysely then locks the connection. */
class SingleConnectionAdapter extends PostgresAdapter {
  override get supportsMultipleConnections(): boolean {
    return false;
  }
}

/**
 * A dialect whose every query fails with whatever `answer` returns (or
 * succeeds when it returns nothing), and whose connection attempt fails with
 * whatever `connect` returns.
 */
function fakeDialect(
  answer: () => Error | undefined,
  options: { connect?: () => Error | undefined; singleConnection?: boolean } = {},
) {
  const calls = { acquired: 0, queries: 0 };
  const connection: DatabaseConnection = {
    async executeQuery<R>(): Promise<QueryResult<R>> {
      calls.queries += 1;
      const error = answer();
      if (error) throw error;
      return { rows: [] };
    },
    async *streamQuery() {
      throw new Error("no streaming");
    },
  };
  const driver: Driver = {
    init: async () => undefined,
    acquireConnection: async () => {
      calls.acquired += 1;
      const error = options.connect?.();
      if (error) throw error;
      return connection;
    },
    beginTransaction: async () => undefined,
    commitTransaction: async () => undefined,
    rollbackTransaction: async () => undefined,
    releaseConnection: async () => undefined,
    destroy: async () => undefined,
  };
  const dialect: Dialect = {
    createDriver: () => driver,
    createQueryCompiler: () => new PostgresQueryCompiler(),
    createAdapter: () =>
      options.singleConnection ? new SingleConnectionAdapter() : new PostgresAdapter(),
    createIntrospector: (db) => new PostgresIntrospector(db),
  };
  return { calls, db: new Kysely<Database>({ dialect: new GuardedDialect(dialect) }) };
}

const ping = (db: Kysely<Database>) => db.executeQuery(CompiledQuery.raw("select 1"));

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  resetDbBreaker();
});

describe("the direct client's guard", () => {
  it("counts only down errors", () => {
    for (const code of [
      "ECONNREFUSED",
      "ECONNRESET",
      "ENOTFOUND",
      "EAI_AGAIN",
      "ENETUNREACH",
      "EPIPE",
      "ECONNABORTED",
      "57014",
      "57P01",
      "53300",
      "08006",
    ]) {
      expect(isDatabaseDown(withCode(code)), code).toBe(true);
    }
    expect(isDatabaseDown(new Error("Query read timeout"))).toBe(true);
    expect(isDatabaseDown(new Error("timeout exceeded when trying to connect"))).toBe(true);
    expect(isDatabaseDown(new DatabaseDownError())).toBe(true);
    for (const code of ["23505", "22P02", "42P01"]) {
      expect(isDatabaseDown(withCode(code)), code).toBe(false);
    }
    expect(isDatabaseDown(new Error("syntax error at or near"))).toBe(false);
    expect(isDatabaseDown(undefined)).toBe(false);
  });

  it("opens after five and answers at once for fifteen seconds", async () => {
    vi.useFakeTimers();
    let failing = true;
    const { calls, db } = fakeDialect(() => (failing ? withCode("ECONNREFUSED") : undefined));
    for (let i = 0; i < DB_BREAKER_FAILURES; i += 1) {
      const error = await ping(db).catch((thrown: unknown) => thrown);
      expect(error).toBeInstanceOf(DatabaseDownError);
      expect((error as DatabaseDownError).cause).toMatchObject({ code: "ECONNREFUSED" });
    }
    expect(calls.queries).toBe(5);
    expect(dbBreakerOpen()).toBe(true);

    await expect(ping(db)).rejects.toBeInstanceOf(DatabaseDownError);
    expect(calls.acquired).toBe(5);
    expect(calls.queries).toBe(5);

    vi.advanceTimersByTime(DB_BREAKER_OPEN_MS - 1);
    await expect(ping(db)).rejects.toBeInstanceOf(DatabaseDownError);
    expect(calls.queries).toBe(5);

    vi.advanceTimersByTime(1);
    failing = false;
    await ping(db);
    expect(calls.queries).toBe(6);

    // A success resets the count: four more failures leave it closed.
    failing = true;
    for (let i = 0; i < DB_BREAKER_FAILURES - 1; i += 1) {
      await expect(ping(db)).rejects.toBeInstanceOf(DatabaseDownError);
    }
    expect(dbBreakerOpen()).toBe(false);
  });

  it("counts a connection that cannot be made as down, and holds nothing after it", async () => {
    let connect: Error | undefined = withCode("ENOTFOUND");
    const { db } = fakeDialect(() => undefined, { connect: () => connect, singleConnection: true });
    for (let i = 0; i < DB_BREAKER_FAILURES; i += 1) {
      const error = await ping(db).catch((thrown: unknown) => thrown);
      expect(error).toBeInstanceOf(DatabaseDownError);
      expect((error as DatabaseDownError).cause).toMatchObject({ code: "ENOTFOUND" });
    }
    expect(dbBreakerOpen()).toBe(true);
    resetDbBreaker();

    // The pool's connect timeout, then a connection: Kysely's lock was freed each time.
    connect = new Error("timeout exceeded when trying to connect");
    await expect(ping(db)).rejects.toBeInstanceOf(DatabaseDownError);
    await expect(
      db.transaction().execute((tx) => tx.selectFrom("community_users").select("id").execute()),
    ).rejects.toBeInstanceOf(DatabaseDownError);
    connect = undefined;
    await expect(ping(db)).resolves.toMatchObject({ rows: [] });
  });

  it("a connection refused for another reason is no answer: it neither counts nor resets", async () => {
    let failing = true;
    let connect: Error | undefined;
    const { db } = fakeDialect(() => (failing ? withCode("ECONNRESET") : undefined), {
      connect: () => connect,
    });
    for (let i = 0; i < DB_BREAKER_FAILURES - 1; i += 1) {
      await expect(ping(db)).rejects.toBeInstanceOf(DatabaseDownError);
    }
    connect = withCode("28P01");
    await expect(ping(db)).rejects.toMatchObject({ code: "28P01" });
    expect(dbBreakerOpen()).toBe(false);
    connect = undefined;
    await expect(ping(db)).rejects.toBeInstanceOf(DatabaseDownError);
    expect(dbBreakerOpen()).toBe(true);
    failing = false;
  });

  it("passes a refused query on as it is, and never counts it", async () => {
    const { db } = fakeDialect(() => withCode("23505"));
    for (let i = 0; i < DB_BREAKER_FAILURES + 1; i += 1) {
      await expect(ping(db)).rejects.toMatchObject({ code: "23505" });
    }
    expect(dbBreakerOpen()).toBe(false);
  });

  it("the PostgREST client and Kysely share one breaker", async () => {
    const { db } = testDb();
    withDbFault(/community_users/);
    // POSTs: postgrest-js never retries one, so each is one down answer.
    for (let i = 0; i < DB_BREAKER_FAILURES - 1; i += 1) {
      const { error } = await getCommunityDb()
        .from("community_users")
        .insert({ username: `u${i}`, password_hash: "x" });
      expect(error?.message).toMatch(/not responding/);
    }
    expect(dbBreakerOpen()).toBe(false);
    await expect(db.selectFrom("community_users").select("id").execute()).rejects.toBeInstanceOf(
      DatabaseDownError,
    );
    expect(dbBreakerOpen()).toBe(true);
    // Open: an unfaulted table fails at once on both clients.
    await expect(db.selectFrom("community_events").select("id").execute()).rejects.toBeInstanceOf(
      DatabaseDownError,
    );
    const { error } = await getCommunityDb().from("community_events").select("id");
    expect(error?.message).toMatch(/not responding/);
    await expect(
      db.transaction().execute((tx) => tx.selectFrom("community_events").select("id").execute()),
    ).rejects.toBeInstanceOf(DatabaseDownError);

    // A refused connection holds nothing: PGlite's one connection is free again.
    resetDbBreaker();
    await expect(db.selectFrom("community_events").select("id").execute()).resolves.toEqual([]);
  });

  it("a fault hook fails the matching query only, never in production", async () => {
    const { db } = testDb();
    withDbFault(/community_events/, withCode("23505"));
    await expect(db.selectFrom("community_users").select("id").execute()).resolves.toEqual([]);
    await expect(db.selectFrom("community_events").select("id").execute()).rejects.toMatchObject({
      code: "23505",
    });

    vi.stubEnv("NODE_ENV", "production");
    // A hook left installed is never consulted there, and none can be installed.
    await expect(db.selectFrom("community_events").select("id").execute()).resolves.toEqual([]);
    expect(() => setDbFaultForTests(() => undefined)).toThrow(/tests only/);
  });
});
