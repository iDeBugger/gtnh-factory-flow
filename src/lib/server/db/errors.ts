/**
 * What a route says when the database fails. No database client here, so a
 * module can name these without loading one.
 */

/** What a player reads when the database cannot be reached. */
export const COMMUNITY_DB_DOWN_MESSAGE =
  "The community database is not responding. Try again in a few minutes.";

/**
 * What a service answers when a query failed: the database-down
 * line when it could not be reached, else the route's own sentence. The
 * schema is the migration runner's, so a missing table is a broken deploy,
 * not a setup step a player could take, and the database's own message
 * (table and column names) stays in the log.
 */
export function storageErrorMessage(error: unknown, fallback: string): string {
  return isDatabaseDown(error) ? COMMUNITY_DB_DOWN_MESSAGE : fallback;
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

/**
 * Whether an error is the database's own answer: a five-character SQLSTATE
 * together with the severity Postgres sends with every error (`pg` and
 * PGlite both carry it). A Node error code such as EPIPE or EPERM has the
 * same shape as a SQLSTATE, but no severity, so it is not taken for one.
 */
export function isDatabaseError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const { code, severity } = error as { code?: unknown; severity?: unknown };
  return typeof code === "string" && /^[0-9A-Z]{5}$/.test(code) && typeof severity === "string";
}

/**
 * Socket errors that mean the server is gone or unreachable. ENOTFOUND and
 * EAI_AGAIN are a host with no address: compose's DNS has no record for the
 * `postgres` service while its container is stopped or restarting. EPIPE is
 * a write on a socket the server just closed.
 */
const DOWN_SOCKET_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EPIPE",
  "ECONNABORTED",
]);
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
