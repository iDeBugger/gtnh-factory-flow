import { NextResponse } from "next/server";
import type { ServiceErrorKind, ServiceResult } from "../services/result";

/** The status each kind of service error answers with, unless the error names its own. */
export const SERVICE_ERROR_STATUS: Record<ServiceErrorKind, number> = {
  "not-found": 404,
  forbidden: 403,
  conflict: 409,
  "bad-request": 400,
  unauthorized: 401,
  "rate-limited": 429,
  "too-large": 413,
  unavailable: 503,
};

/**
 * A service's result as the route's answer: the value through `toBody` with
 * `init` (headers such as a public `Cache-Control` belong to a success
 * only; a function of the value when they depend on it, such as a
 * `Set-Cookie`), or `{ error: message, ...body }` at the error's status with
 * `Cache-Control: no-store`, so no cache keeps a refusal or an outage.
 */
export function serviceResponse<T>(
  result: ServiceResult<T>,
  toBody: (value: T) => unknown,
  init?: ResponseInit | ((value: T) => ResponseInit),
): NextResponse {
  if (result.ok) {
    const ready = typeof init === "function" ? init(result.value) : init;
    return NextResponse.json(toBody(result.value), ready);
  }
  const { kind, message, status, body, headers } = result.error;
  // The message first and never replaced: `error` in `body` is dropped.
  const { error: _replaced, ...rest } = body ?? {};
  return NextResponse.json(
    { error: message, ...rest },
    {
      status: status ?? SERVICE_ERROR_STATUS[kind],
      headers: { ...headers, "Cache-Control": "no-store" },
    },
  );
}
