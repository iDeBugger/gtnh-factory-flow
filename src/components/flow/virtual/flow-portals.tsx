import { useLayoutEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useStore, type ReactFlowState } from "@xyflow/react";

/**
 * React Flow's `ViewportPortal` and `EdgeLabelRenderer`, with the target looked up once.
 *
 * React Flow's own find their target with a `querySelector` in a store selector, which runs on every store change:
 * every camera step, for every portal on the board (83 ms of a 2 s zoom at 1,000 cards). Here the target is found
 * when the board's root changes, and kept.
 */
const domNodeOf = (state: ReactFlowState) => state.domNode;

function usePortalTarget(selector: string): HTMLElement | null {
  const domNode = useStore(domNodeOf);
  const [target, setTarget] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (!domNode) {
      setTarget(null);
      return;
    }
    let frame = 0;
    const find = () => {
      const element = domNode.querySelector<HTMLElement>(selector);
      if (element) setTarget(element);
      else frame = requestAnimationFrame(find);
    };
    find();
    return () => cancelAnimationFrame(frame);
  }, [domNode, selector]);
  return target;
}

/** Children drawn in the viewport's own coordinates (React Flow's ViewportPortal). */
export function FlowViewportPortal({ children }: { children: ReactNode }) {
  const target = usePortalTarget(".react-flow__viewport-portal");
  return target ? createPortal(children, target) : null;
}

/** Children drawn in the edge-label layer (React Flow's EdgeLabelRenderer). */
export function FlowEdgeLabelPortal({ children }: { children: ReactNode }) {
  const target = usePortalTarget(".react-flow__edgelabel-renderer");
  return target ? createPortal(children, target) : null;
}
