import { useSyncExternalStore } from "react";

/**
 * Where the tour is. `phase` is "playing" while a step acts something out, "waiting" once its note is up and the
 * tour waits for the player, "idle" when no tour runs. The offer's "asked once" flag lives in localStorage.
 */
export type TourPhase = "idle" | "playing" | "waiting";

export interface TourState {
  phase: TourPhase;
  /** The step being played or shown (0-based). */
  index: number;
  /** The script's length, for the last step's tick. */
  total: number;
  /** The step's note, once its actions are done. */
  noteReady: boolean;
}

const IDLE: TourState = { phase: "idle", index: 0, total: 0, noteReady: false };
let state: TourState = IDLE;
const listeners = new Set<() => void>();

export function getTour(): TourState {
  return state;
}

export function setTour(patch: Partial<TourState>): void {
  const next = { ...state, ...patch };
  if (next.phase === state.phase && next.index === state.index && next.total === state.total && next.noteReady === state.noteReady) {
    return;
  }
  state = next;
  for (const listener of listeners) listener();
}

export function resetTour(): void {
  state = IDLE;
  for (const listener of listeners) listener();
}

export function useTour(): TourState {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getTour,
    () => IDLE,
  );
}

const OFFERED_KEY = "gtnhplanner.tour.offered";

/** Whether the first-run offer was answered (either way puts it away for good). */
export function tourOffered(): boolean {
  try {
    return window.localStorage.getItem(OFFERED_KEY) === "1";
  } catch {
    return true;
  }
}

export function markTourOffered(): void {
  try {
    window.localStorage.setItem(OFFERED_KEY, "1");
  } catch {
    // Without storage it asks again next visit, which is the safe way round.
  }
}
