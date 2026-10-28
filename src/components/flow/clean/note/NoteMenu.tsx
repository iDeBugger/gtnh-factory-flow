import type { FactoryNodeColorTag } from "@/lib/model/types";
import { BoardMenu, MenuLine, MenuRow } from "../menus/BoardMenu";
import { NOTE, NOTE_COLOR_MENU, notePalette } from "./note-model";

export interface NoteMenuState {
  x: number;
  y: number;
  view: "main" | "colour";
}

/** The sticky note's right-click menu, in the mod's words: write, colour, bigger and smaller text, delete. */
export function NoteMenu({
  state,
  colorTag,
  font,
  onView,
  onClose,
  onWrite,
  onColor,
  onFont,
  onDelete,
}: {
  state: NoteMenuState;
  colorTag: FactoryNodeColorTag | undefined;
  font: number;
  onView: (view: NoteMenuState["view"]) => void;
  onClose: () => void;
  onWrite: () => void;
  onColor: (tag: FactoryNodeColorTag) => void;
  onFont: (steps: number) => void;
  onDelete: () => void;
}) {
  const run = (action: () => void) => () => {
    action();
    onClose();
  };
  if (state.view === "colour") {
    const current = colorTag ?? NOTE.defaultColor;
    return (
      <BoardMenu x={state.x} y={state.y} label="Note colour" title="Colour" onClose={onClose}>
        {NOTE_COLOR_MENU.map(([tag, name]) => (
          <MenuRow
            key={tag}
            label={name}
            swatch={notePalette(tag).paper}
            checked={tag === current}
            onClick={run(() => onColor(tag))}
          />
        ))}
      </BoardMenu>
    );
  }
  return (
    <BoardMenu x={state.x} y={state.y} label="Sticky note" onClose={onClose}>
      <MenuRow label="Write on it" onClick={run(onWrite)} />
      <MenuRow label="Colour..." onClick={() => onView("colour")} />
      <MenuRow label="Bigger text" detail={`${font} px`} onClick={run(() => onFont(1))} />
      <MenuRow label="Smaller text" onClick={run(() => onFont(-1))} />
      <MenuLine />
      <MenuRow label="Delete note" danger onClick={run(onDelete)} />
    </BoardMenu>
  );
}
