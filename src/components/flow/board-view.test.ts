// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const STORAGE_KEY = "gtnh-factory-flow-board-view";

/**
 * The calm colours and the glance view must never survive a page load. The board has no switch for either, and the
 * image export borrows both for the length of a capture, putting them back in a `finally`, which never runs if the
 * tab closes mid-export. So a stored value is never honoured, and neither reaches storage. Settings with no control
 * (an old board's line widths and dashes) are dropped the same way.
 */
describe("board view: the session-only settings cannot outlive the session", () => {
  beforeEach(() => {
    vi.resetModules();
    window.localStorage.clear();
  });

  it("ignores stored calm, glance and retired settings", async () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ calmMode: true, glanceMode: "status", fixedEdgeWidth: true, linePulseMode: true }),
    );
    const { readBoardViewSnapshot } = await import("./board-view");
    const view = readBoardViewSnapshot();
    expect(view.calmMode).toBe(false);
    expect(view.glanceMode).toBe("identity");
    expect("fixedEdgeWidth" in view).toBe(false);
    expect("linePulseMode" in view).toBe(false);
  });

  it("never writes them to storage, so an interrupted export strands nobody", async () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ fixedEdgeWidth: true }));
    const { writeBoardView } = await import("./board-view");
    writeBoardView({ calmMode: true, glanceMode: "power" });
    const stored = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "{}") as Record<string, unknown>;
    expect(stored).not.toHaveProperty("calmMode");
    expect(stored).not.toHaveProperty("glanceMode");
    expect(stored).not.toHaveProperty("fixedEdgeWidth");
  });

  it("still sets them IN MEMORY, which is all the export capture needs", async () => {
    const { readBoardViewSnapshot, writeBoardView } = await import("./board-view");
    writeBoardView({ calmMode: true, glanceMode: "usage" });
    expect(readBoardViewSnapshot()).toMatchObject({ calmMode: true, glanceMode: "usage" });
    writeBoardView({ calmMode: false, glanceMode: "identity" });
    expect(readBoardViewSnapshot()).toMatchObject({ calmMode: false, glanceMode: "identity" });
  });

  it("keeps writing the settings that ARE preferences", async () => {
    const { writeBoardView } = await import("./board-view");
    writeBoardView({ canvasPattern: "cross", calmMode: true });
    const stored = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "{}") as Record<string, unknown>;
    expect(stored.canvasPattern).toBe("cross");
  });
});
