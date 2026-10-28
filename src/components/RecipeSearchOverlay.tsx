import { useDropdownDismiss } from "@/lib/hooks/use-dropdown-dismiss";
import { wheelChangesValues } from "@/lib/device-settings";

import {
  ArrowLeftRight,
  ChevronLeft,
  ChevronRight,
  Plus,
  Search,
  Star,
  X,
  Zap,
} from "lucide-react";
import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import "./chrome/mod-panel.css";
import "./nei/nei.css";
import "./nei/nei-recipe.css";
import { ModPick } from "./chrome/ModPick";
import { createPortal } from "react-dom";
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from "react";
import type { DatasetResourceIndexEntry, RecipeSummary } from "@/lib/datasets/types";
import type { RecipeQueryRole, RecipeQuerySideOp } from "@/lib/datasets/recipe-query";
import { GT_VOLTAGE_TIERS, getRecipeMachineHandlers } from "@/lib/model";
import type { MachineTier, ResourceAmount } from "@/lib/model/types";
import { getVoltageTierIndex } from "@/lib/model/tiers";
import { resourceLabel } from "@/lib/model/resources";
import { playBoardSound } from "@/lib/board-sounds";
import type { RecipeBrowserMachinePin, TierFilter } from "@/store/factory-store";
import {
  machineIconAtTier,
  useMachineHandlerIconEntries,
  useRecipeMapIcons,
} from "./flow/machine-icons";
import { useIsCompactViewport } from "@/lib/compact-view";
import { getUiScale, useUiScale } from "@/lib/ui-scale";
import { machineArtPixels } from "./flow/MachinePicker";
import { isEditableKeyboardTarget } from "./flow/keyboard";
import { ItemPickerPopover } from "./ItemPickerPopover";
import { isSwatchFluid, ResourceIcon, spriteArtPixels } from "./nei/ResourceIcon";
import {
  cardCellHeight,
  CARD_WIDTH,
  LookupPowerCard,
  LookupRecipeCard,
  LookupSkeletonCard,
  powerCardRows,
  recipeCardRows,
  type ChipMenuPicker,
  type LookupHandlers,
  type RateView,
} from "./nei/lookup-card";
import { itemTipLines, McFloatingTip } from "./nei/McTip";
import { summaryToPreviewRecipe, type PreviewContextResource } from "./recipe-preview";
import {
  POWER_EU_CLAUSE_ID,
  searchPowerSourcesForStencil,
  type PowerStencilHit,
} from "@/lib/power/power-search";
import { useFactoryStore } from "@/store/factory-store";
import { overlayInsets } from "@/lib/workspace-columns";
import { planGameVersion } from "@/lib/model/game-version";

/**
 * One condition on the stencil: a resource and the side of the recipe it must
 * appear on, dressed to draw its own chip.
 */
export interface StencilClause extends Pick<
  ResourceAmount,
  "kind" | "id" | "displayName" | "iconPath" | "iconAtlas" | "dominantColor"
> {
  role: RecipeQueryRole;
}

const RATE_VIEW_CHOICES: Array<{ view: RateView; label: string; title: string }> = [
  { view: "recipe", label: "Recipe", title: "Amounts per craft, as the recipe is written" },
  { view: "tick", label: "/t", title: "Rates per tick, one machine at full speed" },
  { view: "second", label: "/s", title: "Rates per second, one machine at full speed" },
  { view: "minute", label: "/min", title: "Rates per minute, one machine at full speed" },
  { view: "hour", label: "/hr", title: "Rates per hour, one machine at full speed" },
  {
    view: "ratio",
    label: "Ratio",
    title: "Amounts reduced to lowest terms; time plays no part",
  },
  {
    view: "eu",
    label: "EU",
    title: "EU spent per unit of each output, one machine at the recipe's own tier",
  },
];

/** Survives close and reopen: the reading you chose is a preference, not a query. */
let storedRateView: RateView = "recipe";

/** A condition row in flight: where the hand holds it and where it would land. */
interface StencilDrag {
  /** Index into `clauses` of the row being moved, or -1 for a new one. */
  index: number;
  /**
   * A condition NOT yet in the stencil: a slot lifted off a recipe. It lands
   * only when released over a side; anywhere else it vanishes.
   */
  source?: StencilClause;
  width: number;
  pitch: number;
  grabDX: number;
  grabDY: number;
  startX: number;
  startY: number;
  x: number;
  y: number;
  active: boolean;
  overRole: RecipeQueryRole | undefined;
  overSlot: number;
}

/** A recipe map that matched: one machine tab. */
export interface RecipeMapChip {
  id: string;
  label: string;
  count?: number;
  icon?: Pick<
    ResourceAmount,
    "kind" | "id" | "amount" | "displayName" | "iconPath" | "iconAtlas" | "dominantColor"
  >;
}

/** The Generators tab's id: never a recipe map's name. */
const GENERATORS_TAB = "@generators";

interface MachineTab {
  id: string;
  label: string;
  count?: number;
  icon?: RecipeMapChip["icon"];
  generators?: boolean;
  /** The pinned machine's own tab while the stencil is empty: no recipes asked for yet. */
  pinned?: boolean;
}

/** The pinned machine's tab's id: never a recipe map's name. */
const PINNED_TAB = "@pinned";

// NEI's measures in shell px (one GUI pixel is about 1.75): an 18 px slot, a 24 px tab. A page is a grid of the
// tab's cards, every card in the tab's tallest card's cell, as a handler's recipes are.
const TAB = 42;
const CELL_GAP = 12;
const PAGE_PAD = 6;

/**
 * The recipe search as NEI's recipe window: a tab per machine on the window's
 * top edge, the machine's name and the page between their arrows, the open
 * tab's recipes a page at a time, the machines that run them in a column on
 * the left. The STENCIL of the wanted recipe sits on its own card at the
 * bottom: takes on the left and makes on the right, each side combining its
 * items with ANY, ALL or ONLY; a recipe must satisfy both sides.
 */
export function RecipeSearchOverlay({
  clauses,
  takesOp,
  makesOp,
  onClausesChange,
  onTakesOpChange,
  onMakesOpChange,
  onSwapSides,
  recipeMapChips,
  activeTab,
  onSelectTab,
  onRecipeMapHover,
  recipes,
  hasMore,
  isLoading,
  unavailable,
  queryError,
  query,
  onQueryChange,
  maxTier,
  onMaxTierChange,
  onSelectRecipe,
  onAdd,
  onPrefetch,
  onBrowseResource,
  onLoadMore,
  onClose,
  browseKey,
  canGoBack,
  canGoForward,
  onBack,
  onForward,
  contextResource,
  searchPickerResources,
  machinePin,
  onClearPin,
}: {
  clauses: StencilClause[];
  takesOp: RecipeQuerySideOp;
  makesOp: RecipeQuerySideOp;
  onClausesChange: (clauses: StencilClause[]) => void;
  onTakesOpChange: (op: RecipeQuerySideOp) => void;
  onMakesOpChange: (op: RecipeQuerySideOp) => void;
  onSwapSides: () => void;
  recipeMapChips: RecipeMapChip[];
  /** The open tab; absent opens the first. */
  activeTab?: string;
  onSelectTab: (tab: string) => void;
  onRecipeMapHover: (recipeMap: string) => void;
  recipes: RecipeSummary[];
  hasMore: boolean;
  isLoading: boolean;
  /** Why no recipes can show at all (a plan for a version this site has no recipes for). */
  unavailable?: string;
  queryError?: string;
  query: string;
  onQueryChange: (query: string) => void;
  maxTier: TierFilter;
  onMaxTierChange: (tier: TierFilter) => void;
  selectedRecipeId?: string;
  onSelectRecipe: (recipeId: string) => void;
  onAdd: (recipe: RecipeSummary, machineHandlerId?: string) => void | Promise<void>;
  onPrefetch?: (recipeId: string) => void;
  onBrowseResource: (resource: ResourceAmount, mode: "recipes" | "uses") => void;
  onLoadMore: () => void;
  onClose: () => void;
  /** Changes with every page the search shows; the page-turn sound keys on it. */
  browseKey: string;
  canGoBack: boolean;
  canGoForward: boolean;
  onBack: () => void;
  onForward: () => void;
  contextResource?: PreviewContextResource;
  searchPickerResources: (
    query: string,
    signal: AbortSignal,
  ) => Promise<DatasetResourceIndexEntry[]>;
  /** SHARED MACHINES: the search is pinned to one card's machine; only its recipes show and the add joins that card. */
  machinePin?: RecipeBrowserMachinePin;
  /** The pin card's unpin key: every machine's recipes show and a pick makes a new card. */
  onClearPin?: () => void;
}) {
  const machineIconEntries = useMachineHandlerIconEntries();
  const recipeMapIcons = useRecipeMapIcons();
  const machinePinIcon = machinePin
    ? (machineIconAtTier(
        machinePin.handlerId ? machineIconEntries.get(machinePin.handlerId) : undefined,
        machinePin.tier,
      ) ?? (machinePin.recipeMaps[0] ? recipeMapIcons.get(machinePin.recipeMaps[0]) : undefined))
    : undefined;
  const panelRef = useRef<HTMLElement>(null);
  const layout = useRecipeSearchViewport();
  // A phone (or any window the app calls compact) gets the search FULL
  // SCREEN: the window and the stencil fill it, the machine column goes.
  const compact = useIsCompactViewport();
  // The shell zoom, for placing fixed children of this zoomed portal.
  const uiScale = useUiScale();
  const sheet = compact || layout.sheet;
  const [pickerRole, setPickerRole] = useState<RecipeQueryRole | undefined>(undefined);
  const [rateView, setRateView] = useState<RateView>(() => storedRateView);
  const changeRateView = useCallback((view: RateView) => {
    storedRateView = view;
    setRateView(view);
  }, []);
  // The wheel walks the rate keys: down for the next reading, up for the
  // previous, wrapping at the ends. Attached by hand and non-passive so
  // nothing behind scrolls with it.
  const ratePillsRef = useRef<HTMLDivElement | null>(null);
  const rateViewRef = useRef(rateView);
  rateViewRef.current = rateView;
  useEffect(() => {
    const element = ratePillsRef.current;
    if (!element) {
      return;
    }
    const onWheel = (event: WheelEvent) => {
      const delta = event.deltaY || event.deltaX;
      if (!delta || !wheelChangesValues()) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      const at = RATE_VIEW_CHOICES.findIndex((choice) => choice.view === rateViewRef.current);
      const step = delta > 0 ? 1 : -1;
      const next =
        RATE_VIEW_CHOICES[(at + step + RATE_VIEW_CHOICES.length) % RATE_VIEW_CHOICES.length]!;
      if (next.view === "eu") {
        playBoardSound("dialEnergy");
      } else {
        playBoardSound("tick");
      }
      changeRateView(next.view);
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, [changeRateView]);
  const [chipMenu, setChipMenu] = useState<
    | {
        x: number;
        y: number;
        resource: ResourceAmount;
        /** Set when the slot accepts several forms: pick one here. */
        picker?: ChipMenuPicker;
      }
    | undefined
  >(undefined);
  // A recipe's own menu (right click on its ground, or a held press).
  const [cardMenu, setCardMenu] = useState<CardMenu | undefined>(undefined);

  // Sounds: open on mount, a page turn on every browse-key change (an item,
  // a refactor, back, forward), close on the close paths. An add closes
  // silently here because the card landing on the board makes its own sound.
  const openedRef = useRef(false);
  useEffect(() => {
    if (!openedRef.current) {
      openedRef.current = true;
      playBoardSound("pageOpen");
      return;
    }
    playBoardSound("pageTurn");
  }, [browseKey]);
  const closeSearch = useCallback(() => {
    playBoardSound("pageClose");
    onClose();
  }, [onClose]);

  // The slot under the pointer: R and U over it ask NEI's two questions.
  const hoverSlotRef = useRef<ResourceAmount | undefined>(undefined);
  const setHoverSlot = useCallback((resource: ResourceAmount | undefined) => {
    hoverSlotRef.current = resource;
  }, []);

  const removeClause = (index: number) => {
    playBoardSound("stencilRemove");
    onClausesChange(clauses.filter((_, at) => at !== index));
  };

  const addResourceClause = useCallback(
    (resource: ResourceAmount, role: RecipeQueryRole) => {
      const already = clauses.some(
        (clause) =>
          clause.role === role && clause.kind === resource.kind && clause.id === resource.id,
      );
      if (!already) {
        playBoardSound("stencilAdd");
        onClausesChange([
          ...clauses,
          {
            role,
            kind: resource.kind,
            id: resource.id,
            displayName: resource.displayName,
            iconPath: resource.iconPath,
            iconAtlas: resource.iconAtlas,
            dominantColor: resource.dominantColor ?? resource.iconAtlas?.dominantColor,
          },
        ]);
      }
    },
    [clauses, onClausesChange],
  );

  // A row dragged onto the other column changes sides; dragged within its own
  // it reorders. Dropping where the same item already sits does nothing.
  const moveClause = useCallback(
    (fromIndex: number, role: RecipeQueryRole, beforeIndex?: number) => {
      const dragged = clauses[fromIndex];
      if (!dragged) {
        return;
      }
      const duplicate = clauses.some(
        (clause, at) =>
          at !== fromIndex &&
          clause.role === role &&
          clause.kind === dragged.kind &&
          clause.id === dragged.id,
      );
      if (duplicate) {
        return;
      }
      const before = beforeIndex !== undefined ? clauses[beforeIndex] : undefined;
      const rest = clauses.filter((_, at) => at !== fromIndex);
      const moved = { ...dragged, role };
      const insertAt = before ? rest.indexOf(before) : -1;
      if (insertAt >= 0) {
        rest.splice(insertAt, 0, moved);
      } else {
        rest.push(moved);
      }
      onClausesChange(rest);
    },
    [clauses, onClausesChange],
  );

  // The condition rows drag by hand, not by the browser's link-ghost: the
  // lifted row rides the pointer as a floating copy while the rows beneath
  // slide apart to show exactly where it would land.
  const [stencilDrag, setStencilDrag] = useState<StencilDrag | undefined>(undefined);
  const stencilDragRef = useRef<StencilDrag | undefined>(undefined);
  useEffect(() => {
    stencilDragRef.current = stencilDrag;
  }, [stencilDrag]);
  const sideListsRef = useRef(new Map<RecipeQueryRole, HTMLDivElement>());
  const registerSideList = useCallback((role: RecipeQueryRole, element: HTMLDivElement | null) => {
    if (element) {
      sideListsRef.current.set(role, element);
    } else {
      sideListsRef.current.delete(role);
    }
  }, []);

  const beginRowDrag = useCallback(
    (index: number, event: ReactPointerEvent<HTMLElement>) => {
      if (event.button !== 0) {
        return;
      }
      const rect = event.currentTarget.getBoundingClientRect();
      const clause = clauses[index];
      if (!clause) {
        return;
      }
      setStencilDrag({
        index,
        width: rect.width,
        pitch: rect.height + 6,
        grabDX: event.clientX - rect.left,
        grabDY: event.clientY - rect.top,
        startX: event.clientX,
        startY: event.clientY,
        x: event.clientX,
        y: event.clientY,
        active: false,
        overRole: clause.role,
        overSlot: 0,
      });
    },
    [clauses],
  );

  const beginChipDrag = useCallback(
    (resource: ResourceAmount, event: ReactPointerEvent<HTMLElement>) => {
      // Mouse only: on a finger a slot's drag is the page's scroll.
      if (event.button !== 0 || event.pointerType !== "mouse") {
        return;
      }
      // The ghost should be a stencil row, so it takes a stencil row's size.
      let pitch = 42;
      let width = 280;
      for (const element of sideListsRef.current.values()) {
        const row = element.firstElementChild;
        if (row) {
          const rect = row.getBoundingClientRect();
          pitch = rect.height + 6;
          width = rect.width;
          break;
        }
      }
      setStencilDrag({
        index: -1,
        source: {
          role: "takes",
          kind: resource.kind,
          id: resource.id,
          displayName: resource.displayName,
          iconPath: resource.iconPath,
          iconAtlas: resource.iconAtlas,
          dominantColor: resource.dominantColor ?? resource.iconAtlas?.dominantColor,
        },
        width,
        pitch,
        grabDX: 18 * getUiScale(),
        grabDY: 18 * getUiScale(),
        startX: event.clientX,
        startY: event.clientY,
        x: event.clientX,
        y: event.clientY,
        active: false,
        overRole: undefined,
        overSlot: 0,
      });
    },
    [],
  );

  useEffect(() => {
    if (!stencilDrag) {
      return;
    }

    const layoutCount = (role: RecipeQueryRole) => {
      const draggedIndex = stencilDragRef.current?.index;
      return clauses.filter((clause, at) => clause.role === role && at !== draggedIndex).length;
    };

    const onMove = (event: globalThis.PointerEvent) => {
      setStencilDrag((drag) => {
        if (!drag) {
          return drag;
        }
        let overRole = drag.source ? undefined : drag.overRole;
        let overSlot = drag.overSlot;
        for (const [role, element] of sideListsRef.current) {
          const rect = element.getBoundingClientRect();
          if (
            event.clientX >= rect.left - 32 &&
            event.clientX <= rect.right + 32 &&
            event.clientY >= rect.top - 32 &&
            event.clientY <= rect.bottom + 32
          ) {
            overRole = role;
            const within = event.clientY - rect.top + element.scrollTop;
            overSlot = Math.max(0, Math.min(layoutCount(role), Math.round(within / drag.pitch)));
          }
        }
        return {
          ...drag,
          x: event.clientX,
          y: event.clientY,
          active:
            drag.active || Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) > 4,
          overRole,
          overSlot,
        };
      });
    };

    const onUp = () => {
      const drag = stencilDragRef.current;
      setStencilDrag(undefined);
      if (!drag?.active) {
        return;
      }
      // The click that closes a real drag is not a click on the slot: swallow
      // the one the browser is about to send, and only that one.
      const swallow = (event: MouseEvent) => {
        event.stopPropagation();
        event.preventDefault();
      };
      window.addEventListener("click", swallow, true);
      window.setTimeout(() => window.removeEventListener("click", swallow, true), 0);
      if (drag.overRole === undefined) {
        return;
      }
      const layoutRows = clauses.filter(
        (clause, at) => clause.role === drag.overRole && at !== drag.index,
      );
      const before = layoutRows[drag.overSlot];
      if (drag.source) {
        const role = drag.overRole;
        const already = clauses.some(
          (clause) =>
            clause.role === role &&
            clause.kind === drag.source!.kind &&
            clause.id === drag.source!.id,
        );
        if (already) {
          return;
        }
        const next = [...clauses];
        const at = before ? clauses.indexOf(before) : -1;
        const landed = { ...drag.source, role };
        if (at >= 0) {
          next.splice(at, 0, landed);
        } else {
          next.push(landed);
        }
        playBoardSound("stencilAdd");
        onClausesChange(next);
        return;
      }
      moveClause(drag.index, drag.overRole, before ? clauses.indexOf(before) : undefined);
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
    // The listeners live for the length of ONE drag, not one pointer frame:
    // keying on the boolean keeps every move from re-wiring the window.
  }, [clauses, moveClause, onClausesChange, stencilDrag !== undefined]);
  // What the ghost shows: the row being moved, or the slot being carried in.
  const liftedClause = stencilDrag ? (stencilDrag.source ?? clauses[stencilDrag.index]) : undefined;

  const addClause = (entry: DatasetResourceIndexEntry, role: RecipeQueryRole) => {
    const already = clauses.some(
      (clause) => clause.role === role && clause.kind === entry.kind && clause.id === entry.id,
    );
    if (!already) {
      onClausesChange([
        ...clauses,
        {
          role,
          kind: entry.kind,
          id: entry.id,
          displayName: entry.displayName,
          iconPath: entry.iconPath,
          iconAtlas: entry.iconAtlas,
          dominantColor: entry.dominantColor ?? entry.iconAtlas?.dominantColor,
        },
      ]);
    }
    setPickerRole(undefined);
  };

  const takesClauses = clauses.filter((clause) => clause.role === "takes");
  const makesClauses = clauses.filter((clause) => clause.role === "makes");

  // Generators are not recipes, but they answer the same questions: a
  // takes/makes condition matches a source's flows under ANY setting, and
  // placing the hit dials those settings in. Purely client-side.
  const isReadOnly = useFactoryStore((state) => state.isReadOnly);
  const addPowerSourceNode = useFactoryStore((state) => state.addPowerSourceNode);
  const refactorNodeToPowerSource = useFactoryStore((state) => state.refactorNodeToPowerSource);
  const gameVersion = useFactoryStore((state) => planGameVersion(state.project));
  const allPowerHits = useMemo(
    () => searchPowerSourcesForStencil(clauses, takesOp, makesOp, query, gameVersion),
    [clauses, takesOp, makesOp, query, gameVersion],
  );
  // The tier filter reads the generators too: a source's unlock chip is its
  // tier, and one above the ceiling is out exactly as a recipe would be. A
  // source with no tier chip is never filtered.
  const powerHits = useMemo(
    () =>
      machinePin
        ? []
        : maxTier === "all"
          ? allPowerHits
          : allPowerHits.filter(
              (hit) => !hit.source.unlock || powerUnlockWithinTier(hit.source.unlock, maxTier),
            ),
    [allPowerHits, machinePin, maxTier],
  );
  // "What takes power" is nearly everything in the pack, so nothing answers
  // it; the empty page explains instead of listing a misleading few.
  const asksWhatTakesPower = clauses.some(
    (clause) => clause.id === POWER_EU_CLAUSE_ID && clause.role === "takes",
  );
  const placePowerHit = useCallback(
    (hit: PowerStencilHit) => {
      if (useFactoryStore.getState().isReadOnly) return;
      // Refactor mode: the pick REPLACES the card the search came from,
      // exactly as a recipe pick does - not a second card beside it.
      const refactorNodeId = useFactoryStore.getState().recipeBrowserRefactorNodeId;
      if (refactorNodeId) {
        refactorNodeToPowerSource(refactorNodeId, hit.source.id, hit.settings);
      } else {
        addPowerSourceNode(hit.source.id, hit.settings);
      }
      onClose();
    },
    [addPowerSourceNode, refactorNodeToPowerSource, onClose],
  );

  // PINNED with an empty stencil and no name typed: nothing is asked yet. The
  // window shows the machine as its one tab and asks for an item instead.
  const pinnedIdle = machinePin !== undefined && clauses.length === 0 && query.trim() === "";

  // ===== the tabs: Generators first when any answer, then a tab per machine =====
  const tabs = useMemo<MachineTab[]>(
    () =>
      pinnedIdle && machinePin
        ? [
            {
              id: PINNED_TAB,
              label: machinePin.label,
              icon: machinePinIcon ? { ...machinePinIcon, amount: 1 } : undefined,
              pinned: true,
            },
          ]
        : [
            ...(powerHits.length > 0
              ? [{ id: GENERATORS_TAB, label: "Generators", count: powerHits.length, generators: true }]
              : []),
            ...recipeMapChips.map((chip) => ({
              id: chip.id,
              label: chip.label,
              count: chip.count,
              icon: chip.icon,
            })),
          ],
    [machinePin, machinePinIcon, pinnedIdle, powerHits.length, recipeMapChips],
  );
  const activeTabId =
    activeTab && tabs.some((tab) => tab.id === activeTab) ? activeTab : tabs[0]?.id;
  const activeIndex = Math.max(
    0,
    tabs.findIndex((tab) => tab.id === activeTabId),
  );
  const active = tabs[activeIndex];
  const onGenerators = active?.generators === true;
  const selectTab = useCallback(
    (id: string) => {
      if (id === activeTabId) {
        return;
      }
      playBoardSound("tick");
      onSelectTab(id);
    },
    [activeTabId, onSelectTab],
  );
  const stepTab = (step: 1 | -1) => {
    if (tabs.length < 2) {
      return;
    }
    const next = tabs[(activeIndex + step + tabs.length) % tabs.length];
    if (next) {
      selectTab(next.id);
    }
  };

  // The tab strip pages as NEI's does: as many tabs as fit, its own < and >.
  const [tabRun, setTabRun] = useState<HTMLDivElement | null>(null);
  const tabRunWidth = useElementSize(tabRun).width;
  const tabsPerPage = Math.max(1, Math.floor((tabRunWidth || TAB * 8) / TAB));
  const tabPageCount = Math.max(1, Math.ceil(tabs.length / tabsPerPage));
  const [tabPageState, setTabPageState] = useState<{ key: string; page: number }>();
  const tabPageKey = `${activeTabId}|${tabsPerPage}|${tabs.length}`;
  const tabPage = Math.min(
    tabPageCount - 1,
    tabPageState?.key === tabPageKey ? tabPageState.page : Math.floor(activeIndex / tabsPerPage),
  );
  const visibleTabs = tabs.slice(tabPage * tabsPerPage, (tabPage + 1) * tabsPerPage);
  const stepTabPage = (step: 1 | -1) => {
    playBoardSound("tick");
    setTabPageState({ key: tabPageKey, page: (tabPage + step + tabPageCount) % tabPageCount });
  };
  const [tabTip, setTabTip] = useState<{ id: string; x: number; y: number }>();
  const tipTab = tabTip ? tabs.find((tab) => tab.id === tabTip.id) : undefined;

  // ===== the open tab's recipes, a page at a time =====
  const tabRecipes = useMemo(
    () =>
      active && !onGenerators ? recipes.filter((recipe) => recipe.recipeMap === active.id) : [],
    [active, onGenerators, recipes],
  );
  const cell = useMemo(
    () => ({
      width: CARD_WIDTH,
      height: onGenerators
        ? cardCellHeight(powerHits.map((hit) => powerCardRows(hit, gameVersion)))
        : cardCellHeight(tabRecipes.map(recipeCardRows)),
    }),
    [onGenerators, powerHits, tabRecipes, gameVersion],
  );
  const [pageEl, setPageEl] = useState<HTMLDivElement | null>(null);
  const area = useElementSize(pageEl);
  const columns = Math.max(1, Math.floor((area.width + CELL_GAP) / (cell.width + CELL_GAP)));
  const rows = Math.max(
    1,
    Math.floor((area.height - PAGE_PAD * 2 + CELL_GAP) / (cell.height + CELL_GAP)),
  );
  const perPage = columns * rows;
  const tabTotal = onGenerators
    ? powerHits.length
    : Math.max(active?.count ?? tabRecipes.length, tabRecipes.length);
  const pageCount = Math.max(1, Math.ceil(tabTotal / perPage));
  const viewKey = [
    browseKey,
    activeTabId,
    clauses.map((clause) => `${clause.role}:${clause.kind}:${clause.id}`).join(","),
    takesOp,
    makesOp,
    query.trim(),
    maxTier,
  ].join("|");
  const [pageState, setPageState] = useState<{ key: string; page: number }>({ key: "", page: 0 });
  const page = Math.min(pageCount - 1, pageState.key === viewKey ? pageState.page : 0);
  const turnPage = useCallback(
    (step: number, wrap: boolean) => {
      if (pageCount < 2) {
        return;
      }
      const raw = page + step;
      const next = wrap ? (raw + pageCount) % pageCount : Math.max(0, Math.min(pageCount - 1, raw));
      if (next !== page) {
        playBoardSound("pageTurn");
        setPageState({ key: viewKey, page: next });
      }
    },
    [page, pageCount, viewKey],
  );
  // A slot that turned away under a still pointer answers no R or U.
  useEffect(() => {
    hoverSlotRef.current = undefined;
  }, [viewKey, page]);
  const pageStart = page * perPage;
  const pageEnd = Math.min(tabTotal, pageStart + perPage);
  const pageRecipes = onGenerators ? [] : tabRecipes.slice(pageStart, pageEnd);
  const pageHits = onGenerators ? powerHits.slice(pageStart, pageEnd) : [];
  const awaited = onGenerators ? 0 : Math.max(0, pageEnd - pageStart - pageRecipes.length);
  // One recipe taller than the page (a narrow window): the page scrolls.
  const overflows = cell.height > area.height - PAGE_PAD * 2 && area.height > 0;

  // The page asks for what it shows: recipes arrive in tab order, so more
  // pages load until this page is full or the server has no more.
  const loadForPage = useEffectEvent(() => {
    if (onGenerators || !active || isLoading || !hasMore) {
      return;
    }
    if (tabRecipes.length < pageEnd) {
      onLoadMore();
    }
  });
  useEffect(() => {
    loadForPage();
  }, [pageEnd, tabRecipes.length, hasMore, isLoading, activeTabId]);

  // The wheel over the page turns it, as NEI's does; a page that scrolls
  // scrolls first and turns at its ends.
  const wheelRef = useRef({ at: 0, sum: 0 });
  const turnPageBy = useEffectEvent((step: number) => turnPage(step, false));
  useEffect(() => {
    if (!pageEl) {
      return;
    }
    const onWheel = (event: WheelEvent) => {
      const delta = event.deltaY || event.deltaX;
      if (!delta) {
        return;
      }
      if (pageEl.scrollHeight > pageEl.clientHeight + 1) {
        const atTop = pageEl.scrollTop <= 0;
        const atBottom = pageEl.scrollTop + pageEl.clientHeight >= pageEl.scrollHeight - 1;
        if ((delta < 0 && !atTop) || (delta > 0 && !atBottom)) {
          return;
        }
      }
      event.preventDefault();
      const now = performance.now();
      const state = wheelRef.current;
      if (now - state.at > 250) {
        state.sum = 0;
      }
      state.sum += delta;
      if (Math.abs(state.sum) < 30 || now - state.at < 140) {
        return;
      }
      state.at = now;
      const step = state.sum > 0 ? 1 : -1;
      state.sum = 0;
      turnPageBy(step);
    };
    pageEl.addEventListener("wheel", onWheel, { passive: false });
    return () => pageEl.removeEventListener("wheel", onWheel);
  }, [pageEl]);

  // The machines that run the open tab's recipes: NEI's catalysts.
  const catalysts = useMemo(() => {
    if (!active || onGenerators) {
      return [];
    }
    const found: CatalystResource[] = [];
    const seen = new Set<string>();
    const push = (resource: CatalystResource | undefined) => {
      if (resource && !seen.has(`${resource.kind}:${resource.id}`)) {
        seen.add(`${resource.kind}:${resource.id}`);
        found.push(resource);
      }
    };
    const first = tabRecipes[0];
    if (first) {
      for (const handler of getRecipeMachineHandlers(summaryToPreviewRecipe(first))) {
        const entry = machineIconEntries.get(handler.id);
        if (entry?.tiers?.length) {
          for (const variant of entry.tiers) push(variant.resource);
        } else {
          push(entry?.resource);
        }
      }
    }
    if (found.length === 0) {
      push(active.icon ?? recipeMapIcons.get(active.id));
    }
    return found;
  }, [active, machineIconEntries, onGenerators, recipeMapIcons, tabRecipes]);
  const [catTip, setCatTip] = useState<{ index: number; x: number; y: number }>();

  // The recipe filter: NEI's magnifier opens a field in the page row.
  const [findOpen, setFindOpen] = useState(() => query.trim() !== "");
  const findRef = useRef<HTMLInputElement | null>(null);
  const showFind = findOpen || query.trim() !== "";

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const inTextField = isEditableKeyboardTarget(event.target);
      // The browser's history keys walk the search's pages, and so does a
      // bare Backspace when it is not deleting text in a box.
      const backKey =
        (event.altKey && event.key === "ArrowLeft") ||
        (event.key === "Backspace" &&
          !inTextField &&
          !event.altKey &&
          !event.ctrlKey &&
          !event.metaKey);
      const forwardKey = event.altKey && event.key === "ArrowRight";
      if (backKey || forwardKey) {
        const allowed = backKey ? canGoBack : canGoForward;
        if (allowed) {
          event.preventDefault();
          (backKey ? onBack : onForward)();
        }
        return;
      }
      if (!inTextField && (event.key === "PageDown" || event.key === "PageUp")) {
        event.preventDefault();
        turnPageBy(event.key === "PageDown" ? 1 : -1);
        return;
      }
      // R and U over a slot, as in NEI.
      const key = event.key.toLowerCase();
      if (
        !inTextField &&
        (key === "r" || key === "u") &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey &&
        !event.shiftKey &&
        hoverSlotRef.current
      ) {
        event.preventDefault();
        onBrowseResource({ ...hoverSlotRef.current, amount: 1 }, key === "r" ? "recipes" : "uses");
        return;
      }
      if (event.key !== "Escape") {
        return;
      }
      if (chipMenu || cardMenu) {
        setChipMenu(undefined);
        setCardMenu(undefined);
        return;
      }
      closeSearch();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    canGoBack,
    canGoForward,
    cardMenu,
    chipMenu,
    closeSearch,
    onBack,
    onBrowseResource,
    onForward,
  ]);

  // Any press outside a menu dismisses it, and so does a wheel turn (the menu
  // is pinned to the screen while its page turns away). CAPTURE phase on
  // purpose: the search's panels stop pointer events from bubbling, so a
  // bubbling listener would never hear presses there. Presses inside the
  // menu are told apart by containment.
  const menuRef = useRef<HTMLDivElement | null>(null);
  useDropdownDismiss(Boolean(chipMenu || cardMenu), {
    refs: [menuRef],
    onClose: () => {
      setChipMenu(undefined);
      setCardMenu(undefined);
    },
    fade: true,
  });

  const openCardMenu = useCallback((event: ReactMouseEvent, menu: Omit<CardMenu, "x" | "y">) => {
    event.preventDefault();
    event.stopPropagation();
    setChipMenu(undefined);
    // Real px -> shell px: the menu is a fixed child of the zoomed root.
    const scale = getUiScale();
    setCardMenu({
      ...menu,
      x: Math.min(event.clientX / scale, window.innerWidth / scale - 270),
      y: Math.min(event.clientY / scale, window.innerHeight / scale - 80),
    });
  }, []);

  const openChipMenu = useCallback(
    (event: ReactMouseEvent, resource: ResourceAmount, picker?: ChipMenuPicker) => {
      event.preventDefault();
      event.stopPropagation();
      // Real px -> shell px: the menu is a fixed child of the zoomed root.
      const scale = getUiScale();
      setChipMenu({
        x: Math.min(event.clientX / scale, window.innerWidth / scale - 270),
        y: Math.min(event.clientY / scale, window.innerHeight / scale - (picker ? 330 : 140)),
        resource,
        picker,
      });
    },
    [],
  );

  const cardHandlers = useMemo<LookupHandlers>(
    () => ({
      onBrowseResource,
      onChipMenu: openChipMenu,
      onChipDragStart: beginChipDrag,
      onHoverSlot: setHoverSlot,
    }),
    [beginChipDrag, onBrowseResource, openChipMenu, setHoverSlot],
  );

  const keyStop = (event: ReactPointerEvent) => event.stopPropagation();

  const closeButton = (
    <button
      type="button"
      aria-label="Close recipe search"
      onClick={closeSearch}
      className="nei-btn nrw-close"
    >
      <X className="h-4 w-4" aria-hidden />
    </button>
  );

  // What the page says when it has no recipes to show.
  const emptyText = unavailable
    ? unavailable
    : queryError
    ? queryError
    : clauses.length === 0 && !query.trim()
      ? machinePin
        ? `Add an item to Takes or Makes. Only recipes the ${machinePin.label} runs will show.`
        : "Add an item to either side of the card below."
      : tabs.length === 0 && !isLoading
        ? asksWhatTakesPower
          ? "Nearly every machine takes power, so that list would be the whole pack. Search for what makes power instead."
          : machinePin
            ? `Nothing the ${machinePin.label} runs matches.`
            : "No matching recipes."
        : undefined;

  const pageLabel = `Page ${tabs.length > 0 ? page + 1 : 0}/${tabs.length > 0 ? pageCount : 0}`;
  const gridStyle = {
    gridTemplateColumns: `repeat(${columns}, ${cell.width}px)`,
    // Rows fit their own cards; a page is still counted by the tallest, so it never runs over.
    gridAutoRows: "auto",
    alignItems: "start",
  };

  // A PORTAL, not a child: on compact this component mounts inside a drawer,
  // and a drawer slides on `translate` - which quietly turns every fixed
  // descendant into a drawer-relative one. Full screen means the body.
  return createPortal(
    <div
      className={[
        // ui-zoom: a body portal is outside the zoomed shell, so the search
        // zooms itself; the viewport it is laid out in is read in shell px.
        "ui-zoom pointer-events-auto fixed inset-0 flex items-center justify-center bg-black/70",
        // On compact it outranks ALL the app chrome: full screen means full screen.
        compact ? "z-[90]" : "z-50",
        sheet ? "" : "px-3 py-2",
      ].join(" ")}
      onPointerDown={closeSearch}
      // The dim starts where the item browser ends: the items column stays
      // bright and clickable beside the search, because the two are one tool.
      style={{ left: sheet ? 0 : layout.leftInset, right: sheet ? 0 : layout.rightInset }}
    >
      {/* The section itself does NOT stop the close: only its solid parts do,
          so the bare corners beside the stencil still read as the backdrop. */}
      <section
        ref={panelRef}
        className="nrw pointer-events-auto relative flex flex-col"
        aria-label="Recipe search"
        style={{
          width: sheet ? "100%" : `min(${layout.width}px, 100%)`,
          height: sheet ? "100%" : `min(${layout.height}px, 100%)`,
          padding: sheet ? "6px 6px 0" : undefined,
        }}
      >
        {/* ===== the machine tabs on the window's top edge ===== */}
        <div className="nrw-tabs" onPointerDown={keyStop}>
          {tabPageCount > 1 ? (
            <button
              type="button"
              className="nei-btn nrw-tab-step"
              aria-label="Previous machines"
              onClick={() => stepTabPage(-1)}
            >
              &lt;
            </button>
          ) : null}
          <div className="nrw-tab-run" ref={setTabRun} role="tablist" aria-label="Machines">
            {visibleTabs.map((tab) => (
              <button
                key={tab.id}
                type="button"
                role="tab"
                className="nrw-tab"
                aria-selected={tab.id === activeTabId}
                aria-label={tab.label}
                data-machine-tab=""
                onClick={() => selectTab(tab.id)}
                onMouseEnter={() => {
                  if (!tab.generators && !tab.pinned) onRecipeMapHover(tab.id);
                }}
                onMouseMove={(event) =>
                  setTabTip({ id: tab.id, x: event.clientX, y: event.clientY })
                }
                onMouseLeave={() => setTabTip(undefined)}
              >
                <span className="nrw-tab-art">
                  {tab.generators ? (
                    <Zap className="h-5 w-5 fill-current text-amber-400" aria-hidden />
                  ) : tab.icon ? (
                    <ResourceIcon
                      resource={{ ...tab.icon, amount: 1 }}
                      size="sm"
                      bare
                      showAmount={false}
                      tooltip={false}
                      className="!h-full !w-full"
                      iconPixelSize={machineArtPixels(28)}
                    />
                  ) : (
                    <Star aria-hidden className="h-4 w-4 text-[#9a9ca4]" />
                  )}
                </span>
              </button>
            ))}
          </div>
          {tabPageCount > 1 ? (
            <button
              type="button"
              className="nei-btn nrw-tab-step"
              aria-label="Next machines"
              onClick={() => stepTabPage(1)}
            >
              &gt;
            </button>
          ) : null}
          {closeButton}
        </div>

        {/* ===== the window ===== */}
        <div className="nrw-panel nrw-window" onPointerDown={keyStop}>
          {/* The machine's name between NEI's two arrows. */}
          <div className="nrw-row">
            {tabs.length > 1 ? (
              <button
                type="button"
                className="nei-btn"
                aria-label="Previous machine"
                onClick={() => stepTab(-1)}
              >
                &lt;
              </button>
            ) : null}
            <div className="nrw-band">
              <span className="nrw-text nrw-title" data-recipe-tab-title="">
                {active?.label ?? machinePin?.label ?? (isLoading ? "" : "No recipes")}
              </span>
            </div>
            {tabs.length > 1 ? (
              <button
                type="button"
                className="nei-btn"
                aria-label="Next machine"
                onClick={() => stepTab(1)}
              >
                &gt;
              </button>
            ) : null}
          </div>

          {/* The page between its two arrows, and the recipe filter. */}
          <div className="nrw-row">
            <button
              type="button"
              className="nei-btn"
              aria-label="Previous page"
              disabled={pageCount < 2}
              onClick={() => turnPage(-1, true)}
            >
              &lt;
            </button>
            <button
              type="button"
              className="nei-btn"
              aria-label="Filter recipes by name"
              aria-pressed={showFind}
              data-on={showFind ? "" : undefined}
              style={{ marginLeft: 2 }}
              onClick={() => {
                if (showFind) {
                  onQueryChange("");
                  setFindOpen(false);
                } else {
                  setFindOpen(true);
                  window.requestAnimationFrame(() => findRef.current?.focus());
                }
              }}
            >
              <Search className="h-3 w-3" aria-hidden />
            </button>
            {showFind ? (
              <>
                <label className="nrw-find">
                  <input
                    ref={findRef}
                    value={query}
                    onChange={(event) => onQueryChange(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Escape" && query) {
                        event.stopPropagation();
                        onQueryChange("");
                      }
                    }}
                    placeholder="Filter by name..."
                    aria-label="Filter recipes by name"
                  />
                </label>
                <span className="nrw-text nrw-find-page">
                  {tabs.length > 0 ? `${page + 1}/${pageCount}` : "0/0"}
                </span>
              </>
            ) : (
              <div className="nrw-band">
                <span className="nrw-text">{pageLabel}</span>
              </div>
            )}
            <button
              type="button"
              className="nei-btn"
              aria-label="Next page"
              disabled={pageCount < 2}
              onClick={() => turnPage(1, true)}
            >
              &gt;
            </button>
          </div>

          {/* ===== the body: the machines that run the open tab, then the page ===== */}
          <div className="nrw-body">
            {!sheet ? (
              <div
                className="nrw-machines recipe-search-scroll"
                aria-label="Machines that run these recipes"
              >
                {catalysts.map((resource, index) => (
                  <button
                    key={`${resource.kind}:${resource.id}`}
                    type="button"
                    className="nrw-catalyst"
                    aria-label={resource.displayName ?? resource.id}
                    onClick={() =>
                      onBrowseResource({ ...resource, amount: 1 } as ResourceAmount, "recipes")
                    }
                    onContextMenu={(event) => {
                      event.preventDefault();
                      onBrowseResource({ ...resource, amount: 1 } as ResourceAmount, "uses");
                    }}
                    onMouseEnter={() => setHoverSlot({ ...resource, amount: 1 } as ResourceAmount)}
                    onMouseMove={(event) =>
                      setCatTip(
                        event.buttons === 0
                          ? { index, x: event.clientX, y: event.clientY }
                          : undefined,
                      )
                    }
                    onMouseLeave={() => {
                      setHoverSlot(undefined);
                      setCatTip(undefined);
                    }}
                  >
                    <span className="nrw-art">
                      <ResourceIcon
                        resource={{ ...resource, amount: 1 } as ResourceAmount}
                        size="sm"
                        bare
                        showAmount={false}
                        tooltip={false}
                        className="!h-full !w-full"
                        iconPixelSize={machineArtPixels(28)}
                      />
                    </span>
                  </button>
                ))}
              </div>
            ) : null}
            <div
              ref={setPageEl}
              className="nrw-page recipe-search-scroll"
              data-recipe-page=""
              data-overflow={overflows ? "" : undefined}
              style={{ padding: `${PAGE_PAD}px 0` }}
            >
              {emptyText ? (
                <div className="nrw-empty">
                  <span>{emptyText}</span>
                </div>
              ) : tabs.length === 0 ? (
                <div
                  className="nrw-grid"
                  style={gridStyle}
                  role="status"
                  aria-label="Loading recipes"
                >
                  {Array.from({ length: Math.min(perPage, 12) }, (_, index) => (
                    <LookupSkeletonCard key={index} delay={index * 110} />
                  ))}
                </div>
              ) : onGenerators ? (
                <div className="nrw-grid" style={gridStyle}>
                  {pageHits.map((hit) => (
                    <LookupPowerCard
                      key={`${hit.source.id}|${JSON.stringify(hit.settings ?? {})}`}
                      hit={hit}
                      rateView={rateView}
                      onPlace={() => placePowerHit(hit)}
                      handlers={cardHandlers}
                      onCardMenu={(event) =>
                        openCardMenu(event, {
                          label: hit.source.name,
                          add: () => placePowerHit(hit),
                        })
                      }
                    />
                  ))}
                </div>
              ) : (
                <div className="nrw-grid" style={gridStyle}>
                  {pageRecipes.map((recipe) => (
                    <LookupRecipeCard
                      key={recipe.id}
                      recipe={recipe}
                      contextResource={contextResource}
                      onSelectRecipe={onSelectRecipe}
                      onAdd={onAdd}
                      onPrefetch={onPrefetch}
                      handlers={cardHandlers}
                      rateView={rateView}
                      onCardMenu={(event, add) =>
                        openCardMenu(event, {
                          label: recipe.name,
                          add,
                        })
                      }
                    />
                  ))}
                  {awaited > 0 ? (
                    <div
                      className="contents"
                      role="status"
                      aria-label={`Loading ${active?.label ?? ""} recipes`}
                    >
                      {Array.from({ length: awaited }, (_, index) => (
                        <LookupSkeletonCard key={index} delay={index * 110} />
                      ))}
                    </div>
                  ) : null}
                </div>
              )}
            </div>
          </div>

          {/* ===== the foot: back and forward, how amounts read, the tier ceiling ===== */}
          <div className="nrw-foot">
            <button
              type="button"
              className="nei-btn"
              onClick={onBack}
              disabled={!canGoBack}
              aria-label="Back to the previous search"
            >
              <ChevronLeft className="h-3.5 w-3.5" aria-hidden />
            </button>
            <button
              type="button"
              className="nei-btn"
              onClick={onForward}
              disabled={!canGoForward}
              aria-label="Forward to the next search"
            >
              <ChevronRight className="h-3.5 w-3.5" aria-hidden />
            </button>
            <div ref={ratePillsRef} className="nrw-seg" role="group" aria-label="How amounts read">
              {RATE_VIEW_CHOICES.map((choice) => (
                <button
                  key={choice.view}
                  type="button"
                  className="nei-btn"
                  title={choice.title}
                  aria-pressed={rateView === choice.view}
                  data-gold={choice.view === "eu" ? "" : undefined}
                  onClick={() => {
                    if (choice.view === "eu" && rateView !== "eu") {
                      playBoardSound("dialEnergy");
                    } else if (choice.view !== rateView) {
                      playBoardSound("tick");
                    }
                    changeRateView(choice.view);
                  }}
                >
                  {choice.label}
                </button>
              ))}
            </div>
            <div className="nrw-tier">
              <ModPick
                value={maxTier}
                onChange={(tier) => {
                  playBoardSound("tick");
                  onMaxTierChange(tier);
                }}
                label="Maximum machine tier"
                options={[
                  { value: "all" as TierFilter, label: "All tiers" },
                  ...GT_VOLTAGE_TIERS.map((entry) => ({
                    value: entry.tier as TierFilter,
                    label: `≤ ${entry.tier}`,
                  })),
                ]}
              />
            </div>
          </div>
        </div>

        {/* ===== the stencil: its own card under the window ===== */}
        <div className="flex shrink-0 justify-center pt-3 compact:pb-2 compact:pt-2">
          <div
            className="nrw-panel nrw-stencil relative w-full max-w-[880px]"
            onPointerDown={keyStop}
          >
            <div className="flex items-stretch gap-2 compact:gap-1">
              {machinePin ? (
                /* THE MACHINE PIN: the search came from a card's "Add another
                   recipe", so only that machine's recipes show and a pick
                   joins its card. Its picture, its name, one word, and the
                   unpin key; closing the search ends it too. */
                <div className="nrw-pin compact:!w-[104px]" data-machine-pin="">
                  {onClearPin ? (
                    <button
                      type="button"
                      className="nei-btn nrw-pin-clear"
                      onClick={() => {
                        playBoardSound("stencilRemove");
                        onClearPin();
                      }}
                      aria-label={`Unpin the ${machinePin.label}`}
                      title="Unpin: every machine's recipes show and a pick makes a new card"
                    >
                      <X className="h-3 w-3" aria-hidden />
                    </button>
                  ) : null}
                  <span className="flex h-12 w-12 items-center justify-center">
                    {machinePinIcon ? (
                      <ResourceIcon
                        resource={{ ...machinePinIcon, amount: 1 }}
                        size="sm"
                        bare
                        showAmount={false}
                        tooltip={false}
                        className="!h-12 !w-12"
                        iconPixelSize={machineArtPixels(48)}
                      />
                    ) : null}
                  </span>
                  <span className="nrw-text w-full truncate text-[13px]">{machinePin.label}</span>
                  <span className="text-[11px] uppercase text-[#9a9ca4]">Pinned</span>
                </div>
              ) : null}
              <StencilSide
                label="Takes"
                role="takes"
                sideClauses={takesClauses}
                clauses={clauses}
                op={takesOp}
                onOpChange={onTakesOpChange}
                onRemove={removeClause}
                drag={stencilDrag}
                onRowPointerDown={beginRowDrag}
                registerListRef={registerSideList}
                onOpenPicker={() => setPickerRole(pickerRole === "takes" ? undefined : "takes")}
              />
              <button
                type="button"
                onClick={() => {
                  playBoardSound("tick");
                  onSwapSides();
                }}
                aria-label="Swap the takes and makes sides"
                className="nrw-swap compact:!w-9"
              >
                <ProgressArrow className="nrw-swap-rest" />
                <ArrowLeftRight aria-hidden className="nrw-swap-hover h-6 w-6" />
              </button>
              <StencilSide
                label="Makes"
                role="makes"
                sideClauses={makesClauses}
                clauses={clauses}
                op={makesOp}
                onOpChange={onMakesOpChange}
                onRemove={removeClause}
                drag={stencilDrag}
                onRowPointerDown={beginRowDrag}
                registerListRef={registerSideList}
                onOpenPicker={() => setPickerRole(pickerRole === "makes" ? undefined : "makes")}
              />
            </div>
            {pickerRole ? (
              <ItemPickerPopover
                role={pickerRole}
                onPick={(entry, role) => {
                  playBoardSound("stencilAdd");
                  addClause(entry, role);
                }}
                onClose={() => setPickerRole(undefined)}
                searchPickerResources={searchPickerResources}
              />
            ) : null}
          </div>
        </div>

        {/* ===== the lifted condition, riding the pointer ===== */}
        {stencilDrag?.active && liftedClause ? (
          <div
            className="pointer-events-none fixed z-[60]"
            // The drag is tracked in real px; this box is a fixed child of
            // the zoomed root, so it is placed in shell px.
            style={{
              left: (stencilDrag.x - stencilDrag.grabDX) / uiScale,
              top: (stencilDrag.y - stencilDrag.grabDY) / uiScale,
              width: stencilDrag.width / uiScale,
            }}
          >
            <span className="nrw-cond" data-lifted="">
              <ConditionSlot clause={liftedClause} />
              <span className="nrw-text nrw-cond-name">
                {liftedClause.displayName ?? liftedClause.id}
              </span>
            </span>
          </div>
        ) : null}

        {/* ===== a recipe's menu ===== */}
        {cardMenu ? (
          <div
            ref={menuRef}
            className="nrw-panel nrw-menu"
            style={{ left: cardMenu.x, top: cardMenu.y }}
            onPointerDown={keyStop}
          >
            <div className="nrw-menu-head">{cardMenu.label}</div>
            {!isReadOnly ? (
              <button
                type="button"
                className="nrw-menu-item"
                onClick={() => {
                  cardMenu.add();
                  setCardMenu(undefined);
                }}
              >
                {machinePin ? "Add to the card" : "Add to board"}
              </button>
            ) : (
              <div className="nrw-menu-head">Open a copy to add recipes</div>
            )}
          </div>
        ) : null}
        {/* ===== a slot's menu: every way to use an item ===== */}
        {chipMenu ? (
          <div
            ref={menuRef}
            className="nrw-panel nrw-menu"
            style={{ left: chipMenu.x, top: chipMenu.y }}
            onPointerDown={keyStop}
          >
            <div className="nrw-menu-head">{resourceLabel(chipMenu.resource)}</div>
            {(
              [
                {
                  label: "Find what makes it",
                  act: () => onBrowseResource({ ...chipMenu.resource, amount: 1 }, "recipes"),
                },
                {
                  label: "Find what uses it",
                  act: () => onBrowseResource({ ...chipMenu.resource, amount: 1 }, "uses"),
                },
                {
                  label: "Add to takes",
                  act: () => addResourceClause(chipMenu.resource, "takes"),
                },
                {
                  label: "Add to makes",
                  act: () => addResourceClause(chipMenu.resource, "makes"),
                },
              ] as const
            ).map((item) => (
              <button
                key={item.label}
                type="button"
                className="nrw-menu-item"
                onClick={() => {
                  item.act();
                  setChipMenu(undefined);
                }}
              >
                {item.label}
              </button>
            ))}
            {chipMenu.picker ? (
              <>
                <div className="nrw-menu-rule" />
                <div className="nrw-menu-head">This slot also takes</div>
                <div className="recipe-search-scroll max-h-[180px] overflow-y-auto">
                  {chipMenu.picker.faces.map((face) => (
                    <button
                      key={`${face.kind}:${face.id}`}
                      type="button"
                      className="nrw-menu-item"
                      aria-current={face.id === chipMenu.picker?.currentId ? "true" : undefined}
                      onClick={() => {
                        chipMenu.picker?.onPick(face);
                        setChipMenu(undefined);
                      }}
                    >
                      <span className="flex h-6 w-6 shrink-0 items-center justify-center overflow-hidden">
                        <ResourceIcon
                          resource={{ ...face, amount: 1 }}
                          size="sm"
                          bare
                          showAmount={false}
                          tooltip={false}
                          className="!h-full !w-full"
                          iconPixelSize={machineArtPixels(24)}
                        />
                      </span>
                      <span className="min-w-0 flex-1 truncate">{face.displayName ?? face.id}</span>
                      {/* Three faces all called "Iron Nugget" are three
                          mods' nuggets: say which, or the list is useless. */}
                      {face.modId ? (
                        <span className="shrink-0 text-[11px] text-[#9a9ca4]">{face.modId}</span>
                      ) : null}
                    </button>
                  ))}
                </div>
              </>
            ) : null}
          </div>
        ) : null}

        {tabTip && tipTab ? (
          <McFloatingTip
            x={tabTip.x}
            y={tabTip.y}
            lines={[
              { text: tipTab.label, tone: "name" },
              ...(tipTab.count !== undefined
                ? [
                    {
                      text: `${tipTab.count.toLocaleString()} ${tipTab.count === 1 ? "recipe" : "recipes"}`,
                    },
                  ]
                : []),
            ]}
          />
        ) : null}
        {catTip && catalysts[catTip.index] ? (
          <McFloatingTip
            x={catTip.x}
            y={catTip.y}
            lines={itemTipLines({
              name: catalysts[catTip.index]!.displayName ?? catalysts[catTip.index]!.id,
              id: catalysts[catTip.index]!.id,
            })}
          />
        ) : null}
      </section>
    </div>,
    document.body,
  );
}

type CatalystResource = Pick<
  ResourceAmount,
  "kind" | "id" | "displayName" | "iconPath" | "iconAtlas" | "dominantColor"
>;

/** A side size and its observer, in the element's own (shell) px. */
function useElementSize(element: HTMLElement | null): { width: number; height: number } {
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    if (!element) {
      return;
    }
    const read = () => {
      const width = element.clientWidth;
      const height = element.clientHeight;
      setSize((current) =>
        current.width === width && current.height === height ? current : { width, height },
      );
    };
    read();
    const observer = new ResizeObserver(read);
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);
  return size;
}

/** NEI's progress arrow, in the window's grey. */
function ProgressArrow({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 22 15"
      width="33"
      height="22"
      className={className}
      fill="currentColor"
    >
      <path d="M0 5h13V0l9 7.5-9 7.5v-5H0z" />
    </svg>
  );
}

/**
 * One column of the stencil card: the side's name in NEI's band with the
 * ANY / ALL / ONLY keys, the condition rows, then the empty slot that adds one.
 * The stack scrolls inside a FIXED height, so removing a condition never moves
 * the card and the next X stays under the pointer. While a row is dragged this
 * column hides it and the rows below the landing spot slide down to make room.
 */
function StencilSide({
  label,
  role,
  sideClauses,
  clauses,
  op,
  onOpChange,
  onRemove,
  drag,
  onRowPointerDown,
  registerListRef,
  onOpenPicker,
}: {
  label: string;
  role: RecipeQueryRole;
  sideClauses: StencilClause[];
  clauses: StencilClause[];
  op: RecipeQuerySideOp;
  onOpChange: (op: RecipeQuerySideOp) => void;
  onRemove: (index: number) => void;
  drag?: StencilDrag;
  onRowPointerDown: (index: number, event: ReactPointerEvent<HTMLElement>) => void;
  registerListRef: (role: RecipeQueryRole, element: HTMLDivElement | null) => void;
  onOpenPicker: () => void;
}) {
  const dragActive = drag?.active ?? false;
  const layoutClauses = dragActive
    ? sideClauses.filter((clause) => clauses.indexOf(clause) !== drag?.index)
    : sideClauses;
  const gapAt = dragActive && drag?.overRole === role ? drag.overSlot : undefined;
  const pitch = drag?.pitch ?? 42;
  const changeOp = (next: RecipeQuerySideOp) => {
    if (next !== op) {
      playBoardSound("tick");
    }
    onOpChange(next);
  };

  return (
    <div className="nrw-stencil-side">
      <div className="nrw-stencil-head">
        <div className="nrw-band">
          <span className="nrw-text">{label}</span>
        </div>
        <div className="nrw-seg" role="group" aria-label={`${label}: how its items combine`}>
          {(
            [
              ["any", "Any"],
              ["all", "All"],
              ["only", "Only"],
            ] as const
          ).map(([value, text]) => (
            <button
              key={value}
              type="button"
              className="nei-btn"
              aria-pressed={op === value}
              onClick={() => changeOp(value)}
            >
              {text}
            </button>
          ))}
        </div>
      </div>
      {/* A fixed-height stack so removing a row never moves the card. */}
      <div
        ref={(element) => registerListRef(role, element)}
        className="recipe-search-scroll flex h-[84px] flex-col gap-1.5 overflow-y-auto pr-1 compact:h-[124px]"
      >
        {layoutClauses.map((clause, slot) => {
          const index = clauses.indexOf(clause);
          const shifted = gapAt !== undefined && slot >= gapAt;
          return (
            <span
              key={`${clause.role}:${clause.kind}:${clause.id}`}
              onPointerDown={(event) => onRowPointerDown(index, event)}
              style={{ transform: shifted ? `translateY(${pitch}px)` : undefined }}
              className="nrw-cond"
            >
              <ConditionSlot clause={clause} />
              <span className="nrw-text nrw-cond-name compact:whitespace-normal compact:text-[12px] compact:leading-tight">
                {clause.displayName ?? clause.id}
              </span>
              <button
                type="button"
                className="nei-btn"
                onPointerDown={(event) => event.stopPropagation()}
                onClick={() => onRemove(index)}
                aria-label={`Remove ${clause.displayName ?? clause.id} from the search`}
              >
                <X className="h-3 w-3" aria-hidden />
              </button>
            </span>
          );
        })}
        <button
          type="button"
          onClick={onOpenPicker}
          aria-label={
            role === "takes" ? "Add an input to the search" : "Add an output to the search"
          }
          style={{ transform: gapAt !== undefined ? `translateY(${pitch}px)` : undefined }}
          className="nrw-add-cond"
        >
          <span className="nrw-slot" data-empty="">
            <Plus className="h-4 w-4" aria-hidden />
          </span>
          <span className="nrw-text text-[13px] !text-inherit" style={{ textShadow: "none" }}>
            {role === "takes" ? "Input" : "Output"}
          </span>
        </button>
      </div>
    </div>
  );
}

/** A condition's item in its slot. */
function ConditionSlot({ clause }: { clause: StencilClause }) {
  return (
    <span className="nrw-slot" data-empty="">
      <span className="nrw-art">
        {clause.id === POWER_EU_CLAUSE_ID ? (
          <Zap className="h-4 w-4 fill-current text-amber-300" aria-hidden />
        ) : (
          <SlotArt resource={{ ...clause, amount: 1 }} />
        )}
      </span>
    </span>
  );
}

/** An item's or fluid's art at a slot's size, sized as the items column sizes it. */
function SlotArt({ resource }: { resource: ResourceAmount }) {
  return (
    <ResourceIcon
      itemZoom={1.5}
      resource={{ ...resource, amount: 1, chance: undefined }}
      size="sm"
      bare
      showAmount={false}
      showConsumedState={false}
      tooltip={false}
      iconPixelSize={
        resource.kind === "fluid" ? (isSwatchFluid(resource) ? 36 : spriteArtPixels(28)) : undefined
      }
      className="!h-full !w-full"
    />
  );
}

/** A generator's unlock chip sits at or under the tier ceiling. */
function powerUnlockWithinTier(unlock: string, maxTier: Exclude<TierFilter, "all">): boolean {
  const known = GT_VOLTAGE_TIERS.some((entry) => entry.tier === unlock);
  if (!known) {
    return true;
  }
  return (
    getVoltageTierIndex(unlock as Exclude<MachineTier, "DEMO">) <= getVoltageTierIndex(maxTier)
  );
}

interface CardMenu {
  x: number;
  y: number;
  /** The recipe's name, as the menu's heading. */
  label: string;
  add: () => void;
}

/**
 * The search covers everything beside the item browser. The items column
 * stays live because it seeds queries; the overview is only readouts, so the
 * search covers it.
 */
const BOARD_SIDEBAR_LEFT = 306;
const RECIPE_SEARCH_MIN_WIDTH = 640;
const RECIPE_SEARCH_MAX_WIDTH = 900;
const RECIPE_SEARCH_MAX_HEIGHT = 800;
const RECIPE_SEARCH_SHEET_BELOW = 700;

interface RecipeSearchViewport {
  /** Filling the screen rather than floating over the board. */
  sheet: boolean;
  /** Where the search begins: the item browser keeps everything left of it. */
  leftInset: number;
  /** Plan boards seat the items on the right: the search stops short of them. */
  rightInset: number;
  width: number;
  height: number;
}

function measureLeftSidebar(scale: number): number {
  if (typeof document === "undefined") {
    return BOARD_SIDEBAR_LEFT;
  }
  const element = document.querySelector('aside[data-help-anchor="browser"]');
  // Real px -> shell px.
  return element ? Math.round(element.getBoundingClientRect().width / scale) : BOARD_SIDEBAR_LEFT;
}

/** In SHELL px: the search draws zoomed, so the window is measured in its units. */
function readRecipeSearchViewport(): RecipeSearchViewport {
  if (typeof window === "undefined") {
    return { sheet: false, leftInset: BOARD_SIDEBAR_LEFT, rightInset: 0, width: 960, height: 760 };
  }

  const scale = getUiScale();
  const viewportWidth = window.innerWidth / scale;
  const viewportHeight = window.innerHeight / scale;

  // Too narrow to be a window at all: fill the screen instead of leaving a
  // panel that is mostly margin. The item browser is a drawer here anyway.
  if (viewportWidth < RECIPE_SEARCH_SHEET_BELOW) {
    return {
      sheet: true,
      leftInset: 0,
      rightInset: 0,
      width: viewportWidth,
      height: viewportHeight,
    };
  }

  const { left: leftInset, right: rightInset } = overlayInsets(scale, () =>
    measureLeftSidebar(scale),
  );
  return {
    sheet: false,
    leftInset,
    rightInset,
    width: Math.min(
      RECIPE_SEARCH_MAX_WIDTH,
      Math.max(RECIPE_SEARCH_MIN_WIDTH, viewportWidth - leftInset - rightInset - 96),
    ),
    height: Math.min(RECIPE_SEARCH_MAX_HEIGHT, Math.max(360, viewportHeight - 96)),
  };
}

function useRecipeSearchViewport(): RecipeSearchViewport {
  const [viewport, setViewport] = useState(readRecipeSearchViewport);

  useEffect(() => {
    const update = () => setViewport(readRecipeSearchViewport());

    window.addEventListener("resize", update);
    // Collapsing the item browser is not a window resize, and the search
    // should take the room it gives back.
    const observer = new ResizeObserver(update);
    const element = document.querySelector('aside[data-help-anchor="browser"]');
    if (element) {
      observer.observe(element);
    }

    return () => {
      window.removeEventListener("resize", update);
      observer.disconnect();
    };
  }, []);

  return viewport;
}
