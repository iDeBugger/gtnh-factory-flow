/**
 * A value loaded at most once per `ttlMs`, held in memory only, never on
 * disk, since the image's filesystem is read-only (the sitemap and llms.txt,
 * for an hour):
 * - the first call waits for the load, and calls during it share that load;
 * - once the value is older than `ttlMs`, a call gets the old value at once
 *   and starts one reload in the background;
 * - a reload that throws keeps the old value, and the next call past the TTL
 *   tries again; a first load that throws rejects, and the next call tries
 *   again.
 * So a crawl burst costs one load, and a failing database never empties a
 * file that was already served.
 */
export function ttlMemo<T>(
  ttlMs: number,
  load: () => Promise<T>,
  now: () => number = Date.now,
): () => Promise<T> {
  let held: { value: T; at: number } | undefined;
  let pending: Promise<T> | undefined;

  const start = (): Promise<T> => {
    const startedAt = now();
    const run = (async () => load())().then((value) => {
      held = { value, at: startedAt };
      return value;
    });
    pending = run;
    run.then(
      () => {
        if (pending === run) pending = undefined;
      },
      () => {
        if (pending === run) pending = undefined;
      },
    );
    return run;
  };

  return () => {
    if (!held) {
      return pending ?? start();
    }
    if (now() - held.at >= ttlMs && !pending) {
      // The caller already has the old value; a failed reload only means the old value stays.
      start().catch(() => undefined);
    }
    return Promise.resolve(held.value);
  };
}
