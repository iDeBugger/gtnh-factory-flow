import { useFactoryStore } from "@/store/factory-store";
import { useDesignStore } from "@/store/design-store";
import type { Pt } from "./director";
import {
  card,
  closestOf,
  css,
  escapeRe,
  portRow,
  rectOf,
  textOf,
  visible,
  within,
  type Target,
} from "./targets";
import { getBoardBridge } from "./TourBridge";

/**
 * Where the script's steps point, by name, for the website's planner: the items column, the recipe search, a
 * card's parts and ports, a drawer's parts, the overview rail, the top bar's keys, menus. Each looks again every
 * time it is asked. Where two places could be meant, the one the plan's first card or drawer sits at wins.
 */

const q = (selector: string): Element | null => {
  for (const el of document.querySelectorAll(selector)) if (visible(el)) return el;
  return null;
};

// region The items column and the recipe search

export const itemsSearch: Target = () => q('input[aria-label="Search items and fluids"]');

export const itemTile =
  (name: string): Target =>
  () =>
    q(`[role="option"][aria-label="${name.replace(/"/g, '\\"')}"]`);

export const recipeOverlay: Target = closestOf(css('button[aria-label="Close recipe search"]'), ".fixed");

/** A machine's tab on the recipe search's top edge, when its page of tabs is showing. */
export const machineTab = (re: RegExp): Target => textOf("[data-machine-tab]", re, recipeOverlay);

/** Whether the recipe search shows this machine's tab open. */
export function machineTabOpen(re: RegExp): boolean {
  const title = recipeOverlay()?.querySelector("[data-recipe-tab-title]");
  return title !== null && title !== undefined && re.test(title.textContent ?? "");
}

/** One of the recipe search's own keys by its name (Next machines, Next page). */
export const overlayKey =
  (name: string): Target =>
  () => {
    const key = recipeOverlay()?.querySelector(`button[aria-label="${name}"]`) ?? null;
    return key && visible(key) && !(key as HTMLButtonElement).disabled ? key : null;
  };

/** Whether the open page has landed: recipes on it and none still on the way. */
export function recipePageSettled(): boolean {
  const page = recipeOverlay()?.querySelector("[data-recipe-page]");
  return (
    Boolean(page?.querySelector("[data-recipe]")) && !page?.querySelector(".recipe-search-skeleton")
  );
}

/**
 * The "Add recipe node" key of a recipe on the open page of a machine's tab in the recipe search; with `has`, of
 * the recipe whose rows read so (each row's amount and name, run together).
 */
export const addRecipe =
  (machine: RegExp, has?: RegExp): Target =>
  () => {
    const overlay = recipeOverlay();
    if (!overlay || !machineTabOpen(machine)) return null;
    for (const key of overlay.querySelectorAll(
      '[data-recipe-page] [aria-label="Add recipe node"]',
    )) {
      if (!visible(key)) continue;
      if (!has) return key;
      const recipe = key.closest("[data-recipe]");
      if (recipe && has.test(recipe.textContent ?? "")) return key;
    }
    return null;
  };

// endregion

// region The board

/** A spot on the free board, as a fraction of the pane (clear of the corners where keys and the map sit). */
export const boardSpot =
  (fx: number, fy: number): (() => Pt | null) =>
  () => {
    const pane = getBoardBridge()?.paneRect();
    return pane ? { x: pane.left + pane.width * fx, y: pane.top + pane.height * fy } : null;
  };

/** A spot beside a thing: its centre shifted by dx, dy. */
export const beside =
  (target: Target, dx: number, dy: number): (() => Pt | null) =>
  () => {
    const el = target();
    if (!el) return null;
    const r = rectOf(el);
    return { x: r.x + r.w / 2 + dx, y: r.y + r.h / 2 + dy };
  };

/** A spot to the right of a thing, its middle height, `gap` px past its edge (kept on the board). */
export const rightOf =
  (target: Target, gap: number): (() => Pt | null) =>
  () => {
    const el = target();
    if (!el) return null;
    const r = rectOf(el);
    const pane = getBoardBridge()?.paneRect();
    const x = r.x + r.w + gap;
    return { x: pane ? Math.min(x, pane.right - 70) : x, y: r.y + r.h / 2 };
  };

export const leftOf =
  (target: Target, gap: number): (() => Pt | null) =>
  () => {
    const el = target();
    if (!el) return null;
    const r = rectOf(el);
    const pane = getBoardBridge()?.paneRect();
    const x = r.x - gap;
    return { x: pane ? Math.max(x, pane.left + 70) : x, y: r.y + r.h / 2 };
  };

/**
 * A spot beside a thing that is on the board and clear of every card and drawer: to its right, else below, left,
 * above (a narrow board leaves no room on the right, and a drop on a card makes no drawer).
 */
export const clearBeside =
  (target: Target, gap: number): (() => Pt | null) =>
  () => {
    const el = target();
    const pane = getBoardBridge()?.paneRect();
    if (!el || !pane) return null;
    const r = rectOf(el);
    const others = [...document.querySelectorAll(".react-flow__node")].filter(visible).map(rectOf);
    const m = 40;
    const spots: Pt[] = [
      { x: r.x + r.w + gap, y: r.y + r.h / 2 },
      { x: r.x + r.w / 2, y: r.y + r.h + gap },
      { x: r.x - gap, y: r.y + r.h / 2 },
      { x: r.x + r.w / 2, y: r.y - gap },
    ];
    const free = (p: Pt) =>
      p.x >= pane.left + m &&
      p.x <= pane.right - m &&
      p.y >= pane.top + m &&
      p.y <= pane.bottom - m &&
      !others.some((o) => p.x >= o.x - 8 && p.x <= o.x + o.w + 8 && p.y >= o.y - 8 && p.y <= o.y + o.h + 8);
    return spots.find(free) ?? rightOf(target, gap)();
  };

/** Where a drag from the head of card B must end to leave B just under card A (a clone put right). */
export const underCard =
  (a: Target, b: Target, headOfB: Target, gapPx = 50): (() => Pt | null) =>
  () => {
    const ea = a();
    const eb = b();
    const h = headOfB();
    if (!ea || !eb || !h) return null;
    const ra = rectOf(ea);
    const rb = rectOf(eb);
    const rh = rectOf(h);
    return { x: rh.x + rh.w / 2 + (ra.x - rb.x), y: rh.y + rh.h / 2 + (ra.y + ra.h + gapPx - rb.y) };
  };

/** A point inside a thing at a fraction of its box. */
export const pointIn =
  (target: Target, fx: number, fy: number): (() => Pt | null) =>
  () => {
    const el = target();
    if (!el) return null;
    const r = rectOf(el);
    return { x: r.x + r.w * fx, y: r.y + r.h * fy };
  };

/** The rectangle that holds both things (a note about two keys). */
export const around =
  (...targets: Target[]): Target =>
  () => {
    const els = targets.map((t) => t()).filter((e): e is Element => e !== null);
    if (els.length === 0) return null;
    if (els.length === 1) return els[0]!;
    const rects = els.map(rectOf);
    const x0 = Math.min(...rects.map((r) => r.x));
    const y0 = Math.min(...rects.map((r) => r.y));
    const x1 = Math.max(...rects.map((r) => r.x + r.w));
    const y1 = Math.max(...rects.map((r) => r.y + r.h));
    // A box element standing for them, kept in the tour's own layer so hit tests never land on it.
    let box = document.querySelector<HTMLElement>("[data-tour-box]");
    if (!box) {
      box = document.createElement("div");
      box.dataset.tourBox = "";
      box.dataset.tour = "box";
      box.style.cssText = "position:fixed;pointer-events:none;visibility:hidden";
      (document.querySelector("[data-tour='layer']") ?? document.body).append(box);
    }
    box.style.left = `${x0}px`;
    box.style.top = `${y0}px`;
    box.style.width = `${x1 - x0}px`;
    box.style.height = `${y1 - y0}px`;
    return box;
  };

/** The card's name key, tier chip, count, gear, menu, picture, power row. */
export const cardPart =
  (index: number, part: "name" | "tier" | "count" | "gear" | "menu" | "power" | "picture" | "head"): Target =>
  () => {
    const root = card(index)();
    if (!root) return null;
    const sel = {
      name: ".cc-name",
      tier: '.cc-chip[aria-label^="Tier"]',
      count: ".cc-count",
      gear: '[aria-label="Machine settings"]',
      menu: '[aria-label="Card actions"]',
      picture: ".cc-pic",
      head: ".cc-head",
      power: ".cc-bolt",
    }[part];
    const el = root.querySelector(sel);
    if (!el || !visible(el)) return null;
    return part === "power" ? (el.closest(".cc-row") ?? el) : el;
  };

export const portBox = (cardIndex: number, side: "Input" | "Output", name: string): Target =>
  within(portRow(cardIndex, side, name), ".cc-prb");

export const portKey = (cardIndex: number, side: "Input" | "Output", name: string): Target =>
  within(portRow(cardIndex, side, name), ".cc-prk");

export const portHandle =
  (cardIndex: number, side: "Input" | "Output", name: string): Target =>
  () => {
    const root = card(cardIndex)();
    if (!root) return null;
    const re = new RegExp(`^${side}: ${escapeRe(name)}\\.`);
    for (const h of root.querySelectorAll(".react-flow__handle[aria-label]")) {
      if (re.test(h.getAttribute("aria-label") ?? "") && visible(h)) return h;
    }
    return null;
  };

export const storageEl =
  (index: number): Target =>
  () => {
    const id = useFactoryStore.getState().project.storages?.[index]?.id;
    return id ? q(`.react-flow__node[data-id="${CSS.escape(id)}"]`) : null;
  };

/** A drawer found by its resource's name. */
export const drawerOf =
  (name: string): Target =>
  () => {
    for (const el of document.querySelectorAll("[data-storage-node-id]")) {
      if (visible(el) && new RegExp(escapeRe(name), "i").test(el.textContent ?? "")) {
        return el.closest(".react-flow__node") ?? el;
      }
    }
    return null;
  };

export const drawerPart =
  (name: string, part: "rule" | "rate" | "delete" | "body"): Target =>
  () => {
    const d = drawerOf(name)();
    if (!d) return null;
    const sel = { rule: "[data-cd-key]", rate: ".cd-box", delete: ".cd-del", body: ".cd-body" }[part];
    const el = d.querySelector(sel);
    return el && visible(el) ? el : null;
  };

/** A card's Forced row at a port (what the plan brings in or sends out there anyway). */
export const forcedRow = (cardIndex: number, side: "Input" | "Output", name: string): Target =>
  within(portRow(cardIndex, side, name), ".cc-forced");

// endregion

// region The top bar and the chrome

/** A key of the board's toolbars or the app's header by its label or title. */
export const topKey = (re: RegExp): Target => () => {
  for (const el of document.querySelectorAll("button, [role=button]")) {
    if (!visible(el)) continue;
    if (el.closest("[data-tour]")) continue;
    if (re.test(el.getAttribute("aria-label") ?? "") || re.test(el.getAttribute("title") ?? "")) return el;
  }
  return null;
};

/** A key of the mod's top bar (chrome/ModBar), by its id. */
export const barKey =
  (id: string): Target =>
  () =>
    q(`.mb-key[data-mb="${id}"]`);

export const fitKey: Target = barKey("fit");
export const undoKey: Target = barKey("undo");
export const redoKey: Target = barKey("redo");
export const rateUnitKey: Target = barKey("rate");
export const powerUnitKey: Target = barKey("power");
export const libraryKey: Target = barKey("plans");
export const helpKey: Target = barKey("help");

export const railRoot: Target = () => q(".rail-root");
export const railSection = (name: RegExp): Target => textOf(".rail-sec", name, () => railRoot());
export const railLine = (name: RegExp): Target => textOf(".rail-line", name, () => railRoot());

/** The menu or popup the last click opened (a menu role, a listbox, or the card's popover). */
export const openMenu: Target = () => q('[role="menu"]');

/** The card's settings sheet: the smallest box holding both the Settings and the Formulas columns. */
export const settingsSheet: Target = () => {
  let best: Element | null = null;
  let area = Infinity;
  for (const el of document.querySelectorAll("div")) {
    if (!visible(el) || el.closest("[data-tour]")) continue;
    const text = el.textContent ?? "";
    if (!/^Settings/.test(text) || !/Formulas/.test(text)) continue;
    const r = el.getBoundingClientRect();
    if (r.width * r.height < area) {
      area = r.width * r.height;
      best = el;
    }
  }
  return best;
};
export const menuRow = (re: RegExp): Target => () => {
  const menu = openMenu();
  const pool = menu ? [...menu.querySelectorAll("*")] : [...document.querySelectorAll('[role="menuitem"]')];
  for (const el of pool) {
    if (!visible(el)) continue;
    if (el.children.length > 2) continue;
    if (re.test(el.textContent ?? "")) return el;
  }
  return null;
};

// endregion

// region Plan state, for waiting on what the planner does by itself

export function nodeCount(): number {
  return useFactoryStore.getState().project.nodes.length;
}

export function storageCount(): number {
  return useFactoryStore.getState().project.storages?.length ?? 0;
}

export function activePlanName(): string {
  return useFactoryStore.getState().project.name;
}

export function designCount(): number {
  return useDesignStore.getState().designs.length;
}

/** Whether the planner has finished solving (no card reads "(set count)" that has a count to show). */
export function solved(): boolean {
  const result = useFactoryStore.getState().lastResult;
  return !result.stale;
}

// endregion

/** An element found by its own visible text only (an aria-label elsewhere with the same word does not count). */
export const byOwnText =
  (selector: string, re: RegExp): Target =>
  () => {
    for (const el of document.querySelectorAll(selector)) {
      if (!visible(el) || el.closest("[data-tour]")) continue;
      if (re.test((el.textContent ?? "").trim())) return el;
    }
    return null;
  };

/** The top bar's Non-recipe key, which opens the non-recipe machines (the mod's own place for it). */
export const powerKey: Target = barKey("nonrecipe");

/** The overview's block for a resource's spare (forced) flow, with its places and their share bars. */
export const spareBlock = (name: string): Target => textOf(".rail-spare", new RegExp(escapeRe(name)), () => railRoot());

/** The nth place's share bar of a spare block. */
export const spareBar =
  (name: string, index: number): Target =>
  () => {
    const bars = [...(spareBlock(name)()?.querySelectorAll(".rail-spare-bar") ?? [])].filter(visible);
    return bars[index] ?? null;
  };
