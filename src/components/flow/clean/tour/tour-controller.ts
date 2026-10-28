import { useSyncExternalStore } from "react";
import { isCompactViewport } from "@/lib/compact-view";
import { Cursor, draws } from "./cursor";
import { Director, tourWarnings, type NoteSpec } from "./director";
import { resetPointerState } from "./input";
import { enterSandbox, leaveSandbox } from "./sandbox";
import { tourSteps } from "./script";
import { getTour, markTourOffered, resetTour, setTour } from "./tour-store";

/**
 * The tour's one running instance: the sandbox, the cursor, the director. `startTour` is what the ? key's
 * "Take the tour" and the first-run offer call; `TourHost` provides the layer the cursor draws into.
 */

let layer: HTMLElement | undefined;
let cursor: Cursor | undefined;
let director: Director | undefined;
let note: NoteSpec | null = null;
let starting = false;
const noteListeners = new Set<() => void>();

function setNote(next: NoteSpec | null) {
  note = next;
  for (const l of noteListeners) l();
}

export function useTourNote(): NoteSpec | null {
  return useSyncExternalStore(
    (l) => {
      noteListeners.add(l);
      return () => noteListeners.delete(l);
    },
    () => note,
    () => null,
  );
}

export function attachTourLayer(el: HTMLElement | undefined): void {
  layer = el;
}

export function getTourCursor(): Cursor | undefined {
  return cursor;
}

/** Whether the planner can be toured right now (the host is mounted). */
export function tourAvailable(): boolean {
  // The tour drives the full layout (the overview beside the board, the items column); compact boards have neither.
  // The cutoffs are in shell pixels, so the interface zoom counts: the media query knows it, window.innerWidth does not.
  return layer !== undefined && !isCompactViewport();
}

export async function startTour(step = 0): Promise<void> {
  if (starting || getTour().phase !== "idle" || !tourAvailable()) return;
  starting = true;
  markTourOffered();
  try {
    const steps = tourSteps();
    setTour({ phase: "playing", index: 0, total: steps.length, noteReady: false });
    await enterSandbox();
    cursor = new Cursor(layer!);
    director = new Director(steps, cursor, {
      onNote: setNote,
      onLeave: () => void leaveTour(),
    });
    await draws(3);
    if (step > 0) await director.jump(step);
    else await director.play(0);
  } catch (error) {
    console.error("[tour] could not start", error);
    await leaveTour();
  } finally {
    starting = false;
  }
}

export async function leaveTour(): Promise<void> {
  const d = director;
  if (!d && getTour().phase === "idle") return;
  d?.stop();
  director = undefined;
  cursor?.destroy();
  cursor = undefined;
  setNote(null);
  resetPointerState();
  resetTour();
  await leaveSandbox();
}

export function tourNext(): void {
  void director?.next();
}

export function tourBack(): void {
  void director?.back();
}

export function tourHurry(): void {
  director?.hurry();
}

export async function tourJump(step: number): Promise<void> {
  if (getTour().phase === "idle") await startTour(step);
  else await director?.jump(step);
}

/** For the dev harness and tests: where the tour is, and what it warned about. */
export function tourStatus(): { phase: string; index: number; total: number; warnings: readonly string[] } {
  const t = getTour();
  return { phase: t.phase, index: t.index, total: t.total, warnings: tourWarnings() };
}
