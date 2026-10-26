// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A matchMedia that answers one way for every query.
 *
 * Defined onto the window rather than spied: this jsdom has no matchMedia at all,
 * which is also why `compact-view` treats a missing one as "not compact" instead
 * of assuming it can call it.
 */
function stubMatchMedia(matches: boolean) {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (media: string) =>
      ({
        matches,
        media,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      }) as unknown as MediaQueryList,
  });
}

describe("compact viewport", () => {
  beforeEach(() => {
    // Both modules cache: compact-view keeps one MediaQueryList, workspace-view
    // reads its defaults once. Each case needs them built against its own stub.
    vi.resetModules();
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    Reflect.deleteProperty(window, "matchMedia");
  });

  it("is not compact where there is no matchMedia to ask", async () => {
    const { isCompactViewport } = await import("./compact-view");

    expect(isCompactViewport()).toBe(false);
  });

  it("asks a media query, not window.innerWidth", async () => {
    // A mobile browser widens the layout viewport when a page overflows it, so a
    // 390px phone showing this app used to report an innerWidth of 935 — which is
    // how the one device with room for neither column got both of them.
    stubMatchMedia(true);
    Object.defineProperty(window, "innerWidth", { value: 935, configurable: true });

    const { isCompactViewport } = await import("./compact-view");

    expect(isCompactViewport()).toBe(true);
  });

  it("is not compact on a window with room for the columns", async () => {
    stubMatchMedia(false);

    const { isCompactViewport } = await import("./compact-view");

    expect(isCompactViewport()).toBe(false);
  });

  it("starts a compact window on the board, with both columns closed", async () => {
    stubMatchMedia(true);

    const { readWorkspaceViewSnapshot } = await import("./workspace-view");
    const workspace = readWorkspaceViewSnapshot();

    expect(workspace.leftPanelOpen).toBe(false);
    expect(workspace.rightPanelOpen).toBe(false);
  });

  it("starts a wide window with both columns open", async () => {
    stubMatchMedia(false);

    const { readWorkspaceViewSnapshot } = await import("./workspace-view");
    const workspace = readWorkspaceViewSnapshot();

    expect(workspace.leftPanelOpen).toBe(true);
    expect(workspace.rightPanelOpen).toBe(true);
  });

  it("keeps a shared plan from opening a drawer over a compact board", async () => {
    // Both columns open is ordinary advice from a plan built on a desktop. Obeyed
    // on a phone it would stack two full-height drawers over the board it is
    // trying to show off.
    stubMatchMedia(true);

    const { applyPlanView } = await import("./plan-view");
    const { readWorkspaceViewSnapshot } = await import("./workspace-view");
    const { getActiveRateUnit } = await import("./model/rate-unit");
    applyPlanView({ leftPanelOpen: true, rightPanelOpen: true, rateUnit: "hour" });

    const workspace = readWorkspaceViewSnapshot();
    expect(workspace.leftPanelOpen).toBe(false);
    expect(workspace.rightPanelOpen).toBe(false);
    // Everything else the plan carries still lands.
    expect(getActiveRateUnit()).toBe("hour");
  });
});
