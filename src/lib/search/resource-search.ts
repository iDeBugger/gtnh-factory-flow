import type { DatasetResourceIndexEntry } from "@/lib/datasets/types";
import { isOreDictionaryResource, isVirtualChoiceResource } from "@/lib/model/resources";
import {
  buildSearchVocabulary,
  buildTokenSearchIndex,
  createTokenInterner,
  queryTextSearchIndex,
  resolveSearchPhases,
  type SearchPhase,
  type SearchVocabulary,
  type TextSearchIndex,
} from "./text-index";
import {
  matchSearchEntry,
  parseSearchQuery,
  splitSearchTokens,
  type SearchEntryFields,
  type SearchQuery,
} from "./text-search";

/**
 * The item (resource) search, over a dataset's resource list: one copy of the
 * code for the server's `/resources` route and the browser's search worker
 * (`resource-search.worker.ts`), so the two answer the same total, the same
 * page in the same order and the same spelling correction. Nothing here reads
 * a file or the network: each side hands in the list and the per-dataset facts
 * (made/used counts, what crops and bees make, the community popularity).
 */

export type ResourceQuerySort =
  | "relevance"
  | "name"
  | "mod"
  | "recipes"
  | "made"
  | "uses"
  | "popular";

export type ResourceSourceFilter = "plants" | "bees";

export interface ResourceSearchRequest {
  query: string;
  offset: number;
  limit: number;
  kind?: "item" | "fluid";
  mod?: string;
  sort?: ResourceQuerySort;
  source?: ResourceSourceFilter;
  /** Community popularity by `${kind}:${id}`, required only by sort "popular". */
  popularity?: Map<string, number>;
}

const RESOURCE_SORTS = new Set<string>(["name", "mod", "recipes", "made", "uses", "popular"]);

/** The most one request answers, and what one without a limit gets. */
export const RESOURCE_SEARCH_MAX_LIMIT = 120;
const RESOURCE_SEARCH_DEFAULT_LIMIT = 24;

/**
 * A request as the `/resources` route reads its query string, and as the
 * browser's worker must read the same request: whole numbers parsed as
 * `parseInt` does, the limit held to 1-120, unknown kinds, sorts and sources
 * dropped ("relevance" is the default, so it is dropped too).
 */
export function normalizeResourceSearchRequest(raw: {
  query: string | null;
  offset: string | number | null;
  limit: string | number | null;
  kind?: string | null;
  mod?: string | null;
  sort?: string | null;
  source?: string | null;
}): Omit<ResourceSearchRequest, "popularity"> {
  const offset = Number.parseInt(String(raw.offset ?? ""), 10);
  const limit = Number.parseInt(String(raw.limit ?? ""), 10);
  return {
    query: raw.query ?? "",
    offset: Number.isInteger(offset) ? Math.max(0, offset) : 0,
    limit: Number.isInteger(limit)
      ? Math.max(1, Math.min(RESOURCE_SEARCH_MAX_LIMIT, limit))
      : RESOURCE_SEARCH_DEFAULT_LIMIT,
    kind: raw.kind === "item" || raw.kind === "fluid" ? raw.kind : undefined,
    mod: raw.mod ?? undefined,
    sort: raw.sort && RESOURCE_SORTS.has(raw.sort) ? (raw.sort as ResourceQuerySort) : undefined,
    source: raw.source === "plants" || raw.source === "bees" ? raw.source : undefined,
  };
}

export type ResourceDirectionCounts = ReadonlyMap<string, { madeBy: number; usedBy: number }>;

export interface ResourceSearchIndexes {
  sortedResourceIndexes: number[];
  /**
   * Each resource split by where its words came from, so a word in the item's
   * name counts for more than the same word buried in a registry id.
   */
  fields: SearchEntryFields[];
  searchIndex: TextSearchIndex;
  /** The words items are actually called: what a typo gets corrected against. */
  vocabulary: SearchVocabulary;
}

export interface ResourceSearch {
  matches: Array<{ resourceIndex: number; score: number }>;
  modCounts: Map<string, number>;
  resolved: { query: SearchQuery; phase: SearchPhase };
}

/** Mod is encoded in the id prefix ("gregtech:gt.metaitem..."); fluids are bare ids. */
export function getResourceModId(resource: { id: string; kind: string }): string {
  const colon = resource.id.indexOf(":");
  if (colon > 0) {
    return resource.id.slice(0, colon);
  }
  return resource.kind === "fluid" ? "fluids" : "other";
}

export function buildResourceSearchIndexes(
  resourceIndex: readonly DatasetResourceIndexEntry[],
): ResourceSearchIndexes {
  const fields: SearchEntryFields[] = [];
  const tokensByEntry: string[][] = [];
  const intern = createTokenInterner();
  const sortedResourceIndexes = resourceIndex
    .map((resource, index) => {
      fields[index] = resourceSearchFields(resource, intern);
      tokensByEntry[index] = [
        ...new Set([
          ...(fields[index].name ?? []),
          ...(fields[index].id ?? []),
          ...(fields[index].text ?? []),
        ]),
      ];
      return index;
    })
    .filter((index) => {
      const resource = resourceIndex[index];
      return Boolean(resource && !isVirtualChoiceResource(resource));
    })
    .sort((leftIndex, rightIndex) => {
      const left = resourceIndex[leftIndex];
      const right = resourceIndex[rightIndex];
      return (
        (right?.recipeCount ?? 0) - (left?.recipeCount ?? 0) ||
        (left?.displayName ?? left?.id ?? "").localeCompare(right?.displayName ?? right?.id ?? "")
      );
    });

  return {
    sortedResourceIndexes,
    fields,
    searchIndex: buildTokenSearchIndex(tokensByEntry, sortedResourceIndexes),
    // Ore dictionary entries are named "Ore Dictionary: plateSteel", which is not
    // a phrase anyone types, so only real names teach the corrector words.
    vocabulary: buildSearchVocabulary(
      sortedResourceIndexes
        .map((index) => resourceIndex[index])
        .filter((resource) => resource && !isOreDictionaryResource(resource))
        .map((resource) => resource.displayName ?? ""),
    ),
  };
}

function resourceSearchFields(
  resource: DatasetResourceIndexEntry,
  intern: (tokens: string[]) => string[],
): SearchEntryFields {
  return {
    nameText: (resource.displayName ?? resource.id).trim().toLowerCase(),
    name: intern(splitSearchTokens(resource.displayName ?? "")),
    id: intern(splitSearchTokens(`${resource.id} ${(resource.oreDictionary ?? []).join(" ")}`)),
    text: intern(splitSearchTokens((resource.tooltip ?? []).join(" "))),
  };
}

/** Every match of a request, scored and sorted, with the mod counts of its scope. */
export function searchResources(
  resourceIndex: readonly DatasetResourceIndexEntry[],
  indexes: ResourceSearchIndexes,
  request: ResourceSearchRequest,
  facts: {
    directionCounts: ResourceDirectionCounts;
    /** The `kind:id` keys a crop or bee makes, when the request names a source. */
    sourceKeys?: ReadonlySet<string>;
  },
): ResourceSearch {
  const { sourceKeys } = facts;
  let modCounts = new Map<string, number>();

  const resolved = resolveSearchPhases(
    parseSearchQuery(request.query),
    indexes.vocabulary,
    (query, options) => {
      // Counted per pass, because which mods are on offer depends on which
      // reading of the query the results came from.
      const counts = new Map<string, number>();
      const matches: Array<{ resourceIndex: number; score: number }> = [];
      // A query the index cannot narrow walks the whole list, the partial phase
      // included: about 60k entries, 40-60 ms, within the heavy base cost and
      // the metering, and that walk is what finds "bag of holding" (no item is
      // named that) and "motor lv hv" (the motors of those tiers).
      const candidateIndexes =
        queryTextSearchIndex(indexes.searchIndex, query, options) ?? indexes.sortedResourceIndexes;

      for (const resourceIndexNumber of candidateIndexes) {
        const resource = resourceIndex[resourceIndexNumber];
        if (
          !resource ||
          isVirtualChoiceResource(resource) ||
          (!resource.iconPath && !resource.iconAtlas)
        ) {
          continue;
        }
        if (request.kind && resource.kind !== request.kind) {
          continue;
        }
        if (sourceKeys && !sourceKeys.has(`${resource.kind}:${resource.id}`)) {
          continue;
        }

        const score = matchSearchEntry(query, indexes.fields[resourceIndexNumber] ?? {}, options);
        if (score === undefined) {
          continue;
        }

        // Mod counts reflect the search+kind scope, so the mod dropdown always
        // shows what picking each mod would leave.
        const modId = getResourceModId(resource);
        counts.set(modId, (counts.get(modId) ?? 0) + 1);
        if (request.mod && modId !== request.mod) {
          continue;
        }
        matches.push({
          resourceIndex: resourceIndexNumber,
          score: score > 0 ? score + resourceRelevanceBias(resource) : score,
        });
      }

      modCounts = counts;
      return matches;
    },
  );

  const matches = sortResourceMatches(
    resourceIndex,
    resolved.results,
    request.sort ?? "relevance",
    facts.directionCounts,
    request.popularity,
  );
  return { matches, modCounts, resolved };
}

/**
 * The page a request asks for, out of a search. `blankMod` is the mod of a
 * request with nothing typed answered from the un-modded list: its mod counts
 * are taken before the mod filter and the sort is stable, so filtering that
 * list is the same answer as searching with the mod.
 */
export function resourceSearchPage(
  resourceIndex: readonly DatasetResourceIndexEntry[],
  search: ResourceSearch,
  request: Pick<ResourceSearchRequest, "offset" | "limit">,
  blankMod?: string,
) {
  const { modCounts, resolved } = search;
  const matches = blankMod
    ? search.matches.filter((match) => {
        const resource = resourceIndex[match.resourceIndex];
        return resource !== undefined && getResourceModId(resource) === blankMod;
      })
    : search.matches;

  return {
    resources: matches
      .slice(request.offset, request.offset + request.limit)
      .map((match) => resourceIndex[match.resourceIndex])
      .filter(Boolean),
    total: matches.length,
    offset: request.offset,
    limit: request.limit,
    hasMore: request.offset + request.limit < matches.length,
    mods: [...modCounts.entries()]
      .map(([id, count]) => ({ id, count }))
      .sort((a, b) => b.count - a.count || a.id.localeCompare(b.id)),
    ...searchOutcome(resolved),
  };
}

/**
 * The key a request with nothing typed is kept under, or undefined for a
 * typed one. The mod is not part of it (see `resourceSearchPage`): keyed on
 * the mod, a request with a made-up mod name could push every player's list
 * out of what is kept.
 */
export function blankResourceSearchKey(request: ResourceSearchRequest): string | undefined {
  return request.query.trim() === ""
    ? JSON.stringify([request.kind ?? "", request.sort ?? "relevance", request.source ?? null])
    : undefined;
}

/**
 * The nudge that settles two equally good name matches.
 *
 * Between "Steel Plate" and "Compressed Aluminium Plate Casing", the item used
 * in more recipes and named more plainly is the one that was meant, so both
 * count for a little - never enough to outrank an actual better match.
 */
function resourceRelevanceBias(resource: DatasetResourceIndexEntry): number {
  const name = resource.displayName ?? resource.id;
  return Math.log10(1 + (resource.recipeCount ?? 0)) / 10 - name.length / 400;
}

/** What the search did, for the "showing results for ..." line. */
export function searchOutcome(resolved: { query: SearchQuery; phase: SearchPhase }) {
  return {
    searchPhase: resolved.phase,
    corrections: resolved.phase === "corrected" ? resolved.query.corrections : [],
  };
}

function sortResourceMatches(
  resourceIndex: readonly DatasetResourceIndexEntry[],
  matches: Array<{ resourceIndex: number; score: number }>,
  sort: ResourceQuerySort,
  directionCounts: ResourceDirectionCounts,
  popularity?: Map<string, number>,
) {
  const nameOf = (match: { resourceIndex: number }) => {
    const resource = resourceIndex[match.resourceIndex];
    return (resource?.displayName ?? resource?.id ?? "").toLowerCase();
  };
  const modOf = (match: { resourceIndex: number }) =>
    getResourceModId(resourceIndex[match.resourceIndex]);
  const recipesOf = (match: { resourceIndex: number }) =>
    resourceIndex[match.resourceIndex]?.recipeCount ?? 0;
  const countsOf = (match: { resourceIndex: number }) => {
    const resource = resourceIndex[match.resourceIndex];
    return (
      (resource && directionCounts.get(`${resource.kind}:${resource.id}`)) ?? {
        madeBy: 0,
        usedBy: 0,
      }
    );
  };

  if (sort === "name") {
    return [...matches].sort((left, right) => nameOf(left).localeCompare(nameOf(right)));
  }
  if (sort === "mod") {
    return [...matches].sort(
      (left, right) =>
        modOf(left).localeCompare(modOf(right)) || nameOf(left).localeCompare(nameOf(right)),
    );
  }
  if (sort === "recipes") {
    return [...matches].sort(
      (left, right) =>
        recipesOf(right) - recipesOf(left) || nameOf(left).localeCompare(nameOf(right)),
    );
  }
  if (sort === "made") {
    return [...matches].sort(
      (left, right) =>
        countsOf(right).madeBy - countsOf(left).madeBy || nameOf(left).localeCompare(nameOf(right)),
    );
  }
  if (sort === "uses") {
    return [...matches].sort(
      (left, right) =>
        countsOf(right).usedBy - countsOf(left).usedBy || nameOf(left).localeCompare(nameOf(right)),
    );
  }

  if (sort === "popular") {
    // What the community actually builds, aggregated over shared setups. A
    // typed query still wins first: "steel" must find steel, not the most
    // popular thing named vaguely like it. Resources no plan has touched
    // fall back to the best-match order behind everything with a score.
    const popularityOf = (match: { resourceIndex: number }) => {
      const resource = resourceIndex[match.resourceIndex];
      return (resource && popularity?.get(`${resource.kind}:${resource.id}`)) ?? 0;
    };
    return [...matches].sort(
      (left, right) =>
        right.score - left.score ||
        popularityOf(right) - popularityOf(left) ||
        countsOf(right).madeBy - countsOf(left).madeBy ||
        nameOf(left).localeCompare(nameOf(right)),
    );
  }

  // Best match. Equal scores - and with nothing typed every score is 0 - fall
  // to the thing with the most ways to MAKE it, which is the item a planner
  // most likely came to place.
  return [...matches].sort(
    (left, right) => right.score - left.score || countsOf(right).madeBy - countsOf(left).madeBy,
  );
}
