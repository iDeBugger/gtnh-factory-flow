import "./chrome.css";

import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useDropdownDismiss } from "@/lib/hooks/use-dropdown-dismiss";
import { activateOnKey } from "@/lib/hooks/button-keys";
import { getUiScale } from "@/lib/ui-scale";

/**
 * The mod draws its bar, tabs and menus in GUI pixels at GUI scale 2: two screen pixels each. This file's sizes are
 * GUI pixels in css px under the interface's 1.17, so the bar and its menus wear 2 / 1.17 more (chrome.css).
 */
export const CHROME_SCREEN_K = 2 / 1.17;
import { playBoardSound } from "@/lib/board-sounds";
import { tipAttrs } from "@/components/flow/clean/interaction";
import { PixelIcon } from "./pixel-icons";

/** Where a menu hangs from, in real (unzoomed) screen pixels. */
export interface ChromeAnchor {
  left: number;
  top: number;
  bottom: number;
  right?: number;
}

export function chromeAnchorOf(element: Element): ChromeAnchor {
  const r = element.getBoundingClientRect();
  return { left: r.left, top: r.top, bottom: r.bottom, right: r.right };
}

/** A row of a menu: its label, a quiet detail at the right, and what it does. */
export interface MenuEntry {
  label: string;
  detail?: string;
  tone?: "red";
  current?: boolean;
  disabled?: boolean;
  /** A thin rule above this row. */
  ruleAbove?: boolean;
  /** A tooltip: why a greyed row does nothing, or more about what it does. */
  tip?: string;
  /** A small coloured dot before the label (a task's status). */
  dot?: string;
  /** A plus before the label: the row makes something new. */
  plus?: boolean;
  /** A picture before the label. */
  icon?: ReactNode;
  /** A font-family for the label alone (the font picker shows each font in itself). */
  labelFont?: string;
  /**
   * The rows of a menu this row opens at its side (the mouse over it for `SUBMENU_HOVER_MS`, a press, or Right or
   * Enter); `onSelect` is not called for such a row.
   */
  submenu?: MenuEntry[];
  onSelect: () => void;
}

/** The attribute that makes a press on an element count as inside the menu it opens (the key toggles it). */
export const MENU_ANCHOR_ATTR = "data-menu-anchor";

/**
 * Hover intent: the mouse opens a submenu, or shuts it by moving to another row, only after resting this long. A
 * pointer crossing other rows on its way into the submenu reaches it first, which cancels the pending close.
 */
export const SUBMENU_HOVER_MS = 200;

/** What a row asks of its submenu. */
type SubAsk =
  /** The mouse came onto the row (`open`: the row has a submenu); takes effect after `SUBMENU_HOVER_MS`. */
  | { kind: "hover"; open: boolean }
  /** A press opens it; a touch or pen press toggles it. */
  | { kind: "press"; toggle: boolean }
  /** Right or Enter: open it and move focus into it. */
  | { kind: "keys" }
  /** Left from inside it: shut it. */
  | { kind: "back" }
  /** The pointer reached the submenu or its row: a pending change is dropped. */
  | { kind: "stay" };

/** The keys a menu handles itself; they never reach the board's camera or anything else on the page. */
const MENU_KEYS = new Set(["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Home", "End", "Tab"]);

/**
 * The mod's PickList in Popup's frame: rows 20 high, the label left, the detail right in muted ink, the hovered
 * row lit, the current one shaded. A body portal closed by Escape, a press outside, a scroll or the camera
 * moving (the app's one dropdown rule); picking a row closes it, then does what the row says.
 */
export function ChromeMenu({
  anchor,
  entries,
  label,
  title,
  minWidth,
  align = "left",
  zIndex,
  onClose,
}: {
  anchor: ChromeAnchor;
  entries: MenuEntry[];
  label: string;
  title?: string;
  minWidth?: number;
  /** `right` hangs the menu's right edge from the anchor's right edge (the keys at the bar's end). */
  align?: "left" | "right";
  /** Over a column that stacks above the bar's menus (the items column). */
  zIndex?: number;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // The row whose submenu is open; `focus` counts the keyboard's asks (each moves focus to its first row).
  const [sub, setSub] = useState<{ index: number; focus: number }>();
  const hoverTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(hoverTimer.current), []);
  const askSub = (index: number, ask: SubAsk) => {
    window.clearTimeout(hoverTimer.current);
    hoverTimer.current = undefined;
    if (ask.kind === "stay") return;
    if (ask.kind === "hover") {
      // Already the open one, or nothing open to shut: no wait.
      if (ask.open ? sub?.index === index : sub === undefined) return;
      hoverTimer.current = window.setTimeout(() => {
        setSub(ask.open ? { index, focus: 0 } : undefined);
      }, SUBMENU_HOVER_MS);
      return;
    }
    if (ask.kind === "back") {
      setSub(undefined);
      return;
    }
    if (ask.kind === "keys") {
      setSub((current) => ({ index, focus: (current?.index === index ? current.focus : 0) + 1 }));
      return;
    }
    setSub((current) =>
      current?.index === index ? (ask.toggle ? undefined : current) : { index, focus: 0 },
    );
  };
  useDropdownDismiss(true, {
    refs: [ref],
    onClose,
    insideSelector: `[${MENU_ANCHOR_ATTR}]`,
  });
  // Keyboard: focus moves into the menu (the first row), and goes back to the key that opened it on close.
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const menu = ref.current;
    (ownRows(menu)[0] ?? menu)?.focus({ preventScroll: true });
    return () => {
      const active = document.activeElement;
      // Only take focus back when it was in the menu (a row picked that opened something else keeps its own).
      if (previous?.isConnected && (!active || active === document.body || menu?.contains(active))) {
        previous.focus({ preventScroll: true });
      }
    };
  }, []);
  // The menu wears the bar's extra zoom (chrome.css .mm, CHROME_SCREEN_K): its box is in those pixels.
  const scale = getUiScale() * CHROME_SCREEN_K;
  const shell = (px: number) => px / scale;
  const vw = shell(window.innerWidth);
  const spaceBelow = shell(window.innerHeight - anchor.bottom) - 8;
  const style: React.CSSProperties = {
    minWidth: minWidth ?? 100,
    maxHeight: Math.max(80, spaceBelow),
    top: shell(anchor.bottom) + 2,
    ...(zIndex === undefined ? {} : { zIndex }),
  };
  // The menu's width is only known once it is drawn, so one wider than the room on its side (a right-hung menu
  // near the window's left edge, as the items column's is) is slid back inside the window before it paints.
  const [slide, setSlide] = useState(0);
  useLayoutEffect(() => {
    const box = ref.current?.getBoundingClientRect();
    if (!box) return;
    const margin = 2 * scale;
    if (box.left < margin) {
      setSlide(shell(margin - box.left));
    } else if (box.right > window.innerWidth - margin) {
      setSlide(-Math.min(shell(box.right - (window.innerWidth - margin)), shell(box.left - margin)));
    }
    // Measured once as it opens: a menu closes on a scroll or a camera move, so its anchor does not move under it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  if (align === "right" && anchor.right !== undefined) {
    style.right = Math.max(2, vw - shell(anchor.right)) - slide;
  } else {
    style.left = Math.max(2, shell(anchor.left)) + slide;
  }
  return createPortal(
    <div
      ref={ref}
      role="menu"
      aria-label={label}
      data-mod-menu=""
      className="mm ui-zoom nodrag nowheel"
      style={style}
      onClick={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
      onWheel={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.preventDefault()}
      tabIndex={-1}
      onKeyDown={(event) => {
        // Keys the menu handles stop here: the board pans on arrows from the window, and a camera move closes menus.
        if (MENU_KEYS.has(event.key)) event.stopPropagation();
        const rows = ownRows(ref.current);
        const at = rows.indexOf(document.activeElement as HTMLElement);
        const step = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
        if (step) {
          event.preventDefault();
          rows[at < 0 ? (step > 0 ? 0 : rows.length - 1) : (at + step + rows.length) % rows.length]?.focus();
        } else if (event.key === "Home" || event.key === "End") {
          event.preventDefault();
          rows[event.key === "Home" ? 0 : rows.length - 1]?.focus();
        } else if (event.key === "Tab") {
          event.preventDefault();
          onClose();
        }
      }}
    >
      {title ? <div className="mm-title">{title}</div> : null}
      <div className="mm-scroll">
        {entries.map((entry, index) => (
          <MenuRow
            key={`${entry.label}:${index}`}
            entry={entry}
            onClose={onClose}
            subOpen={sub?.index === index ? sub : undefined}
            onSub={(ask) => askSub(index, ask)}
          />
        ))}
      </div>
    </div>,
    document.body,
  );
}

/** A menu's own enabled rows, not those of a submenu open inside it. */
function ownRows(menu: HTMLElement | null | undefined): HTMLElement[] {
  if (!menu) return [];
  return [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]:not([aria-disabled])')].filter(
    (row) => row.closest('[role="menu"]') === menu,
  );
}

function MenuRow({
  entry,
  onClose,
  subOpen,
  onSub,
}: {
  entry: MenuEntry;
  onClose: () => void;
  /** This row's submenu is open; `focus` counts the keyboard's asks to move into it. */
  subOpen?: { focus: number };
  onSub?: (ask: SubAsk) => void;
}): ReactNode {
  const rowRef = useRef<HTMLDivElement>(null);
  const pressedBy = useRef<string>("mouse");
  const subId = useId();
  const hasSub = Boolean(entry.submenu?.length) && !entry.disabled;
  return (
    <>
      {entry.ruleAbove ? <div className="mm-rule" /> : null}
      <div
        ref={rowRef}
        role="menuitem"
        className="mm-row"
        tabIndex={-1}
        onKeyDown={(event) => {
          if (hasSub && event.target === event.currentTarget && ["ArrowRight", "Enter", " "].includes(event.key)) {
            event.preventDefault();
            event.stopPropagation();
            onSub?.({ kind: "keys" });
            return;
          }
          activateOnKey(event);
        }}
        onPointerDown={(event) => {
          pressedBy.current = event.pointerType || "mouse";
        }}
        onPointerEnter={(event) => {
          // A finger presses instead: only the mouse opens and shuts by hovering.
          if (event.pointerType === "mouse") onSub?.(subOpen ? { kind: "stay" } : { kind: "hover", open: hasSub });
        }}
        data-tone={entry.tone}
        data-current={entry.current ? "" : undefined}
        data-off={entry.disabled ? "" : undefined}
        data-hot={subOpen ? "" : undefined}
        aria-disabled={entry.disabled || undefined}
        aria-haspopup={hasSub ? "menu" : undefined}
        aria-expanded={hasSub ? Boolean(subOpen) : undefined}
        aria-controls={hasSub && subOpen ? subId : undefined}
        {...(entry.tip ? tipAttrs({ id: `menu|${entry.label}`, title: entry.tip }) : {})}
        onClick={() => {
          if (entry.disabled) return;
          playBoardSound("tick");
          if (hasSub) {
            // A mouse press opens it (the hover may have already); a touch or pen press toggles it.
            onSub?.({ kind: "press", toggle: pressedBy.current !== "mouse" });
            pressedBy.current = "mouse";
            return;
          }
          onClose();
          entry.onSelect();
        }}
      >
        {entry.dot ? <span className="mm-dot" style={{ background: entry.dot }} aria-hidden /> : null}
        {entry.plus ? <PixelIcon name="plus" className="mm-plus" /> : null}
        {entry.icon ?? null}
        <span className="mm-label" style={entry.labelFont ? { fontFamily: entry.labelFont } : undefined}>
          {entry.label}
        </span>
        {entry.detail ? <span className="mm-detail">{entry.detail}</span> : null}
        {entry.submenu?.length ? <SubArrow /> : null}
      </div>
      {hasSub && subOpen ? (
        <SubMenu
          id={subId}
          row={rowRef}
          label={entry.label}
          entries={entry.submenu!}
          focus={subOpen.focus}
          onStay={() => onSub?.({ kind: "stay" })}
          onBack={() => onSub?.({ kind: "back" })}
          onClose={onClose}
        />
      ) : null}
    </>
  );
}

/**
 * A row's submenu: the same rows, hung beside the row (to its right, or its left where the window has no room; under
 * or over it where neither side has room, so the row's own words stay in view). It is drawn inside the menu, so a
 * press in it is a press inside, and it wears the menu's zoom: its box is in those pixels. Picking a row closes the
 * whole menu; Left goes back to the row, and focus inside it goes back to the row whenever it shuts.
 */
function SubMenu({
  id,
  row,
  label,
  entries,
  focus,
  onStay,
  onBack,
  onClose,
}: {
  id: string;
  row: React.RefObject<HTMLDivElement | null>;
  label: string;
  entries: MenuEntry[];
  focus: number;
  onStay: () => void;
  onBack: () => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{ left: number; top: number }>();
  const scale = getUiScale() * CHROME_SCREEN_K;
  useLayoutEffect(() => {
    const at = row.current?.getBoundingClientRect();
    const box = ref.current?.getBoundingClientRect();
    if (!at || !box) return;
    const margin = 2 * scale;
    // The menu's top padding (4 GUI px) above its first row, so the first row lines up with the row it hangs from.
    const pad = 4 * scale;
    const right = window.innerWidth - margin;
    const bottom = window.innerHeight - margin;
    let left = at.right + scale;
    let top = at.top - pad;
    if (left + box.width > right) left = at.left - scale - box.width;
    if (left < margin) {
      // Neither side has room (a phone): under the row, its right edge at the row's, or over it if the window ends.
      left = Math.max(margin, Math.min(at.right - box.width, right - box.width));
      top = at.bottom + box.height <= bottom ? at.bottom : at.top - box.height;
    }
    top = Math.max(margin, Math.min(top, bottom - box.height));
    setPlace({ left: left / scale, top: top / scale });
    // Measured once as it opens: the menu closes on a scroll, so the row does not move under it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Each keyboard ask moves focus to the first row, also into a submenu the mouse opened.
  useEffect(() => {
    if (focus > 0 && place) ownRows(ref.current)[0]?.focus({ preventScroll: true });
  }, [focus, place]);
  // Shut for any reason (Left, the mouse on another row) with focus inside: focus goes back to the row, never the page.
  useLayoutEffect(() => {
    const menu = ref.current;
    const owner = row.current;
    return () => {
      if (menu?.contains(document.activeElement) && owner?.isConnected) owner.focus({ preventScroll: true });
    };
  }, [row]);
  return (
    <div
      ref={ref}
      id={id}
      role="menu"
      aria-label={label}
      className="mm mm-sub"
      tabIndex={-1}
      style={place ? { left: place.left, top: place.top } : { left: 0, top: 0, visibility: "hidden" }}
      onPointerEnter={onStay}
      onKeyDown={(event) => {
        // Its keys are its own: neither the menu it hangs from nor the board's camera sees them.
        if (MENU_KEYS.has(event.key)) event.stopPropagation();
        const rows = ownRows(ref.current);
        const at = rows.indexOf(document.activeElement as HTMLElement);
        const step = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
        if (step) {
          event.preventDefault();
          rows[at < 0 ? (step > 0 ? 0 : rows.length - 1) : (at + step + rows.length) % rows.length]?.focus();
        } else if (event.key === "Home" || event.key === "End") {
          event.preventDefault();
          rows[event.key === "Home" ? 0 : rows.length - 1]?.focus();
        } else if (event.key === "ArrowLeft") {
          event.preventDefault();
          onBack();
        } else if (event.key === "Tab") {
          event.preventDefault();
          onClose();
        }
      }}
    >
      <div className="mm-scroll">
        {entries.map((entry, index) => (
          <MenuRow key={`${entry.label}:${index}`} entry={entry} onClose={onClose} />
        ))}
      </div>
    </div>
  );
}

/** The pixel chevron of a row that opens a submenu. */
function SubArrow() {
  return (
    <svg className="mm-sub-arrow" width="4" height="7" viewBox="0 0 4 7" shapeRendering="crispEdges" aria-hidden fill="currentColor">
      <path d="M0 0h1v1h-1zM1 1h1v1h-1zM2 2h1v1h-1zM3 3h1v1h-1zM2 4h1v1h-1zM1 5h1v1h-1zM0 6h1v1h-1z" />
    </svg>
  );
}
