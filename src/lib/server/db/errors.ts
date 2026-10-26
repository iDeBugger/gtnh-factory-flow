/**
 * What a route says when the database fails. No database client here, so a
 * module can name these without loading one.
 */

/** What a player reads when the database cannot be reached. */
export const COMMUNITY_DB_DOWN_MESSAGE =
  "The community database is not responding. Try again in a few minutes.";

/**
 * PGRST204 / 42703: the table predates a column this build reads or writes.
 * Re-running supabase/schema.sql (idempotent ALTERs) fixes it.
 */
export function isMissingColumnError(error: { code?: string } | null | undefined): boolean {
  return error?.code === "PGRST204" || error?.code === "42703";
}

export function communityStorageErrorMessage(
  error: { code?: string; message?: string } | null,
  fallback: string,
): string {
  if (error?.code === "PGRST204" || error?.code === "42703") {
    return "Community storage is out of date: re-run the latest supabase/schema.sql in the Supabase SQL editor.";
  }
  return error?.message ?? fallback;
}

/**
 * A missing or stale table says so by name: the schema is pasted by hand,
 * and the app has to tell "not set up yet" from "broken".
 */
export function libraryStorageErrorMessage(
  error: { code?: string; message?: string } | null,
  fallback: string,
): string {
  if (error?.code === "PGRST205" || error?.code === "42P01") {
    return "Plan sync is not set up yet: run supabase/schema.sql in the Supabase SQL editor.";
  }
  if (error?.code === "PGRST204" || error?.code === "42703") {
    return "Plan sync is out of date: re-run the latest supabase/schema.sql in the Supabase SQL editor.";
  }
  // Anything else: say what the database said, so the strip's red line
  // names the cause instead of hiding it behind a fallback.
  return error?.message ? `${fallback} ${error.message}` : fallback;
}

/**
 * Turns the two schema-drift Postgres errors into messages that say what to
 * actually do, instead of a generic 500: PGRST205 means the blueprints table
 * has never been created; PGRST204/42703 mean the table predates a column
 * this build reads or writes (schema.sql converges when re-run — its later
 * additions are idempotent ALTERs). Anything else keeps the caller's word.
 */
export function blueprintStorageErrorMessage(
  error: { code?: string } | null,
  fallback: string,
): string {
  if (error?.code === "PGRST205") {
    return "Blueprint storage is not set up yet: run supabase/schema.sql in the Supabase SQL editor.";
  }
  if (error?.code === "PGRST204" || error?.code === "42703") {
    return "Blueprint storage is out of date: re-run the latest supabase/schema.sql in the Supabase SQL editor.";
  }
  return fallback;
}

/**
 * A query the database refused or could not answer, thrown by a repository
 * with the database's own code and message, so a service can still word it
 * (`libraryStorageErrorMessage`) as the route did. A failed write that came
 * back with no row and no error carries an empty message.
 */
export class DbQueryError extends Error {
  readonly code?: string;

  constructor(error: { code?: string; message?: string } | null | undefined) {
    super(error?.message ?? "");
    this.name = "DbQueryError";
    this.code = error?.code;
  }
}

/**
 * The database could not be reached or could not answer in time, thrown by
 * the direct client (`db/guard.ts`) with the original error as `cause`. Its
 * message is the player copy, which `serverErrorResponse` passes on.
 */
export class DatabaseDownError extends Error {
  constructor(cause?: unknown) {
    super(COMMUNITY_DB_DOWN_MESSAGE, cause === undefined ? undefined : { cause });
    this.name = "DatabaseDownError";
  }
}

/** Socket errors that mean the server is gone or unreachable. */
const DOWN_SOCKET_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EHOSTUNREACH"]);
/**
 * SQLSTATEs that mean the server stopped the work or has no room for it:
 * 57014 a statement timeout or cancel, 57P01..57P03 a shutdown or a server
 * not accepting connections yet, 53300 too many connections. Class 08 is
 * every connection exception.
 */
const DOWN_SQLSTATES = new Set(["57014", "57P01", "57P02", "57P03", "53300"]);
/** What `pg` and its pool throw with no code: the client's query timeout, the pool's connect timeout, a dropped socket. */
const DOWN_MESSAGES = [
  /^Query read timeout$/,
  /timeout exceeded when trying to connect/,
  /^Connection terminated/,
  /is not queryable/,
];

/**
 * Whether an error means the database is down (unreachable, timed out,
 * shutting down, full), as opposed to a query it refused. Only these move the
 * breaker; a constraint or syntax error is an answer and never counts.
 */
export function isDatabaseDown(error: unknown): boolean {
  if (error instanceof DatabaseDownError) {
    return true;
  }
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const { code, message } = error as { code?: unknown; message?: unknown };
  if (typeof code === "string") {
    if (DOWN_SOCKET_CODES.has(code) || DOWN_SQLSTATES.has(code) || /^08[0-9A-Z]{3}$/.test(code)) {
      return true;
    }
  }
  return typeof message === "string" && DOWN_MESSAGES.some((pattern) => pattern.test(message));
}
