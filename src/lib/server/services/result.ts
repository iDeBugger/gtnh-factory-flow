/**
 * What a service answers: a value, or an error a route maps to its status
 * and body (`http/service-response.ts`). Services never build HTTP
 * responses, so the same rule serves the site's routes and the live service.
 */

export type ServiceErrorKind =
  | "not-found"
  | "forbidden"
  | "conflict"
  | "bad-request"
  | "unauthorized"
  | "rate-limited"
  | "too-large"
  | "unavailable";

export interface ServiceError {
  kind: ServiceErrorKind;
  /** The player-facing sentence, answered as `error`. */
  message: string;
  /** Overrides the kind's status, for the routes whose answer differs. */
  status?: number;
  /** Fields answered beside `error`, such as `{ live: true }`; an `error` here never replaces `message`. */
  body?: Record<string, unknown>;
}

export type ServiceResult<T> = { ok: true; value: T } | { ok: false; error: ServiceError };

export function ok<T>(value: T): ServiceResult<T> {
  return { ok: true, value };
}

export function fail(
  kind: ServiceErrorKind,
  message: string,
  extra?: { status?: number; body?: Record<string, unknown> },
): ServiceResult<never> {
  return { ok: false, error: { kind, message, ...extra } };
}
