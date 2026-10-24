import { describe, expect, test } from "vitest";
import { hasAmperageOverclock, maxInputTierSkips } from "./power-input-rules";

// GT5U@5.09.51.476: GT++ registers "High Current Industrial Arc Furnace"
// (gtPlusPlus/xmod/gregtech/registration/gregtech/GregtechIndustrialArcFurnace.java:22) and leaves
// ProcessingLogic's defaults: maxTierSkips = 1 (gregtech/api/logic/ProcessingLogic.java:52) and
// setAmperageOC(true) (gregtech/api/metatileentity/implementations/MTEMultiBlockBase.java:1024).
describe("power input rules by game version", () => {
  test("tier skips 2.8.1 gives the High Current Industrial Arc Furnace the default skip", () => {
    expect(maxInputTierSkips("High Current Industrial Arc Furnace", "2.8.1")).toBe(1);
    expect(maxInputTierSkips("High Current Industrial Arc Furnace", "2.9")).toBe(0);
    expect(maxInputTierSkips("Industrial Arc Furnace", "2.9")).toBe(0);
  });

  test("tier skips 2.8.1 keeps the other zero-skip machines", () => {
    for (const version of ["2.8.1", "2.9"]) {
      expect(maxInputTierSkips("Precise Auto-Assembler MT-3662", version)).toBe(0);
      expect(maxInputTierSkips("Steam Grinder", version)).toBe(0);
      expect(maxInputTierSkips("Electric Blast Furnace", version)).toBe(1);
    }
  });

  test("amperage OC 2.8.1 lets the High Current Industrial Arc Furnace overclock on amperage", () => {
    expect(hasAmperageOverclock("High Current Industrial Arc Furnace", "2.8.1")).toBe(true);
    expect(hasAmperageOverclock("High Current Industrial Arc Furnace", "2.9")).toBe(false);
    expect(hasAmperageOverclock("Industrial Arc Furnace", "2.9")).toBe(false);
    expect(hasAmperageOverclock("Steam Grinder", "2.8.1")).toBe(false);
  });

  test("amperage OC 2.8.1 keeps the other exclusions", () => {
    for (const version of ["2.8.1", "2.9"]) {
      expect(hasAmperageOverclock("Compact Fusion Computer MK-I Prototype", version)).toBe(false);
      expect(hasAmperageOverclock("Nano Forge", version)).toBe(false);
      expect(hasAmperageOverclock("Steam Grinder", version)).toBe(false);
      expect(hasAmperageOverclock("Electric Blast Furnace", version)).toBe(true);
    }
  });
});
