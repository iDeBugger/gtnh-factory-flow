import { useState } from "react";
import { BoardMenu, MenuLine, MenuRow } from "../menus/BoardMenu";
import { GT_NODE_COLORS } from "../../node-colors";
import type { FactoryAnnotation, FactoryNodeColorTag } from "@/lib/model/types";
import { useFactoryStore } from "@/store/factory-store";
import { arrowStyle, boxStyleWith, drawingLook } from "./drawing-look";
import { NOTE_COLOR_MENU } from "./note-model";

type View = "main" | "colour" | "fill" | "border" | "marks" | "thickness" | "heads";

const MARKS = ["none", "dots", "grid", "graph", "ruled", "hatch"] as const;

/**
 * A box's or an arrow's right-click menu (docs/annotations.md), the same words and rows as the mod's. Box and zone:
 * Colour..., Fill..., Border..., Marks..., Delete. Arrow: Colour..., Thickness..., Heads..., Delete. Each "..." row
 * opens a short list with the current choice ticked.
 */
export function AnnotationMenu({
  annotation,
  x,
  y,
  onClose,
}: {
  annotation: FactoryAnnotation;
  x: number;
  y: number;
  onClose: () => void;
}) {
  const [view, setView] = useState<View>("main");
  const patch = (change: Partial<FactoryAnnotation>) => () => {
    useFactoryStore.getState().updateAnnotation(annotation.id, change);
    onClose();
  };
  const box = (change: Parameters<typeof boxStyleWith>[1]) => patch({ style: boxStyleWith(annotation, change) });
  const look = drawingLook(annotation);
  const arrow = annotation.kind === "arrow";
  const arrowLook = arrowStyle(annotation);
  const thick = Math.round(arrowLook.width);
  const word = (s: string) => s[0].toUpperCase() + s.slice(1);

  if (view === "colour") {
    const current = annotation.colorTag ?? "yellow";
    return (
      <BoardMenu x={x} y={y} label="Colour" title="Colour" onClose={onClose}>
        {NOTE_COLOR_MENU.map(([tag, name]) => (
          <MenuRow key={tag} label={name} swatch={GT_NODE_COLORS[tag]?.swatch} checked={tag === current} onClick={patch(recolour(annotation, tag))} />
        ))}
      </BoardMenu>
    );
  }
  if (view !== "main") {
    return (
      <BoardMenu x={x} y={y} label={word(view)} title={word(view)} onClose={onClose}>
        {view === "fill"
          ? (["tint", "solid", "none"] as const).map((fill) => (
              <MenuRow key={fill} label={word(fill)} checked={look.surface === fill} onClick={box({ fill })} />
            ))
          : null}
        {view === "border"
          ? (["solid", "dashed"] as const).map((border) => (
              <MenuRow
                key={border}
                label={word(border)}
                checked={(look.border === "dashed" ? "dashed" : "solid") === border}
                onClick={box({ border })}
              />
            ))
          : null}
        {view === "marks"
          ? MARKS.map((marks) => (
              <MenuRow key={marks} label={word(marks)} checked={look.marks === marks} onClick={box({ marks })} />
            ))
          : null}
        {view === "thickness"
          ? ([[1, "Thin"], [2, "Normal"], [4, "Thick"]] as const).map(([value, name]) => (
              <MenuRow key={value} label={name} checked={thick === value} onClick={patch({ arrowWidth: value })} />
            ))
          : null}
        {view === "heads" ? (
          <>
            <MenuRow label="One end" checked={!arrowLook.both} onClick={patch({ arrowHeads: "end" })} />
            <MenuRow label="Both ends" checked={arrowLook.both} onClick={patch({ arrowHeads: "both" })} />
          </>
        ) : null}
      </BoardMenu>
    );
  }

  return (
    <BoardMenu x={x} y={y} label={arrow ? "Arrow" : "Box"} onClose={onClose}>
      <MenuRow label="Colour..." onClick={() => setView("colour")} />
      {arrow ? (
        <>
          <MenuRow label="Thickness..." onClick={() => setView("thickness")} />
          <MenuRow label="Heads..." onClick={() => setView("heads")} />
        </>
      ) : (
        <>
          <MenuRow label="Fill..." onClick={() => setView("fill")} />
          <MenuRow label="Border..." onClick={() => setView("border")} />
          <MenuRow label="Marks..." onClick={() => setView("marks")} />
        </>
      )}
      <MenuLine />
      <MenuRow
        label={arrow ? "Delete arrow" : annotation.kind === "zone" ? "Delete zone" : "Delete box"}
        danger
        onClick={() => {
          useFactoryStore.getState().deleteAnnotation(annotation.id);
          onClose();
        }}
      />
    </BoardMenu>
  );
}

/** One colour for the whole drawing: the tag, with any separate border or fill colour let go. */
export function recolour(annotation: FactoryAnnotation, tag: FactoryNodeColorTag): Partial<FactoryAnnotation> {
  if (!annotation.style) return { colorTag: tag };
  const rest = { ...annotation.style };
  delete rest.borderColor;
  delete rest.fillColor;
  delete rest.fillTheme;
  return { colorTag: tag, style: rest };
}
