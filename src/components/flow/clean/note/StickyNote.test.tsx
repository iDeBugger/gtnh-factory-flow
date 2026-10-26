// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { ReactFlowProvider, type NodeProps } from "@xyflow/react";
import type { FactoryAnnotation } from "@/lib/model/types";
import { useFactoryStore } from "@/store/factory-store";
import { AnnotationSwitch } from "./AnnotationSwitch";
import { StickyNote, type StickyNoteFlowNode } from "./StickyNote";

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  // jsdom has no PointerEvent: React's pointer handlers listen for events named pointer*, so a MouseEvent will do.
  if (typeof globalThis.PointerEvent === "undefined") {
    globalThis.PointerEvent = class extends MouseEvent {
      pointerId: number;
      constructor(type: string, init: PointerEventInit = {}) {
        super(type, init);
        this.pointerId = init.pointerId ?? 1;
      }
    } as unknown as typeof PointerEvent;
  }
});
afterEach(cleanup);

/** The most elements one resting note may cost: root, text, three keys. */
const BUDGET = 6;

function note(extra: Partial<FactoryAnnotation> = {}): FactoryAnnotation {
  return {
    id: "n1",
    kind: "text",
    colorTag: "yellow",
    text: "Titanium line",
    position: { x: 0, y: 0 },
    size: { width: 180, height: 120 },
    ...extra,
  };
}

function props(annotation: FactoryAnnotation, selected = false): NodeProps<StickyNoteFlowNode> {
  return {
    id: annotation.id,
    type: "annotationNode",
    data: { annotation },
    selected,
    width: annotation.size.width,
    height: annotation.size.height,
    dragging: false,
    draggable: true,
    selectable: true,
    deletable: true,
    isConnectable: false,
    zIndex: 0,
    positionAbsoluteX: 0,
    positionAbsoluteY: 0,
  } as unknown as NodeProps<StickyNoteFlowNode>;
}

function load(annotations: FactoryAnnotation[], planMode = true) {
  act(() => {
    const project = useFactoryStore.getState().project;
    useFactoryStore.setState({ project: { ...project, planMode, annotations } });
  });
}

const annotations = () => useFactoryStore.getState().project.annotations ?? [];

function renderNote(annotation: FactoryAnnotation) {
  load([annotation]);
  return render(
    <ReactFlowProvider>
      <StickyNote {...props(annotation)} />
    </ReactFlowProvider>,
  );
}

/** A press let go at the same place (a click) on a note-local point; jsdom's rects are all zero, so local = client. */
function click(el: HTMLElement, x: number, y: number) {
  fireEvent(el, new PointerEvent("pointerdown", { bubbles: true, clientX: x, clientY: y, button: 0 }));
  fireEvent(window, new PointerEvent("pointerup", { bubbles: true, clientX: x, clientY: y, button: 0 }));
}

beforeEach(() => load([]));

describe("StickyNote", () => {
  it("stays within the DOM budget, with its keys", () => {
    const { container } = renderNote(note());
    expect(container.querySelectorAll("*").length).toBeLessThanOrEqual(BUDGET);
    expect(container.querySelectorAll(".sn-key")).toHaveLength(3);
  });

  it("paints the mod's yellow paper from the colour tag", () => {
    const { container } = renderNote(note());
    const root = container.querySelector<HTMLElement>(".sn")!;
    expect(root.style.getPropertyValue("--sn-paper").toUpperCase()).toBe("#FEE26E");
    expect(root.style.getPropertyValue("--sn-ink").toUpperCase()).toBe("#1E1E22");
  });

  it("an empty note says so, dimly", () => {
    const { container } = renderNote(note({ text: "" }));
    expect(container.querySelector(".sn-text")?.textContent).toBe("Double-click to write");
    expect(container.querySelector(".sn-text")?.hasAttribute("data-empty")).toBe(true);
  });

  it("hides its keys when they do not fit", () => {
    const { container } = renderNote(note({ size: { width: 30, height: 20 } }));
    expect(container.querySelectorAll(".sn-key")).toHaveLength(0);
  });

  it("a click writes on it, and what is written is saved when writing ends", () => {
    const { container } = renderNote(note());
    const root = container.querySelector<HTMLElement>(".sn")!;
    click(root, 60, 60);
    const area = container.querySelector<HTMLTextAreaElement>("textarea");
    expect(area).not.toBeNull();
    expect(root.hasAttribute("data-editing")).toBe(true);
    fireEvent.change(area!, { target: { value: "Titanium line: check the coil" } });
    fireEvent.blur(area!);
    expect(annotations()[0]?.text).toBe("Titanium line: check the coil");
    expect(container.querySelector("textarea")).toBeNull();
  });

  it("the same words leave the note as it was; new lines grow it to show them", () => {
    const { container } = renderNote(note());
    const root = container.querySelector<HTMLElement>(".sn")!;
    click(root, 60, 60);
    fireEvent.blur(container.querySelector("textarea")!);
    expect(annotations()[0]?.size).toEqual({ width: 180, height: 120 });
    click(root, 60, 60);
    const area = container.querySelector<HTMLTextAreaElement>("textarea")!;
    fireEvent.change(area, { target: { value: Array.from({ length: 12 }, (_, i) => `line ${i}`).join("\n") } });
    fireEvent.blur(area);
    expect(annotations()[0]?.size.height).toBeGreaterThan(120);
    expect((annotations()[0]?.size.height ?? 1) % 20).toBe(0);
  });

  it("Escape ends writing", () => {
    const { container } = renderNote(note());
    click(container.querySelector<HTMLElement>(".sn")!, 60, 60);
    const area = container.querySelector<HTMLTextAreaElement>("textarea")!;
    area.focus();
    fireEvent.change(area, { target: { value: "changed" } });
    fireEvent.keyDown(area, { key: "Escape" });
    expect(container.querySelector("textarea")).toBeNull();
    expect(annotations()[0]?.text).toBe("changed");
  });

  it("a press that moved is a carry, not a click", () => {
    const { container } = renderNote(note());
    const root = container.querySelector<HTMLElement>(".sn")!;
    fireEvent(root, new PointerEvent("pointerdown", { bubbles: true, clientX: 60, clientY: 60, button: 0 }));
    fireEvent(window, new PointerEvent("pointerup", { bubbles: true, clientX: 90, clientY: 60, button: 0 }));
    expect(container.querySelector("textarea")).toBeNull();
  });

  it("the keys: bigger and smaller text by the website's step, delete at the top left", () => {
    const { container } = renderNote(note({ fontSize: 20 }));
    const root = container.querySelector<HTMLElement>(".sn")!;
    // 180 wide: bigger at 180 - 3 - 9 = 168, smaller 9 + 2 further left (157); delete at x 3, y 1, 9 square.
    click(root, 172, 6);
    expect(annotations()[0]?.fontSize).toBe(22);
    act(() => useFactoryStore.getState().updateAnnotation("n1", { fontSize: 20 }));
    click(root, 161, 6);
    expect(annotations()[0]?.fontSize).toBe(18);
    click(root, 8, 6);
    expect(annotations()).toHaveLength(0);
  });

  it("text sizes stop at the website's range", () => {
    const { container } = renderNote(note({ fontSize: 96 }));
    click(container.querySelector<HTMLElement>(".sn")!, 170, 6);
    expect(annotations()[0]?.fontSize).toBe(96);
  });

  it("an edge press starts a resize, not writing; letting go sets the size on the grid", () => {
    const { container } = renderNote(note());
    const root = container.querySelector<HTMLElement>(".sn")!;
    root.setPointerCapture = () => {};
    root.releasePointerCapture = () => {};
    root.hasPointerCapture = () => false;
    fireEvent(root, new PointerEvent("pointerdown", { bubbles: true, clientX: 178, clientY: 60, button: 0 }));
    fireEvent(root, new PointerEvent("pointermove", { bubbles: true, clientX: 238, clientY: 60 }));
    fireEvent(root, new PointerEvent("pointerup", { bubbles: true, clientX: 238, clientY: 60 }));
    expect(annotations()[0]?.size).toEqual({ width: 240, height: 120 });
    expect(container.querySelector("textarea")).toBeNull();
  });

  it("never gets smaller than five cells by two", () => {
    const { container } = renderNote(note());
    const root = container.querySelector<HTMLElement>(".sn")!;
    root.setPointerCapture = () => {};
    root.releasePointerCapture = () => {};
    root.hasPointerCapture = () => false;
    fireEvent(root, new PointerEvent("pointerdown", { bubbles: true, clientX: 178, clientY: 118, button: 0 }));
    fireEvent(root, new PointerEvent("pointermove", { bubbles: true, clientX: 0, clientY: 0 }));
    fireEvent(root, new PointerEvent("pointerup", { bubbles: true, clientX: 0, clientY: 0 }));
    expect(annotations()[0]?.size).toEqual({ width: 100, height: 40 });
  });

  it("right-click opens the menu with the mod's rows; colour and delete work", () => {
    const { container } = renderNote(note());
    fireEvent.contextMenu(container.querySelector(".sn")!, { clientX: 50, clientY: 50 });
    const rows = () => Array.from(document.querySelectorAll("[role^=menuitem]")).map((b) => b.textContent);
    expect(rows()).toEqual(["Write on it", "Colour...", "Bigger text14 px", "Smaller text", "Delete note"]);
    fireEvent.click(document.querySelectorAll("[role^=menuitem]")[1]!);
    expect(rows().slice(0, 4)).toEqual(["Yellow", "Orange", "Pink", "Red"]);
    expect(document.querySelector("[role^=menuitem]")!.hasAttribute("data-checked")).toBe(true);
    fireEvent.click(Array.from(document.querySelectorAll("[role^=menuitem]")).find((b) => b.textContent === "Pink")!);
    expect(annotations()[0]?.colorTag).toBe("pink");
    expect(document.querySelectorAll('[role="menu"]')).toHaveLength(0);
    fireEvent.contextMenu(container.querySelector(".sn")!, { clientX: 50, clientY: 50 });
    fireEvent.click(Array.from(document.querySelectorAll("[role^=menuitem]")).find((b) => b.textContent === "Delete note")!);
    expect(annotations()).toHaveLength(0);
  });

  it("a read-only board lets a note be read, not changed", () => {
    const { container } = renderNote(note());
    act(() => useFactoryStore.setState({ isReadOnly: true }));
    click(container.querySelector<HTMLElement>(".sn")!, 60, 60);
    expect(container.querySelector("textarea")).toBeNull();
    fireEvent.contextMenu(container.querySelector(".sn")!);
    expect(document.querySelectorAll('[role="menu"]')).toHaveLength(0);
    act(() => useFactoryStore.setState({ isReadOnly: false }));
  });
});

describe("AnnotationSwitch", () => {
  const mount = (annotation: FactoryAnnotation) => {
    load([annotation], true);
    return render(
      <ReactFlowProvider>
        <AnnotationSwitch {...(props(annotation) as unknown as Parameters<typeof AnnotationSwitch>[0])} />
      </ReactFlowProvider>,
    );
  };

  it("draws a text annotation as a sticky note", () => {
    expect(mount(note()).container.querySelector(".sn")).not.toBeNull();
  });
});

describe("the data", () => {
  it("notes and old annotations share one list; editing a note leaves the others untouched", () => {
    const box: FactoryAnnotation = {
      id: "box1",
      kind: "box",
      colorTag: "cyan",
      position: { x: 20, y: 40 },
      size: { width: 200, height: 100 },
      style: { border: "dashed" },
    };
    const arrow: FactoryAnnotation = {
      id: "a1",
      kind: "arrow",
      position: { x: 0, y: 0 },
      size: { width: 60, height: 60 },
      arrowDirection: "down-right",
    };
    load([box, note(), arrow]);
    const before = JSON.stringify([box, arrow]);
    act(() => {
      useFactoryStore.getState().updateAnnotation("n1", { colorTag: "pink", fontSize: 22 });
      useFactoryStore.getState().updateAnnotation("n1", { text: "hello" });
    });
    const list = annotations();
    expect(JSON.stringify([list[0], list[2]])).toBe(before);
    expect(list[1]).toMatchObject({ kind: "text", colorTag: "pink", fontSize: 22, text: "hello" });
  });
});
