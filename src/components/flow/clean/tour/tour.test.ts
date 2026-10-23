// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { parseLines, parseSpans, plainText } from "./markup";
import { overlap, placeNote } from "./placement";
import { tourSteps } from "./script";
import { withModAndCommunityOn, withModAndCommunityUnset } from "@/test-support/mod-and-community";

describe("tour markup", () => {
  it("makes words between asterisks gold and {b:} {o:} the resource inks", () => {
    expect(parseSpans("A *gold* word, {b:Blue} and {o:Orange}.")).toEqual([
      { text: "A ", ink: "plain" },
      { text: "gold", ink: "gold" },
      { text: " word, ", ink: "plain" },
      { text: "Blue", ink: "blue" },
      { text: " and ", ink: "plain" },
      { text: "Orange", ink: "orange" },
      { text: ".", ink: "plain" },
    ]);
  });

  it("lifts a leading mouse or key glyph out of each line", () => {
    const lines = parseLines("{M} *Middle mouse* to pan.\n{K} *W A S D* to move.\nTry it.");
    expect(lines.map((l) => l.glyph)).toEqual(["M", "K", undefined]);
    expect(plainText("{M} *Middle mouse* to pan.\nTry it.")).toBe("Middle mouse to pan.\nTry it.");
  });
});

describe("note placement", () => {
  const viewport = { w: 1000, h: 700 };
  const size = { w: 330, h: 120 };

  it("goes below the thing when there is room, the tip under its middle", () => {
    const p = placeNote({ target: { x: 400, y: 100, w: 200, h: 100 }, size, viewport });
    expect(p.side).toBe("below");
    expect(p.y).toBeGreaterThanOrEqual(200);
    expect(p.x + p.tip).toBeCloseTo(500, 0);
  });

  it("goes above when there is no room below", () => {
    const p = placeNote({ target: { x: 400, y: 560, w: 200, h: 100 }, size, viewport });
    expect(p.side).toBe("above");
    expect(p.y + size.h).toBeLessThanOrEqual(560);
  });

  it("stays on the screen and off what it was told to avoid", () => {
    const target = { x: 20, y: 20, w: 100, h: 60 };
    const avoid = [{ x: 0, y: 90, w: 130, h: 200 }];
    const p = placeNote({ target, size, viewport, avoid });
    expect(p.x).toBeGreaterThanOrEqual(10);
    const rect = { x: p.x, y: p.y, w: size.w, h: size.h };
    expect(overlap(rect, avoid[0]!)).toBe(0);
    expect(p.side).toBe("right");
  });

  it("says its piece in the middle with nothing to point at", () => {
    const p = placeNote({ target: null, size, viewport });
    expect(p.side).toBe("centre");
    expect(p.x).toBe((1000 - 330) / 2);
  });
});

describe("the script", () => {
  withModAndCommunityOn();

  it("visits the Community shelf in the library", () => {
    const library = tourSteps().find((step) => step.id === "library");
    expect(library?.note.text).toMatch(/\*Community\*/);
  });

  it("has unique step ids and a note for each, in plain short words", () => {
    const steps = tourSteps();
    const ids = steps.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(steps.length).toBeGreaterThanOrEqual(30);
    for (const step of steps) {
      expect(step.note.text.length).toBeGreaterThan(10);
      expect(step.actions.length).toBeGreaterThan(0);
      // The owner's voice: no website or Factory Flow names in a note.
      expect(step.note.text).not.toMatch(/gtnhplanner\.com|factory flow/i);
    }
  });

  it("leaves out what needs the game", () => {
    const all = tourSteps().map((s) => s.note.text).join("\n");
    expect(all).not.toMatch(/\bNEI\b|in the world|pin list|crosshair/i);
  });
});

describe("the script with the community library switched off", () => {
  withModAndCommunityUnset();

  it("runs from Plans to the new plan with no Community shelf to wait for or click", () => {
    const steps = tourSteps();
    const ids = steps.map((s) => s.id);
    expect(ids).not.toContain("library");
    expect(ids.indexOf("new-plan")).toBe(ids.indexOf("plans") + 1);
    expect(ids[ids.length - 1]).toBe("feedback");
    expect(steps.map((s) => s.note.text).join("\n")).not.toMatch(/community/i);
    // Each step still has its actions, so the director plays it through to the end.
    for (const step of steps) expect(step.actions.length).toBeGreaterThan(0);
  });
});
