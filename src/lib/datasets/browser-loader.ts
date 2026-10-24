"use client";

import type { MachineTier, Recipe, ResourceAmount } from "@/lib/model/types";
import type { RecipeContentRef } from "@/lib/import-export/recipe-ref-match";
import { DATASET_ANSWER_VERSION, DATASET_ANSWER_VERSION_PARAM } from "./answer-version";
import { RESOLVE_RECIPES_CHUNK_REFS } from "./resolve-recipes-limits";
import type { ClientFileKind, ClientFileListingResponse } from "./client-file-kinds";
import {
  serializeRecipeQueryClause,
  type RecipeQueryClause,
  type RecipeQuerySideOp,
} from "./recipe-query";
import type { SearchCorrection, SearchPhase } from "@/lib/search";
import type {
  DatasetResourceIndexEntry,
  DatasetVersion,
  RecipeDataset,
  RecipeSummary,
} from "./types";

type TierFilter = "all" | Exclude<MachineTier, "DEMO">;

export interface RecipeMapSelection {
  mode: "exclude" | "include";
  maps: string[];
}

export interface RecipeDatasetQuery {
  query: string;
  resource?: Pick<ResourceAmount, "kind" | "id">;
  mode: "recipes" | "uses";
  /** Multi-condition search; when present these replace resource+mode. */
  clauses?: RecipeQueryClause[];
  takesOp?: RecipeQuerySideOp;
  makesOp?: RecipeQuerySideOp;
  /** Page across every recipe map instead of scoping to one. */
  allMaps?: boolean;
  /**
   * The machine chips' multi-select: "exclude" lists the unselected maps,
   * "include" the selected ones (empty include = none). Absent means all.
   */
  mapSelection?: RecipeMapSelection;
  recipeMap?: string;
  maxTier: TierFilter;
  offset: number;
  limit: number;
}

export interface RecipeDatasetQueryResult {
  recipes: RecipeSummary[];
  total: number;
  recipeMaps: string[];
  recipeMapCounts?: Record<string, number>;
  recipeMapIcons?: Record<string, DatasetResourceIndexEntry>;
  offset: number;
  limit: number;
  hasMore: boolean;
  searchPhase?: SearchPhase;
  corrections?: SearchCorrection[];
}

export interface RecipeDatasetResourceQuery {
  query: string;
  offset: number;
  limit: number;
  kind?: "item" | "fluid";
  mod?: string;
  sort?: "relevance" | "name" | "mod" | "recipes" | "made" | "uses" | "popular";
  /** Narrow to what a crop can grow or a bee can make. */
  source?: "plants" | "bees";
}

export interface RecipeDatasetResourceQueryResult {
  resources: DatasetResourceIndexEntry[];
  total: number;
  offset: number;
  limit: number;
  hasMore: boolean;
  /** Mods present in the current search scope, with match counts. */
  mods?: Array<{ id: string; count: number }>;
  /** How the results were arrived at: as typed, respelled, or loosened. */
  searchPhase?: SearchPhase;
  /** The words that had to be respelled to find anything. */
  corrections?: SearchCorrection[];
}

export type RecipeDatasetResolveRef = RecipeContentRef;

export interface RecipeDatasetResolveResult {
  matches: Array<{
    importedId: string;
    recipeId: string;
    /** The same slots, amounts, ticks and EU under a new id. */
    exact: boolean;
  }>;
}

export async function initRecipeDatasetVersion(
  _manifestUrl: string,
  version: DatasetVersion,
  options: { signal?: AbortSignal } = {},
): Promise<RecipeDataset> {
  return fetchClientFile(version, "catalog", options.signal, () => {
    const url = new URL(
      `/api/datasets/${encodeURIComponent(version.id)}/catalog`,
      window.location.origin,
    );
    addDatasetCacheKey(url, version);
    return fetchJson<RecipeDataset>(url.toString(), { signal: options.signal });
  });
}

/**
 * Where the server keeps this version's static answers, by request URL. Only
 * a complete listing is kept: one the server is still writing is asked again
 * next time, so a file written since is picked up.
 */
const clientFileListings = new Map<string, Promise<ClientFileListingResponse>>();

function clientFileListing(version: DatasetVersion): Promise<ClientFileListingResponse> {
  const url = new URL(
    `/api/datasets/${encodeURIComponent(version.id)}/client-files`,
    window.location.origin,
  );
  addDatasetCacheKey(url, version);
  const key = url.toString();
  const kept = clientFileListings.get(key);
  if (kept) {
    return kept;
  }
  const listing = fetchJson<ClientFileListingResponse>(key).then(
    (answer) => {
      if (!answer.complete) {
        clientFileListings.delete(key);
      }
      return { complete: answer.complete === true, files: answer.files ?? {} };
    },
    () => {
      clientFileListings.delete(key);
      return { complete: false, files: {} };
    },
  );
  clientFileListings.set(key, listing);
  return listing;
}

/**
 * One of the answers every player gets the same (the catalog, the pickers'
 * lists, the recipe id list), from the server's content-addressed static file
 * when it lists one: the same JSON as the API route, cached a year by the
 * browser and Cloudflare. Anything else (no listing yet, a file missing, an
 * old server) asks the API as before.
 */
async function fetchClientFile<T>(
  version: DatasetVersion,
  kind: ClientFileKind,
  signal: AbortSignal | undefined,
  fromApi: () => Promise<T>,
): Promise<T> {
  const path = (await clientFileListing(version)).files[kind];
  if (path) {
    try {
      return await fetchJson<T>(new URL(path, window.location.origin).toString(), { signal });
    } catch (error) {
      if (signal?.aborted) {
        throw error;
      }
    }
  }
  return fromApi();
}

/**
 * Full recipes already fetched this session, keyed by their request URL (which
 * carries the dataset hash, so a republished dataset misses cleanly). Even
 * with HTTP caching in play this saves the parse and the cache lookup, and it
 * holds the promise rather than the recipe so a hover prefetch and the click
 * that follows it share one request.
 */
const recipeFetchCache = new Map<string, Promise<Recipe>>();
const RECIPE_FETCH_CACHE_LIMIT = 256;

export async function getRecipeDatasetRecipe(
  _manifestUrl: string,
  version: DatasetVersion,
  recipeId: string,
  options: { signal?: AbortSignal } = {},
): Promise<Recipe> {
  const url = new URL(
    `/api/datasets/${encodeURIComponent(version.id)}/recipes/${encodeURIComponent(recipeId)}`,
    window.location.origin,
  );
  addDatasetCacheKey(url, version);
  const key = url.toString();
  if (options.signal) {
    // An abortable request is one caller's alone; caching it would let that
    // caller's abort reject everyone else's hit.
    return fetchJson<Recipe>(key, { signal: options.signal }, { retryWhenBusy: true });
  }

  const cached = recipeFetchCache.get(key);
  if (cached) {
    return cached;
  }

  const promise = fetchJson<Recipe>(key, undefined, { retryWhenBusy: true }).catch((error) => {
    recipeFetchCache.delete(key);
    throw error;
  });
  if (recipeFetchCache.size >= RECIPE_FETCH_CACHE_LIMIT) {
    const oldest = recipeFetchCache.keys().next().value;
    if (oldest !== undefined) {
      recipeFetchCache.delete(oldest);
    }
  }
  recipeFetchCache.set(key, promise);
  return promise;
}

export async function getRecipeDatasetRecipeIds(
  _manifestUrl: string,
  version: DatasetVersion,
): Promise<string[]> {
  const result = await fetchClientFile(version, "recipe-ids", undefined, () => {
    const url = new URL(
      `/api/datasets/${encodeURIComponent(version.id)}/recipe-ids`,
      window.location.origin,
    );
    addDatasetCacheKey(url, version);
    return fetchJson<{ recipeIds: string[] }>(url.toString(), undefined, {
      retryWhenBusy: true,
    });
  });
  return result.recipeIds;
}

/**
 * The server takes a bounded number of refs per call, so a plan whose
 * recipes are all stale goes in chunks, one after the other, and the matches
 * are joined in order. One chunk's refusal fails the whole resolution, as one
 * call's did.
 */
export async function resolveRecipeDatasetRecipes(
  _manifestUrl: string,
  version: DatasetVersion,
  recipes: RecipeDatasetResolveRef[],
): Promise<RecipeDatasetResolveResult> {
  const url = new URL(
    `/api/datasets/${encodeURIComponent(version.id)}/resolve-recipes`,
    window.location.origin,
  );
  addDatasetCacheKey(url, version);
  const matches: RecipeDatasetResolveResult["matches"] = [];
  for (let at = 0; at === 0 || at < recipes.length; at += RESOLVE_RECIPES_CHUNK_REFS) {
    const chunk = recipes.slice(at, at + RESOLVE_RECIPES_CHUNK_REFS);
    const answer = await fetchJson<RecipeDatasetResolveResult>(
      url.toString(),
      { method: "POST", body: JSON.stringify({ recipes: chunk }) },
      { retryWhenBusy: true },
    );
    matches.push(...answer.matches);
  }
  return { matches };
}

export async function queryRecipeDatasetRecipes(
  _manifestUrl: string,
  version: DatasetVersion,
  query: RecipeDatasetQuery,
  options: { signal?: AbortSignal } = {},
): Promise<RecipeDatasetQueryResult> {
  const url = new URL(
    `/api/datasets/${encodeURIComponent(version.id)}/recipes`,
    window.location.origin,
  );
  url.searchParams.set("query", query.query);
  url.searchParams.set("mode", query.mode);
  url.searchParams.set("maxTier", query.maxTier);
  url.searchParams.set("offset", String(query.offset));
  url.searchParams.set("limit", String(query.limit));
  addDatasetCacheKey(url, version);
  if (query.recipeMap) {
    url.searchParams.set("recipeMap", query.recipeMap);
  }
  if (query.resource) {
    url.searchParams.set("resourceKind", query.resource.kind);
    url.searchParams.set("resourceId", query.resource.id);
  }
  for (const clause of query.clauses ?? []) {
    url.searchParams.append("clause", serializeRecipeQueryClause(clause));
  }
  if (query.takesOp && query.takesOp !== "any") {
    url.searchParams.set("takesOp", query.takesOp);
  }
  if (query.makesOp && query.makesOp !== "any") {
    url.searchParams.set("makesOp", query.makesOp);
  }
  if (query.allMaps) {
    url.searchParams.set("allMaps", "1");
  }
  if (query.mapSelection) {
    url.searchParams.set("mapMode", query.mapSelection.mode);
    for (const map of query.mapSelection.maps) {
      url.searchParams.append("map", map);
    }
  }

  return fetchJson<RecipeDatasetQueryResult>(url.toString(), { signal: options.signal });
}

export async function listRecipeDatasetCrops(
  _manifestUrl: string,
  version: DatasetVersion,
  options: { signal?: AbortSignal } = {},
): Promise<{ crops: RecipeSummary[] }> {
  return fetchClientFile(version, "crops", options.signal, () => {
    const url = new URL(
      `/api/datasets/${encodeURIComponent(version.id)}/crops`,
      window.location.origin,
    );
    addDatasetCacheKey(url, version);
    return fetchJson<{ crops: RecipeSummary[] }>(url.toString(), { signal: options.signal });
  });
}

/** The Extreme Entity Crusher's mobs, for the spawner picker on its card. */
export async function listRecipeDatasetMobs(
  _manifestUrl: string,
  version: DatasetVersion,
  options: { signal?: AbortSignal } = {},
): Promise<{ mobs: RecipeSummary[] }> {
  return fetchClientFile(version, "mobs", options.signal, () => {
    const url = new URL(
      `/api/datasets/${encodeURIComponent(version.id)}/mobs`,
      window.location.origin,
    );
    addDatasetCacheKey(url, version);
    return fetchJson<{ mobs: RecipeSummary[] }>(url.toString(), { signal: options.signal });
  });
}

export async function queryRecipeDatasetResources(
  _manifestUrl: string,
  version: DatasetVersion,
  query: RecipeDatasetResourceQuery,
  options: { signal?: AbortSignal } = {},
): Promise<RecipeDatasetResourceQueryResult> {
  const url = new URL(
    `/api/datasets/${encodeURIComponent(version.id)}/resources`,
    window.location.origin,
  );
  url.searchParams.set("query", query.query);
  url.searchParams.set("offset", String(query.offset));
  url.searchParams.set("limit", String(query.limit));
  if (query.kind) {
    url.searchParams.set("kind", query.kind);
  }
  if (query.mod) {
    url.searchParams.set("mod", query.mod);
  }
  if (query.sort && query.sort !== "relevance") {
    url.searchParams.set("sort", query.sort);
  }
  if (query.source) {
    url.searchParams.set("source", query.source);
  }
  addDatasetCacheKey(url, version);

  return fetchJson<RecipeDatasetResourceQueryResult>(url.toString(), { signal: options.signal });
}

/**
 * The server refuses an address that has spent its minute's dataset budget
 * with a 429 and a Retry-After. A search shows that refusal in its pane. A
 * plan open or import fetches one body per recipe and must never fail whole
 * on one refusal, so those wait and ask again, this many times.
 */
const BUSY_RETRIES = 6;
const BUSY_RETRY_DEFAULT_MS = 10_000;
const BUSY_RETRY_MAX_MS = 30_000;

async function fetchJson<T>(
  url: string,
  init?: RequestInit,
  options: { retryWhenBusy?: boolean } = {},
): Promise<T> {
  // No cache mode: every GET here carries the dataset checksum and the answer
  // version in its URL (addDatasetCacheKey), so the browser's HTTP cache can
  // legally reuse responses across reloads and sessions. The server marks such
  // responses immutable to match.
  const request: RequestInit = {
    headers: {
      Accept: "application/json",
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
    },
    ...init,
  };
  let response = await fetch(url, request);
  for (
    let retry = 0;
    response.status === 429 && options.retryWhenBusy && retry < BUSY_RETRIES;
    retry += 1
  ) {
    await response.text();
    await waitToRetry(retryAfterMs(response), init?.signal);
    response = await fetch(url, request);
  }

  const contentType = response.headers.get("content-type") ?? "";
  const body = await response.text();
  const payload =
    body && contentType.includes("application/json")
      ? (JSON.parse(body) as T | { error?: string })
      : undefined;

  if (!response.ok) {
    throw new Error(
      typeof payload === "object" && payload && "error" in payload && payload.error
        ? payload.error
        : `Request failed (${response.status} ${response.statusText || "HTTP error"}).`,
    );
  }

  if (!payload) {
    const preview = body.trim().replace(/\s+/g, " ").slice(0, 120);
    throw new Error(
      `Expected JSON but received ${contentType || "an unknown content type"}${
        preview ? `: ${preview}` : "."
      }`,
    );
  }

  return payload as T;
}

function retryAfterMs(response: Response): number {
  const seconds = Number.parseInt(response.headers.get("retry-after") ?? "", 10);
  return Number.isInteger(seconds) && seconds > 0
    ? Math.min(seconds * 1000, BUSY_RETRY_MAX_MS)
    : BUSY_RETRY_DEFAULT_MS;
}

function waitToRetry(ms: number, signal?: AbortSignal | null): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("The request was aborted.", "AbortError"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("The request was aborted.", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Every dataset request's cache key: the dataset's checksum and the version of
 * the code that answers it (`answer-version.ts`), so neither a republished
 * dataset nor a deploy that changes an answer is ever served from an old copy.
 */
export function addDatasetCacheKey(url: URL, version: DatasetVersion) {
  url.searchParams.set("datasetHash", version.checksumSha256 ?? version.publishedAt ?? version.id);
  url.searchParams.set(DATASET_ANSWER_VERSION_PARAM, DATASET_ANSWER_VERSION);
}
