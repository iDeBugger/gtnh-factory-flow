import type {
  CompiledQuery,
  DatabaseConnection,
  DatabaseIntrospector,
  Dialect,
  DialectAdapter,
  Driver,
  QueryCompiler,
  QueryResult,
  TransactionSettings,
} from "kysely";
import { dbBreakerOpen, recordDbOutcome } from "./breaker";
import { DatabaseDownError, isDatabaseDown } from "./errors";

/**
 * The direct client behind the same breaker as the PostgREST one
 * (`db/breaker.ts`): while it is open a query fails at once with
 * `DatabaseDownError` and never takes a connection; every query that comes
 * back counts, a down error toward opening it and any answer (rows or a
 * refusal such as a constraint error) as closing the count. A down error is
 * rethrown as `DatabaseDownError` so every caller words it the same.
 */

type DbFault = (sql: string, parameters: readonly unknown[]) => Error | undefined;

const FAULT = Symbol.for("gtnh.db.fault");
type WithFault = typeof globalThis & { [FAULT]?: DbFault };

/**
 * For tests: fail each query the hook returns an error for, as if the driver
 * had thrown it, before it is sent. Refused in production, and a hook left
 * installed is never consulted there.
 */
export function setDbFaultForTests(fault: DbFault | undefined): void {
  if (fault && process.env.NODE_ENV === "production") {
    throw new Error("setDbFaultForTests is for tests only.");
  }
  (globalThis as WithFault)[FAULT] = fault;
}

function faultFor(sql: string, parameters: readonly unknown[]): Error | undefined {
  if (process.env.NODE_ENV === "production") {
    return undefined;
  }
  return (globalThis as WithFault)[FAULT]?.(sql, parameters);
}

/** Records the outcome and gives back what to throw: a down error as `DatabaseDownError`. */
function settle(error: unknown, record = true): unknown {
  const down = isDatabaseDown(error);
  if (record) {
    recordDbOutcome(down);
  }
  return down && !(error instanceof DatabaseDownError) ? new DatabaseDownError(error) : error;
}

class GuardedConnection implements DatabaseConnection {
  constructor(readonly inner: DatabaseConnection) {}

  async executeQuery<R>(
    compiledQuery: CompiledQuery,
    options?: Parameters<DatabaseConnection["executeQuery"]>[1],
  ): Promise<QueryResult<R>> {
    let result: QueryResult<R>;
    try {
      const fault = faultFor(compiledQuery.sql, compiledQuery.parameters);
      if (fault) {
        throw fault;
      }
      result = await this.inner.executeQuery<R>(compiledQuery, options);
    } catch (error) {
      throw settle(error);
    }
    recordDbOutcome(false);
    return result;
  }

  streamQuery<R>(
    compiledQuery: CompiledQuery,
    chunkSize: number,
    options?: Parameters<DatabaseConnection["streamQuery"]>[2],
  ): AsyncIterableIterator<QueryResult<R>> {
    return this.inner.streamQuery<R>(compiledQuery, chunkSize, options);
  }
}

/**
 * A connection that was never made: the breaker is open, or the pool could
 * not connect. Every query on it throws that failure. Kysely holds a lock
 * per connection on single-connection drivers (PGlite) and releases it only
 * through `releaseConnection`, so a failed acquire hands this back rather
 * than throwing, which would leave the lock taken for good.
 */
class FailedConnection implements DatabaseConnection {
  constructor(readonly error: unknown) {}

  async executeQuery<R>(): Promise<QueryResult<R>> {
    throw this.error;
  }

  async *streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {
    throw this.error;
  }
}

const unwrap = (connection: DatabaseConnection): DatabaseConnection =>
  connection instanceof GuardedConnection ? connection.inner : connection;

class GuardedDriver implements Driver {
  constructor(private readonly inner: Driver) {}

  init(options?: Parameters<Driver["init"]>[0]): Promise<void> {
    return this.inner.init(options);
  }

  async acquireConnection(
    options?: Parameters<Driver["acquireConnection"]>[0],
  ): Promise<DatabaseConnection> {
    if (dbBreakerOpen()) {
      return new FailedConnection(new DatabaseDownError());
    }
    try {
      return new GuardedConnection(await this.inner.acquireConnection(options));
    } catch (error) {
      // The pool's connect timeout or a refused socket.
      return new FailedConnection(settle(error));
    }
  }

  async beginTransaction(
    connection: DatabaseConnection,
    settings: TransactionSettings,
  ): Promise<void> {
    if (connection instanceof FailedConnection) {
      // Already counted when the connection failed.
      throw connection.error;
    }
    try {
      await this.inner.beginTransaction(unwrap(connection), settings);
    } catch (error) {
      throw settle(error);
    }
  }

  async commitTransaction(connection: DatabaseConnection): Promise<void> {
    if (connection instanceof FailedConnection) {
      throw connection.error;
    }
    try {
      await this.inner.commitTransaction(unwrap(connection));
    } catch (error) {
      throw settle(error);
    }
  }

  async rollbackTransaction(connection: DatabaseConnection): Promise<void> {
    if (connection instanceof FailedConnection) {
      return;
    }
    try {
      await this.inner.rollbackTransaction(unwrap(connection));
    } catch (error) {
      // A rollback follows the failure that was already counted.
      throw settle(error, false);
    }
  }

  async savepoint(
    connection: DatabaseConnection,
    savepointName: string,
    compileQuery: QueryCompiler["compileQuery"],
  ): Promise<void> {
    if (!this.inner.savepoint) {
      throw new Error("This database driver has no savepoints.");
    }
    await this.inner.savepoint(unwrap(connection), savepointName, compileQuery);
  }

  async rollbackToSavepoint(
    connection: DatabaseConnection,
    savepointName: string,
    compileQuery: QueryCompiler["compileQuery"],
  ): Promise<void> {
    if (!this.inner.rollbackToSavepoint) {
      throw new Error("This database driver has no savepoints.");
    }
    await this.inner.rollbackToSavepoint(unwrap(connection), savepointName, compileQuery);
  }

  async releaseSavepoint(
    connection: DatabaseConnection,
    savepointName: string,
    compileQuery: QueryCompiler["compileQuery"],
  ): Promise<void> {
    if (!this.inner.releaseSavepoint) {
      throw new Error("This database driver has no savepoints.");
    }
    await this.inner.releaseSavepoint(unwrap(connection), savepointName, compileQuery);
  }

  async releaseConnection(
    connection: DatabaseConnection,
    options?: Parameters<Driver["releaseConnection"]>[1],
  ): Promise<void> {
    if (connection instanceof FailedConnection) {
      return;
    }
    await this.inner.releaseConnection(unwrap(connection), options);
  }

  destroy(options?: Parameters<Driver["destroy"]>[0]): Promise<void> {
    return this.inner.destroy(options);
  }
}

/** Any Kysely dialect (`PostgresDialect` over the pool, `PGliteDialect` in tests) behind the breaker. */
export class GuardedDialect implements Dialect {
  constructor(private readonly inner: Dialect) {}

  createDriver(): Driver {
    return new GuardedDriver(this.inner.createDriver());
  }

  createQueryCompiler(): QueryCompiler {
    return this.inner.createQueryCompiler();
  }

  createAdapter(): DialectAdapter {
    return this.inner.createAdapter();
  }

  createIntrospector(db: Parameters<Dialect["createIntrospector"]>[0]): DatabaseIntrospector {
    return this.inner.createIntrospector(db);
  }
}
