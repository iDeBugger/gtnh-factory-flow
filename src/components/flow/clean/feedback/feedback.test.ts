// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { APP_VERSION } from "@/lib/version";
import { buildReport, deviceId, faceRects, sendsLine, titleOf, versions } from "./feedback-model";

/** The site's guard (src/lib/server/feedback-guard.ts) knows the web's own shapes. */
const DEVICE = /^web-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MOD_VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]+)?$/;
const OS = /^[A-Za-z0-9 ._()/+-]{1,100}$/;

describe("feedback report", () => {
  beforeEach(() => window.localStorage.clear());

  it("carries the shapes the route's guard wants", () => {
    const v = versions();
    expect(MOD_VERSION.test(v.mod)).toBe(true);
    expect(v.mod).toBe(APP_VERSION);
    expect(v.java).toBe("");
    expect(v.pack).toBe("");
    expect(OS.test(v.os)).toBe(true);
    expect(DEVICE.test(deviceId())).toBe(true);
  });

  it("keeps one device id", () => {
    expect(deviceId()).toBe(deviceId());
  });

  it("makes the title the first line, cut at a word", () => {
    expect(titleOf("  Wires cross the card\nmore words")).toBe("Wires cross the card");
    const long = `${"word ".repeat(40)}end`;
    const t = titleOf(long);
    expect(t.endsWith("...")).toBe(true);
    expect(t.length).toBeLessThanOrEqual(100);
    expect(titleOf("   ")).toBe("");
  });

  it("names what goes with the words", () => {
    expect(sendsLine("Iron line", true)).toBe(
      "Sent with it: the open plan 'Iron line' and a picture of it. Tasks and comments stay out.",
    );
    expect(sendsLine("Iron line", false)).toBe("Sent with it: the open plan 'Iron line'. Tasks and comments stay out.");
    expect(sendsLine(undefined, false)).toBe("Nothing goes with it but your words.");
  });

  it("builds the route's report, mood and picture only when there are some", () => {
    const base = buildReport({ kind: "idea", text: "A thing\nand why" });
    expect(base).toMatchObject({ origin: "web", kind: "idea", title: "A thing", description: "A thing\nand why", plans: [] });
    expect("mood" in base).toBe(false);
    expect("picture" in base).toBe(false);
    const full = buildReport({ kind: "bug", mood: "sad", text: "x", plan: { name: "P", plan: { a: 1 } }, picture: "AAAA" });
    expect(full).toMatchObject({ mood: "sad", picture: "AAAA", plans: [{ name: "P", plan: { a: 1 } }] });
  });
});

describe("faces", () => {
  it("draws the mod's 14 pixel disc with eyes and a mouth that differ by mood", () => {
    const rects = (m: number) => faceRects(m, false, false);
    expect(rects(0).length).not.toBe(rects(1).length);
    const happy = rects(0);
    expect(happy.slice(-5).map((r) => [r.x, r.y, r.w, r.h])).toEqual([
      [4, 4, 2, 2],
      [8, 4, 2, 2],
      [3, 8, 1, 1],
      [4, 9, 6, 1],
      [10, 8, 1, 1],
    ]);
  });

  it("rings a picked face in white and lights a hovered one", () => {
    expect(faceRects(0, true, false).slice(0, 3).every((r) => r.fill === "#FFFFFF")).toBe(true);
    expect(faceRects(0, false, true)[0]!.fill).not.toBe(faceRects(0, false, false)[0]!.fill);
  });
});

describe("the route takes what the box sends", () => {
  it("parses as a report and looks like the web's to the guard", async () => {
    const { parseFeedback } = await import("@/lib/server/feedback");
    const { looksSentByTheGame, looksSentByTheWeb } = await import("@/lib/server/feedback-guard");
    const { createNewProject } = await import("@/examples");
    const body = buildReport({
      kind: "bug",
      mood: "okay",
      text: "The card overlaps\nwhen I clone it",
      plan: { name: "Iron line", plan: createNewProject() },
    });
    const report = parseFeedback(JSON.parse(JSON.stringify(body)));
    expect("error" in report).toBe(false);
    if ("error" in report) return;
    expect(report.title).toBe("The card overlaps");
    expect(report.plans).toHaveLength(1);
    expect(looksSentByTheWeb(report)).toBe(true);
    expect(looksSentByTheGame(report)).toBe(false);
  });
});
