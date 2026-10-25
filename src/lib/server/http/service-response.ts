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
 * A service's result as the route's answer: the value through `toBody`, or
 * `{ error: message, ...body }` at the error's status. `init` applies to
 * both (headers such as `Cache-Control`); an error sets its own status.
 */
export function serviceResponse<T>(
  result: ServiceResult<T>,
  toBody: (value: T) => unknown,
  init?: ResponseInit,
): NextResponse {
  if (result.ok) {
    return NextResponse.json(toBody(result.value), init);
  }
  const { kind, message, status, body } = result.error;
  return NextResponse.json(
    { error: message, ...body },
    { ...init, status: status ?? SERVICE_ERROR_STATUS[kind] },
  );
}
