// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDesignStore } from "@/store/design-store";
import { useFactoryStore } from "@/store/factory-store";
import { CARD_FLASH_ATTRIBUTE, CARD_FLASH_FALLBACK_MS, CARD_FLASH_MS, flashCard } from "./card-flash";

function board(...ids: string[]): HTMLElement {
  const root = document.createElement("div");
  root.className = "react-flow__nodes";
  for (const id of ids) {
    const node = document.createElement("div");
    node.className = "react-flow__node";
    node.dataset.id = id;
    root.appendChild(node);
  }
  document.body.appendChild(root);
  return root;
}

const flash = (root: HTMLElement, id: string) =>
  root.querySelector(`[data-id="${id}"]`)!.getAttribute(CARD_FLASH_ATTRIBUTE);

describe("flashCard", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.runAllTimers();
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  it("outlines the card for a second, then takes the outline off", () => {
    const root = board("a", "b");
    expect(flashCard("b")).toBe(true);
    expect(flash(root, "b")).not.toBeNull();
    expect(flash(root, "a")).toBeNull();
    vi.advanceTimersByTime(CARD_FLASH_MS - 1);
    expect(flash(root, "b")).not.toBeNull();
    vi.advanceTimersByTime(1);
    expect(flash(root, "b")).toBeNull();
  });

  it("restarts on a second click: a new animation name and a full second again", () => {
    const root = board("a");
    flashCard("a");
    const first = flash(root, "a");
    vi.advanceTimersByTime(600);
    flashCard("a");
    const second = flash(root, "a");
    expect(second).not.toBeNull();
    expect(second).not.toBe(first);
    vi.advanceTimersByTime(CARD_FLASH_MS - 1);
    expect(flash(root, "a")).toBe(second);
    vi.advanceTimersByTime(1);
    expect(flash(root, "a")).toBeNull();
  });

  it("moves the outline when another card is reached", () => {
    const root = board("a", "b");
    flashCard("a");
    flashCard("b");
    expect(flash(root, "a")).toBeNull();
    expect(flash(root, "b")).not.toBeNull();
  });

  it("finds ids that need escaping and answers false for a card not on the board", () => {
    const root = board('odd"id');
    expect(flashCard('odd"id')).toBe(true);
    expect(flash(root, 'odd\\"id')).not.toBeNull();
    expect(flashCard("missing")).toBe(false);
    expect(flash(root, 'odd\\"id')).toBeNull();
  });

  it("goes at once when another tab or plan comes onto the board, where a card of the same id would wear it", () => {
    const root = board("a");
    useDesignStore.setState({ activeDesignId: "tab-1" });
    flashCard("a");
    useDesignStore.setState({ activeDesignId: "tab-2" });
    expect(flash(root, "a")).toBeNull();

    flashCard("a");
    const project = useFactoryStore.getState().project;
    useFactoryStore.setState({ project: { ...project, id: `${project.id}-other` } });
    expect(flash(root, "a")).toBeNull();
    useFactoryStore.setState({ project });

    // An edit to the same plan keeps it.
    flashCard("a");
    useFactoryStore.setState({ project: { ...useFactoryStore.getState().project, name: "Edited" } });
    expect(flash(root, "a")).not.toBeNull();
    useFactoryStore.setState({ project });
  });

  describe("where the outline fades", () => {
    const realMatchMedia = window.matchMedia;
    beforeEach(() => {
      window.matchMedia = ((query: string) => ({ matches: false, media: query })) as unknown as typeof window.matchMedia;
    });
    afterEach(() => {
      window.matchMedia = realMatchMedia;
    });
    const ended = (target: Element, animationName: string) => {
      const event = new Event("animationend", { bubbles: true });
      Object.defineProperty(event, "animationName", { value: animationName });
      target.dispatchEvent(event);
    };

    it("ends when its fade ends, not a second after the click: a far card's fade starts only when it is shown", () => {
      const root = board("a");
      const wrapper = root.querySelector('[data-id="a"]')!;
      flashCard("a");
      const name = `cc-card-flash-${flash(root, "a")}`;
      vi.advanceTimersByTime(CARD_FLASH_MS + 400);
      expect(flash(root, "a")).not.toBeNull();
      // The card's own animations bubble through the wrapper; another animation on it is not the fade.
      const inner = document.createElement("div");
      wrapper.appendChild(inner);
      ended(inner, name);
      ended(wrapper, "cc-glance-in");
      expect(flash(root, "a")).not.toBeNull();
      ended(wrapper, name);
      expect(flash(root, "a")).toBeNull();
    });

    it("ends anyway when the fade never runs (a card never shown)", () => {
      const root = board("a");
      flashCard("a");
      vi.advanceTimersByTime(CARD_FLASH_FALLBACK_MS - 1);
      expect(flash(root, "a")).not.toBeNull();
      vi.advanceTimersByTime(1);
      expect(flash(root, "a")).toBeNull();
    });

    it("a restart is not ended by the fade it replaced", () => {
      const root = board("a");
      const wrapper = root.querySelector('[data-id="a"]')!;
      flashCard("a");
      const first = `cc-card-flash-${flash(root, "a")}`;
      flashCard("a");
      const wrapperListeners = flash(root, "a");
      ended(wrapper, first);
      // The first listener went with the first flash; the second fade is still to end.
      expect(flash(root, "a")).toBe(wrapperListeners);
      ended(wrapper, `cc-card-flash-${wrapperListeners}`);
      expect(flash(root, "a")).toBeNull();
    });
  });
});
