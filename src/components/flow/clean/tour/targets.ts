import { useFactoryStore } from "@/store/factory-store";
import { glanceLeaveZoom } from "../../node-detail";
import { boardZoomScale } from "@/lib/ui-scale";
import { draws } from "./cursor";
import type { Rect } from "./placement";
import { hitTest } from "./input";
import { getBoardBridge } from "./TourBridge";

/**
 * Everything the tour points at is found by name, afresh each time it is asked (cards move, menus open and close),
 * never held. A target is a function that gives the element now, or null. A board target that is off the visible
 * board pans the board to it first, so the cursor never clicks what cannot be seen.
 */

export type Target = () => Element | null;

export function rectOf(el: Element): Rect {
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.top, w: r.width, h: r.height };
}

export function visible(el: Element | null): el is Element {
  if (!el || !el.isConnected) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

/** The first visible element matching the selector. */
export function css(selector: string, root?: ParentNode): Target {
  return () => {
    // `document` is read when the target runs: css() is called at module load, which the server renders too.
    for (const el of (root ?? document).querySelectorAll(selector)) if (visible(el)) return el;
    return null;
  };
}

/** Whether the element's aria-label or its text (each on its own) matches. */
export function matches(el: Element, re: RegExp): boolean {
  return re.test(el.getAttribute("aria-label") ?? "") || re.test((el.textContent ?? "").trim());
}

/** The first visible element matching the selector whose text or aria-label matches. */
export function textOf(selector: string, re: RegExp, root: () => ParentNode | null = () => document): Target {
  return () => {
    const scope = root();
    if (!scope) return null;
    for (const el of scope.querySelectorAll(selector)) {
      if (!visible(el)) continue;
      if (matches(el, re)) return el;
    }
    return null;
  };
}

/** A target found inside another target's element. */
export function within(parent: Target, selector: string, re?: RegExp): Target {
  return () => {
    const root = parent();
    if (!root) return null;
    for (const el of root.querySelectorAll(selector)) {
      if (!visible(el)) continue;
      if (!re || matches(el, re)) return el;
    }
    return null;
  };
}

/** The element's closest ancestor matching the selector. */
export function closestOf(target: Target, selector: string): Target {
  return () => target()?.closest(selector) ?? null;
}

// region The board

/** The id of the nth card of the plan (in the order it was added). */
export function cardId(index: number): string | undefined {
  return useFactoryStore.getState().project.nodes[index]?.id;
}

export function storageId(index: number): string | undefined {
  return useFactoryStore.getState().project.storages?.[index]?.id;
}

export function nodeEl(id: string | undefined): Element | null {
  if (!id) return null;
  const el = document.querySelector(`.react-flow__node[data-id="${CSS.escape(id)}"]`);
  return visible(el) ? el : null;
}

export const card =
  (index: number): Target =>
  () =>
    nodeEl(cardId(index));

export const drawer =
  (index: number): Target =>
  () =>
    nodeEl(storageId(index));

/** A port row of a card: the row holding the port's handle ("Input: Iron Ingot", "Output: Iron Plate"). */
export const portRow =
  (cardIndex: number, side: "Input" | "Output", name: RegExp | string): Target =>
  () => {
    const root = card(cardIndex)();
    if (!root) return null;
    const re = typeof name === "string" ? new RegExp(`^${side}: ${escapeRe(name)}\\.`) : name;
    for (const handle of root.querySelectorAll(".react-flow__handle[aria-label]")) {
      const label = handle.getAttribute("aria-label") ?? "";
      if (label.startsWith(`${side}: `) && re.test(label)) return handle.closest(".cc-row") ?? handle;
    }
    return null;
  };

export function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export const inRow = (row: Target, selector: string): Target => within(row, selector);

// endregion

/** Waits until the target shows (visible), polling each frame. */
export async function waitFor(target: Target, timeoutMs = 3500, aborted: () => boolean = () => false): Promise<Element | null> {
  const t0 = performance.now();
  for (;;) {
    const el = target();
    if (el) return el;
    if (aborted() || performance.now() - t0 > timeoutMs) return null;
    await draws(1);
  }
}

/** Waits until the element's box has stopped moving for two draws (a card glides, a menu opens). */
export async function settled(target: Target, timeoutMs = 2500): Promise<Element | null> {
  const t0 = performance.now();
  let last = "";
  let still = 0;
  for (;;) {
    const el = target();
    if (el) {
      const r = el.getBoundingClientRect();
      const key = `${Math.round(r.left)},${Math.round(r.top)},${Math.round(r.width)},${Math.round(r.height)}`;
      still = key === last ? still + 1 : 0;
      last = key;
      if (still >= 2) return el;
    } else {
      still = 0;
      last = "";
    }
    if (performance.now() - t0 > timeoutMs) return el;
    await draws(1);
  }
}

/** The centre of an element, in the page's pixels. */
export function centreOf(el: Element): { x: number; y: number } {
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

/**
 * A board element off the visible board pans the board to it (and one hidden behind the overview or the items
 * column does too), so the cursor never clicks what cannot be seen.
 */
export async function bringIntoView(el: Element): Promise<void> {
  const bridge = getBoardBridge();
  const pane = bridge?.paneRect();
  if (!bridge || !pane || !el.closest(".react-flow")) return;
  const r = el.getBoundingClientRect();
  const margin = 24;
  const inside =
    r.left >= pane.left + margin &&
    r.right <= pane.right - margin &&
    r.top >= pane.top + margin &&
    r.bottom <= pane.bottom - margin;
  if (inside) return;
  const v = bridge.viewport();
  if (!v) return;
  const cx = (r.left + r.width / 2 - pane.left - v.x) / v.zoom;
  const cy = (r.top + r.height / 2 - pane.top - v.y) / v.zoom;
  bridge.setCenter(cx, cy);
  await draws(3);
}

/**
 * Zooms the board in to where cards still show their parts, about the middle of the view. Fit on a narrow board
 * can leave the cards in the glance view (no count, no ports to click); a target off the pane is panned to later.
 */
export function keepDetail(): void {
  const bridge = getBoardBridge();
  const pane = bridge?.paneRect();
  const v = bridge?.viewport();
  if (!bridge || !pane || !v) return;
  const floor = (glanceLeaveZoom() + 0.02) * boardZoomScale();
  if (v.zoom >= floor) return;
  bridge.setCenter((pane.width / 2 - v.x) / v.zoom, (pane.height / 2 - v.y) / v.zoom, floor);
}

/** Whether the element is clipped by a scrolling ancestor (a list scrolled past it). */
export function clippedByScroller(el: Element): boolean {
  const r = el.getBoundingClientRect();
  for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
    const o = getComputedStyle(p);
    const pr = p.getBoundingClientRect();
    if (/(auto|scroll|hidden)/.test(o.overflowY) && (r.bottom > pr.bottom + 1 || r.top < pr.top - 1)) return true;
    // A narrow window clips a wide row sideways (a recipe's add key past the search box's right edge).
    if (/(auto|scroll|hidden)/.test(o.overflowX) && (r.right > pr.right + 1 || r.left < pr.left - 1)) return true;
  }
  return r.bottom > window.innerHeight || r.top < 0 || r.right > window.innerWidth || r.left < 0;
}

/** Scrolls a list so the element shows (the recipe search, the items column, a menu). */
export async function scrollToShow(el: Element): Promise<void> {
  if (el.closest('.react-flow') || !clippedByScroller(el)) return;
  (el as HTMLElement).scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' as ScrollBehavior });
  await draws(2);
}

function scrollerOf(el: Element): HTMLElement | null {
  for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
    if (/(auto|scroll)/.test(getComputedStyle(p).overflowY) && p.scrollHeight > p.clientHeight) return p;
  }
  return null;
}

/**
 * Makes sure a press at the element's middle lands on it: something sticky (a list's header bar) may cover it once
 * scrolled into view. The list is put so the element sits in the middle of it, then nudged a little each way from
 * there until the middle is free.
 */
export async function ensureHittable(el: Element): Promise<void> {
  const free = () => {
    const c = centreOf(el);
    const hit = hitTest(c.x, c.y);
    return Boolean(hit && (hit === el || el.contains(hit)));
  };
  if (free()) return;
  const scroller = scrollerOf(el);
  if (!scroller) return;
  const pr = scroller.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  scroller.scrollBy({ top: r.top + r.height / 2 - (pr.top + pr.height * 0.6), behavior: 'instant' as ScrollBehavior });
  await draws(2);
  if (free()) return;
  const home = scroller.scrollTop;
  for (const dy of [40, -40, 80, -80, 120, -120, 180, -180]) {
    scroller.scrollTop = home + dy;
    await draws(2);
    if (free()) return;
  }
  scroller.scrollTop = home;
}
