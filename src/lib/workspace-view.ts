import { useSyncExternalStore } from "react";
import { isCompactViewport } from "./compact-view";

/**
 * Workspace preferences: which side columns are open, and how the machine list weighs power.
 *
 * Same mechanism as `board-view.ts`: personal taste rather than part of a
 * plan, kept in localStorage outside any store and read through
 * useSyncExternalStore so the server can render defaults without a hydration
 * mismatch. Opening a shared setup is the exception (see `plan-view.ts`).
 * Keys a stored blob carries beyond these are ignored, and the next write drops them.
 */
export interface WorkspaceView {
  /** The items column (a phone's items drawer). */
  leftPanelOpen: boolean;
  /** The overview column (a phone's overview drawer). */
  rightPanelOpen: boolean;
  /**
   * The build list's power figures, weighted by how hard each machine
   * actually runs instead of every machine at full draw at once. Display
   * arithmetic only.
   */
  averageMachineDraw: boolean;
}

const WORKSPACE_VIEW_STORAGE_KEY = "gtnh-factory-flow-workspace-view";

export const DEFAULT_WORKSPACE_VIEW: WorkspaceView = {
  leftPanelOpen: true,
  rightPanelOpen: true,
  averageMachineDraw: true,
};

/**
 * Whether the side columns start open.
 *
 * On a compact window they start closed so the board gets the screen; the
 * choice is then remembered like any other.
 *
 * A media query rather than `window.innerWidth`: a mobile browser widens the
 * layout viewport when a page overflows it, so `innerWidth` on a 390px phone
 * can report 935.
 */
function defaultPanelsOpen(): boolean {
  return typeof window === "undefined" || !isCompactViewport();
}

function defaultWorkspaceView(): WorkspaceView {
  const open = defaultPanelsOpen();
  return { ...DEFAULT_WORKSPACE_VIEW, leftPanelOpen: open, rightPanelOpen: open };
}

let workspaceViewState: WorkspaceView = DEFAULT_WORKSPACE_VIEW;
let workspaceViewLoaded = false;
const listeners = new Set<() => void>();

function readWorkspaceView(): WorkspaceView {
  try {
    const raw = window.localStorage.getItem(WORKSPACE_VIEW_STORAGE_KEY);
    if (!raw) {
      return defaultWorkspaceView();
    }
    const parsed = JSON.parse(raw) as Partial<Record<keyof WorkspaceView, unknown>>;
    // An ABSENT key takes the default; only an explicit `false` means off, so
    // a blob saved before a setting existed cannot silently opt out of it.
    const flag = (value: unknown, fallback: boolean) =>
      typeof value === "boolean" ? value : fallback;

    return {
      leftPanelOpen: flag(parsed.leftPanelOpen, defaultPanelsOpen()),
      rightPanelOpen: flag(parsed.rightPanelOpen, defaultPanelsOpen()),
      averageMachineDraw: flag(
        parsed.averageMachineDraw,
        DEFAULT_WORKSPACE_VIEW.averageMachineDraw,
      ),
    };
  } catch {
    return defaultWorkspaceView();
  }
}

export function subscribeWorkspaceView(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// Identity stays stable between writes, which is what useSyncExternalStore
// needs to avoid an infinite render loop.
function getSnapshot(): WorkspaceView {
  if (!workspaceViewLoaded) {
    workspaceViewLoaded = true;
    workspaceViewState = readWorkspaceView();
  }
  return workspaceViewState;
}

function getServerSnapshot(): WorkspaceView {
  return DEFAULT_WORKSPACE_VIEW;
}

export function writeWorkspaceView(patch: Partial<WorkspaceView>) {
  workspaceViewState = { ...getSnapshot(), ...patch };
  try {
    window.localStorage.setItem(
      WORKSPACE_VIEW_STORAGE_KEY,
      JSON.stringify(workspaceViewState),
    );
  } catch {
    // A full or blocked storage quota must never break the workspace.
  }
  for (const listener of listeners) {
    listener();
  }
}

export function useWorkspaceView(): WorkspaceView {
  return useSyncExternalStore(subscribeWorkspaceView, getSnapshot, getServerSnapshot);
}

/** The same value the hook returns, for callers outside React. */
export function readWorkspaceViewSnapshot(): WorkspaceView {
  return getSnapshot();
}
