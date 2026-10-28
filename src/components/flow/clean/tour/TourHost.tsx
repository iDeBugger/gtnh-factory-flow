import { useEffect, useRef, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { OPEN_TOUR_EVENT } from "@/components/chrome/chrome-events";
import { Callout } from "./Callout";
import * as input from "./input";
import {
  attachTourLayer,
  leaveTour,
  startTour,
  tourBack,
  tourHurry,
  tourJump,
  tourNext,
  tourStatus,
  useTourNote,
} from "./tour-controller";
import { useTour } from "./tour-store";
import "./tour.css";

/**
 * Mount once (FactoryPlannerApp or the board): the layer the tour's cursor draws into, the shield that keeps the
 * player's clicks off the board while a step plays (a click anywhere hurries it), the note, and the keys:
 * right arrow, Space or Enter is next, left arrow back, Esc leaves. Only the player's own keys count
 * (the tour's synthetic ones are not trusted events), and none is taken while the player types in a box.
 */
export function TourHost() {
  const tour = useTour();
  const note = useTourNote();
  const layerRef = useRef<HTMLDivElement | null>(null);
  const active = tour.phase !== "idle";
  // The server renders nothing and the first client render must match it; the portal comes after mount.
  const mounted = useSyncExternalStore(
    () => () => undefined,
    () => true,
    () => false,
  );

  useEffect(() => {
    if (!mounted) return;
    attachTourLayer(layerRef.current ?? undefined);
    // A handle for walking the tour by hand in development.
    if (process.env.NODE_ENV !== "production") {
      (window as unknown as { __tour?: object }).__tour = {
        start: startTour,
        jump: tourJump,
        next: tourNext,
        back: tourBack,
        leave: leaveTour,
        status: tourStatus,
        input,
      };
    }
    return () => attachTourLayer(undefined);
  }, [mounted]);

  useEffect(() => {
    // Help > Take the tour (and the settings' Take it) knock on this door.
    const onKnock = (event: Event) => {
      event.preventDefault();
      void startTour();
    };
    window.addEventListener(OPEN_TOUR_EVENT, onKnock);
    return () => window.removeEventListener(OPEN_TOUR_EVENT, onKnock);
  }, []);

  useEffect(() => {
    if (!active) return;
    const onKey = (event: KeyboardEvent) => {
      if (!event.isTrusted) return;
      const target = event.target;
      const typing =
        target instanceof HTMLElement && Boolean(target.closest("input, textarea, select, [contenteditable='true']"));
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        void leaveTour();
        return;
      }
      // Nothing else reaches the planner while the tour plays: only Esc, and the note's own keys.
      event.preventDefault();
      event.stopPropagation();
      if (typing || event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.key === "ArrowRight" || event.key === " " || event.key === "Enter") tourNext();
      else if (event.key === "ArrowLeft") tourBack();
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (!event.isTrusted) return;
      event.preventDefault();
      event.stopPropagation();
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("keyup", onKeyUp, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("keyup", onKeyUp, true);
    };
  }, [active]);

  if (!mounted) return null;
  return createPortal(
    <div ref={layerRef} className="tour-layer" data-tour="layer" data-active={active ? "" : undefined}>
      {/* Over the whole page for the whole tour: the player can only use the note. While a step plays, a click
          hurries it to its note. */}
      {active ? (
        <div
          className="tour-shield"
          data-tour="shield"
          data-waiting={tour.phase === "waiting" ? "" : undefined}
          onPointerDown={tour.phase === "playing" ? tourHurry : undefined}
          onClick={tour.phase === "playing" ? tourHurry : undefined}
          onWheel={(event) => event.stopPropagation()}
          onContextMenu={(event) => event.preventDefault()}
        />
      ) : null}
      {active && note && tour.phase === "waiting" ? (
        <Callout
          note={note}
          last={tour.index + 1 >= tour.total}
          done={tour.noteReady}
          canBack={tour.index > 0}
          onNext={tourNext}
          onBack={tourBack}
          onLeave={() => void leaveTour()}
        />
      ) : null}
    </div>,
    document.body,
  );
}
