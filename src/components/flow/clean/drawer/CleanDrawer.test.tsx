// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ReactFlowProvider } from "@xyflow/react";
import { createEmptyProject } from "@/examples";
import type { FactoryStorage } from "@/lib/model/types";
import type { StorageRole } from "@/lib/model/storage-role";
import { useFactoryStore } from "@/store/factory-store";
import { CleanDrawer } from "./CleanDrawer";

vi.mock("@/lib/compact-view", () => ({ isCompactViewport: () => false }));

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});
afterEach(cleanup);

/** The most elements one drawer may cost (the classic drawer is 42 to 55): 18, and the side key an input or output has. */
const BUDGET = 19;

function storage(patch: Partial<FactoryStorage> = {}): FactoryStorage {
  return {
    id: "s1",
    kind: "item",
    resourceId: "mock:dust",
    displayName: "Mock Dust",
    iconPath: "/nei/test/mock.png",
    position: { x: 0, y: 0 },
    ...patch,
  };
}

function load(s: FactoryStorage, plan?: { unanchored?: string[]; unmetDrawers?: string[] }) {
  const project = { ...createEmptyProject(), storages: [s] };
  useFactoryStore.setState({
    project,
    lastResult: plan
      ? ({ plan: { unanchored: [], unmetDrawers: [], forced: [], leftovers: [], unneeded: [], terminals: [], notes: [], openGates: 0, ...plan } } as never)
      : undefined,
  });
}

function renderDrawer(s: FactoryStorage, role: StorageRole, net = 1.5, selected = false) {
  const result = { storageId: s.id, netPerSecond: net } as never;
  return render(
    <ReactFlowProvider>
      <CleanDrawer data={{ storage: s, result }} selected={selected} role={role} />
    </ReactFlowProvider>,
  );
}

const stored = () => useFactoryStore.getState().project.storages![0]!;

beforeEach(() => {
  useFactoryStore.setState({ isReadOnly: false });
});

describe("the clean drawer", () => {
  it("costs at most 19 elements", () => {
    load(storage({ targetPerSecond: 2, targetMode: "at-least" }));
    const { container } = renderDrawer(stored(), "product");
    const count = container.querySelector(".cd-wrap")!.querySelectorAll("*").length;
    console.info(`[clean drawer] DOM elements: ${count}`);
    expect(count).toBeLessThanOrEqual(BUDGET);
  });

  it("wears the mod's kinds: blue source, orange product, steel trash", () => {
    load(storage());
    for (const [role, kind] of [
      ["source", "source"],
      ["product", "product"],
      ["byproduct", "product"],
      ["trash", "trash"],
    ] as const) {
      const { container } = renderDrawer(stored(), role);
      expect(container.querySelector(".cd")!.getAttribute("data-kind")).toBe(kind);
      cleanup();
    }
  });

  it("keeps every control a div (globals.css forces the button font)", () => {
    load(storage());
    const { container } = renderDrawer(stored(), "product");
    expect(container.querySelectorAll("button, select, textarea").length).toBe(0);
  });

  it("shows the rule mark, the rate and the progress of a product with a target", () => {
    load(storage({ targetPerSecond: 2, targetMode: "at-least" }));
    const { container } = renderDrawer(stored(), "product", 1);
    const key = container.querySelector(".cd-key")!;
    expect(key.getAttribute("data-mark")).toBe("≥");
    expect(key.hasAttribute("data-any")).toBe(false);
    const box = container.querySelector(".cd-box")!;
    expect(box.getAttribute("data-text")).toBe("2");
    expect(box.getAttribute("data-unit")).toBe("/s");
    expect(box.hasAttribute("data-progress")).toBe(true);
    expect((box as HTMLElement).style.getPropertyValue("--cd-progress")).toBe("0.5");
    expect(box.getAttribute("data-tone")).toBe("ok");
  });

  it("asks for a rate when nothing sets its part of the plan", () => {
    load(storage(), { unanchored: ["s1"] });
    const { container } = renderDrawer(stored(), "source");
    const box = container.querySelector(".cd-box")!;
    expect(box.getAttribute("data-text")).toBe("Set");
    expect(box.hasAttribute("data-prompt")).toBe(true);
    cleanup();
    load(storage(), { unanchored: [] });
    const calm = renderDrawer(stored(), "source").container.querySelector(".cd-box")!;
    expect(calm.getAttribute("data-text")).toBe("Set");
    expect(calm.hasAttribute("data-prompt")).toBe(false);
  });

  it("marks a target the plan cannot reach in red", () => {
    load(storage({ targetPerSecond: 4, targetMode: "exact" }), { unmetDrawers: ["s1"] });
    const { container } = renderDrawer(stored(), "product", 1);
    const box = container.querySelector(".cd-box")!;
    expect(box.hasAttribute("data-unmet")).toBe(true);
    expect(box.getAttribute("data-tone")).toBe("bad");
    const tip = JSON.parse(box.getAttribute("data-tip")!);
    expect(tip.title).toBe("Target rate");
    expect(tip.rows).toContainEqual({ label: "Reaches", value: "1 /s", tone: "red" });
  });

  it("trash has no rule: a key and the word Voided", () => {
    load(storage({ drainMode: "trash" }));
    const { container } = renderDrawer(stored(), "trash");
    expect(container.querySelector(".cd-key")!.getAttribute("data-mark")).toBe("×");
    const box = container.querySelector(".cd-box")!;
    expect(box.getAttribute("data-text")).toBe("Voided");
    expect(box.hasAttribute("data-fixed")).toBe(true);
  });

  it("is grabbed by a grip wider than its bar: past its top and sides, a little into the row, under the keys", () => {
    load(storage());
    const { container } = renderDrawer(stored(), "source");
    // The grip is the drawer's own pseudo-element, so the bar's tip rides the drawer and the bar has none.
    expect(JSON.parse(container.querySelector(".cd")!.getAttribute("data-tip")!).id).toBe("s1|bar");
    expect(container.querySelector(".cd-bar")!.hasAttribute("data-tip")).toBe(false);
    const css = readFileSync(`${process.cwd()}/src/components/flow/clean/drawer/drawer.css`, "utf8");
    const grip = /\n\.cd::before \{([^}]*)\}/.exec(css)?.[1] ?? "";
    const value = (name: string) => new RegExp(`\\b${name}: ([^;]+);`).exec(grip)?.[1];
    expect([value("left"), value("right"), value("top"), value("height")]).toEqual(["-4px", "-4px", "-8px", "21px"]);
    // Over the row's wiring handle (30), under the delete and side keys (41).
    expect(Number(value("z-index"))).toBeGreaterThan(30);
    expect(Number(value("z-index"))).toBeLessThan(41);
    expect(value("cursor")).toBe("grab");
  });

  it("selects, lights and delete-keys through data attributes", () => {
    load(storage());
    const { container } = renderDrawer(stored(), "source", 1, true);
    expect(container.querySelector(".cd")!.hasAttribute("data-selected")).toBe(true);
    expect(container.querySelector(".cd-del")).not.toBeNull();
  });

  it("deletes with its key", () => {
    load(storage());
    const { container } = renderDrawer(stored(), "source");
    fireEvent.click(container.querySelector(".cd-del")!);
    expect(useFactoryStore.getState().project.storages ?? []).toHaveLength(0);
  });
});

describe("the rule menu", () => {
  it("lists the four rules and, for a product, the row that voids it", () => {
    load(storage({ targetPerSecond: 2, targetMode: "at-least" }));
    const { container } = renderDrawer(stored(), "product");
    fireEvent.click(container.querySelector(".cd-key")!);
    const rows = Array.from(document.querySelectorAll("[role^=menuitem]")).map((row) => row.textContent);
    expect(rows).toEqual(["Any~", "At least≥", "Exactly=", "At most≤", "Void it (trash)"]);
    expect(Array.from(document.querySelectorAll("[role^=menuitem]"))[1]!.hasAttribute("data-checked")).toBe(true);
  });

  it("a source has the four rules and no void row", () => {
    load(storage());
    const { container } = renderDrawer(stored(), "source");
    fireEvent.click(container.querySelector(".cd-key")!);
    expect(Array.from(document.querySelectorAll("[role^=menuitem]")).map((row) => row.textContent)).toEqual(["Any~", "At least≥", "Exactly=", "At most≤"]);
  });

  it("trash has one row: Keep it (product)", () => {
    load(storage({ drainMode: "trash" }));
    const { container } = renderDrawer(stored(), "trash");
    fireEvent.click(container.querySelector(".cd-key")!);
    expect(Array.from(document.querySelectorAll("[role^=menuitem]")).map((row) => row.textContent)).toEqual(["Keep it (product)"]);
    fireEvent.click(screen.getByText("Keep it (product)"));
    expect(stored().drainMode).toBe("product");
  });

  it("the cycle lives in it: Void it makes the product trash", () => {
    load(storage({ targetPerSecond: 2, targetMode: "at-least" }));
    const { container } = renderDrawer(stored(), "product");
    fireEvent.click(container.querySelector(".cd-key")!);
    fireEvent.click(screen.getByText("Void it (trash)"));
    expect(stored().drainMode).toBe("trash");
  });

  it("picking a rule changes the stored rule", () => {
    load(storage({ targetPerSecond: 2, targetMode: "at-least" }));
    const { container } = renderDrawer(stored(), "product");
    fireEvent.click(container.querySelector(".cd-key")!);
    fireEvent.click(screen.getByText("At most"));
    expect(stored().targetMode).toBe("at-most");
  });

  it("a right click on the key goes to the previous rule, wrapping", () => {
    load(storage({ targetPerSecond: 2, targetMode: "at-least" }));
    const { container } = renderDrawer(stored(), "product");
    fireEvent.contextMenu(container.querySelector(".cd-key")!);
    expect(stored().targetMode).toBe("ignore");
  });

  it("a rule picked on a byproduct makes it a product first", () => {
    load(storage({ drainMode: "byproduct", targetPerSecond: 2, targetMode: "ignore" }));
    const { container } = renderDrawer(stored(), "byproduct");
    fireEvent.click(container.querySelector(".cd-key")!);
    fireEvent.click(screen.getByText("At least"));
    expect(stored().drainMode).toBe("product");
    expect(stored().targetMode).toBe("at-least");
  });
});

describe("the rate box", () => {
  function type(container: HTMLElement, text: string) {
    fireEvent.click(container.querySelector(".cd-box")!);
    const input = container.querySelector(".cd-box input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: text } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.blur(input);
  }

  it("takes shorthand: 2.5k", () => {
    load(storage());
    const { container } = renderDrawer(stored(), "product", 0);
    type(container, "2.5k");
    expect(stored().targetPerSecond).toBe(2500);
    expect(stored().targetMode).toBe("at-least");
  });

  it("takes a fraction: 1/3", () => {
    load(storage());
    const { container } = renderDrawer(stored(), "product", 0);
    type(container, "1/3");
    expect(stored().targetPerSecond).toBeCloseTo(1 / 3, 10);
  });

  it("typing a rate on a source makes it Exactly", () => {
    load(storage());
    const { container } = renderDrawer(stored(), "source", 0);
    type(container, "4");
    expect(stored().targetMode).toBe("exact");
    expect(Math.abs(stored().targetPerSecond ?? 0)).toBe(4);
  });

  it("a middle click clears it to Any, so it reads Set again", () => {
    load(storage({ targetPerSecond: 2, targetMode: "at-least" }));
    const { container } = renderDrawer(stored(), "product");
    fireEvent(container.querySelector(".cd-box")!, new MouseEvent("auxclick", { bubbles: true, button: 1 }));
    expect(stored().targetPerSecond).toBeUndefined();
  });

  it("the wheel below one clears the rate", () => {
    load(storage({ targetPerSecond: 1, targetMode: "at-least" }));
    const { container } = renderDrawer(stored(), "product");
    fireEvent.wheel(container.querySelector(".cd-box")!, { deltaY: 100 });
    expect(stored().targetPerSecond).toBeUndefined();
  });

  it("the wheel up steps by one in the shown unit", () => {
    load(storage({ targetPerSecond: 2, targetMode: "at-least" }));
    const { container } = renderDrawer(stored(), "product");
    fireEvent.wheel(container.querySelector(".cd-box")!, { deltaY: -100 });
    expect(stored().targetPerSecond).toBe(3);
  });
});

describe("the item", () => {
  const browse = vi.fn();
  beforeEach(() => {
    browse.mockClear();
    useFactoryStore.setState({ browseResource: browse } as never);
  });

  it("a click opens the recipes that make it", () => {
    load(storage());
    const { container } = renderDrawer(stored(), "source");
    fireEvent.click(container.querySelector(".cd-body")!);
    expect(browse).toHaveBeenCalledTimes(1);
    expect(browse.mock.calls[0]![0]).toMatchObject({ kind: "item", id: "mock:dust" });
    expect(browse.mock.calls[0]![1]).toBe("recipes");
  });

  it("a right click shows what uses it, not the drawer's menu", () => {
    load(storage());
    const { container } = renderDrawer(stored(), "source");
    fireEvent.contextMenu(container.querySelector(".cd-body")!);
    expect(browse.mock.calls[0]![1]).toBe("uses");
    expect(screen.queryByText("Delete drawer")).toBeNull();
  });

  it("a right click on the rate box is the drawer's menu", () => {
    load(storage());
    const { container } = renderDrawer(stored(), "source");
    fireEvent.contextMenu(container.querySelector(".cd-box")!);
    expect(browse).not.toHaveBeenCalled();
    expect(screen.getByText("Delete drawer")).toBeTruthy();
  });

  it("a click on the rate box or the rule key browses nothing", () => {
    load(storage());
    const { container } = renderDrawer(stored(), "source");
    fireEvent.click(container.querySelector(".cd-box")!);
    fireEvent.click(container.querySelector(".cd-key")!);
    expect(browse).not.toHaveBeenCalled();
  });
});
