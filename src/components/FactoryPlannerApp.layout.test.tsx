// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The board, the browser and the panels are other tests' business; here each is
// a labelled box so the test sees only WHERE the workspace seats them.
vi.mock("./flow/FactoryFlow", () => ({ FactoryFlow: () => <div data-testid="board" /> }));
vi.mock("./RecipeBrowser", () => ({
  RecipeBrowser: () => <aside data-testid="items" data-help-anchor="browser" />,
}));
vi.mock("./AppHeader", () => ({ AppHeader: () => null }));
vi.mock("./PlanIdentityDrawer", () => ({ PlanIdentityDrawer: () => null }));
vi.mock("./TabConflictNotice", () => ({ TabConflictNotice: () => null }));
vi.mock("./library/LibraryPage", () => ({ LibraryPage: () => null }));
vi.mock("./welcome/WelcomePage", () => ({ WelcomePage: () => null }));
vi.mock("./PowerSourceOverlay", () => ({ PowerSourceOverlay: () => null }));
vi.mock("./BlueprintSaveDialog", () => ({ BlueprintSaveDialog: () => null }));

class ResizeObserverStub { observe() {} unobserve() {} disconnect() {} }
vi.stubGlobal("ResizeObserver", ResizeObserverStub);

import { resetRailViewForTests, writeRailView } from "./flow/clean/rail/rail-view";
import { ColumnWorkspace, CompactWorkspace } from "./FactoryPlannerApp";
import { DEFAULT_WORKSPACE_VIEW, readWorkspaceViewSnapshot, writeWorkspaceView } from "@/lib/workspace-view";
import { writeDeviceSettings } from "@/lib/device-settings";
import { leaveWelcomeTab } from "@/lib/welcome/welcome-tab";
import { useDesignStore } from "@/store/design-store";
import { resetLandingRefreshMemory } from "@/lib/datasets/refresh-project-recipes";

function renderColumns() {
  return render(<ColumnWorkspace workspace={readWorkspaceViewSnapshot()} onLoadDatasetVersion={() => {}} />);
}

/** Children of the grid in document order, by test id. */
function order(container: HTMLElement): string[] {
  const main = container.querySelector("main")!;
  return Array.from(main.children).map(
    (child) =>
      child.getAttribute("data-testid") ??
      (child.querySelector("[data-testid]")?.getAttribute("data-testid") ?? "other"),
  );
}

describe("workspace layout", () => {
  beforeEach(() => {
    resetLandingRefreshMemory();
    window.localStorage.clear();
    resetRailViewForTests();
    writeWorkspaceView({ ...DEFAULT_WORKSPACE_VIEW, leftPanelOpen: true, rightPanelOpen: true });
    leaveWelcomeTab();
    useDesignStore.setState({ isHydrated: true, activeDesignId: "d1" });
  });

  afterEach(() => {
    cleanup();
  });

  it("puts the overview left and the items right", () => {
    const { container } = renderColumns();
    expect(order(container)).toEqual(["plan-overview", "board", "items"]);
    const main = container.querySelector("main")!;
    expect(main.getAttribute("data-items-side")).toBe("right");
    expect(main.style.gridTemplateColumns).toBe("336px minmax(0,1fr) 256px");
  });

  it("puts the items left and the overview right when the settings say so, each strip folding to its own side", () => {
    act(() => writeDeviceSettings({ itemsLeft: true }));
    try {
      const { container } = renderColumns();
      expect(order(container)).toEqual(["items", "board", "plan-overview"]);
      const main = container.querySelector("main")!;
      expect(main.getAttribute("data-items-side")).toBe("left");
      expect(main.style.gridTemplateColumns).toBe("256px minmax(0,1fr) 336px");
      act(() => writeRailView({ open: false }));
      expect(screen.getByRole("button", { name: "Open the overview" }).getAttribute("data-side")).toBe("right");
    } finally {
      act(() => writeDeviceSettings({ itemsLeft: false }));
    }
  });

  it("folds the overview to a strip that survives a reload", () => {
    const first = renderColumns();
    act(() => writeRailView({ open: false }));
    first.unmount();
    const stored = JSON.parse(window.localStorage.getItem("gtnh-factory-flow-overview-rail")!);
    expect(stored.open).toBe(false);
    const { container } = renderColumns();
    expect(container.querySelector("main")!.style.gridTemplateColumns).toBe("26px minmax(0,1fr) 256px");
    act(() => writeRailView({ open: true }));
    expect(JSON.parse(window.localStorage.getItem("gtnh-factory-flow-overview-rail")!).open).toBe(true);
  });

  it("folds the items to a 26px rail on the right, the overview's own strip", () => {
    act(() => writeWorkspaceView({ leftPanelOpen: false }));
    act(() => writeRailView({ open: false }));
    const { container } = renderColumns();
    expect(container.querySelector("main")!.style.gridTemplateColumns).toBe("26px minmax(0,1fr) 26px");
    const rail = screen.getByRole("button", { name: "Open the items" });
    const overview = screen.getByRole("button", { name: "Open the overview" });
    // One strip for both: same class, the arrow first (at the top), the name after it.
    expect(rail.className).toBe(overview.className);
    expect(rail.getAttribute("data-side")).toBe("right");
    expect(overview.getAttribute("data-side")).toBe("left");
    expect(rail.textContent).toBe("«ITEMS");
    act(() => writeRailView({ open: true }));
    fireEvent.click(rail);
    expect(readWorkspaceViewSnapshot().leftPanelOpen).toBe(true);
  });

  describe("compact", () => {
    function renderCompact() {
      return render(<CompactWorkspace workspace={readWorkspaceViewSnapshot()} onLoadDatasetVersion={() => {}} />);
    }

    it("puts the overview drawer left and the items right", () => {
      act(() => writeWorkspaceView({ leftPanelOpen: false, rightPanelOpen: false }));
        const { container } = renderCompact();
      expect(screen.getByRole("button", { name: "Show overview" }).className).toContain("left-0");
      expect(screen.getByRole("button", { name: "Show items" }).className).toContain("right-0");
      expect(container.querySelector("main")!.getAttribute("data-items-side")).toBe("right");
    });

    it("opening one drawer closes the other", () => {
      act(() => writeWorkspaceView({ leftPanelOpen: false, rightPanelOpen: false }));
        renderCompact();
      fireEvent.click(screen.getByRole("button", { name: "Show overview" }));
      expect(readWorkspaceViewSnapshot()).toMatchObject({ rightPanelOpen: true, leftPanelOpen: false });
      fireEvent.click(screen.getByRole("button", { name: "Show items" }));
      expect(readWorkspaceViewSnapshot()).toMatchObject({ rightPanelOpen: false, leftPanelOpen: true });
    });
  });
});
