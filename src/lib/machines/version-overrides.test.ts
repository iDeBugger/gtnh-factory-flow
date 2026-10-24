import { describe, expect, test } from "vitest";
import { forVersion } from "./version-overrides";
import { getMachineBehaviour } from "./machine-table";

describe("version overrides", () => {
  test("an override changes 2.8.1 only", () => {
    const overrides = { "2.8.1": { "Blast Furnace": { parallels: 2 } } };
    expect(getMachineBehaviour("Blast Furnace", "2.9", overrides)?.parallels).toBe(
      getMachineBehaviour("Blast Furnace", "2.9")?.parallels,
    );
    expect(getMachineBehaviour("Blast Furnace", "2.8.1", overrides)?.parallels).toBe(2);
  });

  test("a null override hides a machine in that version", () => {
    expect(getMachineBehaviour("Blast Furnace", "2.8.1", { "2.8.1": { "Blast Furnace": null } })).toBeUndefined();
    expect(getMachineBehaviour("Blast Furnace", "2.9", { "2.8.1": { "Blast Furnace": null } })).toBeDefined();
  });

  test("with no overrides every version reads the 2.9 entry itself", () => {
    expect(getMachineBehaviour("Blast Furnace", "2.8.1")).toBe(getMachineBehaviour("Blast Furnace", "2.9"));
  });

  test("forVersion merges a partial over the base and leaves other items alone", () => {
    const overrides = { "2.8.1": { a: { y: 3 } } };
    expect(forVersion("a", { x: 1, y: 2 }, overrides, "2.8.1")).toEqual({ x: 1, y: 3 });
    expect(forVersion("a", { x: 1, y: 2 }, overrides, "2.9")).toEqual({ x: 1, y: 2 });
    const base = { x: 1, y: 2 };
    expect(forVersion("b", base, overrides, "2.8.1")).toBe(base);
  });

  test("an override with no base reads as absent, never as a complete item", () => {
    const overrides = { "2.8.1": { a: { y: 3 } } };
    expect(forVersion<{ x: number; y: number }>("a", undefined, overrides, "2.8.1")).toBeUndefined();
  });
});
