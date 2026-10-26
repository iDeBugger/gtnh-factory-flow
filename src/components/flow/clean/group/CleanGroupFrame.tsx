"use client";

import "../clean.css";
import "./group.css";
import { memo, useEffect, useState, type CSSProperties } from "react";
import type { NodeProps } from "@xyflow/react";
import { boardWindowSize } from "@/lib/model/board-windows";
import type { FactoryPocket } from "@/lib/model/types";
import { useFactoryStore } from "@/store/factory-store";
import { BOARD_DRAG_HANDLE_CLASS, type BoardWindowFlowNode } from "../../board-node-types";
import { useBoardResize, type ResizeSide } from "./use-group-resize";
import { useClickSlop } from "../interaction/click-slop";
import { tipAttrs } from "../interaction/tip-spec";
import { GROUP, groupColorTag, groupColors, machinesText } from "./group-model";
import { onGroupRename } from "./group-rename";

const SIDES: ResizeSide[] = ["n", "s", "e", "w", "nw", "ne", "sw", "se"];

/** The CSS custom properties of a group's chrome. */
export function groupStyle(colors: { border: string; strip: string }): CSSProperties {
  return {
    "--cg-border": colors.border,
    "--cg-strip": colors.strip,
    "--cg-strip-h": `${GROUP.strip}px`,
    "--cg-key": `${GROUP.key}px`,
    "--cg-key-inset": `${GROUP.keyInset}px`,
    "--cg-text-inset": `${GROUP.textInset}px`,
    "--cg-line-h": `${GROUP.line}px`,
    "--cg-row-h": `${GROUP.row}px`,
    "--cg-icon": `${GROUP.icon}px`,
    "--cg-pad": `${GROUP.pad}px`,
    "--cg-grip": `${GROUP.grip}px`,
  } as CSSProperties;
}

/** The title strip's name: a click renames it in place (Enter sets, Escape cancels, empty keeps the old name). */
export function GroupName({
  pocketId,
  name,
  wasClick,
}: {
  pocketId: string;
  name: string;
  wasClick: (event: React.MouseEvent) => boolean;
}) {
  const [draft, setDraft] = useState<string | undefined>(undefined);
  const renamePocket = useFactoryStore((state) => state.renamePocket);
  // The group menu's Rename opens the field here.
  useEffect(() => onGroupRename((id) => id === pocketId && setDraft(name)), [pocketId, name]);
  if (draft !== undefined) {
    const commit = () => {
      if (draft.trim()) renamePocket(pocketId, draft);
      setDraft(undefined);
    };
    return (
      <input
        autoFocus
        className="cg-rename nodrag nopan"
        value={draft}
        aria-label="Group name"
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onFocus={(event) => event.target.select()}
        onPointerDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === "Enter") commit();
          if (event.key === "Escape") setDraft(undefined);
        }}
      />
    );
  }
  return (
    <span
      className="cg-name"
      data-group-name=""
      onClick={(event) => {
        if (!wasClick(event) || event.shiftKey || event.ctrlKey || event.metaKey) return;
        event.stopPropagation();
        setDraft(name);
      }}
    >
      {name}
    </span>
  );
}

/** An OPEN group on a plan board (docs/groups.md): border, title strip with name, machines and the collapse key. */
function CleanGroupFrameComponent({ data, width, height, selected }: NodeProps<BoardWindowFlowNode>) {
  const { pocket } = data;
  const machines = typeof data.machines === "number" ? data.machines : 0;
  const minimizePocket = useFactoryStore((state) => state.minimizePocket);
  const stored = boardWindowSize(pocket);
  const frameWidth = width ?? stored.width;
  const frameHeight = height ?? stored.height;
  const beginResize = useBoardResize(pocket, frameWidth, frameHeight);
  const slop = useClickSlop();
  const colors = groupColors(groupColorTag(pocket));
  const count = machinesText(machines);

  return (
    <div
      className="cg-frame"
      data-group-frame={pocket.id}
      data-selected={selected ? "" : undefined}
      style={{ width: frameWidth, height: frameHeight, ...groupStyle(colors) }}
      onPointerDownCapture={slop.onPointerDownCapture}
    >
      <div
        className={`cg-strip ${BOARD_DRAG_HANDLE_CLASS}`}
        data-group-strip=""
        {...tipAttrs({
          id: `${pocket.id}|strip`,
          title: pocket.name,
          ...(count ? { sub: count } : {}),
          actions: [
            { input: "drag", label: "Move the group" },
            { input: "left", label: "Rename (on the name)" },
            { input: "right", label: "Group menu" },
          ],
        })}
      >
        <GroupName pocketId={pocket.id} name={pocket.name} wasClick={slop.wasClick} />
        {count ? <span className="cg-muted">{count}</span> : null}
        <div
          role="button"
          aria-label="Collapse"
          className="cg-key"
          data-group-key="collapse"
          {...tipAttrs({ id: `${pocket.id}|collapse`, title: "Collapse", actions: [{ input: "left", label: "Collapse" }] })}
          onClick={(event) => {
            if (!slop.wasClick(event)) return;
            event.stopPropagation();
            minimizePocket(pocket.id);
          }}
        />
      </div>
      {SIDES.map((side) => (
        <div
          key={side}
          className="cg-grip nodrag nopan"
          data-side={side}
          onPointerDown={(event) => beginResize(side, event)}
        />
      ))}
    </div>
  );
}

export const CleanGroupFrame = memo(
  CleanGroupFrameComponent,
  (previous, next) =>
    previous.data === next.data &&
    previous.width === next.width &&
    previous.height === next.height &&
    previous.selected === next.selected,
);

/**
 * An open group's body, painted under the wires (FactoryFlow's BoardFloors): the group colour at 8%. It lights up
 * while a carried card would join the group (`data-drop`, group-drop.ts) and dims while one is carried out of it
 * (`data-leaving`).
 */
export function GroupFloor({ pocket, width, height }: { pocket: FactoryPocket; width: number; height: number }) {
  const colors = groupColors(groupColorTag(pocket));
  return (
    <div
      aria-hidden
      data-board-floor={pocket.id}
      className="cg-floor"
      style={
        {
          transform: `translate(${pocket.position.x}px, ${pocket.position.y}px)`,
          width,
          height,
          "--cg-body": colors.body,
          "--cg-c": colors.c,
        } as CSSProperties
      }
    />
  );
}
