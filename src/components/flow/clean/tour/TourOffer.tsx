import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { getUiScale } from "@/lib/ui-scale";
import { startTour, tourAvailable } from "./tour-controller";
import { getTour, markTourOffered, tourOffered } from "./tour-store";
import "./tour.css";

/**
 * The first-run offer (the mod's TourOffer): a note over the board the first time the planner opens, asked once.
 * Either answer puts it away for good. It waits until a board is on screen and nothing else covers it.
 */
export function TourOffer() {
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    if (tourOffered()) return;
    const id = window.setInterval(() => {
      const board = document.querySelector<HTMLElement>(".factory-flow-board");
      if (!board || !tourAvailable() || getTour().phase !== "idle") return;
      const r = board.getBoundingClientRect();
      // Something over the board (a dialog, the welcome page, the recipe search) holds the offer back.
      const probe = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      if (r.width < 200 || !probe || !board.contains(probe)) return;
      window.clearInterval(id);
      window.setTimeout(() => {
        if (tourOffered() || getTour().phase !== "idle") return;
        // Under any notices the board is showing (a converted plan's), never over their text.
        const notices = document.querySelector<HTMLElement>(".rail-notices-top")?.getBoundingClientRect();
        setAt({ x: r.left + 16, y: Math.max(r.top + 70, notices && notices.height > 0 ? notices.bottom + 8 : 0) });
      }, 1200);
    }, 1500);
    return () => window.clearInterval(id);
  }, []);

  if (!at || typeof document === "undefined") return null;
  const answer = (take: boolean) => {
    markTourOffered();
    setAt(null);
    if (take) void startTour();
  };
  return createPortal(
    <div
      className="tour-offer ui-zoom"
      data-tour="offer"
      role="dialog"
      aria-label="Take the tour"
      // Drawn at the interface zoom, as the menus are: its place in real pixels, divided back.
      style={{ left: at.x / getUiScale(), top: at.y / getUiScale() }}
    >
      <div className="tour-offer-title">New to GTNH Planner?</div>
      <div>A quick tour shows you around in about three minutes.</div>
      <div className="tour-offer-keys">
        <div role="button" className="tour-offer-key" data-primary="" onClick={() => answer(true)}>
          Take the tour
        </div>
        <div role="button" className="tour-offer-key" onClick={() => answer(false)}>
          Not now
        </div>
      </div>
    </div>,
    document.body,
  );
}
