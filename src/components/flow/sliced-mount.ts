import { useEffect, useMemo, useState } from "react";
import { virtualizationEnabled } from "./virtual/card-virtualizer";

/**
 * A BIG PLAN MOUNTS IN SLICES, NEAREST THE CAMERA FIRST.
 *
 * Mounting 1,000 cards in one React commit is one task of 5-6 s (190,000
 * elements) in which nothing responds, and a second one lands when the
 * measured sizes come back. This hands React Flow the cards a slice at a time
 * instead: the ones around the camera first (about a screen's worth, so the
 * board is usable almost at once), then the rest in a few growing slices.
 *
 * Only the `nodes` and `edges` props of the board are sliced; the project,
 * the router's geometry, the solve and everything keyed on the whole plan
 * keep seeing every card (cards not yet mounted route by their estimated
 * size, as an unmeasured card always has). A wire is handed over once both of
 * its cards are.
 *
 * It applies only to a plan that arrives whole: more than `SLICE_MIN_NODES`
 * cards appearing at once for a board that had none (the first open, a tab
 * switch). Cards added later go straight in. `localStorage
 * ["gtnh-factory-flow.no-slice"] = "1"` turns it off.
 */

export const SLICE_MIN_NODES = 250;
/** The first slice: about a screen and its surroundings. */
export const FIRST_SLICE = 40;
/** Each slice after it is this many times the cards already in. */
export const SLICE_GROWTH = 3;
/** The pause before each slice, for the last one to be drawn and measured. */
const SLICE_PAUSE_MS = 120;

type SliceNode = { id: string; position: { x: number; y: number }; parentId?: string };
type SliceEdge = { source: string; target: string };

function disabled(): boolean {
  // Cards reach React Flow as shells and fill in near the camera first (virtual/card-virtualizer.ts), which is
  // what this was for, without sending the whole board round again for every slice.
  if (virtualizationEnabled()) {
    return true;
  }
  try {
    return window.localStorage.getItem("gtnh-factory-flow.no-slice") === "1";
  } catch {
    return false;
  }
}

/**
 * The order cards mount in: nearest `focus` first (flow space), a card's
 * parent before it. Pure, so it can be tested.
 */
export function sliceOrder(
  nodes: readonly SliceNode[],
  focus: { x: number; y: number },
): string[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const distance = (node: SliceNode) => {
    let { x, y } = node.position;
    // Members of an open board are frame-relative: walk up to flow space.
    for (let parent = node.parentId ? byId.get(node.parentId) : undefined, hops = 0; parent && hops < 8; hops++) {
      x += parent.position.x;
      y += parent.position.y;
      parent = parent.parentId ? byId.get(parent.parentId) : undefined;
    }
    return Math.hypot(x - focus.x, y - focus.y);
  };
  const ranked = nodes
    .map((node) => [distance(node), node] as const)
    .sort((a, b) => a[0] - b[0] || (a[1].id < b[1].id ? -1 : 1));
  const order: string[] = [];
  const seen = new Set<string>();
  const add = (node: SliceNode, depth = 0) => {
    if (seen.has(node.id)) {
      return;
    }
    const parent = node.parentId ? byId.get(node.parentId) : undefined;
    if (parent && depth < 8) {
      add(parent, depth + 1);
    }
    seen.add(node.id);
    order.push(node.id);
  };
  for (const [, node] of ranked) {
    add(node);
  }
  return order;
}

/**
 * How many cards are in after the next slice, given how many are in now.
 *
 * Slices GROW rather than stay small: every slice makes React Flow measure
 * the new cards, which sends the whole board (geometry, route solve, wires)
 * round again, so a thousand cards in slices of 24 took 33 s instead of 5.
 * Growing by a factor keeps it to a handful of passes (40, 160, 640, all).
 */
export function nextSliceCount(count: number, total: number): number {
  return Math.min(total, Math.max(FIRST_SLICE, count * (1 + SLICE_GROWTH)));
}

/**
 * `nodes` and `edges` as the board should mount them now. `key` names the
 * board (the plan's id): a new key with a big plan starts a new slicing.
 * `focus` says where the camera is, in flow space, when slicing starts.
 */
export function useSlicedMount<N extends SliceNode, E extends SliceEdge>(
  nodes: N[],
  edges: E[],
  key: string | undefined,
  focus: () => { x: number; y: number } | undefined,
): { nodes: N[]; edges: E[] } {
  // The ids in mount order and how many are in, for the plan being sliced.
  const [slicing, setSlicing] = useState<
    { key: string | undefined; order: string[]; count: number } | undefined
  >();
  // What the last render saw, to tell a plan arriving from a card added.
  const [seen, setSeen] = useState<{ key: string | undefined; count: number }>({
    key: undefined,
    count: 0,
  });
  // Decided DURING the render that first sees the plan (derived state: React
  // throws this render away and renders again), because an effect would run
  // after the commit that had already mounted every card.
  let current = slicing;
  if (seen.key !== key || seen.count !== nodes.length) {
    setSeen({ key, count: nodes.length });
    const arrived = nodes.length >= SLICE_MIN_NODES;
    const fresh = seen.key !== key || seen.count < SLICE_MIN_NODES / 2;
    if (arrived && fresh && !disabled()) {
      const order = sliceOrder(nodes, focus() ?? centroid(nodes));
      current = { key, order, count: Math.min(order.length, FIRST_SLICE) };
      setSlicing(current);
    }
  }

  // The next slice goes in once the last one has had time to be drawn and
  // measured, until every card is in.
  useEffect(() => {
    if (!slicing || slicing.count >= slicing.order.length) {
      return;
    }
    const timer = window.setTimeout(() => {
      setSlicing((now) =>
        now === slicing
          ? { ...now, count: nextSliceCount(now.count, now.order.length) }
          : now,
      );
    }, SLICE_PAUSE_MS);
    return () => window.clearTimeout(timer);
  }, [slicing]);

  return useMemo(() => {
    if (!current || current.key !== key || current.count >= current.order.length) {
      return { nodes, edges };
    }
    const mounted = new Set(current.order.slice(0, current.count));
    const known = new Set(current.order);
    // Cards the slicing never heard of (added since) go straight in.
    const shownNodes = nodes.filter((node) => mounted.has(node.id) || !known.has(node.id));
    const shown = new Set(shownNodes.map((node) => node.id));
    const shownEdges = edges.filter((edge) => shown.has(edge.source) && shown.has(edge.target));
    return { nodes: shownNodes, edges: shownEdges };
  }, [current, key, nodes, edges]);
}

function centroid(nodes: readonly SliceNode[]): { x: number; y: number } {
  let x = 0;
  let y = 0;
  for (const node of nodes) {
    x += node.position.x;
    y += node.position.y;
  }
  const n = Math.max(1, nodes.length);
  return { x: x / n, y: y / n };
}
