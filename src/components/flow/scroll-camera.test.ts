// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ZOOMING_ATTRIBUTE, ZOOM_REST_MS, zoomingMark } from "./scroll-camera";

describe("the viewport's zoom hint", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("is worn while the zoom moves and dropped once it rests", () => {
    const viewport = document.createElement("div");
    const mark = zoomingMark(viewport);
    expect(viewport.hasAttribute(ZOOMING_ATTRIBUTE)).toBe(false);

    mark.zoomed();
    expect(viewport.hasAttribute(ZOOMING_ATTRIBUTE)).toBe(true);
    vi.advanceTimersByTime(ZOOM_REST_MS - 1);
    mark.zoomed();
    vi.advanceTimersByTime(ZOOM_REST_MS - 1);
    expect(viewport.hasAttribute(ZOOMING_ATTRIBUTE)).toBe(true);

    vi.advanceTimersByTime(1);
    expect(viewport.hasAttribute(ZOOMING_ATTRIBUTE)).toBe(false);
  });

  it("is dropped when the camera goes", () => {
    const viewport = document.createElement("div");
    const mark = zoomingMark(viewport);
    mark.zoomed();
    mark.dispose();
    expect(viewport.hasAttribute(ZOOMING_ATTRIBUTE)).toBe(false);
    vi.advanceTimersByTime(ZOOM_REST_MS);
    expect(viewport.hasAttribute(ZOOMING_ATTRIBUTE)).toBe(false);
  });

  // Worn at rest, Chrome draws a board zoomed out from its old, larger raster: soft text and icons.
  it("is the only will-change: transform on the viewport", () => {
    const css = readFileSync(path.resolve(__dirname, "../../client/globals.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const rules = [...css.matchAll(/([^{}]*\.react-flow__viewport[^{}]*)\{([^}]*)\}/g)].filter(([, , body]) =>
      /will-change:\s*transform/.test(body!),
    );
    expect(rules.map(([, selector]) => selector!.trim())).toEqual([
      `.factory-flow-board .react-flow__viewport[${ZOOMING_ATTRIBUTE}]`,
    ]);
  });
});
