import { PostgrestClient } from "@supabase/postgrest-js";
import {
  assertLocalDbAllowed,
  isLocalDb,
  LOCAL_DB_SERVICE_KEY,
  localDbFetch,
  localDbUrl,
} from "../local-db/client";
import { dbBreakerOpen, recordDbOutcome } from "./breaker";
import { COMMUNITY_DB_DOWN_MESSAGE } from "./errors";

/**
 * Server-only database access: PostgREST at `POSTGREST_URL` with a service
 * token (`POSTGREST_SERVICE_TOKEN`, a JWT for the `service_role`, which
 * bypasses row security). This module must never be imported from client
 * components: the API routes and the live service are its only consumers.
 */
export type DbClient = PostgrestClient;

let cachedClient: DbClient | undefined;

/**
 * How long one database request may take before it is abandoned. Without a
 * limit, a stalled database holds requests open for minutes, so
 * pages hang instead of failing and the server piles up open sockets. A
 * healthy request finishes in well under a second, so this only cuts off a
 * stall.
 */
export const COMMUNITY_DB_TIMEOUT_MS = 20_000;

const DB_DOWN_HEADER = "x-community-db-down";

/** A PostgREST-shaped error answer, which every client reads as `{ message }`. */
function dbDownResponse(status: number): Response {
  return Response.json(
    { message: COMMUNITY_DB_DOWN_MESSAGE, code: "", details: `HTTP ${status}`, hint: "" },
    { status, headers: { [DB_DOWN_HEADER]: "1" } },
  );
}

/** The database client's fetch: `fetchWithDbTimeout` behind the breaker. */
async function fetchFromDb(
  input: Parameters<typeof fetch>[0],
  init: Parameters<typeof fetch>[1],
  send: typeof fetch = fetch,
): Promise<Response> {
  if (dbBreakerOpen()) {
    // 504: postgrest-js retries a 503, which would only meet the breaker again.
    return dbDownResponse(504);
  }
  const response = await fetchWithDbTimeout(input, init, COMMUNITY_DB_TIMEOUT_MS, send);
  recordDbOutcome(Boolean(response.headers.get(DB_DOWN_HEADER)));
  return response;
}

/**
 * The client's fetch, abandoned after `timeoutMs`,
 * body included. A timeout before the answer arrives becomes a 504, not a
 * rejection: postgrest-js RETRIES a GET that rejects (other than with an
 * AbortError) three more times with backoff, and words a rejection as its
 * error's name and message. A proxy in front of a stalled database answers
 * with its own error page (an HTML or text/plain 502, 522 or 524), which the
 * client would pass on whole as the error message: any 5xx that is not JSON
 * becomes the same plain answer, keeping its status
 * so postgrest-js still retries a 520. A 4xx is left alone (PostgREST reads
 * an empty 404 as no rows).
 */
export async function fetchWithDbTimeout(
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
  timeoutMs = COMMUNITY_DB_TIMEOUT_MS,
  send: typeof fetch = fetch,
): Promise<Response> {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), timeoutMs).unref?.();
  const signal = init?.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal;
  let response: Response;
  try {
    response = await send(input, { ...init, signal });
  } catch (error) {
    if (controller.signal.aborted && !init?.signal?.aborted) {
      return dbDownResponse(504);
    }
    throw error;
  }
  if (response.status < 500) {
    return response;
  }
  if (!response.headers.get("content-type")?.includes("json")) {
    await response.body?.cancel().catch(() => undefined);
    return dbDownResponse(response.status);
  }
  // PostgREST up but Postgres not (PGRST000-003: no connection, no schema
  // cache, no pool slot) says so in its own words: "Could not query the
  // database for the schema cache. Retrying."
  const body = (await response.clone().json().catch(() => undefined)) as { code?: unknown } | undefined;
  if (typeof body?.code === "string" && /^PGRST00[0-3]$/.test(body.code)) {
    await response.body?.cancel().catch(() => undefined);
    return dbDownResponse(response.status);
  }
  return response;
}

export function isCommunityConfigured(): boolean {
  return isLocalDb() || Boolean(process.env.POSTGREST_URL && process.env.POSTGREST_SERVICE_TOKEN);
}

/** A PostgREST client sending the token as a bearer, through the timed and guarded fetch. */
function postgrestClient(url: string, token: string, send?: typeof fetch): DbClient {
  return new PostgrestClient(url, {
    headers: { Authorization: `Bearer ${token}` },
    fetch: (input, init) => fetchFromDb(input, init, send),
  });
}

export function getCommunityDb(): DbClient {
  if (!cachedClient && isLocalDb()) {
    // Local development (LOCAL_DB=1): the database on this machine, never
    // the configured one, whatever POSTGREST_URL says. Never in production.
    assertLocalDbAllowed();
    cachedClient = postgrestClient(`${localDbUrl()}/rest/v1`, LOCAL_DB_SERVICE_KEY, (i, n) =>
      localDbFetch(i, n, fetch),
    );
  }
  if (!cachedClient) {
    const url = process.env.POSTGREST_URL;
    const token = process.env.POSTGREST_SERVICE_TOKEN;
    if (!url || !token) {
      throw new Error("The database is not configured: set POSTGREST_URL and POSTGREST_SERVICE_TOKEN");
    }
    cachedClient = postgrestClient(url.replace(/\/+$/, ""), token);
  }

  return cachedClient;
}
