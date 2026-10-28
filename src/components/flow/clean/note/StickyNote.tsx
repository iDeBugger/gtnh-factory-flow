import { useReactFlow, useStore, type Node, type NodeProps } from "@xyflow/react";
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { snapToGrid } from "@/lib/board-grid";
import type { FactoryAnnotation } from "@/lib/model/types";
import { useFactoryStore } from "@/store/factory-store";
import { measureClean, useFontEpoch } from "../text-measure";
import type { TipSpec } from "../interaction/tip-spec";
import { NoteMenu, type NoteMenuState } from "./NoteMenu";
import "./note.css";
import { registerZoomConsumer } from "../../virtual/zoom-var";
import {
  NOTE,
  clampFont,
  fontOf,
  glyphPx,
  keysFit,
  linePx,
  neededHeight,
  notePalette,
  partAt,
  resizeAxes,
  severalSelected,
  takeNoteEditRequest,
  type NotePart,
} from "./note-model";

export interface StickyNoteData extends Record<string, unknown> {
  annotation: FactoryAnnotation;
}

export type StickyNoteFlowNode = Node<StickyNoteData, "annotationNode">;

const measure = (text: string, fontPx: number) => measureClean(text, fontPx, 400);

/** The mod's tips (`NoteCard.tip`), by what the pointer is on. */
const TIPS: Record<NotePart, Omit<TipSpec, "id">> = {
  body: {
    title: "Sticky note",
    actions: [
      { input: "left", label: "Click: write" },
      { input: "drag", label: "Move" },
      { input: "right", label: "Colour, text size, delete" },
    ],
  },
  delete: { title: "Delete note" },
  smaller: { title: "Smaller text" },
  bigger: { title: "Bigger text" },
  resize: { title: "Resize", actions: [{ input: "drag", label: "Drag the corner or an edge" }] },
};

const CURSORS = { nwse: "nwse-resize", ew: "ew-resize", ns: "ns-resize" } as const;

/** The caret offset in `display`'s text at a screen point, when the browser can say. */
function caretOffsetAt(display: HTMLElement | null, x: number, y: number): number | undefined {
  if (!display || typeof document === "undefined") return undefined;
  const doc = document as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };
  if (doc.caretPositionFromPoint) {
    const hit = doc.caretPositionFromPoint(x, y);
    if (hit && display.contains(hit.offsetNode)) return hit.offset;
  } else if (doc.caretRangeFromPoint) {
    const range = doc.caretRangeFromPoint(x, y);
    if (range && display.contains(range.startContainer)) return range.startOffset;
  }
  return undefined;
}

function StickyNoteComponent({ data, selected, width, height }: NodeProps<StickyNoteFlowNode>) {
  const { annotation } = data;
  useFontEpoch();
  const updateAnnotation = useFactoryStore((state) => state.updateAnnotation);
  const deleteAnnotation = useFactoryStore((state) => state.deleteAnnotation);
  const locked = useFactoryStore((state) => state.isReadOnly || state.checklistMode);
  const flow = useReactFlow();

  const w = width ?? annotation.size.width;
  const h = height ?? annotation.size.height;
  const text = annotation.text ?? "";
  const font = fontOf(annotation);
  const palette = notePalette(annotation.colorTag);

  // The keys' fit flips with the zoom, but the note only hears when it does.
  const fits = useStore((s) => keysFit(w, h, s.transform[2]));
  // A selection outline shows only when several things are selected.
  const multi = useStore((s) => selected && severalSelected(s.nodeLookup.values()));

  const rootRef = useRef<HTMLDivElement>(null);
  const displayRef = useRef<HTMLDivElement>(null);
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(text);
  const caretRef = useRef<number | undefined>(undefined);
  const [live, setLive] = useState<{ w: number; h: number } | null>(null);
  const [menu, setMenu] = useState<NoteMenuState | null>(null);

  const startEditing = useCallback(
    (caret?: number) => {
      if (locked) return;
      caretRef.current = caret;
      setDraft(text);
      setEditing(true);
    },
    [locked, text],
  );

  // The board writes --board-zoom to the notes directly (virtual/zoom-var.ts), not to every element under it.
  useEffect(() => registerZoomConsumer(rootRef.current), []);

  // A note the board's menu just made starts being written on.
  useEffect(() => {
    if (takeNoteEditRequest(annotation.id)) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- one shot at mount
      startEditing();
    }
  }, [annotation.id, startEditing]);

  useLayoutEffect(() => {
    if (!editing) return;
    const area = areaRef.current;
    if (!area) return;
    area.focus();
    const caret = caretRef.current;
    if (caret === undefined) area.select();
    else area.setSelectionRange(caret, caret);
  }, [editing]);

  const commit = useCallback(() => {
    setEditing(false);
    if (draft === text) return;
    // New words grow the note to show them; the same words leave it the size it was made.
    const needed = neededHeight(draft, annotation.size.width, font, measure);
    updateAnnotation(annotation.id, {
      text: draft,
      size: { width: annotation.size.width, height: Math.max(annotation.size.height, needed) },
    });
  }, [annotation.id, annotation.size.height, annotation.size.width, draft, font, text, updateAnnotation]);

  const stepFont = useCallback(
    (steps: number) => {
      const next = clampFont(font + steps * NOTE.fontStep);
      if (next !== font) updateAnnotation(annotation.id, { fontSize: next });
    },
    [annotation.id, font, updateAnnotation],
  );

  // Pointer: what is under it (for the cursor, the title and the lit key), a click's slop, and resizing.
  const press = useRef<{ x: number; y: number; part: NotePart } | null>(null);
  const resize = useRef<{ sx: number; sy: number; w: number; h: number; ax: boolean; ay: boolean } | null>(null);

  const localPoint = (clientX: number, clientY: number) => {
    const rect = rootRef.current!.getBoundingClientRect();
    const zoom = flow.getZoom();
    return { x: (clientX - rect.left) / zoom, y: (clientY - rect.top) / zoom, zoom };
  };

  const partUnder = (clientX: number, clientY: number): NotePart => {
    const p = localPoint(clientX, clientY);
    return partAt(p.x, p.y, live?.w ?? w, live?.h ?? h, p.zoom, fits);
  };

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const root = rootRef.current;
    if (!root) return;
    if (resize.current) {
      const r = resize.current;
      const zoom = flow.getZoom();
      setLive({
        w: r.ax ? Math.max(NOTE.minWidth, snapToGrid(r.w + (event.clientX - r.sx) / zoom)) : r.w,
        h: r.ay ? Math.max(NOTE.minHeight, snapToGrid(r.h + (event.clientY - r.sy) / zoom)) : r.h,
      });
      return;
    }
    if (locked) return;
    const part = partUnder(event.clientX, event.clientY);
    root.dataset.part = part;
    if (editing) {
      root.removeAttribute("data-tip");
      root.removeAttribute("data-tip-id");
    } else {
      const id = `${annotation.id}|${part}`;
      root.setAttribute("data-tip", JSON.stringify({ ...TIPS[part], id }));
      root.setAttribute("data-tip-id", id);
    }
    if (part === "resize") {
      const p = localPoint(event.clientX, event.clientY);
      const axes = resizeAxes(p.x, p.y, w, h, p.zoom);
      root.style.cursor = axes.w && axes.h ? CURSORS.nwse : axes.w ? CURSORS.ew : CURSORS.ns;
    } else {
      root.style.cursor = "";
    }
    // A press on the resize zone must not carry the note or pan the board: React Flow reads these classes at press.
    root.classList.toggle("nodrag", part === "resize");
    root.classList.toggle("nopan", part === "resize");
  };

  const onPointerLeave = () => {
    const root = rootRef.current;
    if (!root || resize.current) return;
    delete root.dataset.part;
    root.classList.remove("nodrag", "nopan");
  };

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || locked) return;
    const part = partUnder(event.clientX, event.clientY);
    const root = rootRef.current!;
    if (part === "resize") {
      // The mouse press follows this pointer press: tell React Flow not to carry or pan on it (touch and teleporting
      // pointers never hovered first).
      root.classList.add("nodrag", "nopan");
      const p = localPoint(event.clientX, event.clientY);
      const axes = resizeAxes(p.x, p.y, w, h, p.zoom);
      resize.current = { sx: event.clientX, sy: event.clientY, w, h, ax: axes.w, ay: axes.h };
      setLive({ w, h });
      root.setPointerCapture(event.pointerId);
      event.stopPropagation();
      return;
    }
    press.current = { x: event.clientX, y: event.clientY, part };
    const sx = event.clientX;
    const sy = event.clientY;
    const target = event.target as HTMLElement;
    const onUp = (up: PointerEvent) => {
      window.removeEventListener("pointerup", onUp);
      const was = press.current;
      press.current = null;
      if (!was || Math.hypot(up.clientX - sx, up.clientY - sy) >= NOTE.slop) return;
      if (was.part === "delete") {
        deleteAnnotation(annotation.id);
      } else if (was.part === "smaller") {
        stepFont(-1);
      } else if (was.part === "bigger") {
        stepFont(1);
      } else if (!up.shiftKey && !editing) {
        startEditing(target.closest(".sn-text") ? caretOffsetAt(displayRef.current, up.clientX, up.clientY) : undefined);
      }
    };
    window.addEventListener("pointerup", onUp);
  };

  const endResize = (event: React.PointerEvent<HTMLDivElement>) => {
    const r = resize.current;
    if (!r) return;
    resize.current = null;
    const root = rootRef.current;
    if (root?.hasPointerCapture(event.pointerId)) root.releasePointerCapture(event.pointerId);
    const final = live;
    setLive(null);
    if (final && (final.w !== r.w || final.h !== r.h)) {
      updateAnnotation(annotation.id, { size: { width: final.w, height: final.h } });
    } else if (Math.hypot(event.clientX - r.sx, event.clientY - r.sy) < NOTE.slop && !editing) {
      // A press on the edge that never went anywhere is a click on the note.
      startEditing();
    }
  };

  // Written on, the press keeps the keyboard unless it is on the text itself (which places the caret).
  const onMouseDown = (event: React.MouseEvent<HTMLDivElement>) => {
    if (editing && event.target !== areaRef.current) event.preventDefault();
  };

  const onContextMenu = (event: React.MouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (locked) return;
    setMenu({ x: event.clientX, y: event.clientY, view: "main" });
  };

  const shownW = live?.w ?? w;
  const grownH = editing ? Math.max(h, neededHeight(draft, shownW, font, measure)) : h;
  const shownH = live?.h ?? grownH;

  const style = {
    width: shownW,
    height: shownH,
    "--sn-paper": palette.paper,
    "--sn-band": palette.band,
    "--sn-fold-color": palette.fold,
    "--sn-edge": palette.edge,
    "--sn-ink": palette.ink,
    "--sn-fold": `${Math.max(6, Math.min(NOTE.fold, Math.floor(Math.min(shownW, shownH) / 4)))}px`,
    "--sn-glyph": `${glyphPx(font)}px`,
    "--sn-line": `${linePx(font)}px`,
  } as CSSProperties;

  const noText = text.length === 0;

  return (
    <>
      <div
        ref={rootRef}
        className="sn"
        style={style}
        data-editing={editing ? "" : undefined}
        data-multi={multi ? "" : undefined}
        data-keys={fits ? "" : undefined}
        data-smaller-off={font <= NOTE.minFont ? "" : undefined}
        data-bigger-off={font >= NOTE.maxFont ? "" : undefined}
        onPointerMove={onPointerMove}
        onPointerLeave={onPointerLeave}
        onPointerDown={onPointerDown}
        onPointerUp={endResize}
        onPointerCancel={endResize}
        onMouseDown={onMouseDown}
        onContextMenu={onContextMenu}
      >
        {editing ? (
          <textarea
            ref={areaRef}
            className="sn-text sn-area"
            value={draft}
            spellCheck={false}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={commit}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.stopPropagation();
                areaRef.current?.blur();
              }
            }}
          />
        ) : (
          <div ref={displayRef} className="sn-text" data-empty={noText ? "" : undefined}>
            {noText ? "Double-click to write" : text}
          </div>
        )}
        {fits ? (
          <>
            <i className="sn-key" data-key="delete" />
            <i className="sn-key" data-key="smaller" />
            <i className="sn-key" data-key="bigger" />
          </>
        ) : null}
      </div>
      {menu ? (
        <NoteMenu
          state={menu}
          colorTag={annotation.colorTag}
          font={font}
          onView={(view) => setMenu((was) => (was ? { ...was, view } : was))}
          onClose={() => setMenu(null)}
          onWrite={() => startEditing()}
          onColor={(tag) => updateAnnotation(annotation.id, { colorTag: tag })}
          onFont={stepFont}
          onDelete={() => deleteAnnotation(annotation.id)}
        />
      ) : null}
    </>
  );
}

// Position props change every drag frame; this component reads only `data`,
// `selected` and its size.
export const StickyNote = memo(
  StickyNoteComponent,
  (previous, next) =>
    previous.data === next.data &&
    previous.selected === next.selected &&
    previous.width === next.width &&
    previous.height === next.height,
);
