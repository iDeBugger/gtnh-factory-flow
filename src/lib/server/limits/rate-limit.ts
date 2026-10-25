import * as events from "../repos/events";

/**
 * Work in flight per key, so a count-then-record limit sees every earlier
 * record: without this, N requests for one key arriving together all read a
 * count under the limit and all pass. The site is one process, so an
 * in-process queue is the whole story. An entry lives only while something
 * is in flight under its key.
 */
const inFlight = new Map<string, Promise<void>>();

/** Runs `work` after everything already queued under `key`, whatever became of it. */
export function serially<T>(key: string, work: () => Promise<T>): Promise<T> {
  const previous = inFlight.get(key) ?? Promise.resolve();
  const run = previous.then(work, work);
  const settled = run.then(
    () => undefined,
    () => undefined,
  );
  inFlight.set(key, settled);
  void settled.then(() => {
    if (inFlight.get(key) === settled) {
      inFlight.delete(key);
    }
  });
  return run;
}

/** Returns true when the action is allowed; records it when it is. One at a time per key and action. */
export function checkRateLimit(
  actorKey: string,
  action: string,
  maxPerWindow: number,
  windowSeconds: number,
): Promise<boolean> {
  return serially(`${actorKey}:${action}`, async () => {
    if ((await countEvents(actorKey, action, windowSeconds)) >= maxPerWindow) {
      return false;
    }
    await recordEvents([{ actorKey, action }]);
    return true;
  });
}

/** How many times the actor did the action in the last `windowSeconds`. */
export async function countEvents(actorKey: string, action: string, windowSeconds: number): Promise<number> {
  return events.countSince(actorKey, action, new Date(Date.now() - windowSeconds * 1000));
}

/** Records actions for `countEvents`, in one request. */
export async function recordEvents(rows: { actorKey: string; action: string }[]): Promise<void> {
  await events.insert(rows);
  await pruneEvents();
}

/**
 * Nothing reads an event older than the longest window (30 days, the same
 * words check), so older rows only cost the small instance disk and its IO
 * budget. Pruned once an hour per process, after a record: batches of the
 * oldest rows (by the `created_at` index), deleted by id, until a batch comes
 * back short or `PRUNE_BUDGET_MS` has gone, so a backlog drains as fast as
 * the hour's prune can manage yet never holds one request past the statement
 * timeout; what a prune does not reach waits for the next hour. A batch of
 * 500 ids keeps the `id=in.(...)` query string at 4 to 6 KB, under the usual
 * 8 KB request-line limit: never raise `PRUNE_BATCH_ROWS` past that. A prune
 * never fails a save.
 */
export const EVENTS_KEPT_DAYS = 31;
export const PRUNE_BATCH_ROWS = 500;
export const PRUNE_BUDGET_MS = 2_000;
const PRUNE_EVERY_MS = 60 * 60_000;
let lastPruneAt = 0;
let pruneBudgetMs = PRUNE_BUDGET_MS;

/** For tests: the next record prunes again, within `budgetMs`. */
export function forgetEventPrune(budgetMs = PRUNE_BUDGET_MS): void {
  lastPruneAt = 0;
  pruneBudgetMs = budgetMs;
}

async function pruneEvents(): Promise<void> {
  const now = Date.now();
  if (now - lastPruneAt < PRUNE_EVERY_MS) {
    return;
  }
  lastPruneAt = now;
  const before = new Date(now - EVENTS_KEPT_DAYS * 86_400_000);
  try {
    // At least one batch, then more while the budget lasts.
    do {
      const ids = await events.oldestIdsBefore(before, PRUNE_BATCH_ROWS);
      if (ids.length === 0) {
        return;
      }
      await events.deleteIds(ids);
      if (ids.length < PRUNE_BATCH_ROWS) {
        return;
      }
    } while (Date.now() - now < pruneBudgetMs);
  } catch {
    // The rows stay until the next hour's prune.
  }
}
