import { useReactFlow } from "@xyflow/react";
import { useRef, type PointerEvent as ReactPointerEvent } from "react";
import type { FactoryPocket } from "@/lib/model/types";
import {
  BOARD_GRID,
  BOARD_WINDOW_FIT_PAD,
  BOARD_WINDOW_MIN_HEIGHT,
  BOARD_WINDOW_MIN_WIDTH,
  BOARD_WINDOW_TITLE_HEIGHT,
} from "@/lib/board-grid";
import { useFactoryStore } from "@/store/factory-store";
import { publishBoardResizeDraft } from "../../board-resize";
import { rectsOverlap, type PlacementRect } from "../../board-placement";

export type ResizeSide = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

/**
 * Dragging a frame's edge or corner: follows the pointer live (a draft), never cuts into the frame's own members
 * (a cell of padding kept, the title strip too), never crosses anything outside, and lands once on release.
 */
export function useBoardResize(
  pocket: FactoryPocket,
  frameWidth: number,
  frameHeight: number,
): (side: ResizeSide, event: ReactPointerEvent<HTMLElement>) => void {
  const setPocketFrame = useFactoryStore((state) => state.setPocketFrame);
  const { getZoom, getNodes, getInternalNode } = useReactFlow();
  // A resize follows the pointer live and lands in the store once, on
  // release. The DRAFT carries a whole frame, not just a size: dragging the
  // top or left wall moves the origin too, and the board applies both halves
  // together (see board-resize.ts).
  const draftRef = useRef<{ position: { x: number; y: number }; size: { width: number; height: number } } | undefined>(
    undefined,
  );

  const beginResize = (side: ResizeSide, event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const startClient = { x: event.clientX, y: event.clientY };

    // Everything the walls have to respect, measured once at grab time.
    // React Flow gives child positions relative to their parent, so the
    // frame's own absolute origin turns the whole board into one space.
    const self = getInternalNode(pocket.id);
    const frameOrigin = self?.internals.positionAbsolute ?? { x: 0, y: 0 };
    const parentOrigin = {
      x: frameOrigin.x - pocket.position.x,
      y: frameOrigin.y - pocket.position.y,
    };
    const start = {
      left: frameOrigin.x,
      top: frameOrigin.y,
      right: frameOrigin.x + frameWidth,
      bottom: frameOrigin.y + frameHeight,
    };

    // What the board holds: no wall may cut into it.
    const holds = { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity };
    // What stands outside: no wall may cross it.
    const blockers: PlacementRect[] = [];
    const isInside = (nodeId: string): boolean => {
      let cursor = getInternalNode(nodeId)?.parentId;
      const seen = new Set<string>();
      while (cursor !== undefined && !seen.has(cursor)) {
        if (cursor === pocket.id) {
          return true;
        }
        seen.add(cursor);
        cursor = getInternalNode(cursor)?.parentId;
      }
      return false;
    };
    for (const other of getNodes()) {
      if (other.id === pocket.id || other.type === "annotationNode") {
        continue;
      }
      const internal = getInternalNode(other.id);
      const absolute = internal?.internals.positionAbsolute;
      const size = {
        width: internal?.measured?.width ?? 0,
        height: internal?.measured?.height ?? 0,
      };
      if (!absolute || size.width <= 0 || size.height <= 0) {
        continue;
      }
      if (isInside(other.id)) {
        holds.left = Math.min(holds.left, absolute.x);
        holds.top = Math.min(holds.top, absolute.y);
        holds.right = Math.max(holds.right, absolute.x + size.width);
        holds.bottom = Math.max(holds.bottom, absolute.y + size.height);
        continue;
      }
      blockers.push({ x: absolute.x, y: absolute.y, width: size.width, height: size.height });
    }

    const pulls = {
      left: side === "w" || side === "nw" || side === "sw",
      right: side === "e" || side === "ne" || side === "se",
      top: side === "n" || side === "nw" || side === "ne",
      bottom: side === "s" || side === "sw" || side === "se",
    };

    const handleMove = (move: PointerEvent) => {
      const zoom = getZoom() || 1;
      const dx = (move.clientX - startClient.x) / zoom;
      const dy = (move.clientY - startClient.y) / zoom;
      const snap = (value: number) => Math.round(value / BOARD_GRID) * BOARD_GRID;

      let left = pulls.left ? snap(start.left + dx) : start.left;
      let right = pulls.right ? snap(start.right + dx) : start.right;
      let top = pulls.top ? snap(start.top + dy) : start.top;
      let bottom = pulls.bottom ? snap(start.bottom + dy) : start.bottom;

      // A wall never cuts into the board's own cards, and never shrinks the
      // window below the smallest a window may be.
      if (pulls.left) {
        if (holds.left !== Infinity) {
          left = Math.min(left, holds.left - BOARD_WINDOW_FIT_PAD);
        }
        left = Math.min(left, right - BOARD_WINDOW_MIN_WIDTH);
      }
      if (pulls.right) {
        if (holds.right !== -Infinity) {
          right = Math.max(right, holds.right + BOARD_WINDOW_FIT_PAD);
        }
        right = Math.max(right, left + BOARD_WINDOW_MIN_WIDTH);
      }
      if (pulls.top) {
        if (holds.top !== Infinity) {
          top = Math.min(top, holds.top - BOARD_WINDOW_TITLE_HEIGHT - BOARD_WINDOW_FIT_PAD);
        }
        top = Math.min(top, bottom - BOARD_WINDOW_MIN_HEIGHT);
      }
      if (pulls.bottom) {
        if (holds.bottom !== -Infinity) {
          bottom = Math.max(bottom, holds.bottom + BOARD_WINDOW_FIT_PAD);
        }
        bottom = Math.max(bottom, top + BOARD_WINDOW_MIN_HEIGHT);
      }

      // And no wall crosses anything standing outside: a board grows until
      // it meets its neighbour and stops there, exactly as a dragged board
      // stops rather than sliding over one.
      const wouldHit = (rect: PlacementRect) =>
        blockers.some((blocker) => rectsOverlap(rect, blocker));
      const frame = () => ({ x: left, y: top, width: right - left, height: bottom - top });
      if (pulls.left) {
        while (left < start.left && wouldHit(frame())) {
          left += BOARD_GRID;
        }
      }
      if (pulls.right) {
        while (right > start.right && wouldHit(frame())) {
          right -= BOARD_GRID;
        }
      }
      if (pulls.top) {
        while (top < start.top && wouldHit(frame())) {
          top += BOARD_GRID;
        }
      }
      if (pulls.bottom) {
        while (bottom > start.bottom && wouldHit(frame())) {
          bottom -= BOARD_GRID;
        }
      }

      const draft = {
        position: { x: left - parentOrigin.x, y: top - parentOrigin.y },
        size: { width: right - left, height: bottom - top },
      };
      draftRef.current = draft;
      publishBoardResizeDraft({ boardId: pocket.id, ...draft });
    };

    const handleUp = () => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
      const draft = draftRef.current;
      draftRef.current = undefined;
      publishBoardResizeDraft(undefined);
      if (draft) {
        setPocketFrame(pocket.id, draft);
      }
    };
    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp);
  };

  return beginResize;
}
