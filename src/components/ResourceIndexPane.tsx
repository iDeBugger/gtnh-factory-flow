"use client";

import { Zap } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, useTransition } from "react";
import type { DragEvent, PointerEvent, ReactNode, RefObject, WheelEvent } from "react";
import { createPortal } from "react-dom";
import { writeResourceDrag } from "@/lib/resource-drag";
import { DEFAULT_DATASET_MANIFEST_URL } from "@/lib/datasets";
import {
  queryRecipeDatasetResources,
  type RecipeDatasetResourceQueryResult,
} from "@/lib/datasets/browser-loader";
import type { ResourceAmount } from "@/lib/model/types";
import { resourceLabel } from "@/lib/model";
import { applyRecipeInputOverrides } from "@/lib/model/recipe-input-overrides";
import {
  buildSearchVocabulary,
  matchSearchEntry,
  parseSearchQuery,
  resolveSearchPhases,
  splitSearchTokens,
  type SearchCorrection,
  type SearchPhase,
} from "@/lib/search";
import { useFactoryStore } from "@/store/factory-store";
import { activeVersionServesPlan, unservedPlanVersion } from "@/lib/datasets/dataset-cache";
import { recipesNotOnSiteText } from "@/lib/datasets/new-plan-version";
import { POWER_EU_CLAUSE_ID } from "@/lib/power/power-search";
import { useDebouncedValue } from "@/lib/hooks/use-debounced-value";
import { useResourcePopularityOffered } from "@/lib/datasets/resource-popularity-offer";
import { isEchoOfTouch } from "@/lib/pointer-kind";
import { isFromBrowseMenu, useBrowseMenu } from "./browse-menu";
import { ChromeMenu, chromeAnchorOf, MENU_ANCHOR_ATTR, type ChromeAnchor } from "./chrome/ChromeMenu";
import "./chrome/mod-panel.css";
import "./nei/nei.css";
import { isEditableKeyboardTarget } from "./flow/keyboard";
import { itemTipLines, McFloatingTip, type McTipLine } from "./nei/McTip";
import { isSwatchFluid, ResourceIcon, spriteArtPixels } from "./nei/ResourceIcon";
import { planGameVersion } from "@/lib/model/game-version";

/**
 * THE ITEM PANEL, drawn as NEI's item list: page keys and the page count at the
 * top, a grid of slots with the item art alone (the name is the tooltip, a
 * Minecraft one shown at once), and the search field. The six filters and the
 * sort sit in one small menu key beside the page keys. Shared by the items
 * column and every item picker (product drawer button, search stencil keys,
 * library filter). The caller owns the search text (the column keeps it in the
 * store, a picker locally), decides what a slot click does, and where the search
 * field goes: `dock` puts it at the bottom middle of the screen as NEI's is,
 * `bottom` under the list (the phone's drawer), `top` above it (pickers).
 */
export function ResourceIndexPane({
  search,
  onSearchChange,
  searchInputRef,
  searchFlashing = false,
  activeResource,
  onBrowse,
  autoFocus = false,
  searchAt = "top",
  leading,
  defaultSort = "relevance",
}: {
  search: string;
  onSearchChange: (value: string) => void;
  searchInputRef?: RefObject<HTMLInputElement | null>;
  searchFlashing?: boolean;
  activeResource?: IndexedResource;
  onBrowse: (resource: IndexedResource, mode: "recipes" | "uses") => void;
  autoFocus?: boolean;
  searchAt?: "top" | "bottom" | "dock" | "none";
  /** Keys at the start of the page row (the column's fold key). */
  leading?: ReactNode;
  /**
   * The sort it opens on. The items column is NEI's list and opens "As in NEI"; a picker opens on Best match,
   * where what was typed matters more than where NEI keeps it. Never Most popular: over an empty popularity map it
   * is "most ways to make", which opens the list on aspects and Empty Cell.
   */
  defaultSort?: ResourceSortMode;
}) {
  const datasetManifestUrl = useFactoryStore((state) => state.datasetManifestUrl);
  // While a tab's own dataset loads, the other version's items are not listed for it.
  const servesPlan = useFactoryStore(activeVersionServesPlan);
  const unservedVersion = useFactoryStore(unservedPlanVersion);
  const selectedDatasetVersion = useFactoryStore((state) =>
    servesPlan
      ? state.datasetManifest?.versions.find((entry) => entry.id === state.selectedDatasetVersionId)
      : undefined,
  );
  const dataset = useFactoryStore((state) => state.dataset);
  const isDatasetLoading = useFactoryStore((state) => state.isDatasetLoading);
  const recipeSearch = search;
  const setRecipeSearch = onSearchChange;
  const isSearchFlashing = searchFlashing;
  const ownInputRef = useRef<HTMLInputElement | null>(null);
  const inputRef = searchInputRef ?? ownInputRef;
  useEffect(() => {
    if (autoFocus) {
      inputRef.current?.focus();
    }
  }, [autoFocus, inputRef]);
  const [resourcePage, setResourcePage] = useState(0);
  const [resourcePageSize, setResourcePageSize] = useState(RESOURCE_DEFAULT_PAGE_SIZE);
  const [resourceResults, setResourceResults] = useState<IndexedResource[]>([]);
  const [resourceTotal, setResourceTotal] = useState(0);
  const [resourceMod, setResourceMod] = useState("");
  // The sort the player picked, if any. Only a sort on offer counts: Most popular is offered only while the
  // popularity map has entries, and a pick that is no longer offered gives way to the default and is forgotten,
  // so it cannot come back on its own.
  const popularityOffered = useResourcePopularityOffered();
  const sortChoices = useMemo(
    () => RESOURCE_SORT_CHOICES.filter((choice) => choice.value !== "popular" || popularityOffered),
    [popularityOffered],
  );
  const [chosenSort, setChosenSort] = useState<ResourceSortMode>();
  const resourceSort =
    chosenSort !== undefined && sortChoices.some((choice) => choice.value === chosenSort)
      ? chosenSort
      : defaultSort;
  useEffect(() => {
    if (chosenSort !== undefined && chosenSort !== resourceSort) {
      return deferStateUpdate(() => setChosenSort(undefined));
    }
    return undefined;
  }, [chosenSort, resourceSort]);
  const [resourceFilter, setResourceFilter] = useState<ResourceFilterMode>("all");
  const [resourceMods, setResourceMods] = useState<Array<{ id: string; count: number }>>([]);
  const [resourceSearchOutcome, setResourceSearchOutcome] = useState<SearchOutcome>(EXACT_SEARCH);
  // The query key the shown results answer. While it differs from the one the
  // field and page ask for, the list on screen is an older answer.
  const [shownQueryKey, setShownQueryKey] = useState<string>();
  const [resourceQueryError, setResourceQueryError] = useState<string | undefined>();
  const resourceQueryCacheRef = useRef<Map<string, ResourceQueryCacheEntry>>(new Map());
  const debouncedRecipeSearch = useDebouncedValue(recipeSearch, RESOURCE_SEARCH_DEBOUNCE_MS);
  const resourceWheelRef = useRef(0);
  const onBoard = resourceFilter === "board";
  // The board filter is answered here, from the cards themselves, so it needs no
  // request and cannot go stale. Everything else comes back from the server.
  const boardResults = useBoardResourceResults(onBoard, {
    query: debouncedRecipeSearch.trim(),
    mod: resourceMod,
    sort: resourceSort,
    offset: resourcePage * resourcePageSize,
    limit: resourcePageSize,
  });
  const powerRow =
    !onBoard && resourceFilter === "all" && resourcePage === 0
      ? powerSearchRow(debouncedRecipeSearch)
      : undefined;
  const displayedResources = onBoard
    ? boardResults.resources
    : powerRow
      ? [powerRow, ...resourceResults].slice(0, resourcePageSize)
      : resourceResults;
  const displayedTotal = onBoard ? boardResults.total : resourceTotal;
  const displayedOutcome = onBoard ? boardResults.outcome : resourceSearchOutcome;
  const resourcePageCount = Math.max(
    1,
    Math.ceil(displayedTotal / Math.max(1, resourcePageSize)),
  );
  /**
   * The wheel turns the page anywhere in the column, since the paged list
   * does not scroll. Deltas accumulate so a trackpad flick moves a page or
   * two instead of forty.
   */
  const handleResourceWheel = useCallback(
    (event: WheelEvent<HTMLDivElement>) => {
      if (!event.deltaY) {
        return;
      }
      // Turning back the other way starts over, or the notches left over from
      // scrolling down would have to be spent before the page moved up.
      if (Math.sign(event.deltaY) !== Math.sign(resourceWheelRef.current)) {
        resourceWheelRef.current = 0;
      }
      resourceWheelRef.current += event.deltaY;
      const steps = Math.trunc(resourceWheelRef.current / RESOURCE_WHEEL_PAGE_DELTA);
      if (steps === 0) {
        return;
      }
      resourceWheelRef.current -= steps * RESOURCE_WHEEL_PAGE_DELTA;
      setResourcePage((page) => clamp(page + steps, 0, resourcePageCount - 1));
    },
    [resourcePageCount],
  );
  const getResourceQueryKey = useCallback(
    (page: number) =>
      selectedDatasetVersion
        ? getResourceQueryCacheKey({
            versionId: getDatasetVersionCacheKey(selectedDatasetVersion),
            query: debouncedRecipeSearch.trim(),
            offset: page * resourcePageSize,
            limit: resourcePageSize,
            filter: resourceFilter,
            mod: resourceMod,
            sort: resourceSort,
          })
        : "",
    [
      debouncedRecipeSearch,
      resourceFilter,
      resourceMod,
      resourcePageSize,
      resourceSort,
      selectedDatasetVersion,
    ],
  );
  useEffect(() => {
    return deferStateUpdate(() => setResourcePage(0));
  }, [
    debouncedRecipeSearch,
    resourceFilter,
    resourceMod,
    resourceSort,
    selectedDatasetVersion?.id,
  ]);
  useEffect(() => {
    // The board's own resources are answered from memory, below: no request.
    const cacheKey = getResourceQueryKey(resourcePage);
    if (!selectedDatasetVersion || onBoard) {
      return deferStateUpdate(() => {
        setResourceResults([]);
        setResourceTotal(0);
        setShownQueryKey(cacheKey);
        setResourceQueryError(undefined);
      });
    }

    const query = debouncedRecipeSearch.trim();
    const cached = getCachedResourceQuery(resourceQueryCacheRef.current, cacheKey);
    if (cached) {
      return deferStateUpdate(() => {
        setResourceResults(cached.resources);
        setResourceTotal(cached.total);
        setResourceMods(cached.mods ?? []);
        setResourceSearchOutcome(searchOutcomeOf(cached));
        setShownQueryKey(cacheKey);
        setResourceQueryError(undefined);
      });
    }

    const controller = new AbortController();
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) {
        setResourceQueryError(undefined);
      }
    });

    queryResourcesInChunks(
      datasetManifestUrl ?? DEFAULT_DATASET_MANIFEST_URL,
      selectedDatasetVersion,
      {
        query,
        offset: resourcePage * resourcePageSize,
        limit: resourcePageSize,
        kind: resourceFilterKind(resourceFilter),
        mod: resourceMod || undefined,
        sort: resourceSort,
        source: resourceFilterSource(resourceFilter),
      },
      { signal: controller.signal },
    )
      .then((result) => {
        if (cancelled) {
          return;
        }
        setCachedResourceQuery(resourceQueryCacheRef.current, cacheKey, result);
        trimResourceQueryCache(resourceQueryCacheRef.current);
        setResourceResults(result.resources);
        setResourceTotal(result.total);
        setResourceMods(result.mods ?? []);
        setResourceSearchOutcome(searchOutcomeOf(result));
        setShownQueryKey(cacheKey);
      })
      .catch((error) => {
        if (cancelled) {
          return;
        }
        setResourceResults([]);
        setResourceTotal(0);
        setResourceQueryError(error instanceof Error ? error.message : "Resource query failed.");
        setShownQueryKey(cacheKey);
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [
    datasetManifestUrl,
    getResourceQueryKey,
    debouncedRecipeSearch,
    onBoard,
    resourceFilter,
    resourceMod,
    resourcePage,
    resourcePageSize,
    resourceSort,
    selectedDatasetVersion,
  ]);

  // A filter or search change can empty the selected mod's scope; drop a stale pick.
  useEffect(() => {
    if (resourceMod && resourceMods.length > 0 && !resourceMods.some((m) => m.id === resourceMod)) {
      return deferStateUpdate(() => setResourceMod(""));
    }
    return undefined;
  }, [resourceMod, resourceMods]);

  useEffect(() => {
    const maxPage = Math.max(0, Math.ceil(resourceTotal / resourcePageSize) - 1);
    if (resourcePage > maxPage) {
      return deferStateUpdate(() => setResourcePage(maxPage));
    }
    return undefined;
  }, [resourcePage, resourcePageSize, resourceTotal]);

  const browseResource = onBrowse;
  // The docked field is a body portal: drawn only once the page is up, so the server's HTML matches the first render.
  const mounted = useSyncExternalStore(
    noopSubscribe,
    () => true,
    () => false,
  );
  // The list is stale from the first key typed until the answer to it lands: through the debounce, the request,
  // and a page or sort change. Old slots stay on screen (a blank list flashes on every key), dimmed and marked busy.
  const listStale =
    !onBoard &&
    (recipeSearch.trim() !== debouncedRecipeSearch.trim() ||
      shownQueryKey !== getResourceQueryKey(resourcePage));
  const searchNone =
    !listStale && debouncedRecipeSearch.trim() !== "" && displayedTotal === 0 && !!dataset;
  const searchField = (
    <NeiSearchField
      inputRef={inputRef}
      value={recipeSearch}
      onChange={setRecipeSearch}
      flashing={isSearchFlashing}
      none={searchNone}
    />
  );
  const listMenu = (
    <NeiListMenu
      filter={resourceFilter}
      sort={resourceSort}
      sortChoices={sortChoices}
      defaultSort={defaultSort}
      onFilter={setResourceFilter}
      onSort={setChosenSort}
    />
  );
  return (
    <div className="nei pn-column flex min-h-0 flex-1 flex-col" onWheel={handleResourceWheel}>
      {searchAt === "top" ? <div className="nei-search-foot">{searchField}</div> : null}
      {!dataset || !servesPlan ? (
        <>
          <div className="nei-pager">
            {leading}
            <span className="nei-pager-count nei-text"> </span>
          </div>
          <div className="nei-empty">
            {unservedVersion
              ? recipesNotOnSiteText(unservedVersion)
              : isDatasetLoading
                ? "Loading recipe index..."
                : "Recipe index is not loaded yet."}
          </div>
          <div className="min-h-0 flex-1" />
        </>
      ) : (
        <VirtualResourceResultList
          resources={displayedResources}
          total={displayedTotal}
          currentPage={resourcePage}
          isLoading={listStale}
          error={resourceQueryError}
          emptyLabel={
            onBoard
              ? "Nothing placed on the board yet."
              : resourceFilter === "plants"
                ? "No crop grows that."
                : resourceFilter === "bees"
                  ? "No bee makes that."
                  : undefined
          }
          activeResource={activeResource}
          onPageChange={setResourcePage}
          onPageSizeChange={setResourcePageSize}
          onBrowse={browseResource}
          leading={leading}
          trailing={listMenu}
        />
      )}

      {/* What the search had to do to find anything. Only ever shown when it
          had to do something: a spelling stood in, or the words were taken
          one at a time because no item has all of them. */}
      {displayedOutcome.phase !== "exact" ? (
        <p className="nei-note">
          {displayedOutcome.phase === "corrected"
            ? `Showing results for ${displayedOutcome.corrections
                .map((correction) => correction.to)
                .join(", ")}`
            : "No item has all those words. Showing the closest."}
        </p>
      ) : null}

      <RecentResourceStrip onBrowse={browseResource} />
      {searchAt === "bottom" ? <div className="nei-search-foot">{searchField}</div> : null}
      {searchAt === "dock" && mounted
        ? createPortal(
            <div className="nei-dock" data-nei-search-dock="">
              <div className="nei ui-zoom">{searchField}</div>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}

const RESOURCE_DEFAULT_PAGE_SIZE = 6;
/**
 * NEI's slot: 18 GUI px at GUI scale 2, here 32 shell px, the art inside it
 * 28 (16 GUI px). Mirrors `--nei-slot` and `--nei-art` in nei/nei.css.
 */
const NEI_SLOT = 32;
const NEI_ART = 28;
/**
 * The grid fills the column: as many columns as fit at no less than 30 px a slot (the art, 28, and a pixel either
 * side), each slot then widened to share the column out evenly, inside the pager's 6 px side margins. So the left and
 * right margins match and no gutter is left nearly a column wide.
 */
const NEI_SLOT_MIN = 30;
const NEI_GRID_PAD = 6;

/** Columns and slot size (css px) for a column `width` wide. Pure, for the tests. */
export function neiGridFit(width: number): { columns: number; slot: number } {
  const room = Math.max(0, width - NEI_GRID_PAD * 2);
  const columns = Math.max(1, Math.floor(room / NEI_SLOT_MIN));
  return { columns, slot: Math.max(NEI_SLOT_MIN, room / columns) };
}
/** One mouse notch is 100 on most platforms, so one notch is one page. */
const RESOURCE_WHEEL_PAGE_DELTA = 80;

export type ResourceSortMode =
  | "nei"
  | "relevance"
  | "nei-filter"
  | "popular"
  | "name"
  | "mod"
  | "made"
  | "uses";

type ResourceSortChoice = { value: ResourceSortMode; label: string };

/** The sorts the list menu offers, in its order. "popular" only while the popularity map has entries. */
const RESOURCE_SORT_CHOICES: ReadonlyArray<ResourceSortChoice> = [
  { value: "nei", label: "As in NEI" },
  { value: "relevance", label: "Best match" },
  { value: "nei-filter", label: "NEI filter only" },
  { value: "name", label: "Name A–Z" },
  { value: "mod", label: "By mod" },
  { value: "made", label: "Most ways to make" },
  { value: "uses", label: "Most used" },
  { value: "popular", label: "Most popular" },
];


/**
 * The list's filter: six mutually exclusive answers, because the kind and
 * source filters never usefully combine. "Board" is answered from the
 * project in memory rather than the server.
 */
type ResourceFilterMode = "all" | "item" | "fluid" | "board" | "plants" | "bees";

const RESOURCE_FILTER_CHOICES: Array<{
  mode: ResourceFilterMode;
  label: string;
  title: string;
  /** The row in the list menu. */
  menu: string;
}> = [
  { mode: "all", label: "All", title: "Everything", menu: "Everything" },
  { mode: "item", label: "Items", title: "Items", menu: "Items only" },
  { mode: "fluid", label: "Fluids", title: "Fluids", menu: "Fluids only" },
  { mode: "board", label: "Placed", title: "On this board", menu: "On this board" },
  { mode: "plants", label: "CropsNH", title: "Grown", menu: "Grown by crops" },
  { mode: "bees", label: "Bees", title: "From bees", menu: "Made by bees" },
];

/** The dataset query only knows kinds and sources; this splits the choice up. */
function resourceFilterKind(filter: ResourceFilterMode): "item" | "fluid" | undefined {
  return filter === "item" || filter === "fluid" ? filter : undefined;
}

function resourceFilterSource(filter: ResourceFilterMode): "plants" | "bees" | undefined {
  return filter === "plants" || filter === "bees" ? filter : undefined;
}

/**
 * A slot's tooltip, as NEI writes an item's: the name in white, the dataset's
 * tooltip lines and the recipe count in grey, the mod's name last in blue
 * italics.
 */
function resourceTooltipLines(resource: IndexedResource): McTipLine[] {
  const power = resource.id === POWER_EU_CLAUSE_ID;
  return itemTipLines({
    name: power ? "Power (EU/t)" : resourceLabel(resource),
    id: power ? "" : resource.id,
    tooltip: resource.tooltip,
    extra: resource.recipeCount > 0 ? [`${resource.recipeCount} recipes`] : undefined,
  });
}

/** Mod is the id prefix ("gregtech:..."); bare fluid ids group as "fluids". */
function getResourceModLabel(resource: { id: string; kind: string }): string {
  if (resource.id === POWER_EU_CLAUSE_ID) {
    return "generators";
  }
  const colon = resource.id.indexOf(":");
  if (colon > 0) {
    return resource.id.slice(0, colon);
  }
  return resource.kind === "fluid" ? "fluids" : "other";
}

/**
 * The item search's power row: typing "power", "energy" or "eu" puts Power
 * (EU) first. Left click asks who makes it (generators), right click who
 * takes it, as for any item.
 */
function powerSearchRow(query: string): IndexedResource | undefined {
  const trimmed = query.trim().toLowerCase();
  if (trimmed.length < 2) {
    return undefined;
  }
  if (!("power".startsWith(trimmed) || "energy".startsWith(trimmed) || trimmed === "eu")) {
    return undefined;
  }
  return {
    kind: "fluid",
    id: POWER_EU_CLAUSE_ID,
    displayName: "Power (EU)",
    recipeCount: 0,
    dominantColor: "#d99a2b",
  } as IndexedResource;
}

const RESOURCE_QUERY_CACHE_TTL_MS = 90_000;
export const RESOURCE_SEARCH_DEBOUNCE_MS = 125;

function useResourcePageSize(
  containerRef: RefObject<HTMLDivElement | null>,
  onPageSizeChange: (pageSize: number) => void,
) {
  const [pageSize, setPageSize] = useState(RESOURCE_DEFAULT_PAGE_SIZE);
  const [gridColumns, setGridColumns] = useState(2);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || typeof ResizeObserver === "undefined") {
      return;
    }

    // As many whole slots as fit each way, as NEI fills its column.
    const updatePageSize = () => {
      const { columns: nextColumns, slot } = neiGridFit(container.clientWidth);
      const rows = Math.max(1, Math.floor(container.clientHeight / slot));
      container.style.setProperty("--nei-cell", `${slot}px`);
      const nextPageSize = nextColumns * rows;

      setPageSize((current) => (current === nextPageSize ? current : nextPageSize));
      setGridColumns((current) => (current === nextColumns ? current : nextColumns));
      onPageSizeChange(nextPageSize);
    };

    updatePageSize();
    const observer = new ResizeObserver(updatePageSize);
    observer.observe(container);
    return () => observer.disconnect();
  }, [containerRef, onPageSizeChange]);

  return { pageSize, gridColumns };
}

export interface IndexedResource extends Pick<
  ResourceAmount,
  "kind" | "id" | "displayName" | "iconPath" | "iconAtlas" | "dominantColor" | "tooltip"
> {
  recipeCount: number;
}

/** What the search had to do to answer, for the line under the box. */
interface SearchOutcome {
  phase: SearchPhase;
  corrections: SearchCorrection[];
}

const EXACT_SEARCH: SearchOutcome = { phase: "exact", corrections: [] };

function searchOutcomeOf(result: {
  searchPhase?: SearchPhase;
  corrections?: SearchCorrection[];
}): SearchOutcome {
  return result.searchPhase && result.searchPhase !== "exact"
    ? { phase: result.searchPhase, corrections: result.corrections ?? [] }
    : EXACT_SEARCH;
}

/**
 * Every item and fluid the board touches, read off the project: card inputs
 * and outputs (with the picked slot alternative) plus every drawer and tank.
 * One entry per resource.
 */
function useBoardResources(enabled: boolean): IndexedResource[] {
  const nodes = useFactoryStore((state) => state.project.nodes);
  const recipes = useFactoryStore((state) => state.project.recipes);
  const storages = useFactoryStore((state) => state.project.storages);
  const gameVersion = useFactoryStore((state) => planGameVersion(state.project));

  return useMemo(() => {
    if (!enabled) {
      return [];
    }

    const byKey = new Map<string, IndexedResource>();
    // Unlike the dataset list, an entry with no icon is kept: it is genuinely on
    // the board, and its name is what identifies it. Only the demo plan and
    // hand-imported plans hit this.
    const add = (resource: Omit<IndexedResource, "recipeCount">) => {
      if (!resource.id) {
        return;
      }
      const key = `${resource.kind}:${resource.id}`;
      if (!byKey.has(key)) {
        byKey.set(key, { ...resource, recipeCount: 0 });
      }
    };

    const recipesById = new Map(recipes.map((recipe) => [recipe.id, recipe] as const));
    for (const node of nodes) {
      const recipe = recipesById.get(node.recipeId);
      if (!recipe) {
        continue;
      }
      const effectiveRecipe = applyRecipeInputOverrides(recipe, node, gameVersion);
      for (const resource of [...effectiveRecipe.inputs, ...effectiveRecipe.outputs]) {
        add(resource);
      }
    }
    for (const storage of storages ?? []) {
      add({
        kind: storage.kind,
        id: storage.resourceId,
        displayName: storage.displayName,
        iconPath: storage.iconPath,
        iconAtlas: storage.iconAtlas,
        dominantColor: storage.dominantColor,
      });
    }

    return [...byKey.values()];
  }, [enabled, nodes, recipes, storages, gameVersion]);
}

/**
 * The same search run over the board's own resources, using the server's
 * matcher so the Board filter behaves exactly like the dataset list.
 */
function useBoardResourceResults(
  enabled: boolean,
  request: {
    query: string;
    mod: string;
    sort: ResourceSortMode;
    offset: number;
    limit: number;
  },
) {
  const resources = useBoardResources(enabled);

  return useMemo(() => {
    if (!enabled) {
      return { resources: [], total: 0, mods: [], outcome: EXACT_SEARCH };
    }

    const fields = resources.map((resource) => ({
      nameText: (resource.displayName ?? resource.id).toLowerCase(),
      name: splitSearchTokens(resource.displayName ?? ""),
      id: splitSearchTokens(resource.id),
    }));
    const vocabulary = buildSearchVocabulary(
      resources.map((resource) => resource.displayName ?? ""),
    );
    const modCounts = new Map<string, number>();

    const resolved = resolveSearchPhases(
      parseSearchQuery(request.query),
      vocabulary,
      (query, options) => {
        modCounts.clear();
        const matches: Array<{ resource: IndexedResource; score: number }> = [];
        resources.forEach((resource, index) => {
          const score = matchSearchEntry(query, fields[index], options);
          if (score === undefined) {
            return;
          }
          const modId = getResourceModLabel(resource);
          modCounts.set(modId, (modCounts.get(modId) ?? 0) + 1);
          if (request.mod && modId !== request.mod) {
            return;
          }
          matches.push({ resource, score });
        });
        return matches;
      },
    );

    const nameOf = (match: { resource: IndexedResource }) =>
      (match.resource.displayName ?? match.resource.id).toLowerCase();
    const sorted = [...resolved.results].sort((left, right) => {
      if (request.sort === "name") {
        return nameOf(left).localeCompare(nameOf(right));
      }
      if (request.sort === "mod") {
        return (
          getResourceModLabel(left.resource).localeCompare(getResourceModLabel(right.resource)) ||
          nameOf(left).localeCompare(nameOf(right))
        );
      }
      // "Most recipes" has nothing to sort by here (a board resource carries no
      // recipe count), so it falls back to the same order as best match.
      return right.score - left.score || nameOf(left).localeCompare(nameOf(right));
    });

    return {
      resources: sorted
        .slice(request.offset, request.offset + request.limit)
        .map((match) => match.resource),
      total: sorted.length,
      mods: [...modCounts.entries()]
        .map(([id, count]) => ({ id, count }))
        .sort((left, right) => right.count - left.count || left.id.localeCompare(right.id)),
      outcome:
        resolved.phase === "exact"
          ? EXACT_SEARCH
          : { phase: resolved.phase, corrections: resolved.query.corrections },
    };
  }, [
    enabled,
    request.limit,
    request.mod,
    request.offset,
    request.query,
    request.sort,
    resources,
  ]);
}


interface ResourceQueryCacheEntry {
  result: RecipeDatasetResourceQueryResult;
  expiresAt: number;
}


/** More than one row of the widest column could ever show. */
const RECENT_STRIP_LIMIT = 24;

/**
 * The last things looked up, in one row of slots under the list. Click for
 * recipes, right click for uses, like a slot in the list. The list is the
 * store's browse history, so items opened from anywhere (a card's slot too)
 * land here.
 */
function RecentResourceStrip({
  onBrowse,
}: {
  onBrowse: (resource: IndexedResource, mode: "recipes" | "uses") => void;
}) {
  const history = useFactoryStore((state) => state.recipeResourceHistory);
  const activeResource = useFactoryStore((state) => state.recipeBrowserResource);
  const recent = useMemo(
    () => history.slice(0, RECENT_STRIP_LIMIT).map((resource) => ({ ...resource, recipeCount: 0 })),
    [history],
  );

  if (recent.length === 0) {
    return null;
  }

  return (
    <div className="nei-recent" aria-label="Recently viewed" role="listbox">
      <NeiSlots
        resources={recent}
        activeResource={activeResource}
        onBrowse={onBrowse}
        hint="Recently viewed"
      />
    </div>
  );
}

function VirtualResourceResultList({
  resources,
  total,
  currentPage,
  isLoading,
  error,
  emptyLabel,
  activeResource,
  onPageChange,
  onPageSizeChange,
  onBrowse,
  leading,
  trailing,
}: {
  resources: IndexedResource[];
  total: number;
  currentPage: number;
  isLoading: boolean;
  error?: string;
  /** What "nothing here" means under the current filter. */
  emptyLabel?: string;
  activeResource?: IndexedResource;
  onPageChange: (page: number) => void;
  onPageSizeChange: (pageSize: number) => void;
  onBrowse: (resource: IndexedResource, mode: "recipes" | "uses") => void;
  leading?: ReactNode;
  trailing?: ReactNode;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const { pageSize, gridColumns } = useResourcePageSize(containerRef, onPageSizeChange);
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  // NEI's page keys go round: back from the first page is the last.
  const handlePreviousPage = useCallback(() => {
    onPageChange(currentPage === 0 ? pageCount - 1 : currentPage - 1);
  }, [currentPage, onPageChange, pageCount]);
  const handleNextPage = useCallback(() => {
    onPageChange(currentPage >= pageCount - 1 ? 0 : currentPage + 1);
  }, [currentPage, onPageChange, pageCount]);

  return (
    <>
      <div className="nei-pager">
        {leading}
        <button
          type="button"
          className="nei-btn"
          onClick={handlePreviousPage}
          disabled={pageCount <= 1}
          aria-label="Previous resource page"
        >
          <NeiArrow direction="left" />
        </button>
        <span className="nei-pager-count nei-text" aria-live="polite">
          {Math.min(currentPage + 1, pageCount)}/{pageCount}
        </span>
        {trailing}
        <button
          type="button"
          className="nei-btn"
          onClick={handleNextPage}
          disabled={pageCount <= 1}
          aria-label="Next resource page"
        >
          <NeiArrow direction="right" />
        </button>
      </div>
      <div ref={containerRef} className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        {error ? (
          <div className="nei-empty">{error}</div>
        ) : isLoading && resources.length === 0 ? (
          <ResourceResultSkeleton pageSize={pageSize} gridColumns={gridColumns} />
        ) : resources.length === 0 ? (
          <div className="nei-empty">{emptyLabel ?? "No matching resource."}</div>
        ) : (
          <ResourceResultPage
            resources={resources}
            activeResource={activeResource}
            gridColumns={gridColumns}
            isRefreshing={isLoading}
            onBrowseResource={onBrowse}
          />
        )}
      </div>
    </>
  );
}

/** The vanilla button's pixel chevron, 4 x 7 GUI px. */
function NeiArrow({ direction }: { direction: "left" | "right" }) {
  const d = "M3 0h1v1H3zM2 1h1v1H2zM1 2h1v1H1zM0 3h1v1H0zM1 4h1v1H1zM2 5h1v1H2zM3 6h1v1H3z";
  return (
    <svg
      width={8}
      height={14}
      viewBox="0 0 4 7"
      shapeRendering="crispEdges"
      fill="currentColor"
      aria-hidden
      style={direction === "right" ? { transform: "scaleX(-1)" } : undefined}
    >
      <path d={d} />
    </svg>
  );
}

/** Faint empty slots while a page loads. */
function ResourceResultSkeleton({
  pageSize,
  gridColumns,
}: {
  pageSize: number;
  gridColumns: number;
}) {
  const count = Math.max(3, Math.min(pageSize, 200));
  return (
    <div
      className="nei-grid"
      style={{ gridTemplateColumns: `repeat(${gridColumns}, var(--nei-cell, ${NEI_SLOT}px))` }}
      aria-label="Loading resources"
    >
      {Array.from({ length: count }, (_, index) => (
        <div key={index} className="nei-skel" />
      ))}
    </div>
  );
}

/**
 * NEI's search field. Typing filters the list; a right click clears it, as
 * NEI's does; Escape lets go of it. Its text turns red when nothing matches.
 */
function NeiSearchField({
  inputRef,
  value,
  onChange,
  flashing,
  none,
}: {
  inputRef: RefObject<HTMLInputElement | null>;
  value: string;
  onChange: (value: string) => void;
  flashing: boolean;
  none: boolean;
}) {
  const [focused, setFocused] = useState(false);
  return (
    <label
      className={["nei-search", flashing ? "search-box-flash" : ""].join(" ")}
      data-focused={focused ? "" : undefined}
      data-none={none ? "" : undefined}
      onContextMenu={(event) => {
        event.preventDefault();
        onChange("");
        inputRef.current?.focus();
      }}
    >
      {/* 16px text on a phone, deliberately: below that, iOS zooms the whole
          page in the moment the field takes focus, and the way back out is a
          pinch. */}
      <input
        ref={inputRef}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.currentTarget.blur();
          }
        }}
        placeholder="Search..."
        aria-label="Search items and fluids"
        spellCheck={false}
        autoComplete="off"
        className="compact:!text-base"
      />
    </label>
  );
}

/** A menu label inside a sentence: its first letter lowered, unless its first word is a name in capitals (NEI). */
function inSentence(label: string): string {
  const first = label.split(/[\s,]/, 1)[0] ?? "";
  return first.length > 1 && first === first.toUpperCase() ? label : label.charAt(0).toLowerCase() + label.slice(1);
}

/** One menu for what the list shows and how it is sorted, from a key beside the page count. */
function NeiListMenu({
  filter,
  sort,
  sortChoices,
  defaultSort,
  onFilter,
  onSort,
}: {
  filter: ResourceFilterMode;
  sort: ResourceSortMode;
  sortChoices: ReadonlyArray<ResourceSortChoice>;
  defaultSort: ResourceSortMode;
  onFilter: (filter: ResourceFilterMode) => void;
  onSort: (sort: ResourceSortMode) => void;
}) {
  const [anchor, setAnchor] = useState<ChromeAnchor>();
  const close = useCallback(() => setAnchor(undefined), []);
  const changed = filter !== "all" || sort !== defaultSort;
  const filterLabel = RESOURCE_FILTER_CHOICES.find((choice) => choice.mode === filter)?.title ?? filter;
  const sortLabel = sortChoices.find((choice) => choice.value === sort)?.label ?? sort;
  return (
    <>
      <button
        type="button"
        className="nei-btn"
        aria-label="Show and sort"
        aria-haspopup="menu"
        aria-expanded={anchor !== undefined}
        title={`Showing ${inSentence(filterLabel)}, ${inSentence(sortLabel)}`}
        data-on={changed ? "" : undefined}
        {...{ [MENU_ANCHOR_ATTR]: "" }}
        onClick={(event) => {
          const next = chromeAnchorOf(event.currentTarget);
          setAnchor((open) => (open ? undefined : next));
        }}
      >
        <svg width={10} height={10} viewBox="0 0 5 5" shapeRendering="crispEdges" fill="currentColor" aria-hidden>
          <path d="M0 0h5v1H0zM0 2h5v1H0zM0 4h5v1H0z" />
        </svg>
      </button>
      {anchor ? (
        <ChromeMenu
          anchor={anchor}
          label="Show and sort"
          align="right"
          zIndex={80}
          minWidth={170}
          entries={[
            ...RESOURCE_FILTER_CHOICES.map((choice, index) => ({
              label: choice.menu,
              detail: index === 0 ? "Show" : undefined,
              current: filter === choice.mode,
              onSelect: () => onFilter(choice.mode),
            })),
            ...sortChoices.map((choice, index) => ({
              label: choice.label,
              detail: index === 0 ? "Sort" : undefined,
              ruleAbove: index === 0,
              current: sort === choice.value,
              onSelect: () => onSort(choice.value),
            })),
          ]}
          onClose={close}
        />
      ) : null}
    </>
  );
}

/**
 * Touch menu for "makes" vs "uses": a tap (or a hold) opens both as a menu,
 * since a finger has no right button and a list row has no wire drag to
 * protect. One menu for the whole list: the pressed resource is captured at
 * press start, so this costs a ref rather than a hook per item.
 */
function useResourceBrowseMenu(
  browse: (resource: IndexedResource, mode: "recipes" | "uses") => void,
) {
  // Drag an item onto the board for a drawer, or onto Pool's Desired rates.
  const canDrag = useFactoryStore((state) => !state.isReadOnly);
  const pressedRef = useRef<IndexedResource | undefined>(undefined);
  const [pressedName, setPressedName] = useState("");
  const menu = useBrowseMenu({
    name: pressedName,
    onPick: (mode) => {
      const resource = pressedRef.current;
      if (resource) {
        browse(resource, mode);
      }
    },
  });

  return {
    menu: menu.menu,
    /** Spread on the row, after its own click and context-menu handlers. */
    pressProps: (resource: IndexedResource) => ({
      draggable: canDrag && resource.kind !== "aspect",
      onDragStart: (event: DragEvent<HTMLElement>) => {
        if (!canDrag || resource.kind === "aspect") { event.preventDefault(); return; }
        writeResourceDrag(event.dataTransfer, { ...resource, amount: 1 });
      },
      onPointerDown: (event: PointerEvent<HTMLElement>) => {
        pressedRef.current = resource;
        if (event.pointerType !== "mouse") {
          setPressedName(resourceLabel(resource));
        }
        menu.pressHandlers.onPointerDown(event);
      },
      onPointerMove: menu.pressHandlers.onPointerMove,
      onPointerUp: menu.pressHandlers.onPointerUp,
      onPointerCancel: menu.pressHandlers.onPointerCancel,
    }),
    /**
     * Whether the row's own click should stand down: the menu is open, or has just
     * closed and this click is the trailing half of the tap that chose from it.
     */
    claimedByMenu: (event: { target: EventTarget | null }) =>
      isFromBrowseMenu(event) || menu.isPressing || menu.isSettling(),
    /**
     * A tap from a finger opens the menu. `isEchoOfTouch` as well as the row's own
     * pointerdown, because the click a tap synthesises claims to be a mouse.
     */
    openOnTap: (event: React.MouseEvent<HTMLElement>) => {
      if (!menu.wasTouch() && !isEchoOfTouch()) {
        return false;
      }
      return menu.openFromTap({ x: event.clientX, y: event.clientY });
    },
  };
}

function ResourceResultPage({
  resources,
  activeResource,
  gridColumns,
  isRefreshing,
  onBrowseResource,
}: {
  resources: IndexedResource[];
  activeResource?: IndexedResource;
  gridColumns: number;
  isRefreshing: boolean;
  onBrowseResource: (resource: IndexedResource, mode: "recipes" | "uses") => void;
}) {
  const [, startBrowseTransition] = useTransition();

  const browse = useCallback(
    (resource: IndexedResource, mode: "recipes" | "uses") => {
      startBrowseTransition(() => onBrowseResource(resource, mode));
    },
    [onBrowseResource, startBrowseTransition],
  );

  return (
    <div
      className="nei-grid"
      style={{ gridTemplateColumns: `repeat(${gridColumns}, var(--nei-cell, ${NEI_SLOT}px))` }}
      aria-label="Resource results"
      aria-busy={isRefreshing || undefined}
      data-stale={isRefreshing ? "" : undefined}
      role="listbox"
    >
      <NeiSlots resources={resources} activeResource={activeResource} onBrowse={browse} />
    </div>
  );
}

/**
 * NEI's slots: the art alone, the grey highlight under the hovered one, its
 * tooltip at once in Minecraft's box. Left click asks for recipes, right
 * click for uses, and R or U over a slot ask the same, as in NEI. A slot drags
 * onto the board for a drawer.
 */
function NeiSlots({
  resources,
  activeResource,
  onBrowse,
  hint,
}: {
  resources: readonly IndexedResource[];
  activeResource?: { kind: string; id: string };
  onBrowse: (resource: IndexedResource, mode: "recipes" | "uses") => void;
  /** A dim line under the tooltip's name (the recent row says what it is). */
  hint?: string;
}) {
  const rowBrowse = useResourceBrowseMenu(onBrowse);
  // The hovered slot by its place and item: a page that changes under a still
  // pointer (typing, paging with the wheel) leaves no tooltip, and no R or U,
  // for an item no longer there.
  const [hover, setHover] = useState<{ index: number; key: string; x: number; y: number }>();
  const hovered =
    hover && resources[hover.index] && slotKey(resources[hover.index]) === hover.key
      ? resources[hover.index]
      : undefined;
  const hoverRef = useRef<IndexedResource | undefined>(undefined);
  useEffect(() => {
    hoverRef.current = hovered;
  }, [hovered]);
  const dragging = useRef(false);

  // R and U over a slot: the two questions its clicks ask.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const resource = hoverRef.current;
      if (!resource || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
      if (isEditableKeyboardTarget(event.target)) return;
      const key = event.key.toLowerCase();
      if (key !== "r" && key !== "u") return;
      event.preventDefault();
      onBrowse(resource, key === "r" ? "recipes" : "uses");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onBrowse]);

  const leave = () => {
    hoverRef.current = undefined;
    setHover(undefined);
  };
  const tipLines = useMemo(() => {
    if (!hovered) return undefined;
    const lines = resourceTooltipLines(hovered);
    if (hint) lines.splice(1, 0, { text: hint, tone: "hint" });
    return lines;
  }, [hovered, hint]);

  return (
    <>
      {resources.map((resource, index) => {
        const active = activeResource?.kind === resource.kind && activeResource.id === resource.id;
        const press = rowBrowse.pressProps(resource);
        return (
          <button
            key={slotKey(resource)}
            type="button"
            className="nei-slot"
            onClick={(event) => {
              if (rowBrowse.claimedByMenu(event) || rowBrowse.openOnTap(event)) {
                return;
              }
              onBrowse(resource, "recipes");
            }}
            onContextMenu={(event) => {
              event.preventDefault();
              if (rowBrowse.claimedByMenu(event)) {
                return;
              }
              onBrowse(resource, "uses");
            }}
            onMouseMove={(event) => {
              if (dragging.current || event.buttons !== 0) return;
              hoverRef.current = resource;
              setHover({ index, key: slotKey(resource), x: event.clientX, y: event.clientY });
            }}
            onMouseLeave={leave}
            {...press}
            onDragStart={(event) => {
              dragging.current = true;
              leave();
              press.onDragStart(event);
            }}
            onDragEnd={() => {
              dragging.current = false;
            }}
            aria-label={resource.id === POWER_EU_CLAUSE_ID ? "Power (EU/t)" : resourceLabel(resource)}
            role="option"
            aria-selected={active}
          >
            <span className="nei-art minecraft-pixel-art">
              {resource.id === POWER_EU_CLAUSE_ID ? (
                <Zap className="h-5 w-5 fill-current text-amber-400" aria-hidden />
              ) : (
                <ResourceIcon
                  itemZoom={1.5}
                  resource={{ ...resource, amount: 1 }}
                  size="sm"
                  bare
                  showAmount={false}
                  tooltip={false}
                  // Items use the shared fit; fluids match their visual size.
                  iconPixelSize={
                    resource.kind === "fluid"
                      ? isSwatchFluid(resource)
                        ? 36
                        : spriteArtPixels(NEI_ART)
                      : undefined
                  }
                  className="!h-full !w-full"
                />
              )}
            </span>
          </button>
        );
      })}
      {rowBrowse.menu}
      {hover && tipLines ? <McFloatingTip lines={tipLines} x={hover.x} y={hover.y} /> : null}
    </>
  );
}

const noopSubscribe = () => () => {};

const slotKey = (resource: { kind: string; id: string }) => `${resource.kind}:${resource.id}`;

/** The most one resource query answers; a taller page asks for its slots in several. */
const RESOURCE_QUERY_MAX = 120;

/**
 * A page of the list, asked for in pieces of at most 120 (the server's cap), so
 * a tall column fills to its foot as NEI's does. The first answer carries the
 * total, the mods and how the search was read.
 */
async function queryResourcesInChunks(
  ...[manifestUrl, version, query, options]: Parameters<typeof queryRecipeDatasetResources>
): Promise<RecipeDatasetResourceQueryResult> {
  if (query.limit <= RESOURCE_QUERY_MAX) {
    return queryRecipeDatasetResources(manifestUrl, version, query, options);
  }
  const parts: Array<Promise<RecipeDatasetResourceQueryResult>> = [];
  for (let at = 0; at < query.limit; at += RESOURCE_QUERY_MAX) {
    parts.push(
      queryRecipeDatasetResources(
        manifestUrl,
        version,
        { ...query, offset: query.offset + at, limit: Math.min(RESOURCE_QUERY_MAX, query.limit - at) },
        options,
      ),
    );
  }
  const answers = await Promise.all(parts);
  const first = answers[0];
  return {
    ...first,
    resources: answers.flatMap((answer) => answer.resources),
    limit: query.limit,
    hasMore: answers[answers.length - 1].hasMore,
  };
}

export function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

export function deferStateUpdate(callback: () => void) {
  let cancelled = false;
  queueMicrotask(() => {
    if (!cancelled) {
      callback();
    }
  });

  return () => {
    cancelled = true;
  };
}


export function getDatasetVersionCacheKey(version: {
  id: string;
  checksumSha256?: string;
  publishedAt: string;
}) {
  return [version.id, version.checksumSha256 ?? version.publishedAt].join("@");
}


function getResourceQueryCacheKey({
  versionId,
  query,
  offset,
  limit,
  filter,
  mod,
  sort,
}: {
  versionId: string;
  query: string;
  offset: number;
  limit: number;
  filter: ResourceFilterMode;
  mod: string;
  sort: ResourceSortMode;
}) {
  return [versionId, query.trim().toLowerCase(), offset, limit, filter, mod, sort].join("|");
}



function getCachedResourceQuery(cache: Map<string, ResourceQueryCacheEntry>, key: string) {
  const entry = cache.get(key);
  if (!entry) {
    return undefined;
  }

  if (entry.expiresAt <= Date.now()) {
    cache.delete(key);
    return undefined;
  }

  return entry.result;
}

function setCachedResourceQuery(
  cache: Map<string, ResourceQueryCacheEntry>,
  key: string,
  result: RecipeDatasetResourceQueryResult,
) {
  cache.set(key, {
    result,
    expiresAt: Date.now() + RESOURCE_QUERY_CACHE_TTL_MS,
  });
}

function trimResourceQueryCache(cache: Map<string, ResourceQueryCacheEntry>) {
  while (cache.size > 160) {
    const oldestKey = cache.keys().next().value;
    if (!oldestKey) {
      return;
    }
    cache.delete(oldestKey);
  }
}


