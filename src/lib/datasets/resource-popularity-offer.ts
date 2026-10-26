import { useEffect, useSyncExternalStore } from "react";

/**
 * Whether the community popularity map has anything in it, which decides
 * whether the item list offers "Most popular" at all: over an empty map that
 * sort is only "most ways to make" under another name. Asked once per page
 * (`/api/resource-popularity?count=1`, a number, not the map) and again after
 * the server's half-hour cache, so a sweep that lands later is seen and one
 * that empties takes the sort away. Unknown and failed both read as empty.
 */

const FRESH_MS = 30 * 60 * 1000;

let available = false;
let checkedAt: number | undefined;
let inflight: Promise<void> | undefined;
const listeners = new Set<() => void>();

function publish(next: boolean) {
  if (next !== available) {
    available = next;
    for (const listener of listeners) {
      listener();
    }
  }
}

/** Asks the server again now; resolves once the answer is in. */
export function refreshResourcePopularityOffer(): Promise<void> {
  inflight ??= fetch("/api/resource-popularity?count=1", { headers: { Accept: "application/json" } })
    .then(async (response) => {
      const body = response.ok ? ((await response.json()) as { count?: unknown }) : undefined;
      publish(typeof body?.count === "number" && body.count > 0);
    })
    .catch(() => publish(false))
    .finally(() => {
      checkedAt = Date.now();
      inflight = undefined;
    });
  return inflight;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** True while the popularity map is known to hold entries. */
export function useResourcePopularityOffered(): boolean {
  const offered = useSyncExternalStore(
    subscribe,
    () => available,
    () => false,
  );
  useEffect(() => {
    const ask = () => {
      if (checkedAt === undefined || Date.now() - checkedAt >= FRESH_MS) {
        void refreshResourcePopularityOffer();
      }
    };
    ask();
    const timer = window.setInterval(ask, FRESH_MS);
    return () => window.clearInterval(timer);
  }, []);
  return offered;
}

/** Tests only: forget what was learned. */
export function resetResourcePopularityOfferForTests() {
  available = false;
  checkedAt = undefined;
  inflight = undefined;
}
