import "./menus.css";

import type { ReactNode } from "react";
import { MenuPortal } from "./MenuPortal";

/**
 * THE BOARD'S ONE MENU (docs/groups.md, "Menus"): every right-click menu on a plan board and every card, drawer, note
 * and group key menu is this, in the mod's PickList skin (the `cm` panel, Monocraft, square, 1 px chrome). Rows are
 * the same words as the mod's: a "..." row opens a short list of choices, the current one ticked; a red row loses
 * something. The mod's twin is `ui/popup/PickList`.
 */

/** The mod's menus are 150 board px wide: 254 here, at the menus' size on screen. */
export const BOARD_MENU_WIDTH = 254;

export function BoardMenu({
  x,
  y,
  label,
  title,
  width = BOARD_MENU_WIDTH,
  onClose,
  children,
}: {
  /** Where it opens, in real (unzoomed) screen pixels: the pointer, or under a key. */
  x: number;
  y: number;
  label: string;
  /** A heading over the rows (the mod's upper-case title), for a list of choices. */
  title?: string;
  width?: number;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <MenuPortal
      anchor={{ left: x, top: y, bottom: y }}
      width={width}
      maxHeight={420}
      label={label}
      onClose={onClose}
      className="cm-actions cm-board"
    >
      {title ? <div className="cm-head">{title}</div> : null}
      <div className="cm-scroll">{children}</div>
    </MenuPortal>
  );
}

export function MenuRow({
  label,
  detail,
  checked,
  danger,
  disabled,
  swatch,
  onClick,
}: {
  label: string;
  /** Muted text at the row's right end. */
  detail?: string;
  /** The current choice in a list: ticked in gold. */
  checked?: boolean;
  danger?: boolean;
  disabled?: boolean;
  /** A colour square before the label (colour lists). */
  swatch?: string;
  onClick: () => void;
}) {
  const run = () => {
    if (!disabled) onClick();
  };
  return (
    <div
      role={checked === undefined ? "menuitem" : "menuitemradio"}
      tabIndex={disabled ? -1 : 0}
      aria-disabled={disabled ? true : undefined}
      aria-checked={checked === undefined ? undefined : checked}
      className="cm-row"
      data-danger={danger ? "" : undefined}
      data-disabled={disabled ? "" : undefined}
      data-checked={checked ? "" : undefined}
      onClick={(event) => {
        event.stopPropagation();
        run();
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          event.stopPropagation();
          run();
        }
      }}
    >
      {swatch ? <span aria-hidden className="cm-swatch" style={{ background: swatch }} /> : null}
      <span className="cm-name">{label}</span>
      {detail ? <span className="cm-note">{detail}</span> : null}
      {checked ? <span aria-hidden className="cm-tick" /> : null}
    </div>
  );
}

/** A thin rule between groups of rows (before the red ones). */
export function MenuLine() {
  return <div role="separator" className="cm-line" />;
}
