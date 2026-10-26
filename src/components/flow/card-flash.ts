/**
 * The card reached from a machine list wears a light outline for a second (clean.css, `data-card-flash`), so it can
 * be told apart among many.
 *
 * Imperative on purpose: one lookup of the one React Flow wrapper per click, an attribute on it and a timer. No card
 * subscribes to anything and nothing re-renders. The attribute goes on the wrapper rather than the card because every
 * node keeps its wrapper (culling is off) while a far card's contents are not mounted (virtual/), and React Flow
 * leaves attributes it does not own alone. The value alternates between two keyframe names so a second click while
 * the first runs starts the outline again.
 */

/** How long the outline lasts; clean.css's animation runs the same time. */
export const CARD_FLASH_MS = 1000;
export const CARD_FLASH_ATTRIBUTE = "data-card-flash";

let flashed: Element | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
let phase: "a" | "b" = "b";

function wrapperOf(nodeId: string, root: ParentNode): Element | null {
  const id = nodeId.replace(/["\\]/g, "\\$&");
  return root.querySelector(`.react-flow__node[data-id="${id}"]`);
}

function clear(): void {
  if (timer !== undefined) clearTimeout(timer);
  timer = undefined;
  flashed?.removeAttribute(CARD_FLASH_ATTRIBUTE);
  flashed = undefined;
}

/** Outlines the card `nodeId` for `CARD_FLASH_MS`; another call restarts it. False when the card is not on the board. */
export function flashCard(nodeId: string, root: ParentNode | undefined = globalThis.document): boolean {
  if (!root) return false;
  const wrapper = wrapperOf(nodeId, root);
  clear();
  if (!wrapper) return false;
  phase = phase === "a" ? "b" : "a";
  wrapper.setAttribute(CARD_FLASH_ATTRIBUTE, phase);
  flashed = wrapper;
  timer = setTimeout(clear, CARD_FLASH_MS);
  return true;
}
