import {
  createResourceSearchEngine,
  READABLE_RESOURCE_SEARCH_FILE_SCHEMAS,
  type ResourceSearchFile,
} from "./resource-search-engine";
import type { ResourceSearchRequest } from "./resource-search";

/**
 * The item search, off the main thread (a one- or two-letter query walks
 * every item: 30-45 ms on a fast machine, several times that on a slow
 * phone, which must never land on the board's thread). One `load` message
 * downloads the version's `items` file and builds the index; each `query`
 * answers with the JSON the `/resources` route would send, or `fallback` when
 * this worker cannot answer it the same (not loaded, no popularity map yet
 * for the "Most popular" sort, any error), and the page asks the API.
 * The scheduling lives in `src/lib/datasets/resource-search-client.ts`.
 */

export type ResourceSearchWorkerMessage =
  | { type: "load"; itemsUrl: string; popularityUrl: string }
  | { type: "query"; id: number; request: Omit<ResourceSearchRequest, "popularity"> }
  | { type: "cancel"; id: number };

export type ResourceSearchWorkerReply =
  | { type: "ready"; buildMs: number }
  | { type: "failed"; error: string }
  | { type: "result"; id: number; json: string }
  | { type: "fallback"; id: number };

/** As long as the route's popular answers are cached (`max-age=1800`). */
const POPULARITY_FRESH_MS = 30 * 60 * 1000;

let engine: ReturnType<typeof createResourceSearchEngine> | undefined;
let popularityUrl = "";
let popularity: { map: Map<string, number>; at: number } | undefined;
let popularityLoad: Promise<void> | undefined;

function post(reply: ResourceSearchWorkerReply) {
  self.postMessage(reply);
}

function refreshPopularity() {
  popularityLoad ??= fetch(popularityUrl, { headers: { Accept: "application/json" } })
    .then(async (response) => {
      if (!response.ok) {
        throw new Error(`Popularity request failed (${response.status}).`);
      }
      const body = (await response.json()) as { entries?: Array<[string, number]> };
      popularity = { map: new Map(body.entries ?? []), at: Date.now() };
    })
    .catch(() => {
      // Keep the last map; a popular query without one asks the API.
    })
    .finally(() => {
      popularityLoad = undefined;
    });
}

/**
 * Queries waiting to run. A message only queues its query, and each task
 * answers one, so a cancel that arrives while another query walks (the player
 * typed on) still drops its query before the walk.
 */
const waiting: Array<{ id: number; request: Omit<ResourceSearchRequest, "popularity"> }> = [];
let draining = false;

function schedule() {
  if (!draining && waiting.length > 0) {
    draining = true;
    setTimeout(drainOne, 0);
  }
}

function drainOne() {
  draining = false;
  const next = waiting.shift();
  if (next) {
    answer(next.id, next.request);
  }
  schedule();
}

function answer(id: number, request: Omit<ResourceSearchRequest, "popularity">) {
  if (!engine) {
    post({ type: "fallback", id });
    return;
  }
  if (request.sort === "popular") {
    if (!popularity || Date.now() - popularity.at >= POPULARITY_FRESH_MS) {
      refreshPopularity();
    }
    if (!popularity) {
      post({ type: "fallback", id });
      return;
    }
  }
  try {
    const result = engine({
      ...request,
      popularity: request.sort === "popular" ? popularity?.map : undefined,
    });
    // Sent as the route's JSON, so the page reads exactly what the API would
    // have sent (no undefined fields), and the copy across is one string.
    post({ type: "result", id, json: JSON.stringify(result) });
  } catch {
    post({ type: "fallback", id });
  }
}

self.onmessage = async (event: MessageEvent<ResourceSearchWorkerMessage>) => {
  const message = event.data;
  if (message.type === "load") {
    try {
      popularityUrl = message.popularityUrl;
      refreshPopularity();
      const response = await fetch(message.itemsUrl, { headers: { Accept: "application/json" } });
      if (!response.ok) {
        throw new Error(`Item search file request failed (${response.status}).`);
      }
      const file = (await response.json()) as ResourceSearchFile;
      // A file of another format (a tab older or newer than the server's
      // build) would answer wrong; the page asks the API instead.
      if (!READABLE_RESOURCE_SEARCH_FILE_SCHEMAS.has(file?.schemaVersion)) {
        throw new Error(`Item search file has format ${String(file?.schemaVersion)}.`);
      }
      const started = performance.now();
      engine = createResourceSearchEngine(file);
      post({ type: "ready", buildMs: performance.now() - started });
    } catch (error) {
      post({ type: "failed", error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }
  if (message.type === "cancel") {
    const at = waiting.findIndex((query) => query.id === message.id);
    if (at >= 0) {
      waiting.splice(at, 1);
    }
    return;
  }
  waiting.push({ id: message.id, request: message.request });
  schedule();
};
