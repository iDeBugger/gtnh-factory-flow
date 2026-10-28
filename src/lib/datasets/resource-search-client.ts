import type {
  ResourceSearchWorkerMessage,
  ResourceSearchWorkerReply,
} from "@/lib/search/resource-search.worker";
import { normalizeResourceSearchRequest } from "@/lib/search/resource-search";
import type { DatasetVersion } from "./types";

/**
 * The browser's item search: the server's own search code
 * (`src/lib/search/resource-search.ts`) in a Web Worker, over the version's
 * `items` file (the server's content-addressed answer, about 2 MB brotli on
 * 2.9), so typing in an item pane costs the server nothing. Started by the
 * first item query for a version (never by opening a plan), for one version
 * at a time: a query for another version ends this worker and the next one
 * starts lazily, because two indexes would hold twice the memory below. Until
 * the worker is ready, and for any query it cannot answer the same, the caller
 * asks the API (`searchResourcesInBrowser` answers undefined), so the client
 * never waits longer than it did.
 *
 * Memory, measured in headless Chromium (the worker's JS heap after a GC, the
 * index built and a few searches kept): see `src/lib/server/CLAUDE.md`, item
 * search in the browser. Off where the browser reports under 4 GB of device
 * memory (`navigator.deviceMemory`, Chromium only; elsewhere the first-query
 * start is the guard).
 */

interface ActiveSearch {
  key: string;
  worker: Worker;
  ready: boolean;
  pending: Map<number, (json: string | undefined) => void>;
}

let active: ActiveSearch | undefined;
let nextQueryId = 1;
let broken = false;
/** Versions whose file failed to load: not asked again this session, the API answers them. */
const failedKeys = new Set<string>();

function versionKey(version: DatasetVersion): string {
  return `${version.id}:${version.checksumSha256 ?? version.publishedAt ?? ""}`;
}

export function browserResourceSearchAvailable(): boolean {
  if (broken || typeof Worker === "undefined" || typeof navigator === "undefined") {
    return false;
  }
  const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  return memory === undefined || memory >= 4;
}

/** Whether this version's file failed to load this session (the API answers it). */
export function browserResourceSearchFailed(version: DatasetVersion): boolean {
  return failedKeys.has(versionKey(version));
}

/** Whether the worker for this version is started (ready or not). */
export function browserResourceSearchStarted(version: DatasetVersion): boolean {
  return active?.key === versionKey(version);
}

/**
 * Starts the worker for a version, ending another version's. The worker
 * downloads `itemsUrl` itself, so nothing of the file passes the main thread.
 */
export function startBrowserResourceSearch(version: DatasetVersion, itemsUrl: string): void {
  if (
    !browserResourceSearchAvailable() ||
    browserResourceSearchStarted(version) ||
    browserResourceSearchFailed(version)
  ) {
    return;
  }
  stopBrowserResourceSearch();
  let worker: Worker;
  try {
    worker = new Worker(new URL("../search/resource-search.worker.ts", import.meta.url), {
      type: "module",
    });
  } catch {
    broken = true;
    return;
  }
  const search: ActiveSearch = {
    key: versionKey(version),
    worker,
    ready: false,
    pending: new Map(),
  };
  worker.onmessage = (event: MessageEvent<ResourceSearchWorkerReply>) => {
    const reply = event.data;
    if (reply.type === "ready") {
      search.ready = true;
    } else if (reply.type === "failed") {
      failedKeys.add(search.key);
      if (active === search) {
        stopBrowserResourceSearch();
      }
    } else {
      const settle = search.pending.get(reply.id);
      search.pending.delete(reply.id);
      settle?.(reply.type === "result" ? reply.json : undefined);
    }
  };
  worker.onerror = () => {
    broken = true;
    if (active === search) {
      stopBrowserResourceSearch();
    }
  };
  const origin = window.location.origin;
  const load: ResourceSearchWorkerMessage = {
    type: "load",
    itemsUrl: new URL(itemsUrl, origin).toString(),
    popularityUrl: new URL("/api/resource-popularity", origin).toString(),
  };
  worker.postMessage(load);
  active = search;
}

export function stopBrowserResourceSearch(): void {
  const search = active;
  active = undefined;
  if (!search) {
    return;
  }
  search.worker.terminate();
  for (const settle of search.pending.values()) {
    settle(undefined);
  }
  search.pending.clear();
}

/**
 * The answer the `/resources` route would give, from the worker, or undefined
 * when the worker for this version is not ready or cannot answer it the same:
 * the caller then asks the API. An abort rejects at once.
 */
export function searchResourcesInBrowser<T>(
  version: DatasetVersion,
  request: {
    query: string;
    offset: number;
    limit: number;
    kind?: string;
    mod?: string;
    sort?: string;
    source?: string;
  },
  signal?: AbortSignal,
): Promise<T | undefined> | undefined {
  const search = active;
  if (!search || !search.ready || search.key !== versionKey(version)) {
    return undefined;
  }
  return new Promise<T | undefined>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("The request was aborted.", "AbortError"));
      return;
    }
    const id = nextQueryId;
    nextQueryId += 1;
    const onAbort = () => {
      search.pending.delete(id);
      // A query still waiting in the worker is skipped: on a slow device stale
      // one-letter walks would otherwise run one after another.
      const cancel: ResourceSearchWorkerMessage = { type: "cancel", id };
      search.worker.postMessage(cancel);
      reject(new DOMException("The request was aborted.", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    search.pending.set(id, (json) => {
      signal?.removeEventListener("abort", onAbort);
      resolve(json === undefined ? undefined : (JSON.parse(json) as T));
    });
    const message: ResourceSearchWorkerMessage = {
      type: "query",
      id,
      request: normalizeResourceSearchRequest(request),
    };
    search.worker.postMessage(message);
  });
}
