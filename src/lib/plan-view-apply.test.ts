// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";
import { readBoardViewSnapshot, writeBoardView } from "@/components/flow/board-view";
import { getActiveRateUnit } from "./model/rate-unit";
import type { PlanViewState } from "./model/types";
import { applyPlanView, capturePlanView } from "./plan-view";
import { readWorkspaceViewSnapshot, writeWorkspaceView } from "./workspace-view";
import { useFactoryStore } from "@/store/factory-store";

describe("applying a shared plan's view", () => {
  beforeEach(() => {
    writeBoardView({ canvasPattern: "dots", calmMode: false, glanceMode: "identity" });
    writeWorkspaceView({ leftPanelOpen: true, rightPanelOpen: true });
    useFactoryStore.getState().setRateUnit("second");
  });

  it("puts the author's arrangement on screen", () => {
    applyPlanView({ canvasPattern: "cross", rateUnit: "hour", leftPanelOpen: false });

    expect(readBoardViewSnapshot().canvasPattern).toBe("cross");
    expect(readWorkspaceViewSnapshot().leftPanelOpen).toBe(false);
    expect(getActiveRateUnit()).toBe("hour");
  });

  it("takes nothing from settings it no longer carries", () => {
    // Older plans name views the board has no control for; they arrive as nothing at all.
    applyPlanView({ calmMode: true, glanceMode: "status", lineHeatMode: true } as PlanViewState);

    const board = readBoardViewSnapshot();
    expect(board.calmMode).toBe(false);
    expect(board.glanceMode).toBe("identity");
    expect("lineHeatMode" in board).toBe(false);
  });

  it("leaves settings the plan says nothing about alone", () => {
    writeBoardView({ canvasPattern: "graph" });
    applyPlanView({ rateUnit: "minute" });

    expect(getActiveRateUnit()).toBe("minute");
    expect(readBoardViewSnapshot().canvasPattern).toBe("graph");
  });

  it("does nothing at all for a plan with no view", () => {
    applyPlanView(undefined);

    expect(readBoardViewSnapshot().canvasPattern).toBe("dots");
    expect(getActiveRateUnit()).toBe("second");
  });

  it("drops values this build does not recognise", () => {
    // A plan from a newer build must not leave the board in a state no control
    // can undo.
    applyPlanView({ canvasPattern: "hexagons" } as PlanViewState);

    expect(readBoardViewSnapshot().canvasPattern).toBe("dots");
  });

  it("leaves your columns alone across your own tabs", () => {
    applyPlanView({ canvasPattern: "cross", leftPanelOpen: false }, "board");

    expect(readBoardViewSnapshot().canvasPattern).toBe("cross");
    expect(readWorkspaceViewSnapshot().leftPanelOpen).toBe(true);
  });

  it("frames the plan when it is not told where the camera was", () => {
    applyPlanView({ rateUnit: "second" });

    expect(useFactoryStore.getState().boardFocusRequest?.mode).toBe("fit");
  });

  it("lands on a remembered camera instead of framing", () => {
    // How a design tab comes back up where you left it: the camera wins, and
    // the plan is NOT reframed on top of it.
    applyPlanView({ rateUnit: "second" }, "board", { x: -400, y: 120, zoom: 0.5 });

    const request = useFactoryStore.getState().boardFocusRequest;
    expect(request?.mode).toBe("viewport");
    expect(request?.camera).toEqual({ x: -400, y: 120, zoom: 0.5 });
  });

  it("captures what it applies, so a re-share carries the same arrangement", () => {
    const view: PlanViewState = { canvasPattern: "none", rateUnit: "minute", rightPanelOpen: false };
    applyPlanView(view);

    const captured = capturePlanView();
    expect(captured).toMatchObject(view);
    // And never the session-only views: a re-share must not start pinning a reading the original never carried.
    expect("glanceMode" in captured).toBe(false);
    expect("calmMode" in captured).toBe(false);
  });
});
