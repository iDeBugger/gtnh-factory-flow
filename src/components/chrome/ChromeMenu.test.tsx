// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ChromeMenu, SUBMENU_HOVER_MS, type MenuEntry } from "./ChromeMenu";

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const anchor = { left: 10, top: 10, bottom: 30, right: 60 };
const picked = vi.fn();
const entries = (): MenuEntry[] => [
  { label: "Rename", onSelect: () => picked("rename") },
  { label: "Copy plan code", onSelect: () => picked("copy") },
  {
    label: "Convert to",
    detail: "as a new plan",
    onSelect: () => picked("convert row"),
    submenu: [
      { label: "GTNH 2.9", detail: "this plan", current: true, disabled: true, onSelect: () => picked("2.9") },
      { label: "GTNH 2.8.1", onSelect: () => picked("2.8.1") },
      { label: "GTNH 3", onSelect: () => picked("3") },
    ],
  },
  { label: "Delete plan", tone: "red", onSelect: () => picked("delete") },
];

function open(onClose = vi.fn()) {
  render(<ChromeMenu anchor={anchor} entries={entries()} label="Plan options" onClose={onClose} />);
  return onClose;
}
const row = (label: string) =>
  [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((element) =>
    element.textContent?.startsWith(label),
  )!;
const sub = () => document.querySelector<HTMLElement>('[role="menu"] [role="menu"]');
// React builds pointerenter from pointerover; the mouse's own pointer type rides on it.
const mouseOver = (element: Element) => fireEvent.pointerOver(element, { pointerType: "mouse" });
const press = (element: Element, pointerType: string) => {
  fireEvent.pointerDown(element, { pointerType });
  fireEvent.click(element);
};
const wait = (ms: number) => act(() => vi.advanceTimersByTime(ms));

describe("a ChromeMenu row with a submenu", () => {
  it("a mouse click after the hover opened it keeps it open", () => {
    open();
    mouseOver(row("Convert to"));
    expect(sub()).toBeNull();
    wait(SUBMENU_HOVER_MS);
    expect(sub()).not.toBeNull();
    // The click lands in a later render than the hover: it must not toggle the submenu shut.
    press(row("Convert to"), "mouse");
    expect(sub()).not.toBeNull();
    press(row("Convert to"), "mouse");
    expect(sub()).not.toBeNull();
    expect(row("Convert to").getAttribute("aria-expanded")).toBe("true");
  });

  it("a touch or pen press toggles it", () => {
    open();
    press(row("Convert to"), "touch");
    expect(sub()).not.toBeNull();
    press(row("Convert to"), "touch");
    expect(sub()).toBeNull();
    press(row("Convert to"), "pen");
    expect(sub()).not.toBeNull();
  });

  it("a diagonal move across another row reaches the submenu; resting on another row shuts it", () => {
    open();
    mouseOver(row("Convert to"));
    wait(SUBMENU_HOVER_MS);
    mouseOver(row("Delete plan"));
    wait(SUBMENU_HOVER_MS / 2);
    mouseOver(row("GTNH 2.8.1"));
    wait(SUBMENU_HOVER_MS * 2);
    expect(sub()).not.toBeNull();
    mouseOver(row("Delete plan"));
    wait(SUBMENU_HOVER_MS);
    expect(sub()).toBeNull();
  });

  it("names its submenu with aria-controls", () => {
    open();
    press(row("Convert to"), "mouse");
    const id = row("Convert to").getAttribute("aria-controls");
    expect(id).toBeTruthy();
    expect(sub()?.id).toBe(id);
  });

  it("picking a submenu row closes the whole menu and does what it says; the plan's own version does nothing", () => {
    picked.mockClear();
    const onClose = open();
    press(row("Convert to"), "mouse");
    press(row("GTNH 2.9"), "mouse");
    expect(picked).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    press(row("GTNH 2.8.1"), "mouse");
    expect(picked).toHaveBeenCalledWith("2.8.1");
    expect(onClose).toHaveBeenCalled();
  });
});

describe("a ChromeMenu from the keyboard", () => {
  it("its arrows never reach the window (the board would pan and close it), and they reach Convert to", () => {
    const seen: string[] = [];
    const listener = (event: KeyboardEvent) => seen.push(event.key);
    window.addEventListener("keydown", listener);
    try {
      const onClose = open();
      expect(document.activeElement).toBe(row("Rename"));
      fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
      fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
      expect(document.activeElement).toBe(row("Convert to"));
      fireEvent.keyDown(document.activeElement!, { key: "ArrowRight" });
      expect(document.activeElement).toBe(row("GTNH 2.8.1"));
      fireEvent.keyDown(document.activeElement!, { key: "End" });
      expect(document.activeElement).toBe(row("GTNH 3"));
      fireEvent.keyDown(document.activeElement!, { key: "Home" });
      expect(document.activeElement).toBe(row("GTNH 2.8.1"));
      fireEvent.keyDown(document.activeElement!, { key: "ArrowUp" });
      expect(document.activeElement).toBe(row("GTNH 3"));
      fireEvent.keyDown(document.activeElement!, { key: "ArrowLeft" });
      expect(sub()).toBeNull();
      expect(document.activeElement).toBe(row("Convert to"));
      fireEvent.keyDown(document.activeElement!, { key: "End" });
      expect(document.activeElement).toBe(row("Delete plan"));
      expect(seen).toEqual([]);
      expect(onClose).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("keydown", listener);
    }
  });

  it("Right moves focus into a submenu the mouse opened", () => {
    open();
    mouseOver(row("Convert to"));
    wait(SUBMENU_HOVER_MS);
    row("Convert to").focus();
    fireEvent.keyDown(row("Convert to"), { key: "ArrowRight" });
    expect(document.activeElement).toBe(row("GTNH 2.8.1"));
  });

  it("focus in a submenu the mouse then shuts goes back to its row, not the page", () => {
    open();
    row("Convert to").focus();
    fireEvent.keyDown(row("Convert to"), { key: "Enter" });
    expect(document.activeElement).toBe(row("GTNH 2.8.1"));
    mouseOver(row("Rename"));
    wait(SUBMENU_HOVER_MS);
    expect(sub()).toBeNull();
    expect(document.activeElement).toBe(row("Convert to"));
  });
});
