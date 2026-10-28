import { useSyncExternalStore } from "react";
import {
  DEFAULT_CANVAS_THEME_ID,
  isCanvasThemeId,
  type CanvasThemeId,
} from "./canvas-themes";

/**
 * Board view settings: how the canvas looks.
 *
 * This module holds the LIVE settings the board is drawing with, in
 * localStorage and outside the Zustand store so they can be read without an
 * effect. They belong to the factory, not to global taste: a snapshot goes
 * into every design as it is saved and comes back when you switch to it
 * (`plan-view.ts`, and `showProject` in the design store), the same snapshot
 * a shared setup carries. Switching tabs therefore rewrites what is here.
 * The columns and the resource marks deliberately do NOT work this way; see
 * PlanViewScope.
 *
 * Read through useSyncExternalStore: localStorage does not exist during SSR,
 * so the server renders the defaults and the browser swaps in saved values
 * on hydration, which neither mismatches the server HTML nor sets state
 * from inside an effect.
 */
export type CanvasPattern = "dots" | "lines" | "cross" | "ruled" | "graph" | "none";

export const CANVAS_PATTERN_LABEL: Record<CanvasPattern, string> = {
  dots: "Dots",
  lines: "Grid lines",
  cross: "Crosses",
  ruled: "Ruled lines",
  graph: "Graph paper",
  none: "Blank",
};

export const CANVAS_PATTERNS: CanvasPattern[] = [
  "dots",
  "lines",
  "cross",
  // Paper rulings, same selector as the dots: they are marks on the board,
  // drawn in board space, so they pan and zoom with the factory and never
  // stack on top of another pattern.
  "ruled",
  "graph",
  "none",
];

/**
 * What a zoomed-out card leads with: `identity` (the machine icon with its count and name) on the board. The image
 * export borrows the others for one capture (its Cards choice): `status` colours cards and lines by how hard they run,
 * `usage` by their reason word, `power` by voltage tier.
 */
export type GlanceMode = "identity" | "status" | "usage" | "power";

export interface BoardView {
  // No `snapToGrid`: cards are sized in grid cells, so snapping is always on,
  // not a setting.
  canvasPattern: CanvasPattern;
  /** The paper the board is drawn on; see canvas-themes.ts. */
  canvasTheme: CanvasThemeId;
  /**
   * Every status colour steps down to neutral steel. SESSION ONLY, like `glanceMode`: the image export sets both for
   * one capture and puts them back in a `finally`, which never runs if the tab closes mid-export, and the board has
   * no switch for either, so neither is read from storage or written to it.
   */
  calmMode: boolean;
  /** What the glance (zoomed-out) view shows. See GlanceMode. */
  glanceMode: GlanceMode;
}

const BOARD_VIEW_STORAGE_KEY = "gtnh-factory-flow-board-view";

export const DEFAULT_BOARD_VIEW: BoardView = {
  canvasPattern: "dots",
  canvasTheme: DEFAULT_CANVAS_THEME_ID,
  calmMode: false,
  glanceMode: "identity",
};

let boardViewState: BoardView = DEFAULT_BOARD_VIEW;
let boardViewLoaded = false;
const listeners = new Set<() => void>();

function readBoardView(): BoardView {
  try {
    const raw = window.localStorage.getItem(BOARD_VIEW_STORAGE_KEY);
    if (!raw) {
      return DEFAULT_BOARD_VIEW;
    }
    // Keys a stored blob carries beyond these are ignored, and the next write drops them.
    const parsed = JSON.parse(raw) as Partial<Record<keyof BoardView, unknown>>;
    return {
      ...DEFAULT_BOARD_VIEW,
      canvasPattern: CANVAS_PATTERNS.includes(parsed.canvasPattern as CanvasPattern)
        ? (parsed.canvasPattern as CanvasPattern)
        : DEFAULT_BOARD_VIEW.canvasPattern,
      canvasTheme: isCanvasThemeId(parsed.canvasTheme)
        ? parsed.canvasTheme
        : DEFAULT_BOARD_VIEW.canvasTheme,
    };
  } catch {
    // Corrupt or unreadable storage is not worth breaking the board over.
    return DEFAULT_BOARD_VIEW;
  }
}

export function subscribeBoardView(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// Identity is stable between writes, which is what useSyncExternalStore needs
// to avoid an infinite render loop.
function getSnapshot(): BoardView {
  if (!boardViewLoaded) {
    boardViewLoaded = true;
    boardViewState = readBoardView();
  }
  return boardViewState;
}

function getServerSnapshot(): BoardView {
  return DEFAULT_BOARD_VIEW;
}

export function writeBoardView(patch: Partial<BoardView>) {
  boardViewState = { ...getSnapshot(), ...patch };
  try {
    // The session-only settings are stripped on the way out (see BoardView.calmMode).
    const { calmMode: _calm, glanceMode: _glance, ...stored } = boardViewState;
    void _calm;
    void _glance;
    window.localStorage.setItem(BOARD_VIEW_STORAGE_KEY, JSON.stringify(stored));
  } catch {
    // A full or blocked storage quota must never break the board.
  }
  for (const listener of listeners) {
    listener();
  }
}

export function useBoardView(): BoardView {
  return useSyncExternalStore(subscribeBoardView, getSnapshot, getServerSnapshot);
}

/** The same value the hook returns, for callers outside React. */
export function readBoardViewSnapshot(): BoardView {
  return getSnapshot();
}
