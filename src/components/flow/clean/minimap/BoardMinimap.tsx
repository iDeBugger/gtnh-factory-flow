import { useReactFlow, useStore, useStoreApi } from "@xyflow/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { toBoard } from "./minimap-draw";
import { MinimapEngine } from "./minimap-engine";
import { getMinimap, MINIMAP_SIZES, setMinimap, useMinimapSettings } from "./minimap-settings";
import { clearDockOfMinimap } from "./dock-clearance";
import { MinimapSettingsPanel } from "./MinimapSettingsPanel";
import "./minimap.css";

/**
 * The minimap (the mod's, on the board): the whole plan fitted in the board's corner, drawn on ONE canvas from
 * the board's own state, never from the DOM per frame (`MinimapEngine`). It holds still while the board pans and
 * zooms; only the frame of the board's view moves, and a press or drag on it carries the board there. N shows or hides
 * it. No title: the plan's tab names it. Mount it inside the board's ReactFlow.
 */

function isTyping(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && Boolean(target.closest("input, textarea, select, [contenteditable='true']"));
}

export function BoardMinimap({ hidden = false }: { hidden?: boolean }) {
  const settings = useMinimapSettings();
  const flow = useReactFlow();
  const storeApi = useStoreApi();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const engineRef = useRef<MinimapEngine | null>(null);
  const dragRef = useRef<number | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const visible = settings.show && !hidden;
  const size = MINIMAP_SIZES[settings.size];

  // The camera scrolls the flow's own container, so the map lives on the board's root instead.
  const domNode = useStore((s) => s.domNode);
  const host = domNode?.closest<HTMLElement>(".factory-flow-board") ?? null;

  // The frame loop, while the map is up.
  useEffect(() => {
    if (!visible || !host) return;
    const engine = new MinimapEngine(storeApi, () => canvasRef.current);
    engineRef.current = engine;
    const stop = engine.start();
    return () => {
      stop();
      engineRef.current = null;
    };
  }, [visible, host, storeApi]);

  useEffect(() => {
    engineRef.current?.schedule("draw");
  }, [settings]);

  // NEI's search field, centred under the board, steps aside so it never covers the map in a bottom corner.
  useEffect(() => {
    if (!visible || !host) return;
    return clearDockOfMinimap(host, () => wrapRef.current, settings.corner);
  }, [visible, host, settings.corner, settings.size]);

  // N: not while typing, not with a modifier.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey || isTyping(event.target)) return;
      if ((event.key === "n" || event.key === "N") && !event.shiftKey) setMinimap({ show: !getMinimap().show });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const carryTo = useCallback(
    (event: React.PointerEvent) => {
      const canvas = canvasRef.current;
      const engine = engineRef.current;
      const view = engine?.view;
      if (!canvas || !engine || !view) return;
      const rect = canvas.getBoundingClientRect();
      const p = toBoard(view, event.clientX - rect.left, event.clientY - rect.top);
      // The map holds still where it is while the board moves under the press.
      engine.frozen ??= { x: view.cx, y: view.cy };
      void flow.setCenter(p.x, p.y, { zoom: storeApi.getState().transform[2], duration: 0 });
    },
    [flow, storeApi],
  );

  const release = (): void => {
    dragRef.current = null;
    const engine = engineRef.current;
    if (engine) {
      engine.frozen = undefined;
      engine.schedule("draw");
    }
  };

  if (!visible || !host) return null;
  return createPortal(
    <div
      ref={wrapRef}
      className="mmap nodrag nopan nowheel"
      data-minimap=""
      data-corner={settings.corner}
      data-shape={settings.shape}
      style={{ width: size, height: size }}
      onContextMenu={(event) => event.preventDefault()}
    >
      <canvas
        ref={canvasRef}
        className="mmap-canvas"
        style={{ width: size, height: size }}
        aria-label="Minimap"
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.currentTarget.setPointerCapture(event.pointerId);
          dragRef.current = event.pointerId;
          carryTo(event);
        }}
        onPointerMove={(event) => {
          if (dragRef.current === event.pointerId) carryTo(event);
        }}
        onPointerUp={(event) => {
          if (dragRef.current === event.pointerId) release();
        }}
        onPointerCancel={release}
      />
      <div
        role="button"
        aria-label="Minimap settings"
        title="Minimap settings"
        className="mmap-gear"
        onClick={() => setSettingsOpen((open) => !open)}
      />
      {settingsOpen ? <MinimapSettingsPanel onClose={() => setSettingsOpen(false)} /> : null}
    </div>,
    host,
  );
}
