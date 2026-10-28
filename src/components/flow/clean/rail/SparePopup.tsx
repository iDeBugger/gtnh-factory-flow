import { useEffect, useRef, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { useFactoryStore } from "@/store/factory-store";
import { railData } from "./rail-data";
import { SpareBlock, setScopeOfPlace } from "./SpareBlock";
import { hideTip } from "./rail-tip";
import { parsePortKey } from "@/lib/solver/plan/port-key";
import type { SpareBearerView } from "./spare-model";

/**
 * What a card's Forced row opens (a click on it) when its leftover has
 * somewhere else to go: the same block as the overview's, with labels, the
 * place clicked marked "(here)", and under it a small link for a drawer to take
 * it at that port instead. Nothing else: no title, no list. Hovering a place
 * rings its card on the board (the block sets the hover scope).
 */

interface PopupState {
  leftoverKey: string;
  here: string;
  x: number;
  y: number;
}

const POPUP_W = 230;
const PAD = 6;
let popup: PopupState | undefined;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function closeSparePopup(): void {
  if (!popup) return;
  popup = undefined;
  setScopeOfPlace(undefined);
  emit();
}

/**
 * Opens the popup for the leftover a port takes part in, at a screen point.
 * False (nothing opens) when the port is not part of a leftover with a choice.
 */
export function openSparePopupForPort(portKey: string, x: number, y: number): boolean {
  const { project, lastResult } = useFactoryStore.getState();
  const leftover = lastResult?.plan?.leftovers.find(
    (l) =>
      l.bearers.length >= 2 &&
      l.bearers.some((b) => b.portKey === portKey || b.flows.some((f) => f.portKey === portKey)),
  );
  if (!leftover) return false;
  const bearer = leftover.bearers.find(
    (b) => b.portKey === portKey || b.flows.some((f) => f.portKey === portKey),
  )!;
  hideTip();
  popup = { leftoverKey: leftover.key, here: bearer.portKey, x, y };
  void project;
  emit();
  return true;
}

/** A drawer to take the leftover at the clicked place's port instead. */
function putDrawerHere(bearer: SpareBearerView): void {
  const store = useFactoryStore.getState();
  const node = store.project.nodes.find((n) => n.id === bearer.nodeId);
  if (!node) return;
  const position = { x: node.position.x + (bearer.output ? 420 : -240), y: node.position.y };
  store.addStorageForConnection(
    {
      kind: bearer.resource.kind,
      id: bearer.resource.id,
      displayName: bearer.name,
      iconPath: bearer.resource.iconPath,
      iconAtlas: bearer.resource.iconAtlas,
      dominantColor: bearer.resource.dominantColor,
    },
    bearer.nodeId,
    bearer.output ? "output" : "input",
    position,
    parsePortKey(bearer.key)?.handle ?? bearer.handle,
  );
}

export function SparePopupHost() {
  const state = useSyncExternalStore(
    subscribe,
    () => popup,
    () => undefined,
  );
  const project = useFactoryStore((s) => s.project);
  const result = useFactoryStore((s) => s.lastResult);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!state) return undefined;
    const onDown = (event: PointerEvent) => {
      if (ref.current && event.target instanceof Node && ref.current.contains(event.target)) return;
      closeSparePopup();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeSparePopup();
    };
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [state]);

  if (!state || typeof document === "undefined") return null;
  const spare = railData(project, result).spares.find((s) => s.key === state.leftoverKey);
  if (!spare) {
    // The plan moved on and the leftover is gone: nothing left to choose.
    queueMicrotask(closeSparePopup);
    return null;
  }
  const here = spare.bearers.find((b) => b.key === state.here);
  const left = Math.max(4, Math.min(state.x, window.innerWidth - POPUP_W - 2 * PAD - 8));
  const top = Math.max(4, Math.min(state.y + 8, window.innerHeight - 220));
  return createPortal(
    <div
      ref={ref}
      className="rail-popup"
      style={{ left, top, width: POPUP_W + 2 * PAD }}
      data-tooltip-stop
      onContextMenu={(event) => event.preventDefault()}
    >
      <SpareBlock spare={spare} here={state.here} popup width={POPUP_W} />
      {here ? (
        <div
          role="button"
          tabIndex={0}
          className="rail-popup-link"
          onClick={() => {
            closeSparePopup();
            putDrawerHere(here);
          }}
        >
          <span>or put a drawer here</span>
        </div>
      ) : null}
    </div>,
    document.body,
  );
}
