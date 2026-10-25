import type { DatasetResourceIndexEntry } from "@/lib/datasets/types";
import { BoundedLru } from "@/lib/server/bounded-lru";
import {
  blankResourceSearchKey,
  buildResourceSearchIndexes,
  resourceSearchPage,
  searchResources,
  type ResourceSearch,
  type ResourceSearchIndexes,
  type ResourceSearchRequest,
  type ResourceSourceFilter,
} from "./resource-search";

/**
 * The item search's data as the browser downloads it (the `items` client
 * file, written by the server from the same catalog its `/resources` route
 * searches): the resource list exactly as the route returns its entries, and
 * the per-dataset facts the search reads besides it.
 */
export interface ResourceSearchFile {
  schemaVersion: 1;
  resourceIndex: DatasetResourceIndexEntry[];
  /** `[kind:id, madeBy, usedBy]` for every listed resource some recipe makes or uses. */
  directionCounts: Array<[key: string, madeBy: number, usedBy: number]>;
  /** The `kind:id` keys a crop or a bee makes, among the listed resources. */
  sources: Record<ResourceSourceFilter, string[]>;
}

/**
 * How many searches the engine keeps: a tall item column asks one search in
 * several pages of 120 at once, each page the same search, and a player goes
 * back and forth between a few sorts. Fewer than the server's 24 blank lists:
 * one blank list holds every item's match (about 2 MB on 2.9), and this heap
 * is the player's.
 */
const KEPT_SEARCHES = 8;

/**
 * The item search over a downloaded `ResourceSearchFile`: the browser's twin
 * of the server's `queryCatalogResources`, built on the same functions, so
 * every answer is the one the route would send. The search worker wraps it;
 * tests run it beside the server.
 */
export function createResourceSearchEngine(file: ResourceSearchFile) {
  const { resourceIndex } = file;
  const indexes: ResourceSearchIndexes = buildResourceSearchIndexes(resourceIndex);
  const directionCounts = new Map(
    file.directionCounts.map(([key, madeBy, usedBy]) => [key, { madeBy, usedBy }] as const),
  );
  const sources: Record<ResourceSourceFilter, Set<string>> = {
    plants: new Set(file.sources.plants),
    bees: new Set(file.sources.bees),
  };
  const kept = new BoundedLru<string, { popularity?: Map<string, number>; value: ResourceSearch }>(
    KEPT_SEARCHES,
  );

  return function query(request: ResourceSearchRequest) {
    const blankKey = blankResourceSearchKey(request);
    const searched = blankKey === undefined ? request : { ...request, mod: undefined };
    const key =
      blankKey ??
      JSON.stringify([
        request.query,
        request.kind ?? "",
        request.mod ?? "",
        request.sort ?? "relevance",
        request.source ?? null,
      ]);
    const hit = kept.get(key);
    const search =
      hit && hit.popularity === request.popularity
        ? hit.value
        : searchResources(resourceIndex, indexes, searched, {
            directionCounts,
            sourceKeys: request.source ? sources[request.source] : undefined,
          });
    if (search !== hit?.value) {
      kept.set(key, { popularity: request.popularity, value: search });
    }
    return resourceSearchPage(
      resourceIndex,
      search,
      request,
      blankKey !== undefined ? request.mod : undefined,
    );
  };
}
