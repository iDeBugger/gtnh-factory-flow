import { useReactFlow, useStoreApi } from "@xyflow/react";
import { useEffect } from "react";

/**
 * The tour lives outside React Flow's provider; this hands it the camera and the board's box. Mount it inside the
 * board's ReactFlow (it renders nothing).
 */
export interface BoardBridge {
  setCenter: (x: number, y: number, zoom?: number) => void;
  /** The board's pane, in the page's pixels. */
  paneRect: () => DOMRect | null;
  /** The camera: screen px = flow px * zoom + translate. */
  viewport: () => { x: number; y: number; zoom: number } | null;
  /** Flow-space point to the page's pixels. */
  toScreen: (x: number, y: number) => { x: number; y: number } | null;
}

let bridge: BoardBridge | undefined;

export function getBoardBridge(): BoardBridge | undefined {
  return bridge;
}

export function TourBridge() {
  const flow = useReactFlow();
  const storeApi = useStoreApi();
  useEffect(() => {
    const paneRect = () => storeApi.getState().domNode?.getBoundingClientRect() ?? null;
    const viewport = () => {
      const [x, y, zoom] = storeApi.getState().transform;
      return { x, y, zoom };
    };
    bridge = {
      setCenter: (x, y, zoom) => {
        void flow.setCenter(x, y, { zoom: zoom ?? flow.getZoom(), duration: 0 });
      },
      paneRect,
      viewport,
      toScreen: (x, y) => {
        const rect = paneRect();
        const v = viewport();
        return rect ? { x: rect.left + x * v.zoom + v.x, y: rect.top + y * v.zoom + v.y } : null;
      },
    };
    return () => {
      bridge = undefined;
    };
  }, [flow, storeApi]);
  return null;
}
