/**
 * After this many database requests in a row fail as down, the next ones fail
 * at once, without being sent, for `DB_BREAKER_OPEN_MS`; then one goes through
 * to try. A stalled instance only recovers once demand drops (its disk budget
 * refills below baseline), and every tab keeps asking.
 */
export const DB_BREAKER_FAILURES = 5;
export const DB_BREAKER_OPEN_MS = 15_000;
let dbFailuresInARow = 0;
let dbBreakerOpenUntil = 0;

/** For tests: a closed breaker. */
export function resetDbBreaker(): void {
  dbFailuresInARow = 0;
  dbBreakerOpenUntil = 0;
}

/** Whether requests should fail at once without being sent. */
export function dbBreakerOpen(now = Date.now()): boolean {
  return now < dbBreakerOpenUntil;
}

/** Counts one answered request: a down answer moves the breaker toward open, any other closes the count. */
export function recordDbOutcome(down: boolean): void {
  if (down) {
    dbFailuresInARow += 1;
    if (dbFailuresInARow >= DB_BREAKER_FAILURES) {
      dbBreakerOpenUntil = Date.now() + DB_BREAKER_OPEN_MS;
    }
  } else {
    dbFailuresInARow = 0;
  }
}
