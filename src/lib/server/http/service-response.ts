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
 * only), or `{ ...body, error: message }` at the error's status with
 * `Cache-Control: no-store`, so no cache keeps a refusal or an outage.
 */
export function serviceResponse<T>(
  result: ServiceResult<T>,
  toBody: (value: T) => unknown,
  init?: ResponseInit,
): NextResponse {
  if (result.ok) {
    return NextResponse.json(toBody(result.value), init);
  }
  const { kind, message, status, body, headers } = result.error;
  return NextResponse.json(
    { ...body, error: message },
    {
      status: status ?? SERVICE_ERROR_STATUS[kind],
      headers: { ...headers, "Cache-Control": "no-store" },
    },
  );
}
