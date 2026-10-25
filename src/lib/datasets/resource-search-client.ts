import type {
  ResourceSearchWorkerMessage,
  ResourceSearchWorkerReply,
} from "@/lib/search/resource-search.worker";
import { normalizeResourceSearchRequest } from "@/lib/search/resource-search";
import type { DatasetVersion } from "./types";

/**
 * The browser's item search: the server's own search code
 * (`src/lib/search/resource-search.ts`) in a Web Worker, over the version's
 * `items` file (the server's content-addressed answer, about 1.8 MB brotli on
 * 2.9), so typing in an item pane costs the server nothing. One version at a
 * time, the one a page last asked about; another version's worker is ended.
 * Until the worker is ready, and for any query it cannot answer the same, the
 * caller asks the API (`searchResourcesInBrowser` answers undefined), so the
 * client never waits longer than it did.
 *
 * Off on a device that reports under 4 GB of memory: the worker holds the
 * item list and its index, about 110 MB on 2.9 (the parsed list 39 MB, the
 * index 68 MB; 91 MB on 2.8.1, measured in Node), built in about 0.6 s.
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
    failedKeys.has(versionKey(version))
  ) {
    return;
  }
  stopBrowserResourceSearch();
  let worker: Worker;
  try {
    worker = new Worker(new URL("../search/resource-search.worker.ts", import.meta.url));
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
