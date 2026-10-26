"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { onPanelOpenRequest, type SidePanel } from "@/lib/panel-force";
import {
  fitPanels,
  panelDragLimits,
  planColumns,
  type PanelFit,
  type PanelFitInput,
  type WorkspaceColumns,
} from "@/lib/workspace-columns";

export interface PanelWishes {
  /** The player's own folds. */
  itemsOpen: boolean;
  overviewOpen: boolean;
  /** The widths the player set. */
  itemsWidth: number;
  overviewWidth: number;
  /** A page covers the board: the overview is gone. */
  covering: boolean;
  itemsLeft: boolean;
}

export interface PanelFitState {
  /** What the columns show now: the player's folds, and the window's on top of them. */
  itemsOpen: boolean;
  overviewOpen: boolean;
  /** Whether the window (not the player) folded each. */
  itemsAutoFolded: boolean;
  overviewAutoFolded: boolean;
  /** The columns before the window is measured (the server's answer, and the first paint's). */
  initial: WorkspaceColumns;
  /** Ask for a column the window folded to be open: it stays, and the other gives way. */
  openAgainstWindow: (panel: SidePanel) => void;
  /** The column's width now and what it can be dragged to, in shell px. */
  widthOf: (panel: SidePanel) => number;
  limitsOf: (panel: SidePanel) => { min: number; max: number };
  /** A drag in progress: shows this width for the column without rendering, and the end puts the fit back. */
  preview: (panel: SidePanel, width: number) => void;
  setResizing: (resizing: boolean) => void;
}

function inputOf(width: number, wishes: PanelWishes, forced: { items: boolean; overview: boolean }): PanelFitInput {
  return {
    width,
    items: { open: wishes.itemsOpen, forced: forced.items, width: wishes.itemsWidth },
    overview: wishes.covering ? null : { open: wishes.overviewOpen, forced: forced.overview, width: wishes.overviewWidth },
  };
}

/** Writes the grid on the workspace element; what the overlays read (`overlayInsets`) follows it. */
function writeColumns(main: HTMLElement, columns: WorkspaceColumns): void {
  main.style.gridTemplateColumns = columns.template;
  main.dataset.leftPx = String(columns.leftPx);
  main.dataset.rightPx = String(columns.rightPx);
}

/**
 * The plan board's two side columns against the window (`fitPanels`): the workspace's width is read when it changes,
 * the grid is written straight onto it (shell px), and only a fold by the window is state, so the board re-renders
 * when a column folds or comes back, never per pixel of a resize or of a drag.
 */
export function usePanelFit(mainRef: RefObject<HTMLElement | null>, wishes: PanelWishes): PanelFitState {
  const [auto, setAuto] = useState({ items: false, overview: false });
  const wishesRef = useRef(wishes);
  const forced = useRef({ items: false, overview: false });
  const fitRef = useRef<{ fit: PanelFit; width: number } | null>(null);
  const resizing = useRef(false);
  // The latest wishes, in place before the effects below read them.
  useLayoutEffect(() => {
    wishesRef.current = wishes;
  });

  const apply = useCallback(() => {
    const main = mainRef.current;
    const width = main?.clientWidth ?? 0;
    if (!main || width === 0) return;
    const current = wishesRef.current;
    // A column opened against the window is let go once the window would not fold it any more (or the player folds it).
    const plain = fitPanels(inputOf(width, current, { items: false, overview: false }));
    if (forced.current.items && (!current.itemsOpen || !plain.itemsAutoFolded)) forced.current.items = false;
    if (forced.current.overview && (!current.overviewOpen || !plain.overviewAutoFolded)) forced.current.overview = false;
    const fit = fitPanels(inputOf(width, current, forced.current));
    fitRef.current = { fit, width };
    if (!resizing.current) writeColumns(main, planColumns(fit, current.itemsLeft));
    setAuto((previous) =>
      previous.items === fit.itemsAutoFolded && previous.overview === fit.overviewAutoFolded
        ? previous
        : { items: fit.itemsAutoFolded, overview: fit.overviewAutoFolded },
    );
  }, [mainRef]);

  // Before paint, and again whenever what the player wants changes.
  useLayoutEffect(() => {
    apply();
  }, [apply, wishes.itemsOpen, wishes.overviewOpen, wishes.itemsWidth, wishes.overviewWidth, wishes.covering, wishes.itemsLeft]);

  useEffect(() => {
    const main = mainRef.current;
    if (!main || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(apply);
    observer.observe(main);
    return () => observer.disconnect();
  }, [apply, mainRef]);

  const openAgainstWindow = useCallback(
    (panel: SidePanel) => {
      forced.current[panel] = true;
      // The player's own fold is written first and re-renders this: the fit is redone then. Open already (the window
      // folded it), nothing re-renders, so it is redone now.
      const open = panel === "items" ? wishesRef.current.itemsOpen : wishesRef.current.overviewOpen;
      if (open) apply();
    },
    [apply],
  );

  useEffect(() => onPanelOpenRequest(openAgainstWindow), [openAgainstWindow]);

  const widthOf = useCallback((panel: SidePanel) => {
    const state = fitRef.current;
    if (!state) return panel === "items" ? wishesRef.current.itemsWidth : wishesRef.current.overviewWidth;
    return panel === "items" ? state.fit.itemsPx : state.fit.overviewPx;
  }, []);

  const limitsOf = useCallback((panel: SidePanel) => {
    const state = fitRef.current;
    if (!state) return { min: 0, max: Number.POSITIVE_INFINITY };
    return panelDragLimits(panel, state.fit, state.width);
  }, []);

  const preview = useCallback(
    (panel: SidePanel, width: number) => {
      const main = mainRef.current;
      const state = fitRef.current;
      if (!main || !state) return;
      const fit = { ...state.fit };
      if (panel === "items") fit.itemsPx = width;
      else fit.overviewPx = width;
      fit.boardPx = state.width - fit.itemsPx - fit.overviewPx;
      writeColumns(main, planColumns(fit, wishesRef.current.itemsLeft));
    },
    [mainRef],
  );

  const setResizing = useCallback(
    (value: boolean) => {
      resizing.current = value;
      const main = mainRef.current;
      if (!main) return;
      if (value) main.setAttribute("data-resizing", "");
      else {
        main.removeAttribute("data-resizing");
        apply();
      }
    },
    [apply, mainRef],
  );

  const open = (panel: SidePanel) =>
    panel === "items" ? wishes.itemsOpen && !auto.items : wishes.overviewOpen && !wishes.covering && !auto.overview;
  const initialFit = fitPanels(inputOf(Number.POSITIVE_INFINITY, wishes, { items: false, overview: false }));
  return {
    itemsOpen: open("items"),
    overviewOpen: open("overview"),
    itemsAutoFolded: auto.items,
    overviewAutoFolded: auto.overview,
    initial: planColumns(initialFit, wishes.itemsLeft),
    openAgainstWindow,
    widthOf,
    limitsOf,
    preview,
    setResizing,
  };
}
