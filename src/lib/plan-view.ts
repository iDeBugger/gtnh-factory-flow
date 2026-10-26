"use client";

import {
  CANVAS_PATTERNS,
  readBoardViewSnapshot,
  writeBoardView,
  type CanvasPattern,
} from "@/components/flow/board-view";
import { isCanvasThemeId } from "@/components/flow/canvas-themes";
import { isCompactViewport } from "./compact-view";
import type { BoardCamera } from "./designs/design-camera";
import type { PlanViewState } from "./model/types";
import { readWorkspaceViewSnapshot, writeWorkspaceView } from "./workspace-view";
import { getActiveRateUnit } from "./model/rate-unit";
import { useFactoryStore } from "@/store/factory-store";

/**
 * Reading and restoring the workspace arrangement a shared setup carries.
 *
 * Three separate homes feed this: the board's own view settings, the side
 * columns, and the board-wide rate unit. Gathering them in
 * one place means the share dialog and the open-a-setup path each deal with a
 * single object rather than knowing where each setting lives.
 */

/** Everything the current workspace would hand to someone opening this plan. */
export function capturePlanView(): PlanViewState {
  const board = readBoardViewSnapshot();
  const workspace = readWorkspaceViewSnapshot();

  return {
    canvasPattern: board.canvasPattern,
    canvasTheme: board.canvasTheme,
    rateUnit: getActiveRateUnit(),
    leftPanelOpen: workspace.leftPanelOpen,
    rightPanelOpen: workspace.rightPanelOpen,
  };
}

/**
 * How much of a saved arrangement to put back.
 *
 * `all` is someone OPENING a shared setup: they asked to see it the way its
 * author left it, columns included.
 *
 * `board` is switching between your own tabs. The board's own look belongs to
 * the plan, but the side COLUMNS belong to the person, so a tab switch leaves
 * them alone.
 */
export type PlanViewScope = "all" | "board";

/**
 * Put a saved arrangement, and the plan itself, on screen.
 *
 * `camera` is where this tab was last left (see `design-camera.ts`), and it is
 * only ever passed for one of YOUR OWN tabs coming back up. Without one, the
 * plan is framed.
 */
export function applyPlanView(
  view: PlanViewState | undefined,
  scope: PlanViewScope = "all",
  camera?: BoardCamera,
): void {
  applyViewSettings(view, scope);

  // Last, so the panel toggles above have already given the board its width.
  if (camera) {
    useFactoryStore.getState().moveBoardCamera(camera);
    return;
  }

  // A shared plan carries card positions but no camera, and factories can sit
  // thousands of cells from the origin, so frame the cards.
  useFactoryStore.getState().frameBoardNodes();
}

/**
 * The view settings themselves. Values the running build does not recognise
 * are dropped rather than written through, so a plan from a newer version
 * cannot leave the board in a state with no control that undoes it. Absent
 * fields leave the viewer's own setting alone.
 */
function applyViewSettings(view: PlanViewState | undefined, scope: PlanViewScope): void {
  if (!view) {
    return;
  }

  const boardPatch: Parameters<typeof writeBoardView>[0] = {};
  if (view.canvasPattern && CANVAS_PATTERNS.includes(view.canvasPattern as CanvasPattern)) {
    boardPatch.canvasPattern = view.canvasPattern as CanvasPattern;
  }
  if (isCanvasThemeId(view.canvasTheme)) {
    boardPatch.canvasTheme = view.canvasTheme;
  }
  if (Object.keys(boardPatch).length > 0) {
    writeBoardView(boardPatch);
  }

  if (scope === "all") {
    // The columns are the workspace around the board rather than the board itself, and a tab switch leaves them
    // alone (see PlanViewScope). On compact windows the columns are drawers over the board, so the author's open
    // columns would bury the board; they are skipped there.
    const workspacePatch: Parameters<typeof writeWorkspaceView>[0] = {};
    if (!isCompactViewport()) {
      for (const key of ["leftPanelOpen", "rightPanelOpen"] as const) {
        if (typeof view[key] === "boolean") {
          workspacePatch[key] = view[key];
        }
      }
    }
    if (Object.keys(workspacePatch).length > 0) {
      writeWorkspaceView(workspacePatch);
    }
  }

  if (view.rateUnit) {
    // Through the store, not the module singleton, so the store's rateUnit
    // and the formatters' singleton stay in step.
    useFactoryStore.getState().setRateUnit(view.rateUnit);
  }
}
