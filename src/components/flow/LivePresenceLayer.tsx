import { useStore, useReactFlow, ViewportPortal, type ReactFlowState } from "@xyflow/react";
import { memo, useEffect, useMemo, useState } from "react";
import { registerZoomConsumer } from "./virtual/zoom-var";
import { useRemoteCursors, useRemoteSelections, type RemoteCursor } from "@/lib/live/live-presence";
import { inkOn } from "@/components/live/LiveFaces";
import { reportLiveCursor, useLiveSession } from "@/store/live-session";

/**
 * The other people in a live plan, drawn over the board as a layer of its
 * own: each one's pointer with their name on a tag in their colour, and an
 * outline in that colour around whatever they have selected. Positions are
 * the plan's own coordinates, inside the viewport, so the camera carries
 * them like cards; tags and lines are divided by `--board-zoom` to stay one
 * size on screen. The board no longer carries that variable (zoom-var.ts
 * writes it only where something reads it), so each layer's root registers
 * for it, as a sticky note does.
 *
 * Board performance: nothing here touches the cards or the board's stores.
 * A cursor moving re-renders the cursor layer alone (live-presence.ts), a
 * selection changing re-renders the outlines alone, and this tab's pointer
 * is read by a native listener and handed to the session, which sends at
 * most 10 a second.
 */
export const LivePresenceLayer = memo(function LivePresenceLayer({
  boardRef,
}: {
  boardRef: React.RefObject<HTMLDivElement | null>;
}) {
  const live = useLiveSession((state) => state.status === "live");
  const { screenToFlowPosition } = useReactFlow();

  useEffect(() => {
    const board = boardRef.current;
    if (!live || !board) {
      return;
    }
    const onMove = (event: PointerEvent) => {
      const point = screenToFlowPosition({ x: event.clientX, y: event.clientY });
      reportLiveCursor({ x: Math.round(point.x), y: Math.round(point.y) });
    };
    const onLeave = () => reportLiveCursor(null);
    board.addEventListener("pointermove", onMove, { passive: true });
    board.addEventListener("pointerleave", onLeave);
    return () => {
      board.removeEventListener("pointermove", onMove);
      board.removeEventListener("pointerleave", onLeave);
      reportLiveCursor(null);
    };
  }, [boardRef, live, screenToFlowPosition]);

  if (!live) {
    return null;
  }
  return (
    <>
      <RemoteSelectionOutlines />
      <RemoteCursorLayer />
    </>
  );
});

/** A ref that keeps `--board-zoom` written on the element it lands on (zoom-var.ts). */
function useZoomVariable(): (element: HTMLDivElement | null) => void {
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  useEffect(() => registerZoomConsumer(element), [element]);
  return setElement;
}

const RemoteCursorLayer = memo(function RemoteCursorLayer() {
  const cursors = useRemoteCursors();
  const zoomRef = useZoomVariable();
  if (cursors.length === 0) {
    return null;
  }
  return (
    <ViewportPortal>
      <div
        ref={zoomRef}
        aria-hidden
        data-live-cursors
        className="pointer-events-none absolute left-0 top-0"
        style={{ zIndex: 1000 }}
      >
        {cursors.map((cursor) => (
          <RemoteCursorMark key={cursor.conn} cursor={cursor} />
        ))}
      </div>
    </ViewportPortal>
  );
});

const RemoteCursorMark = memo(function RemoteCursorMark({ cursor }: { cursor: RemoteCursor }) {
  return (
    <div
      data-live-cursor={cursor.username}
      className="absolute left-0 top-0"
      style={{ left: cursor.cursor.x, top: cursor.cursor.y }}
    >
      <div className="origin-top-left" style={{ scale: "calc(1 / var(--board-zoom, 1))" }}>
        <svg width="16" height="20" viewBox="0 0 16 20" className="block drop-shadow">
          <path
            d="M1 1 L1 16 L5 12 L8 19 L11 18 L8 11 L14 11 Z"
            fill={cursor.color}
            stroke="#0b0c0e"
            strokeWidth="1.2"
            strokeLinejoin="round"
          />
        </svg>
        <span
          className="absolute left-3 top-4 whitespace-nowrap rounded px-1.5 py-0.5 text-[11px] font-semibold leading-none shadow"
          style={{ background: cursor.color, color: inkOn(cursor.color) }}
        >
          {cursor.username}
        </span>
      </div>
    </div>
  );
});

interface OutlineRect {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

const NO_RECTS: OutlineRect[] = [];

function sameRects(left: OutlineRect[], right: OutlineRect[]): boolean {
  return (
    left.length === right.length &&
    left.every((rect, index) => {
      const other = right[index]!;
      return (
        rect.id === other.id &&
        rect.x === other.x &&
        rect.y === other.y &&
        rect.width === other.width &&
        rect.height === other.height
      );
    })
  );
}

const RemoteSelectionOutlines = memo(function RemoteSelectionOutlines() {
  const selections = useRemoteSelections();
  const zoomRef = useZoomVariable();
  const ids = useMemo(
    () => [...new Set(selections.flatMap((selection) => selection.ids))],
    [selections],
  );
  // Runs on every board store notification: with nobody selecting anything it
  // costs one length check, and otherwise one lookup per selected id.
  const rects = useStore((state: ReactFlowState) => {
    if (ids.length === 0) {
      return NO_RECTS;
    }
    const found: OutlineRect[] = [];
    for (const id of ids) {
      const node = state.nodeLookup.get(id);
      if (!node || node.hidden) {
        continue;
      }
      const width = node.measured?.width ?? node.width ?? 0;
      const height = node.measured?.height ?? node.height ?? 0;
      if (width <= 0 || height <= 0) {
        continue;
      }
      found.push({
        id,
        x: node.internals.positionAbsolute.x,
        y: node.internals.positionAbsolute.y,
        width,
        height,
      });
    }
    return found.length === 0 ? NO_RECTS : found;
  }, sameRects);

  if (rects.length === 0) {
    return null;
  }
  const byId = new Map(rects.map((rect) => [rect.id, rect]));
  return (
    <ViewportPortal>
      <div
        ref={zoomRef}
        aria-hidden
        data-live-selections
        className="pointer-events-none absolute left-0 top-0"
        style={{ zIndex: 999 }}
      >
        {selections.map((selection) =>
          selection.ids.map((id, index) => {
            const rect = byId.get(id);
            if (!rect) {
              return null;
            }
            return (
              <div
                key={`${selection.conn}:${id}`}
                data-live-selected={id}
                className="absolute rounded-[3px]"
                style={{
                  left: rect.x,
                  top: rect.y,
                  width: rect.width,
                  height: rect.height,
                  outline: `calc(2px / var(--board-zoom, 1)) solid ${selection.color}`,
                  outlineOffset: "calc(3px / var(--board-zoom, 1))",
                }}
              >
                {index === 0 ? (
                  <span
                    className="absolute bottom-full left-0 origin-bottom-left whitespace-nowrap rounded px-1 py-px text-[10px] font-semibold leading-none"
                    style={{
                      background: selection.color,
                      color: inkOn(selection.color),
                      scale: "calc(1 / var(--board-zoom, 1))",
                      marginBottom: "calc(5px / var(--board-zoom, 1))",
                    }}
                  >
                    {selection.username}
                  </span>
                ) : null}
              </div>
            );
          }),
        )}
      </div>
    </ViewportPortal>
  );
});
