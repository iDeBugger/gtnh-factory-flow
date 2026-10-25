import { describe, expect, it } from "vitest";
import { cardRimDocks } from "@/components/flow/grid-edge-router";
import { arrangeRimDocks } from "./board-arrange-optimize";

describe("the arrange judge's docks", () => {
  it("are the board's: a clean drawer's 116 x 48 box docks on the grid lines outside its right and bottom", () => {
    const drawer = { left: 200, top: 100, right: 316, bottom: 148 };
    const docks = arrangeRimDocks(drawer);
    expect(docks).toEqual(cardRimDocks(drawer));
    expect(new Set(docks.filter((dock) => dock.side === "bottom").map((dock) => dock.y))).toEqual(new Set([160]));
    expect(new Set(docks.filter((dock) => dock.side === "right").map((dock) => dock.x))).toEqual(new Set([320]));
  });
});
