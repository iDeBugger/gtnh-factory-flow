import { NodeResizer, useReactFlow, useStore, type NodeProps } from "@xyflow/react";
import { memo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { ANNOTATION_MIN_BOX, BOARD_GRID } from "@/lib/board-grid";
import type { FactoryAnnotation } from "@/lib/model/types";
import { useFactoryStore } from "@/store/factory-store";
import { ANNOTATION_DRAG_HANDLE_CLASS, type AnnotationFlowNode } from "../../board-node-types";
import {
  DRAWING,
  arrowEnds,
  arrowFromEnds,
  arrowHead,
  arrowStyle,
  drawingLook,
  marksCss,
  scalePoints,
  surfaceFill,
  type DrawingLook,
} from "./drawing-look";
import { severalSelected } from "./note-model";
import "./drawing.css";

const HANDLE = ANNOTATION_DRAG_HANDLE_CLASS;

/**
 * A box, zone or arrow on a plan board, in the clean card's look (docs/annotations.md): flat, square, a thin line, the
 * card's font. The mod draws the same (`ui/note/DrawingPaint`). Interiors are click-through; a box moves by its
 * border and resizes by its corners and edges, an arrow moves by its line and is reshaped by its two end handles
 * (shown when it is selected or hovered). Pictures are not supported: an image annotation is kept in the data and
 * shows nothing (AnnotationSwitch).
 */
function CleanDrawingComponent({ data, selected, width, height }: NodeProps<AnnotationFlowNode>) {
  const { annotation } = data;
  const updateAnnotation = useFactoryStore((state) => state.updateAnnotation);
  const multi = useStore((s) => selected && severalSelected(s.nodeLookup.values()));
  const kind = annotation.kind;
  const w = kind === "arrow" ? annotation.size.width : (width ?? annotation.size.width);
  const h = kind === "arrow" ? annotation.size.height : (height ?? annotation.size.height);
  const look = drawingLook(annotation);

  return (
    <div
      className="dw"
      data-kind={kind}
      data-selected={selected ? "true" : undefined}
      data-multi={multi ? "" : undefined}
      style={{ width: w, height: h }}
    >
      {kind !== "arrow" ? (
        <NodeResizer
          isVisible={selected && !multi}
          minWidth={ANNOTATION_MIN_BOX}
          minHeight={ANNOTATION_MIN_BOX}
          lineStyle={{ borderColor: "transparent", pointerEvents: "all" }}
          handleStyle={{
            pointerEvents: "all",
            width: 10,
            height: 10,
            borderRadius: 0,
            backgroundColor: DRAWING.selection,
            border: "1px solid #0e7490",
            zIndex: 10,
          }}
          onResizeEnd={(_, p) =>
            updateAnnotation(annotation.id, {
              position: { x: p.x, y: p.y },
              size: { width: p.width, height: p.height },
              ...(kind === "zone" && annotation.points
                ? { points: scalePoints(annotation.points, { width: w, height: h }, p) }
                : undefined),
            })
          }
        />
      ) : null}
      {kind === "box" ? <Box look={look} /> : null}
      {kind === "zone" ? <Zone id={annotation.id} points={annotation.points ?? []} w={w} h={h} look={look} /> : null}
      {kind === "arrow" ? <Arrow annotation={annotation} color={look.borderColor} /> : null}
    </div>
  );
}

function Box({ look }: { look: DrawingLook }) {
  const line = look.border === "none" ? 0 : DRAWING.line;
  return (
    <>
      <div
        className="dw-box"
        style={{
          borderWidth: line,
          borderStyle: look.border === "dashed" ? "dashed" : "solid",
          borderColor: look.borderColor,
          backgroundColor: surfaceFill(look),
        }}
      />
      {look.marks !== "none" ? (
        <div className="dw-box" style={{ ...marksCss(look.marks, look.fillColor), border: "none" }} />
      ) : null}
      <div className={`${HANDLE} dw-strip dw-top`} />
      <div className={`${HANDLE} dw-strip dw-bottom`} />
      <div className={`${HANDLE} dw-strip dw-left`} />
      <div className={`${HANDLE} dw-strip dw-right`} />
    </>
  );
}

function Zone({
  id,
  points,
  w,
  h,
  look,
}: {
  id: string;
  points: Array<{ x: number; y: number }>;
  w: number;
  h: number;
  look: DrawingLook;
}) {
  if (points.length < 3) return null;
  const outline = `${points.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x} ${p.y}`).join(" ")} Z`;
  const fill = surfaceFill(look);
  const clip = `dw-clip-${id}`;
  return (
    <svg className="dw-svg" viewBox={`0 0 ${Math.max(w, 1)} ${Math.max(h, 1)}`} preserveAspectRatio="none">
      <clipPath id={clip}>
        <path d={outline} />
      </clipPath>
      {fill ? <path d={outline} fill={fill} stroke="none" /> : null}
      {look.marks !== "none" ? (
        <foreignObject x={0} y={0} width={w} height={h} clipPath={`url(#${clip})`}>
          <div style={{ width: w, height: h, ...marksCss(look.marks, look.fillColor) }} />
        </foreignObject>
      ) : null}
      {look.border !== "none" ? (
        <path
          d={outline}
          fill="none"
          stroke={look.borderColor}
          strokeWidth={DRAWING.line}
          strokeDasharray={look.border === "dashed" ? `${DRAWING.dashOn} ${DRAWING.dashOff}` : undefined}
          strokeLinejoin="miter"
        />
      ) : null}
      <path d={outline} className={`${HANDLE} dw-hit`} fill="none" stroke="transparent" strokeWidth={24} />
    </svg>
  );
}

type Pt = { x: number; y: number };

function Arrow({ annotation, color }: { annotation: FactoryAnnotation; color: string }) {
  const flow = useReactFlow();
  const updateAnnotation = useFactoryStore((state) => state.updateAnnotation);
  const { width: w, height: h } = annotation.size;
  const base = arrowEnds(annotation.arrowDirection, w, h);
  const [drag, setDrag] = useState<{ from: Pt; to: Pt } | undefined>(undefined);
  const dragging = useRef(false);
  const { from, to } = drag ?? base;
  const style = arrowStyle(annotation);
  const line = `M ${from.x} ${from.y} L ${to.x} ${to.y}`;
  const front = arrowHead(from, to, style.width);
  const back = style.both ? arrowHead(to, from, style.width) : undefined;

  // An end handle: the pointer's travel in board space moves that end, snapped to the grid; letting go stores the
  // new box and direction in one undoable step. React Flow is kept out of it (nodrag nopan).
  const grab = (which: "from" | "to") => (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    event.preventDefault();
    const target = event.currentTarget;
    target.setPointerCapture(event.pointerId);
    const origin = flow.screenToFlowPosition({ x: event.clientX, y: event.clientY });
    const at = annotation.position;
    const snap = (p: Pt): Pt => ({
      x: Math.round((at.x + p.x) / BOARD_GRID) * BOARD_GRID - at.x,
      y: Math.round((at.y + p.y) / BOARD_GRID) * BOARD_GRID - at.y,
    });
    let latest = base;
    dragging.current = true;
    const move = (ev: PointerEvent) => {
      const now = flow.screenToFlowPosition({ x: ev.clientX, y: ev.clientY });
      const moved = snap({ x: base[which].x + now.x - origin.x, y: base[which].y + now.y - origin.y });
      latest = { ...base, [which]: moved };
      setDrag(latest);
    };
    const finish = () => {
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", finish);
      target.removeEventListener("pointercancel", finish);
      dragging.current = false;
      setDrag(undefined);
      if (latest.from.x === latest.to.x && latest.from.y === latest.to.y) return;
      const shape = arrowFromEnds(
        { x: at.x + latest.from.x, y: at.y + latest.from.y },
        { x: at.x + latest.to.x, y: at.y + latest.to.y },
      );
      updateAnnotation(annotation.id, shape);
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", finish);
    target.addEventListener("pointercancel", finish);
  };

  return (
    <>
      {/* never 0 by 0: a level arrow's svg still needs a height to be painted */}
      <svg className="dw-svg" width={Math.max(w, 1)} height={Math.max(h, 1)}>
        <path d={line} stroke={color} strokeWidth={style.width} strokeLinecap="butt" fill="none" />
        <polygon points={front.map((p) => `${p.x},${p.y}`).join(" ")} fill={color} />
        {back ? <polygon points={back.map((p) => `${p.x},${p.y}`).join(" ")} fill={color} /> : null}
        <path d={line} className={`${HANDLE} dw-hit`} stroke="transparent" strokeWidth={24} fill="none" />
      </svg>
      <div
        className="dw-end nodrag nopan"
        aria-label="Arrow tail"
        style={{ left: from.x, top: from.y }}
        onPointerDown={grab("from")}
      />
      <div
        className="dw-end nodrag nopan"
        aria-label="Arrow head"
        style={{ left: to.x, top: to.y }}
        onPointerDown={grab("to")}
      />
    </>
  );
}

export const CleanDrawing = memo(CleanDrawingComponent);
