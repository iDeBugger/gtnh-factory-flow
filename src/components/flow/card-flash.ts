import { useDesignStore } from "@/store/design-store";
import { useFactoryStore } from "@/store/factory-store";

/**
 * The card reached from a machine list wears a light outline for a second (clean.css, `data-card-flash`), so it can
 * be told apart among many.
 *
 * Imperative on purpose: one lookup of the one React Flow wrapper per click, an attribute on it and a timer. No card
 * subscribes to anything and nothing re-renders. The attribute goes on the wrapper rather than the card because every
 * node keeps its wrapper (culling is off) while a far card's contents are not mounted (virtual/), and React Flow
 * leaves attributes it does not own alone. The value alternates between two keyframe names so a second click while
 * the first runs starts the outline again.
 *
 * The outline ends when its fade does (`animationend`), not on a clock from the click: a far card is `display: none`
 * until the camera brings it near, CSS starts the fade only then, and a timer from the click would cut it off half
 * faded. Without motion there is no fade, so it ends `CARD_FLASH_MS` after the click. `CARD_FLASH_FALLBACK_MS` ends
 * it whatever happens (a card never shown). Another plan or tab on the board ends it at once: React Flow keeps the
 * wrapper of a node with the same id, and a converted copy keeps its ids. Those two subscriptions live only while
 * an outline shows.
 */

/** How long the outline lasts; clean.css's animation runs the same time. */
export const CARD_FLASH_MS = 1000;
/** The latest it ends: the camera's flight (420 ms) and the fade, with room to spare. */
export const CARD_FLASH_FALLBACK_MS = 2500;
export const CARD_FLASH_ATTRIBUTE = "data-card-flash";

let flashed: Element | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
let phase: "a" | "b" = "b";
let release: (() => void) | undefined;

function wrapperOf(nodeId: string, root: ParentNode): Element | null {
  const id = nodeId.replace(/["\\]/g, "\\$&");
  return root.querySelector(`.react-flow__node[data-id="${id}"]`);
}

/** Whether the outline fades: clean.css runs no animation under reduced motion (nor does a page with no media). */
function fades(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** Takes the outline off now. */
export function clearCardFlash(): void {
  if (timer !== undefined) clearTimeout(timer);
  timer = undefined;
  release?.();
  release = undefined;
  flashed?.removeAttribute(CARD_FLASH_ATTRIBUTE);
  flashed = undefined;
}

/** Outlines the card `nodeId` for about a second; another call restarts it. False when the card is not on the board. */
export function flashCard(nodeId: string, root: ParentNode | undefined = globalThis.document): boolean {
  if (!root) return false;
  const wrapper = wrapperOf(nodeId, root);
  clearCardFlash();
  if (!wrapper) return false;
  phase = phase === "a" ? "b" : "a";
  wrapper.setAttribute(CARD_FLASH_ATTRIBUTE, phase);
  flashed = wrapper;

  const fading = fades();
  // Only this flash's fade on the wrapper itself: the card's own animations bubble up through it.
  const fade = `cc-card-flash-${phase}`;
  const onEnd = (event: Event) => {
    if (event.target === wrapper && (event as AnimationEvent).animationName === fade) clearCardFlash();
  };
  if (fading) wrapper.addEventListener("animationend", onEnd);
  const plan = useFactoryStore.getState().project.id;
  const design = useDesignStore.getState().activeDesignId;
  const stopPlan = useFactoryStore.subscribe((state) => {
    if (state.project.id !== plan) clearCardFlash();
  });
  const stopDesign = useDesignStore.subscribe((state) => {
    if (state.activeDesignId !== design) clearCardFlash();
  });
  release = () => {
    wrapper.removeEventListener("animationend", onEnd);
    stopPlan();
    stopDesign();
  };
  timer = setTimeout(clearCardFlash, fading ? CARD_FLASH_FALLBACK_MS : CARD_FLASH_MS);
  return true;
}
