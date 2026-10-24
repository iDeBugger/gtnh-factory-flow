import { timingSafeEqual } from "node:crypto";

/**
 * Constant-time check of a shared secret a request carries (an admin header,
 * the live service's internal token) against the one configured. An unset or
 * empty expected value matches nothing, so "no token configured" means nobody
 * holds it. A plain `===` stops at the first differing byte, which is a
 * timing signal, however faint.
 */
export function sameSecret(given: string | null | undefined, expected: string | undefined): boolean {
  if (!given || !expected) {
    return false;
  }
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
