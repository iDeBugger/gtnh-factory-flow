import { useLayoutEffect, useRef, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { getUiScale } from "@/lib/ui-scale";
import { isWiringConnection } from "../../connection-drag";
import { createRestTracker, handFull, onHandChange, restWait, TIP_WAIT_MS } from "./rest-tracker";
import { readTip, type TipSpec } from "./tip-spec";
import { TipPanel } from "./TipPanel";
import { modKeyTip } from "./board-tips";

/**
 * One tooltip for the whole board (the mod's `Tip` plus `Tip.Wait`). Controls
 * carry `data-tip-id` and `data-tip` (see `tipAttrs`); this host listens on the
 * document, waits until the pointer has rested on the same thing for 0.8 s and
 * draws it in a portal. Moving about on the thing keeps the wait, moving to
 * another thing or off everything resets it, and nothing shows while something
 * is in hand, a button is down, a menu is open or text is being typed.
 */

interface Shown {
  spec: TipSpec;
  /** Real (unzoomed) pointer position. */
  x: number;
  y: number;
  /** The card the tip is about (real pixels): the power panel sits against it, as the mod's does. */
  card?: { left: number; right: number; top: number; bottom: number };
}

let shown: Shown | null = null;
const subscribers = new Set<() => void>();
const tracker = createRestTracker(TIP_WAIT_MS);
let timer: ReturnType<typeof setTimeout> | undefined;
let lastX = 0;
let lastY = 0;
let buttonsDown = false;
let installed = false;

function publish(next: Shown | null): void {
  shown = next;
  for (const subscriber of subscribers) subscriber();
}

function hide(): void {
  if (shown) publish(null);
}

function clearTimer(): void {
  if (timer !== undefined) {
    clearTimeout(timer);
    timer = undefined;
  }
}

function now(): number {
  return performance.now();
}

/** Why a tip may not show right now, if it may not. Pure of the pointer: the gates the spec lists (10.1). */
export function tipBlocked(target: Element | null | undefined): boolean {
  if (handFull() || isWiringConnection() || buttonsDown) return true;
  if (typeof document === "undefined") return true;
  const active = document.activeElement;
  if (active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA" || (active as HTMLElement).isContentEditable)) {
    return true;
  }
  // A menu or popup explains only itself.
  if (document.querySelector('[role="menu"]') && !target?.closest('[role="menu"]')) return true;
  return false;
}

/**
 * On a plan board every browser `title` becomes one of this host's tips (so the top bar, tabs, overview and
 * library wait 0.8 s and stay quiet while something is in hand, like the card's): the text moves into
 * `data-tip` as a title and muted lines, and the native attribute goes so the browser never draws its own.
 * An element that is a rich tooltip's root keeps its rich panel; its duplicate title is only stripped.
 */
let titleCounter = 0;
const titleIds = new WeakMap<Element, string>();

function stamp(element: Element, spec: Omit<TipSpec, "id">): void {
  let id = titleIds.get(element);
  if (!id) {
    id = `title|${++titleCounter}`;
    titleIds.set(element, id);
  }
  element.setAttribute("data-tip", JSON.stringify({ ...spec, id }));
  element.setAttribute("data-tip-id", id);
  element.setAttribute("data-tooltip-stop", "");
}

/** Moves an element's `title` into a tip (the mod's wording when it names the key); true when it now has one. */
function adoptTitle(element: Element): boolean {
  const native = element.getAttribute("title");
  if (native === null) return false;
  element.removeAttribute("title");
  if (element.hasAttribute("data-tooltip-root") || !native.trim()) return false;
  const known = modKeyTip(element.getAttribute("aria-label"));
  if (known) {
    stamp(element, known);
    return true;
  }
  const [title = "", ...rest] = native.split(/\r?\n/);
  stamp(element, {
    title,
    notes: rest.filter((line) => line.trim() !== "").map((text) => ({ text, tone: "muted" as const })),
  });
  return true;
}

/**
 * The nearest element with a tip: one that carries `data-tip-id`, or (plan boards) a titled one, adopted now, or a key
 * the mod words itself (`modKeyTip`, by aria-label).
 */
function tipElement(from: Element | null | undefined): Element | null {
  const plan = restWait() > 0;
  for (let element = from ?? null; element; element = element.parentElement) {
    if (plan && element.hasAttribute("title") && adoptTitle(element)) return element;
    if (element.hasAttribute("data-tip-id")) return element;
    if (plan) {
      const known = modKeyTip(element.getAttribute("aria-label"));
      if (known) {
        stamp(element, known);
        return element;
      }
    }
  }
  return null;
}

function targetAt(x: number, y: number): Element | null {
  const hit = document.elementFromPoint?.(x, y);
  // A port's handle covers its whole row, the Forced strip too: the strip's own tip wins where the mouse is over it.
  const strip = hit?.classList.contains("resource-slot-handle")
    ? hit.parentElement?.querySelector(".cc-forced")
    : null;
  if (strip) {
    const box = strip.getBoundingClientRect();
    if (y >= box.top && y <= box.bottom && x >= box.left && x <= box.right) return tipElement(strip);
  }
  return tipElement(hit);
}

function fire(): void {
  timer = undefined;
  if (!tracker.ready(now())) {
    schedule();
    return;
  }
  const element = targetAt(lastX, lastY);
  if (!element || element.getAttribute("data-tip-id") !== tracker.target() || tipBlocked(element)) return;
  const spec = readTip(element);
  if (spec) {
    const card = spec.panel ? element.closest("[data-node-glance-root]")?.getBoundingClientRect() : undefined;
    publish({ spec, x: lastX, y: lastY, card: card && { left: card.left, right: card.right, top: card.top, bottom: card.bottom } });
  }
}

function schedule(): void {
  clearTimer();
  const wait = tracker.remaining(now());
  if (Number.isFinite(wait)) timer = setTimeout(fire, Math.max(0, wait) + 1);
}

function onMove(event: PointerEvent): void {
  if (event.pointerType === "touch") return;
  lastX = event.clientX;
  lastY = event.clientY;
  buttonsDown = event.buttons !== 0;
  const under = event.target as Element | null;
  const element = under?.classList?.contains("resource-slot-handle") ? targetAt(lastX, lastY) : tipElement(under);
  const id = element?.getAttribute("data-tip-id") ?? undefined;
  const before = tracker.target();
  tracker.point(id, now());
  if (buttonsDown || !id || handFull() || isWiringConnection()) {
    clearTimer();
    hide();
    if (buttonsDown) tracker.restart(now());
    return;
  }
  if (shown) {
    if (shown.spec.id === id) {
      publish({ ...shown, x: lastX, y: lastY });
      return;
    }
    hide();
  }
  if (id !== before || timer === undefined) schedule();
}

function onDown(): void {
  buttonsDown = true;
  clearTimer();
  hide();
  tracker.restart(now());
}

function onUp(event: PointerEvent): void {
  buttonsDown = false;
  tracker.restart(now());
  onMove(event);
}

function reset(): void {
  clearTimer();
  hide();
  tracker.point(undefined, now());
}

function PanelView() {
  const state = useSyncExternalStore(
    (listener) => {
      subscribers.add(listener);
      return () => subscribers.delete(listener);
    },
    () => shown,
    () => null,
  );
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!state || !element) return;
    // The panel is a body portal wearing .ui-zoom: its box is in shell pixels, the pointer in real ones.
    const scale = getUiScale();
    const w = element.offsetWidth;
    const h = element.offsetHeight;
    const vw = window.innerWidth / scale;
    const vh = window.innerHeight / scale;
    let x = state.x / scale + 12;
    if (x + w > vw - 4) x = state.x / scale - 12 - w;
    let y = state.y / scale + 12;
    if (y + h > vh - 4) y = state.y / scale - 12 - h;
    if (state.card && state.spec.panel) {
      // Above the card, right edges aligned (the guide to the chips beside the panel, kept on screen); below it when
      // there is no room above; failing both, by the pointer so it stays in sight.
      const guide = element.lastElementChild instanceof HTMLElement ? element.lastElementChild.offsetWidth + 4 : 0;
      x = Math.max(2, Math.min(state.card.right / scale - (w - guide), vw - w - 4));
      y = state.card.top / scale - 6 - h;
      if (y < 2) {
        const under = state.card.bottom / scale + 6;
        y = under + h <= vh ? under : Math.max(2, Math.min(state.y / scale - h - 12, vh - h - 4));
      }
    }
    element.style.left = `${Math.max(4, x)}px`;
    element.style.top = `${Math.max(4, y)}px`;
    element.style.visibility = "visible";
  });
  if (!state) return null;
  return <TipPanel ref={ref} spec={state.spec} style={{ left: 0, top: 0, visibility: "hidden" }} />;
}

/** Installs the one tooltip host. Idempotent; the first clean card calls it. */
export function ensureTipHost(): void {
  if (installed || typeof document === "undefined") return;
  installed = true;
  const mount = document.createElement("div");
  mount.setAttribute("data-clean-tip-host", "");
  document.body.appendChild(mount);
  createRoot(mount).render(<PanelView />);
  const capture = { capture: true, passive: true } as const;
  document.addEventListener("pointermove", onMove, capture);
  document.addEventListener("pointerdown", onDown, capture);
  document.addEventListener("pointerup", onUp, capture);
  document.addEventListener("pointercancel", reset, capture);
  document.addEventListener("wheel", reset, capture);
  document.addEventListener("contextmenu", reset, capture);
  document.addEventListener("keydown", reset, capture);
  document.documentElement.addEventListener("pointerleave", reset);
  window.addEventListener("blur", reset);
  onHandChange(reset);
}
