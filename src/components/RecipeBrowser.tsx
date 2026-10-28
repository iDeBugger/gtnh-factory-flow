import { RailKey } from "@/components/flow/clean/rail/rail-controls";
import "@/components/flow/clean/rail/rail.css";
import { useIsCompactViewport } from "@/lib/compact-view";
import { useBoardCovered } from "./use-covering-page";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DEFAULT_DATASET_MANIFEST_URL } from "@/lib/datasets";
import {
  getRecipeDatasetRecipe,
  queryRecipeDatasetResources,
  queryRecipeDatasetRecipes,
  type RecipeDatasetQueryResult,
  type RecipeMapSelection,
} from "@/lib/datasets/browser-loader";
import type { RecipeQueryClause, RecipeQuerySideOp } from "@/lib/datasets/recipe-query";
import type { DatasetResourceIndexEntry, RecipeSummary } from "@/lib/datasets/types";
import { recipesNotOnSiteText } from "@/lib/datasets/new-plan-version";
import { resourceMatchesInput } from "@/lib/model";
import { MACHINE_PIN_RESOURCE_ID, useFactoryStore } from "@/store/factory-store";
import { useDesignStore } from "@/store/design-store";
import {
  activeVersionServesPlan,
  OTHER_VERSION_RECIPE_MESSAGE,
  refusesRecipeOnPlan,
  unservedPlanVersion,
} from "@/lib/datasets/dataset-cache";
import { gameVersionOfDataset } from "@/lib/model/game-version";
import { leaveWelcomeTab, readWelcomeTabState } from "@/lib/welcome/welcome-tab";
import type {
  RecipeBrowserMachinePin,
  RecipeBrowserMode,
  RecipeBrowserResource,
  RecipeInputPicks,
  TierFilter,
} from "@/store/factory-store";
import type { Recipe, ResourceAmount } from "@/lib/model/types";
import { useDebouncedValue } from "@/lib/hooks/use-debounced-value";
import {
  OPEN_SIDEBAR_TAB_EVENT,
  takePendingSearchFocus,
  takePendingSidebarTab,
} from "@/lib/sidebar-tab";
import { writeWorkspaceView } from "@/lib/workspace-view";
import {
  deferStateUpdate,
  getDatasetVersionCacheKey,
  ResourceIndexPane,
  RESOURCE_SEARCH_DEBOUNCE_MS,
  type IndexedResource,
} from "./ResourceIndexPane";
import { FoldGlyph } from "./flow/clean/fold/FoldKey";
import { useItemsOnRight } from "./use-plan-layout";
import { RecipeSearchOverlay, type RecipeMapChip, type StencilClause } from "./RecipeSearchOverlay";

// Re-exported so existing imports of the preview helpers from here keep working.
export {
  contextualizePreviewRecipe,
  summaryToPreviewRecipe,
  type PreviewContextResource,
} from "./recipe-preview";

const RECIPE_QUERY_LIMIT = 120;

/** Whether the filter block under the search box is folded away. */

const RECIPE_QUERY_CACHE_TTL_MS = 90_000;
const RECIPE_SEARCH_DEBOUNCE_MS = 200;

interface RecipeBrowserProps {
  onLoadDatasetVersion: (versionId: string) => void;
}

export function RecipeBrowser({ onLoadDatasetVersion }: RecipeBrowserProps) {
  // Plan boards seat the items on the right: its edge, fold key and arrow face the other way.
  const itemsOnRight = useItemsOnRight();
  const isCompact = useIsCompactViewport();
  const boardCovered = useBoardCovered();
  const datasetManifest = useFactoryStore((state) => state.datasetManifest);
  const datasetManifestUrl = useFactoryStore((state) => state.datasetManifestUrl);
  const selectedDatasetVersionId = useFactoryStore((state) => state.selectedDatasetVersionId);
  // While the open plan's own dataset loads (a tab on the other version), nothing is asked
  // and the results read as loading: no other version's recipe is offered for this plan.
  const datasetServesOpenPlan = useFactoryStore(activeVersionServesPlan);
  // A plan for a version this site has no recipes for: the page says so instead of loading forever.
  const unservedVersion = useFactoryStore(unservedPlanVersion);
  const projectRecipes = useFactoryStore((state) => state.project.recipes);
  const recipeSearch = useFactoryStore((state) => state.recipeSearch);
  const maxTier = useFactoryStore((state) => state.maxTierFilter);
  const browserResource = useFactoryStore((state) => state.recipeBrowserResource);
  const browserMode = useFactoryStore((state) => state.recipeBrowserMode);
  const browserSeed = useFactoryStore((state) => state.recipeBrowserSeed);
  const refactorNodeId = useFactoryStore((state) => state.recipeBrowserRefactorNodeId);
  const seedNonce = useFactoryStore((state) => state.recipeBrowserSeedNonce);
  const machinePin = useFactoryStore((state) => state.recipeBrowserMachinePin);
  const addRecipeToNode = useFactoryStore((state) => state.addRecipeToNode);
  const clearMachinePin = useFactoryStore((state) => state.clearMachinePin);
  const selectedRecipeId = useFactoryStore((state) => state.selectedRecipeId);
  const setRecipeSearch = useFactoryStore((state) => state.setRecipeSearch);
  const setHighlightSearch = useFactoryStore((state) => state.setHighlightSearch);
  const setMaxTier = useFactoryStore((state) => state.setMaxTierFilter);
  const browseResource = useFactoryStore((state) => state.browseResource);
  const browseBack = useFactoryStore((state) => state.browseBack);
  const browseForward = useFactoryStore((state) => state.browseForward);
  const canBrowseBack = useFactoryStore((state) => state.recipeBrowserBack.length > 0);
  const canBrowseForward = useFactoryStore((state) => state.recipeBrowserForward.length > 0);
  const clearResourceBrowser = useFactoryStore((state) => state.clearResourceBrowser);
  const selectRecipe = useFactoryStore((state) => state.selectRecipe);
  const addNodeForRecipe = useFactoryStore((state) => state.addNodeForRecipeObject);
  const addConnectedNodeForRecipe = useFactoryStore(
    (state) => state.addConnectedNodeForRecipeObject,
  );
  const refactorNodeWithRecipe = useFactoryStore((state) => state.refactorNodeWithRecipe);
  const beginRecipeAdd = useFactoryStore((state) => state.beginRecipeAdd);
  const resolveRecipeAdd = useFactoryStore((state) => state.resolveRecipeAdd);
  const failRecipeAdd = useFactoryStore((state) => state.failRecipeAdd);
  const [recipePage, setRecipePage] = useState(0);
  // The query key of the page whose answer is on screen. More is asked for
  // only on top of a page that has landed, always as that page + 1, so a
  // burst of scroll events all ask for the same page. A bare
  // `page => page + 1` can skip a page when two events beat the loading flag.
  const landedRecipePageKeyRef = useRef<string | undefined>(undefined);
  // The query key of the first page whose answer (or error) is on screen.
  const [answeredKey, setAnsweredKey] = useState<string | undefined>(undefined);
  const [recipeBookSearch, setRecipeBookSearch] = useState("");
  const [filteredRecipes, setFilteredRecipes] = useState<RecipeSummary[]>([]);
  const [, setRecipeTotal] = useState(0);
  const [recipeHasMore, setRecipeHasMore] = useState(false);
  const [availableRecipeMaps, setAvailableRecipeMaps] = useState<string[]>([]);
  // PINNED to a machine: the search is scoped to that machine's maps; otherwise
  // every map that matched is a tab.
  const effectiveMapSelection = useMemo<RecipeMapSelection | undefined>(
    () => (machinePin ? { mode: "include", maps: machinePin.recipeMaps } : undefined),
    [machinePin],
  );
  // Which mode the left panel is in (items, saved blueprints or shared
  // setups), one at a time. A request made before this column mounted (a
  // phone's drawer is unmounted while closed) waits in module state, so it is
  // collected here as well as by the listener below.
  const [sidebarMode, setSidebarMode] = useState<"items">(() => takePendingSidebarTab() ?? "items");
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  // A request that wanted the search box focused, collected on mount the way
  // the tab is (the panel may have been closed when it was made).
  const [pendingSearchFocus, setPendingSearchFocus] = useState(() => takePendingSearchFocus());
  // The box lights up for a moment as well as taking the cursor: a caret
  // alone is easy to miss, and "Find a recipe" has to visibly do something.
  const [isSearchFlashing, setSearchFlashing] = useState(false);
  useEffect(() => {
    if (!pendingSearchFocus || sidebarMode !== "items") {
      return;
    }
    setPendingSearchFocus(false);
    setSearchFlashing(true);
    // A freshly mounted column paints its search box a few frames in, so the
    // focus retries for up to a second. The loop is deliberately NOT cancelled
    // by the cleanup: setPendingSearchFocus above re-runs this effect at once,
    // and cancelling would kill the focus before it lands. After an unmount
    // the ref is empty and the loop runs out.
    let tries = 0;
    const tryFocus = () => {
      const input = searchInputRef.current;
      if (input) {
        input.focus();
        input.select();
        return;
      }
      if (tries++ < 60) {
        window.requestAnimationFrame(tryFocus);
      }
    };
    window.requestAnimationFrame(tryFocus);
    // Same story for the flash: left to run out on its own.
    window.setTimeout(() => setSearchFlashing(false), 1400);
  }, [pendingSearchFocus, sidebarMode]);
  const [recipeMapIcons, setRecipeMapIcons] = useState<Record<string, DatasetResourceIndexEntry>>(
    {},
  );
  const [recipeMapCounts, setRecipeMapCounts] = useState<Record<string, number>>({});
  // The stencil's edits, keyed by the browse that seeded them: a NEW browse
  // starts the stencil over, while edits survive the open search's refetches.
  // Held as edits-plus-key so a fresh browse never queries with the previous
  // item's conditions.
  const [stencilEdits, setStencilEdits] = useState<
    | {
        key: string;
        clauses: StencilClause[];
        takesOp: RecipeQuerySideOp;
        makesOp: RecipeQuerySideOp;
      }
    | undefined
  >(undefined);
  const [recipeQueryLoading, setRecipeQueryLoading] = useState(false);
  const [recipeQueryError, setRecipeQueryError] = useState<string | undefined>();
  const recipeQueryCacheRef = useRef<Map<string, RecipeQueryCacheEntry>>(new Map());
  const pendingRecipePrefetchesRef = useRef<Set<string>>(new Set());
  const debouncedRecipeSearch = useDebouncedValue(recipeSearch, RESOURCE_SEARCH_DEBOUNCE_MS);
  const debouncedRecipeBookSearch = useDebouncedValue(recipeBookSearch, RECIPE_SEARCH_DEBOUNCE_MS);

  // And the general form of the same thing: anything outside the column can
  // ask for a tab by name, and for the cursor in the search box.
  useEffect(() => {
    const openTab = () => {
      const tab = takePendingSidebarTab();
      if (tab) {
        setSidebarMode(tab);
      }
      if (takePendingSearchFocus()) {
        setPendingSearchFocus(true);
      }
    };
    window.addEventListener(OPEN_SIDEBAR_TAB_EVENT, openTab);
    return () => window.removeEventListener(OPEN_SIDEBAR_TAB_EVENT, openTab);
  }, []);

  // Publish the settled query to the canvas. Highlighting every node, storage and
  // edge against a half-typed word is wasted work the user never sees, so the
  // board only reacts once typing pauses.
  useEffect(() => {
    setHighlightSearch(debouncedRecipeSearch);
  }, [debouncedRecipeSearch, setHighlightSearch]);

  const activeResource = useMemo(() => {
    if (!browserResource) {
      return undefined;
    }

    return {
      ...browserResource,
      recipeCount: 0,
      anchorNodeId: browserResource.anchorNodeId,
    };
  }, [browserResource]);

  const recipeMaps = useMemo(
    () => availableRecipeMaps.filter(Boolean).sort((a, b) => a.localeCompare(b)),
    [availableRecipeMaps],
  );

  const recipeMapTabs = useMemo(
    () => buildRecipeMapTabs(recipeMaps, recipeMapIcons),
    [recipeMapIcons, recipeMaps],
  );

  const recipeMapChips = useMemo<RecipeMapChip[]>(
    () =>
      recipeMapTabs
        .filter((tab) => !effectiveMapSelection || effectiveMapSelection.maps.includes(tab.id))
        .map((tab) => ({ ...tab, count: recipeMapCounts[tab.id] })),
    [effectiveMapSelection, recipeMapCounts, recipeMapTabs],
  );

  // Opening the search seeds the stencil with exactly the question the click
  // asked: left click = one output condition, right click = one input - or,
  // for a refactor, every input and output of the card being replaced. Edits
  // made after that carry the browse's key and win while it stays open.
  const browseKey = browseKeyOf(browserResource, browserMode, refactorNodeId, machinePin, seedNonce);
  const seededStencil = useMemo<StencilClause[]>(() => {
    if (!browserResource) {
      return [];
    }
    if (browserSeed?.length) {
      return browserSeed.map((clause) => ({ ...clause }));
    }
    // A pinned browse starts with no condition: the machine is the whole
    // question, and its stand-in resource is not a thing to search for.
    if (browserResource.id === MACHINE_PIN_RESOURCE_ID) {
      return [];
    }
    return [
      {
        role: browserMode === "uses" ? "takes" : "makes",
        kind: browserResource.kind,
        id: browserResource.id,
        displayName: browserResource.displayName,
        iconPath: browserResource.iconPath,
        iconAtlas: browserResource.iconAtlas,
        dominantColor: browserResource.dominantColor ?? browserResource.iconAtlas?.dominantColor,
      },
    ];
  }, [browserMode, browserResource, browserSeed]);
  // A closed search forgets its stencil: the next browse, even of the same
  // item, starts from what it asks.
  useEffect(() => {
    if (browserResource) {
      return;
    }
    return deferStateUpdate(() => setStencilEdits(undefined));
  }, [browserResource]);
  const editsApply = stencilEdits?.key === browseKey;
  const stencilClauses = editsApply ? stencilEdits.clauses : seededStencil;
  // ALL is the default reading: a fresh stencil holds one condition, where
  // all and any agree, and every added condition is usually meant as "and".
  const takesOp = editsApply ? stencilEdits.takesOp : "all";
  const makesOp = editsApply ? stencilEdits.makesOp : "all";
  const queryClauses = useMemo<RecipeQueryClause[]>(
    () => stencilClauses.map(({ role, kind, id }) => ({ role, kind, id })),
    [stencilClauses],
  );

  const changeStencilClauses = useCallback(
    (clauses: StencilClause[]) => {
      setStencilEdits({ key: browseKey, clauses, takesOp, makesOp });
      setRecipePage(0);
    },
    [browseKey, makesOp, takesOp],
  );
  const changeTakesOp = useCallback(
    (op: RecipeQuerySideOp) => {
      setStencilEdits({ key: browseKey, clauses: stencilClauses, takesOp: op, makesOp });
      setRecipePage(0);
    },
    [browseKey, makesOp, stencilClauses],
  );
  const changeMakesOp = useCallback(
    (op: RecipeQuerySideOp) => {
      setStencilEdits({ key: browseKey, clauses: stencilClauses, takesOp, makesOp: op });
      setRecipePage(0);
    },
    [browseKey, stencilClauses, takesOp],
  );
  const swapStencilSides = useCallback(() => {
    setStencilEdits({
      key: browseKey,
      clauses: stencilClauses.map((clause) => ({
        ...clause,
        role: clause.role === "takes" ? "makes" : "takes",
      })),
      takesOp: makesOp,
      makesOp: takesOp,
    });
    setRecipePage(0);
  }, [browseKey, makesOp, stencilClauses, takesOp]);
  // The stencil's unpin key: every machine's recipes show and a pick makes a
  // new card. What the player put on the stencil stays: its edits move to the
  // key the page has once the pin is gone.
  const unpinMachine = useCallback(() => {
    setStencilEdits({
      key: browseKeyOf(browserResource, browserMode, refactorNodeId, undefined, seedNonce),
      clauses: stencilClauses,
      takesOp,
      makesOp,
    });
    setRecipePage(0);
    clearMachinePin();
  }, [
    browserMode,
    browserResource,
    clearMachinePin,
    makesOp,
    refactorNodeId,
    seedNonce,
    stencilClauses,
    takesOp,
  ]);

  const activeRecipeQuery = activeResource
    ? debouncedRecipeBookSearch.trim()
    : debouncedRecipeSearch.trim();

  // PINNED with nothing on the stencil and no name typed: the machine alone is
  // not a question (its whole book runs to thousands of recipes), so nothing is
  // asked and the page asks for an item on Takes or Makes instead.
  const pinnedIdle =
    machinePin !== undefined && queryClauses.length === 0 && activeRecipeQuery === "";

  const selectedDatasetVersion = useMemo(
    () =>
      datasetServesOpenPlan
        ? datasetManifest?.versions.find((entry) => entry.id === selectedDatasetVersionId)
        : undefined,
    [datasetManifest?.versions, datasetServesOpenPlan, selectedDatasetVersionId],
  );

  const getRecipeQueryKey = useCallback(
    (selection: RecipeMapSelection | undefined, page: number) =>
      selectedDatasetVersion
        ? getRecipeQueryCacheKey({
            versionId: getDatasetVersionCacheKey(selectedDatasetVersion),
            query: activeRecipeQuery,
            resource: activeResource,
            mode: browserMode,
            clauses: queryClauses,
            takesOp,
            makesOp,
            mapSelection: selection,
            maxTier,
            offset: page * RECIPE_QUERY_LIMIT,
            limit: RECIPE_QUERY_LIMIT,
          })
        : "",
    [
      activeRecipeQuery,
      activeResource,
      browserMode,
      makesOp,
      maxTier,
      queryClauses,
      selectedDatasetVersion,
      takesOp,
    ],
  );

  // The open tab: NEI's one machine at a time, held per browse so a new item
  // opens on its first tab. A tab the stencil no longer matches gives way to
  // the first. The first tab needs no query of its own: the server lists
  // recipes in tab order, so the unscoped answer starts with its recipes.
  const [viewTab, setViewTab] = useState<{ key: string; id: string } | undefined>(undefined);
  const activeViewTab = viewTab?.key === browseKey ? viewTab.id : undefined;
  const firstRecipeMap = recipeMapChips[0]?.id;
  const selectionForTab = useCallback(
    (tab: string | undefined): RecipeMapSelection | undefined =>
      tab && tab !== firstRecipeMap && recipeMaps.includes(tab)
        ? { mode: "include", maps: [tab] }
        : effectiveMapSelection,
    [effectiveMapSelection, firstRecipeMap, recipeMaps],
  );
  const querySelection = useMemo(
    () => selectionForTab(activeViewTab),
    [activeViewTab, selectionForTab],
  );

  const selectTab = useCallback(
    (tab: string) => {
      setViewTab({ key: browseKey, id: tab });
      setRecipePage(0);
    },
    [browseKey],
  );

  // A pointer over a tab is probably about to open it, so its first page
  // starts travelling now.
  const prefetchRecipeMapTab = useCallback(
    (recipeMap: string) => {
      if (!selectedDatasetVersion || !activeResource || pinnedIdle) {
        return;
      }
      const selection = selectionForTab(recipeMap);
      const cacheKey = getRecipeQueryKey(selection, 0);
      if (
        !cacheKey ||
        getCachedRecipeQuery(recipeQueryCacheRef.current, cacheKey) ||
        pendingRecipePrefetchesRef.current.has(cacheKey)
      ) {
        return;
      }

      pendingRecipePrefetchesRef.current.add(cacheKey);
      void queryRecipeDatasetRecipes(
        datasetManifestUrl ?? DEFAULT_DATASET_MANIFEST_URL,
        selectedDatasetVersion,
        {
          query: activeRecipeQuery,
          resource:
            activeResource.id !== MACHINE_PIN_RESOURCE_ID
              ? { kind: activeResource.kind, id: activeResource.id }
              : undefined,
          mode: browserMode,
          clauses: queryClauses.length > 0 ? queryClauses : undefined,
          takesOp,
          makesOp,
          allMaps: true,
          mapSelection: selection,
          maxTier,
          offset: 0,
          limit: RECIPE_QUERY_LIMIT,
        },
      )
        .then((result) => {
          setCachedRecipeQuery(recipeQueryCacheRef.current, cacheKey, result);
          trimRecipeQueryCache(recipeQueryCacheRef.current);
        })
        .catch(() => {
          // Prefetch is opportunistic; opening the tab surfaces real errors.
        })
        .finally(() => {
          pendingRecipePrefetchesRef.current.delete(cacheKey);
        });
    },
    [
      activeResource,
      activeRecipeQuery,
      browserMode,
      datasetManifestUrl,
      getRecipeQueryKey,
      makesOp,
      maxTier,
      pinnedIdle,
      queryClauses,
      selectedDatasetVersion,
      selectionForTab,
      takesOp,
    ],
  );

  const searchPickerResources = useCallback(
    async (pickerQuery: string, signal: AbortSignal) => {
      if (!selectedDatasetVersion) {
        return [];
      }
      const result = await queryRecipeDatasetResources(
        datasetManifestUrl ?? DEFAULT_DATASET_MANIFEST_URL,
        selectedDatasetVersion,
        { query: pickerQuery, offset: 0, limit: 48 },
        { signal },
      );
      return result.resources;
    },
    [datasetManifestUrl, selectedDatasetVersion],
  );

  const getFullRecipe = useCallback(
    async (recipeId: string, preferDataset = false): Promise<Recipe> => {
      const projectRecipe = projectRecipes.find((recipe) => recipe.id === recipeId);
      if (!preferDataset && projectRecipe && recipeHasRenderableIcons(projectRecipe)) {
        return projectRecipe;
      }
      if (!selectedDatasetVersion) {
        throw new Error("No dataset version is selected.");
      }

      return getRecipeDatasetRecipe(
        datasetManifestUrl ?? DEFAULT_DATASET_MANIFEST_URL,
        selectedDatasetVersion,
        recipeId,
      );
    },
    [datasetManifestUrl, projectRecipes, selectedDatasetVersion],
  );

  const handleAddRecipe = useCallback(
    async (
      recipeSummary: RecipeSummary,
      machineHandlerId?: string,
      inputPicks?: RecipeInputPicks,
    ) => {
      const currentState = useFactoryStore.getState();
      if (currentState.isReadOnly) return;
      const currentResource = currentState.recipeBrowserResource
        ? {
            ...currentState.recipeBrowserResource,
            recipeCount: 0,
            anchorNodeId: currentState.recipeBrowserResource.anchorNodeId,
          }
        : activeResource;
      const currentMode = currentState.recipeBrowserResource
        ? currentState.recipeBrowserMode
        : browserMode;
      // A pick made while Welcome covers the board goes to a fresh blank tab
      // rather than the hidden one. Anchor and refactor targets belong to the
      // covered plan, so they are dropped.
      const welcomeCovered = readWelcomeTabState().active;
      if (welcomeCovered) {
        // The new plan is on the version whose recipes the browser showed, not the
        // New plans choice in Settings: that version may lack this recipe, and the
        // choice's Settings section says so.
        const shown = currentState.datasetManifest?.versions.find(
          (version) => version.id === currentState.selectedDatasetVersionId,
        );
        await useDesignStore
          .getState()
          .addDesign(shown ? { gameVersion: gameVersionOfDataset(shown) } : undefined);
        leaveWelcomeTab();
      }
      const currentRefactorNodeId = welcomeCovered
        ? undefined
        : currentState.recipeBrowserRefactorNodeId;
      const currentMachinePin = welcomeCovered ? undefined : currentState.recipeBrowserMachinePin;
      // The pin's stand-in resource is no item: a search unpinned after it
      // opened places the pick as a new card, wired to nothing.
      const standIn = currentResource?.id === MACHINE_PIN_RESOURCE_ID;
      const anchorNodeId = welcomeCovered || standIn ? undefined : currentResource?.anchorNodeId;
      const contextResource = standIn
        ? undefined
        : getRecipeAddContextResource(currentResource, currentMode, recipeSummary);
      // The book closes on the press, not on the response. A click that seems
      // to do nothing gets clicked again; the chip over the board carries the
      // wait instead, and the apology when the fetch fails.
      clearResourceBrowser();
      const pendingId = beginRecipeAdd(recipeSummary.name);
      try {
        const recipe = await getFullRecipe(recipeSummary.id, Boolean(currentResource));
        // The fetch can resolve after a switch to a tab on the other version: say so, add nothing.
        if (refusesRecipeOnPlan(useFactoryStore.getState(), recipe)) {
          failRecipeAdd(pendingId, OTHER_VERSION_RECIPE_MESSAGE);
          return;
        }
        if (currentMachinePin) {
          // The pinned machine's card takes the pick as one more recipe, keeping
          // the concrete item it was browsed from in its slots.
          if (
            !addRecipeToNode(currentMachinePin.nodeId, recipe, {
              resource: contextResource,
              inputPicks,
            })
          ) {
            failRecipeAdd(
              pendingId,
              `No machine runs both ${recipeSummary.name} and what ${currentMachinePin.label} already has.`,
            );
            return;
          }
        } else if (currentRefactorNodeId) {
          // The refactor's landing: the pick replaces the card it came from.
          refactorNodeWithRecipe(currentRefactorNodeId, recipe, { machineHandlerId });
        } else if (anchorNodeId && contextResource) {
          // Opened from a card's port: the pick lands beside that card and
          // wires itself to the clicked resource.
          addConnectedNodeForRecipe(recipe, anchorNodeId, contextResource, {
            machineHandlerId,
            inputPicks,
          });
        } else {
          addNodeForRecipe(recipe, contextResource, {
            machineHandlerId,
            inputPicks,
            focusCamera: true,
          });
        }
        resolveRecipeAdd(pendingId);
      } catch (error) {
        failRecipeAdd(
          pendingId,
          error instanceof Error ? error.message : "The recipe could not be loaded.",
        );
      }
    },
    [
      activeResource,
      addConnectedNodeForRecipe,
      addNodeForRecipe,
      addRecipeToNode,
      beginRecipeAdd,
      browserMode,
      clearResourceBrowser,
      failRecipeAdd,
      getFullRecipe,
      refactorNodeWithRecipe,
      resolveRecipeAdd,
    ],
  );

  const prefetchRecipeAdd = useCallback(
    (recipeId: string) => {
      // Warm the session cache while the pointer is still hovering, so the
      // plus button usually has its recipe before it is pressed. A failure
      // here is nothing: the click fetches again and reports its own.
      void getFullRecipe(recipeId, true).catch(() => undefined);
    },
    [getFullRecipe],
  );

  useEffect(() => {
    return deferStateUpdate(() => setRecipePage(0));
  }, [
    activeResource?.id,
    activeResource?.kind,
    browserMode,
    maxTier,
    activeRecipeQuery,
    queryClauses,
    takesOp,
    makesOp,
    selectedDatasetVersion?.id,
  ]);

  useEffect(() => {
    return deferStateUpdate(() => setRecipeBookSearch(""));
  }, [activeResource?.id, activeResource?.kind, browserMode, selectedDatasetVersion?.id]);

  useEffect(() => {
    if (!selectedDatasetVersion) {
      return deferStateUpdate(() => {
        setAnsweredKey("");
        setFilteredRecipes([]);
        setRecipeTotal(0);
        setRecipeHasMore(false);
        setAvailableRecipeMaps([]);
        setRecipeMapIcons({});
        setRecipeMapCounts({});
      });
    }

    const query = activeRecipeQuery;
    // Nothing on screen reads these until a resource is being browsed - the
    // search IS the resource view, and it opens with its own filter box.
    // Running the query anyway meant every keystroke in the item box searched
    // 270,000 recipes for a list no one ever saw.
    if (!activeResource) {
      return deferStateUpdate(() => {
        setFilteredRecipes([]);
        setRecipeTotal(0);
        setRecipeHasMore(false);
        setAvailableRecipeMaps([]);
        setRecipeMapIcons({});
        setRecipeMapCounts({});
        setRecipeQueryLoading(false);
        setRecipeQueryError(undefined);
      });
    }

    const cacheKey = getRecipeQueryKey(querySelection, recipePage);
    if (pinnedIdle) {
      return deferStateUpdate(() => {
        landedRecipePageKeyRef.current = cacheKey;
        setAnsweredKey(cacheKey);
        setFilteredRecipes([]);
        setRecipeTotal(0);
        setRecipeHasMore(false);
        setAvailableRecipeMaps([]);
        setRecipeMapIcons({});
        setRecipeMapCounts({});
        setRecipeQueryLoading(false);
        setRecipeQueryError(undefined);
      });
    }
    const cached = getCachedRecipeQuery(recipeQueryCacheRef.current, cacheKey);
    if (cached) {
      return scheduleAfterPaint(() => {
        landedRecipePageKeyRef.current = cacheKey;
        if (recipePage === 0) setAnsweredKey(cacheKey);
        setFilteredRecipes((current) =>
          recipePage === 0 ? cached.recipes : appendUniqueRecipes(current, cached.recipes),
        );
        setRecipeTotal(cached.total);
        setRecipeHasMore(cached.hasMore);
        setAvailableRecipeMaps(cached.recipeMaps);
        setRecipeMapIcons(cached.recipeMapIcons ?? {});
        setRecipeMapCounts(cached.recipeMapCounts ?? {});
        setRecipeQueryLoading(false);
        setRecipeQueryError(undefined);
      });
    }

    const controller = new AbortController();
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) {
        if (recipePage === 0) {
          setFilteredRecipes([]);
          setRecipeTotal(0);
          setRecipeHasMore(false);
        }
        setRecipeQueryLoading(true);
        setRecipeQueryError(undefined);
      }
    });

    const cancelAfterPaint = scheduleAfterPaint(() => {
      void queryRecipeDatasetRecipes(
        datasetManifestUrl ?? DEFAULT_DATASET_MANIFEST_URL,
        selectedDatasetVersion,
        {
          query,
          // A pinned browse's stand-in resource is not a question for the
          // dataset; the pin scopes the maps and the stencil asks the rest.
          resource:
            activeResource && activeResource.id !== MACHINE_PIN_RESOURCE_ID
              ? {
                  kind: activeResource.kind,
                  id: activeResource.id,
                }
              : undefined,
          mode: browserMode,
          clauses: queryClauses.length > 0 ? queryClauses : undefined,
          takesOp,
          makesOp,
          allMaps: true,
          mapSelection: querySelection,
          maxTier,
          offset: recipePage * RECIPE_QUERY_LIMIT,
          limit: RECIPE_QUERY_LIMIT,
        },
        { signal: controller.signal },
      )
        .then((result) => {
          if (cancelled) {
            return;
          }
          setCachedRecipeQuery(recipeQueryCacheRef.current, cacheKey, result);
          trimRecipeQueryCache(recipeQueryCacheRef.current);
          landedRecipePageKeyRef.current = cacheKey;
          if (recipePage === 0) setAnsweredKey(cacheKey);
          setFilteredRecipes((current) =>
            recipePage === 0 ? result.recipes : appendUniqueRecipes(current, result.recipes),
          );
          setRecipeTotal(result.total);
          setRecipeHasMore(result.hasMore);
          setAvailableRecipeMaps(result.recipeMaps);
          setRecipeMapIcons(result.recipeMapIcons ?? {});
          setRecipeMapCounts(result.recipeMapCounts ?? {});
          setRecipeQueryLoading(false);
        })
        .catch((error) => {
          if (cancelled) {
            return;
          }
          if (recipePage === 0) setAnsweredKey(cacheKey);
          setFilteredRecipes([]);
          setRecipeTotal(0);
          setRecipeHasMore(false);
          setAvailableRecipeMaps([]);
          setRecipeMapIcons({});
          setRecipeMapCounts({});
          setRecipeQueryError(error instanceof Error ? error.message : "Recipe query failed.");
          setRecipeQueryLoading(false);
        });
    });

    return () => {
      cancelled = true;
      controller.abort();
      cancelAfterPaint();
    };
  }, [
    activeRecipeQuery,
    activeResource,
    browserMode,
    datasetManifestUrl,
    getRecipeQueryKey,
    makesOp,
    pinnedIdle,
    querySelection,
    maxTier,
    queryClauses,
    recipePage,
    selectedDatasetVersion,
    takesOp,
  ]);
  // Until the open question's first page has an answer (or while a typed name
  // waits out its debounce) the page reads as loading: never "nothing matches"
  // for a question not yet asked.
  const answerPending =
    answeredKey !== getRecipeQueryKey(querySelection, 0) ||
    recipeBookSearch.trim() !== debouncedRecipeBookSearch.trim();
  return (
    <>
      <aside
        data-help-anchor="browser"
        className={`relative z-40 flex h-full min-h-[360px] min-w-0 compact:min-h-0 flex-col ${itemsOnRight ? "border-l" : "border-r"} border-neutral-800 bg-[#25272c] text-neutral-100`}
      >
        {
          // The wheel pages the list from anywhere in the column, including over
          // the controls and the recent shelf, since nothing here scrolls.
          <div className="flex min-h-0 flex-1 flex-col">
            <ResourceIndexPane
              search={recipeSearch}
              onSearchChange={setRecipeSearch}
              searchInputRef={searchInputRef}
              searchFlashing={isSearchFlashing}
              activeResource={activeResource}
              onBrowse={browseResource}
              defaultSort="nei"
              // NEI's field sits at the bottom middle of the screen. On a phone, under a page covering the board and under
              // the recipe search (whose own keys sit there) it is at the column's foot.
              searchAt={isCompact || boardCovered || activeResource ? "bottom" : "dock"}
              leading={
                /* Folds this column away (the overview's fold key, facing the board); on a phone it closes the drawer. */
                <RailKey
                  label="Hide the items column"
                  className="rail-key-fold"
                  onClick={() => writeWorkspaceView({ leftPanelOpen: false })}
                  tip={() => ({ title: "Fold the items" })}
                >
                  <FoldGlyph direction={itemsOnRight ? "right" : "left"} />
                </RailKey>
              }
            />
          </div>
        }
      </aside>

      {activeResource ? (
        <RecipeSearchOverlay
          clauses={stencilClauses}
          takesOp={takesOp}
          makesOp={makesOp}
          onClausesChange={changeStencilClauses}
          onTakesOpChange={changeTakesOp}
          onMakesOpChange={changeMakesOp}
          onSwapSides={swapStencilSides}
          recipeMapChips={recipeMapChips}
          activeTab={activeViewTab}
          onSelectTab={selectTab}
          onRecipeMapHover={prefetchRecipeMapTab}
          recipes={filteredRecipes}
          hasMore={recipeHasMore}
          isLoading={recipeQueryLoading || answerPending || (!datasetServesOpenPlan && !unservedVersion)}
          unavailable={unservedVersion ? recipesNotOnSiteText(unservedVersion) : undefined}
          queryError={recipeQueryError}
          query={recipeBookSearch}
          onQueryChange={(query) => {
            setRecipeBookSearch(query);
            setRecipePage(0);
          }}
          maxTier={maxTier}
          onMaxTierChange={setMaxTier}
          selectedRecipeId={selectedRecipeId}
          onSelectRecipe={selectRecipe}
          onAdd={handleAddRecipe}
          onPrefetch={prefetchRecipeAdd}
          onBrowseResource={(resource, mode) =>
            browseResource(
              {
                kind: resource.kind,
                id: resource.id,
                displayName: resource.displayName,
                iconPath: resource.iconPath,
                iconAtlas: resource.iconAtlas,
                dominantColor: resource.dominantColor ?? resource.iconAtlas?.dominantColor,
                anchorNodeId: activeResource.anchorNodeId,
              },
              mode,
            )
          }
          onLoadMore={() => {
            if (
              !recipeQueryLoading &&
              recipeHasMore &&
              landedRecipePageKeyRef.current === getRecipeQueryKey(querySelection, recipePage)
            ) {
              setRecipePage(recipePage + 1);
            }
          }}
          onClose={clearResourceBrowser}
          browseKey={browseKey}
          canGoBack={canBrowseBack}
          canGoForward={canBrowseForward}
          onBack={browseBack}
          onForward={browseForward}
          contextResource={activeResource}
          searchPickerResources={searchPickerResources}
          machinePin={machinePin}
          onClearPin={unpinMachine}
        />
      ) : null}
    </>
  );
}

/**
 * The open page's identity: the stencil's edits and the open tab hold only while it stays the same. The nonce makes
 * every refactor or pin press a fresh browse: the card's settings may have changed, and old stencil edits must not
 * resurrect over the new seed.
 */
function browseKeyOf(
  resource: RecipeBrowserResource | undefined,
  mode: RecipeBrowserMode,
  refactorNodeId: string | undefined,
  machinePin: RecipeBrowserMachinePin | undefined,
  seedNonce: number,
): string {
  if (!resource) {
    return "";
  }
  return [
    refactorNodeId ? `refactor:${refactorNodeId}:${seedNonce}` : "",
    machinePin ? `pin:${machinePin.nodeId}:${seedNonce}` : "",
    resource.kind,
    resource.id,
    mode,
  ].join("|");
}

interface RecipeMapTab {
  id: string;
  label: string;
  icon?: Pick<
    ResourceAmount,
    "kind" | "id" | "amount" | "displayName" | "iconPath" | "iconAtlas" | "dominantColor"
  >;
}

interface RecipeQueryCacheEntry {
  result: RecipeDatasetQueryResult;
  expiresAt: number;
}

function getRecipeAddContextResource(
  activeResource: (IndexedResource & { anchorNodeId?: string }) | undefined,
  mode: "recipes" | "uses",
  contextRecipe: RecipeSummary | undefined,
):
  | (Pick<
      ResourceAmount,
      | "kind"
      | "id"
      | "displayName"
      | "iconPath"
      | "iconAtlas"
      | "dominantColor"
      | "tooltip"
      | "modId"
    > & {
      mode: "recipes" | "uses";
      inputIndex?: number;
      neiSlot?: ResourceAmount["neiSlot"];
    })
  | undefined {
  if (!activeResource) {
    return undefined;
  }

  if (mode === "uses") {
    const contextInputIndex = contextRecipe?.inputs.findIndex(
      (input) =>
        (input.kind === activeResource.kind && input.id === activeResource.id) ||
        resourceMatchesInput({ kind: activeResource.kind, id: activeResource.id }, input),
    );
    const contextInput =
      contextInputIndex !== undefined && contextInputIndex >= 0
        ? contextRecipe?.inputs[contextInputIndex]
        : undefined;
    const contextSlotInput =
      contextInput ??
      contextRecipe?.inputs.find(
        (input) =>
          input.neiSlot &&
          resourceMatchesInput({ kind: activeResource.kind, id: activeResource.id }, input),
      );
    if (contextSlotInput && !contextSlotInput.id.startsWith("oredict:")) {
      return {
        kind: contextSlotInput.kind,
        id: contextSlotInput.id,
        displayName: contextSlotInput.displayName ?? activeResource.displayName,
        iconPath: contextSlotInput.iconPath ?? activeResource.iconPath,
        iconAtlas: contextSlotInput.iconAtlas ?? activeResource.iconAtlas,
        dominantColor:
          contextSlotInput.dominantColor ??
          contextSlotInput.iconAtlas?.dominantColor ??
          activeResource.dominantColor ??
          activeResource.iconAtlas?.dominantColor,
        tooltip: contextSlotInput.tooltip,
        modId: contextSlotInput.modId,
        mode,
        inputIndex: contextInputIndex,
        neiSlot: contextSlotInput.neiSlot,
      };
    }
  }

  return {
    kind: activeResource.kind,
    id: activeResource.id,
    displayName: activeResource.displayName,
    iconPath: activeResource.iconPath,
    iconAtlas: activeResource.iconAtlas,
    dominantColor: activeResource.dominantColor ?? activeResource.iconAtlas?.dominantColor,
    mode,
  };
}

function recipeHasRenderableIcons(recipe: Recipe) {
  return [...recipe.inputs, ...recipe.outputs]
    .filter((resource) => resource.kind === "item")
    .every((resource) => Boolean(resource.iconPath || resource.iconAtlas));
}

function scheduleAfterPaint(callback: () => void) {
  if (typeof window === "undefined") {
    callback();
    return () => undefined;
  }

  let cancelled = false;
  let firstFrame = 0;
  let secondFrame = 0;

  firstFrame = window.requestAnimationFrame(() => {
    secondFrame = window.requestAnimationFrame(() => {
      if (!cancelled) {
        callback();
      }
    });
  });

  return () => {
    cancelled = true;
    window.cancelAnimationFrame(firstFrame);
    window.cancelAnimationFrame(secondFrame);
  };
}

function appendUniqueRecipes(current: RecipeSummary[], incoming: RecipeSummary[]) {
  const seen = new Set(current.map((recipe) => recipe.id));
  const next = [...current];
  for (const recipe of incoming) {
    if (seen.has(recipe.id)) {
      continue;
    }
    seen.add(recipe.id);
    next.push(recipe);
  }
  return next;
}

function getRecipeQueryCacheKey({
  versionId,
  query,
  resource,
  mode,
  clauses,
  takesOp,
  makesOp,
  mapSelection,
  maxTier,
  offset,
  limit,
}: {
  versionId: string;
  query: string;
  resource?: Pick<ResourceAmount, "kind" | "id">;
  mode: "recipes" | "uses";
  clauses: RecipeQueryClause[];
  takesOp: RecipeQuerySideOp;
  makesOp: RecipeQuerySideOp;
  mapSelection: RecipeMapSelection | undefined;
  maxTier: TierFilter;
  offset: number;
  limit: number;
}) {
  return [
    versionId,
    query.trim().toLowerCase(),
    resource ? `${resource.kind}:${resource.id}` : "",
    mode,
    clauses.map((clause) => `${clause.role}:${clause.kind}:${clause.id}`).join(","),
    takesOp,
    makesOp,
    mapSelection ? `${mapSelection.mode}:${[...mapSelection.maps].sort().join(",")}` : "all",
    maxTier,
    offset,
    limit,
  ].join("|");
}

function getCachedRecipeQuery(cache: Map<string, RecipeQueryCacheEntry>, key: string) {
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

function setCachedRecipeQuery(
  cache: Map<string, RecipeQueryCacheEntry>,
  key: string,
  result: RecipeDatasetQueryResult,
) {
  cache.set(key, {
    result,
    expiresAt: Date.now() + RECIPE_QUERY_CACHE_TTL_MS,
  });
}

function trimRecipeQueryCache(cache: Map<string, RecipeQueryCacheEntry>) {
  while (cache.size > 120) {
    const oldestKey = cache.keys().next().value;
    if (!oldestKey) {
      return;
    }
    cache.delete(oldestKey);
  }
}

function buildRecipeMapTabs(
  recipeMaps: string[],
  icons: Record<string, DatasetResourceIndexEntry>,
): RecipeMapTab[] {
  return recipeMaps.map((recipeMap) => {
    const resource = icons[recipeMap];
    return {
      id: recipeMap,
      label: recipeMap,
      icon: resource
        ? {
            kind: resource.kind,
            id: resource.id,
            amount: 1,
            displayName: resource.displayName,
            iconPath: resource.iconPath,
            iconAtlas: resource.iconAtlas,
            dominantColor: resource.dominantColor ?? resource.iconAtlas?.dominantColor,
          }
        : undefined,
    };
  });
}
