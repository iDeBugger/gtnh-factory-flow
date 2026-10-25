/**
 * A rate limit kept in this process's memory: for cheap, frequent reads (the
 * account search a share box sends as someone types), where the database
 * limiter's two round trips would cost more than the read itself. Bounded:
 * the oldest keys are forgotten past `MAX_KEYS`.
 */

const MAX_KEYS = 10_000;

const windows = new Map<string, number[]>();

/** True when `key` may act now (and counts it); false past `limit` in `windowMs`. */
export function takeMemoryToken(
  key: string,
  limit: number,
  windowMs: number,
  now = Date.now(),
): boolean {
  const since = now - windowMs;
  const stamps = (windows.get(key) ?? []).filter((stamp) => stamp > since);
  if (stamps.length >= limit) {
    windows.set(key, stamps);
    return false;
  }
  stamps.push(now);
  windows.delete(key);
  windows.set(key, stamps);
  while (windows.size > MAX_KEYS) {
    const oldest = windows.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    windows.delete(oldest);
  }
  return true;
}

/** Forgets every window (tests). */
export function resetMemoryTokens(): void {
  windows.clear();
}
