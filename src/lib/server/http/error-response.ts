import { COMMUNITY_DB_DOWN_MESSAGE } from "../db/errors";
import { DatasetNotFoundError } from "../dataset-query";

/**
 * A route's answer for an error it did not expect: the route's own fallback
 * sentence and the error itself to the log only. A database, file system or
 * gzip message names tables, columns or the release's absolute path, and an
 * error built from request text would echo it. The one sentence passed on is
 * the database-down line (db/errors.ts), which the server writes itself and
 * the player is meant to read, wherever a route's error wraps it.
 */
export function serverErrorResponse(
  error: unknown,
  fallback: string,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  const status = init.status ?? 500;
  const down = databaseDownResponse(error, init);
  if (down) {
    return down;
  }
  console.error(fallback, error);
  return Response.json({ error: fallback }, { status, headers: init.headers });
}

/**
 * The database-down line at `init.status` (500 by default) when `error`
 * carries it, else undefined: for a route whose other failures keep an
 * answer of their own (a fixed sentence, or no picture).
 */
export function databaseDownResponse(
  error: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response | undefined {
  if (error instanceof Error && error.message.includes(COMMUNITY_DB_DOWN_MESSAGE)) {
    return Response.json(
      { error: COMMUNITY_DB_DOWN_MESSAGE },
      { status: init.status ?? 500, headers: init.headers },
    );
  }
  return undefined;
}

/**
 * A route handler that answers its own throw: `serverErrorResponse` with the
 * route's sentence and `Cache-Control: no-store`, so an outage reads as the
 * database-down line rather than an empty 500. A signed-in request reads its
 * account and spends its rate limit before any service's own catch, and
 * either fails while the database is down; this is the one place both meet.
 */
export function answeringErrors<A extends unknown[]>(
  fallback: string,
  handler: (...args: A) => Promise<Response>,
): (...args: A) => Promise<Response> {
  return async (...args) => {
    try {
      return await handler(...args);
    } catch (error) {
      return serverErrorResponse(error, fallback, { headers: { "Cache-Control": "no-store" } });
    }
  };
}

/** A dataset route's `catch`: an unserved dataset id is a 404 with a fixed sentence, anything else as above. */
export function datasetErrorResponse(
  error: unknown,
  fallback: string,
  headers?: Record<string, string>,
): Response {
  if (error instanceof DatasetNotFoundError) {
    return Response.json({ error: error.message }, { status: 404, headers });
  }
  return serverErrorResponse(error, fallback, { headers });
}
