import { NextResponse } from "next/server";
import { COMMUNITY_DB_DOWN_MESSAGE } from "../db/errors";
import { DatasetNotFoundError } from "../dataset-query";

/**
 * A route's answer for an error it did not expect: the route's own fallback
 * sentence and the error itself to the log only. A database, file system or
 * gzip message names tables, columns or the release's absolute path, and an
 * error built from request text would echo it. The one sentence passed on is
 * the database-down line (db/rest.ts), which the server writes itself and
 * the player is meant to read, wherever a route's error wraps it.
 */
export function serverErrorResponse(
  error: unknown,
  fallback: string,
  init: { status?: number; headers?: Record<string, string> } = {},
): NextResponse {
  const status = init.status ?? 500;
  if (error instanceof Error && error.message.includes(COMMUNITY_DB_DOWN_MESSAGE)) {
    return NextResponse.json(
      { error: COMMUNITY_DB_DOWN_MESSAGE },
      { status, headers: init.headers },
    );
  }
  console.error(fallback, error);
  return NextResponse.json({ error: fallback }, { status, headers: init.headers });
}

/** A dataset route's `catch`: an unserved dataset id is a 404 with a fixed sentence, anything else as above. */
export function datasetErrorResponse(
  error: unknown,
  fallback: string,
  headers?: Record<string, string>,
): NextResponse {
  if (error instanceof DatasetNotFoundError) {
    return NextResponse.json({ error: error.message }, { status: 404, headers });
  }
  return serverErrorResponse(error, fallback, { headers });
}
