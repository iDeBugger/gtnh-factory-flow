import { useSyncExternalStore } from "react";

/**
 * The rail's own taste, kept per device (not part of any plan): whether it is
 * open or folded to its strip, and which sections are folded. Same mechanism
 * as `workspace-view.ts`: localStorage outside any store, read through
 * `useSyncExternalStore` so the server renders the defaults.
 */
export interface RailView {
  open: boolean;
  /** Folded section titles (`INPUTS`, `OUTPUTS`, `INTERNAL`, `MACHINES`). */
  folded: string[];
}

export const RAIL_VIEW_STORAGE_KEY = "gtnh-factory-flow-overview-rail";

/** The mod opens with INTERNAL folded: what a plan makes and uses itself is the section least looked at. */
export const DEFAULT_FOLDED = ["INTERNAL"];
export const DEFAULT_RAIL_VIEW: RailView = { open: true, folded: DEFAULT_FOLDED };

let current: RailView | undefined;
const listeners = new Set<() => void>();

function parse(raw: string | null): RailView {
  if (!raw) return DEFAULT_RAIL_VIEW;
  try {
    const value = JSON.parse(raw) as Partial<RailView>;
    return {
      open: value.open !== false,
      folded: Array.isArray(value.folded)
        ? value.folded.filter((x): x is string => typeof x === "string")
        : DEFAULT_FOLDED,
    };
  } catch {
    return DEFAULT_RAIL_VIEW;
  }
}

function getSnapshot(): RailView {
  if (current === undefined) {
    try {
      current = parse(window.localStorage.getItem(RAIL_VIEW_STORAGE_KEY));
    } catch {
      current = DEFAULT_RAIL_VIEW;
    }
  }
  return current;
}

function getServerSnapshot(): RailView {
  return DEFAULT_RAIL_VIEW;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function writeRailView(patch: Partial<RailView>): void {
  current = { ...getSnapshot(), ...patch };
  try {
    window.localStorage.setItem(RAIL_VIEW_STORAGE_KEY, JSON.stringify(current));
  } catch {
    // Blocked storage costs the next visit its place, nothing more.
  }
  for (const listener of listeners) listener();
}

export function useRailView(): RailView {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/** Forget what was read (tests). */
export function resetRailViewForTests(): void {
  current = undefined;
}

export function toggleRailSection(title: string): void {
  const folded = new Set(getSnapshot().folded);
  if (!folded.delete(title)) folded.add(title);
  writeRailView({ folded: [...folded] });
}
