import { describe, expect, it, test } from "vitest";
import type { GameVersion } from "@/lib/model/game-version";
import { powerTablesFor } from "../planner-data";
import { buildPowerRecipe } from "../power-recipe";
import { getPowerSource } from "../registry";
import { buildPowerSettingsReader, type PowerModel, type PowerSetting } from "../types";
import { htgrOperation } from "./reactors";

/**
 * Reactor and endgame cards where the pack's Java (GT5U 5.09.54.20) and the
 * workbook disagree; each expectation names the class it follows.
 */
function compute(sourceId: string, settings: Record<string, string> = {}): PowerModel {
  const source = getPowerSource(sourceId, "2.9");
  if (!source) {
    throw new Error(`No power source ${sourceId}`);
  }
  return source.compute(buildPowerSettingsReader(source, settings, "2.9"), "2.9");
}

const flow = (lines: PowerModel["inputs"], name: string) => lines.find((line) => line.name === name)?.perSecond;

describe("Eye of Harmony", () => {
  it("spreads a craft's net EU over its duration in seconds", () => {
    // EyeOfHarmonyRecipeStorage.timeCalculator: T0 runs 18,000 s. The
    // workbook's own net power cell (14. EOH Q10) is -64,360,304,863 EU/t.
    const model = compute("eye-of-harmony", { star: "T0 Overworld" });
    expect(model.euPerTick / -64_360_304_863).toBeCloseTo(1, 5);
    expect(model.stats.find((line) => line.label === "Cycle")?.value).toBe("5h");
  });

  it("consumes 1e9 x (tier + 1) L of hydrogen and helium a craft", () => {
    const overworld = compute("eye-of-harmony", { star: "T0 Overworld" });
    expect(flow(overworld.inputs, "Hydrogen")).toBeCloseTo(1e9 / 18_000, 6);
    expect(flow(overworld.inputs, "Helium")).toBeCloseTo(1e9 / 18_000, 6);
    // The Deep Dark runs at rocket tier 9: 1e10 L over 371,898 s.
    const deepDark = compute("eye-of-harmony", { star: "T10 Deep Dark" });
    expect(flow(deepDark.inputs, "Hydrogen")).toBeCloseTo(1e10 / 371_898, 6);
  });
});

describe("LFTR", () => {
  it("leaves TB Salt from LFTR Fuel 2", () => {
    // RecipeLoaderLFTR: LiFBeF2ZrF4UF4 -> 50 L U Salt, 100 L LiFBeF2ThF4 (TB Salt).
    const model = compute("lftr", { fuel: "LFTR Fuel 2" });
    expect(flow(model.outputs, "TB-Salt")).toBe(1);
    expect(flow(model.outputs, "T-Salt")).toBeUndefined();
    expect(flow(model.outputs, "U-Salt")).toBe(0.5);
  });
});

describe("Large Naquadah Reactor", () => {
  it("draws liquid air, coolant and booster ceil(d/20) times a recipe", () => {
    // MTELargeNaquadahReactor draws when progress % 20 == 0: Mk-II's
    // 70-tick recipe draws 4 times in 3.5 s.
    const mk2 = compute("large-naquadah-reactor", {
      fuel: "Naq Fuel Mk-II",
      coolant: "Cryotheum",
      booster: "Molten Caesium",
    });
    expect(flow(mk2.inputs, "Liquid Air")).toBeCloseTo((2400 * 4) / 3.5, 9);
    expect(flow(mk2.inputs, "Cryotheum")).toBeCloseTo((1000 * 4) / 3.5, 9);
    expect(flow(mk2.inputs, "Molten Caesium")).toBeCloseTo((180 * 4) / 3.5, 9);
    // The fuel is still 1 L per boost level per recipe.
    expect(flow(mk2.inputs, "Naq Fuel Mk-II")).toBeCloseTo(2 / 3.5, 9);
    // Plutonium: 150 ticks, 8 draws in 7.5 s.
    const plutonium = compute("large-naquadah-reactor", { fuel: "Plutonium Fuel (Excited)" });
    expect(flow(plutonium.inputs, "Liquid Air")).toBeCloseTo(2560, 9);
    // Whole-second recipes draw once a second.
    const mk1 = compute("large-naquadah-reactor", { fuel: "Naq Fuel Mk-I" });
    expect(flow(mk1.inputs, "Liquid Air")).toBe(2400);
  });
});

describe("Antimatter", () => {
  it("feeds the growth with Protomatter and burns it with the UMV catalyst", () => {
    // AntimatterForge depletes Protomatter equal to the antimatter it adds;
    // the workbook's gain at 657,600 L is 396.11 L/s (13. Antimatter K6).
    const model = compute("antimatter", { amount: "657600" });
    expect(flow(model.inputs, "Protomatter")).toBeCloseTo(396.1129138, 5);
    expect(flow(model.inputs, "Molten Superconductor Base UMV")).toBeCloseTo(396.1129138, 5);
  });
});

describe("HTGR", () => {
  it("will not run below 100 balls", () => {
    // MTEHighTempGasCooledReactor.MIN_CAPACITY is 1% of 10,000.
    const fill = getPowerSource("htgr", "2.9")?.settings.find((setting) => setting.id === "fill");
    expect(fill?.type === "number" && fill.min).toBe(100);
  });

  it("adds no speedup for a draw that truncates to 0 L/t", () => {
    // Tungsten at 150 balls draws 3 L/t of coolant and 0 of water, so only
    // the coolant speedup (16 a tick) runs: ceil(4,586 / 17) = 270 ticks.
    const run = htgrOperation({ base: 0.05, mult: 0.8, exp: 0.5 }, 150);
    expect(run.coolantPerTick).toBe(3);
    expect(run.waterPerTick).toBe(0);
    expect(run.cycleTicks).toBe(270);
    // A full glowstone reactor keeps both speedups: 202 ticks.
    expect(htgrOperation({ base: 2, mult: 1.2, exp: 1.1 }, 10_000).cycleTicks).toBe(202);
  });
});

describe("unlock chips", () => {
  it.each([
    // THTR and HTGR are crafted with circuitUltimate (ZPM) circuits.
    ["thtr", "ZPM"],
    ["htgr", "ZPM"],
    // The LFTR is crafted around an IV Machine Hull.
    ["lftr", "IV"],
    // bartworks assembles the DEHP at RECIPE_IV.
    ["dehp", "IV"],
    // goodgenerator's assembly line recipe runs at RECIPE_UV.
    ["large-naquadah-reactor", "UV"],
    // The Antimatter Forge's assembly line recipe runs at RECIPE_UMV.
    ["antimatter", "UMV"],
  ])("puts %s at %s, the tier of its controller recipe", (id, tier) => {
    expect(getPowerSource(id, "2.9")?.unlock).toBe(tier);
  });
});

/**
 * GTNH 2.8.1 runs bartworks' HTGR (GT5U 5.09.51.476
 * bartworks/common/tileentities/multis/MTEHighTempGasCooledReactor.java) and registers no ULV
 * solar panel; 2.9 (5.09.54.205) runs kubatech's HTGR and has the ULV panel.
 */
function model(sourceId: string, settings: Record<string, string>, gameVersion: GameVersion): PowerModel {
  const source = getPowerSource(sourceId, gameVersion);
  if (!source) {
    throw new Error(`No power source ${sourceId}`);
  }
  return source.compute(buildPowerSettingsReader(source, settings, gameVersion), gameVersion);
}

const perSecond = flow;

function warningsFor(sourceId: string, settings: Record<string, string>, gameVersion: GameVersion): string[] {
  return buildPowerRecipe(sourceId, settings, "probe", gameVersion)?.power?.warnings ?? [];
}

const panelSetting = (gameVersion: GameVersion): PowerSetting | undefined =>
  getPowerSource("solar-panel", gameVersion)?.settings.find((setting) => setting.id === "panel");

const optionKeys = (setting: PowerSetting | undefined): string[] =>
  setting?.type === "select" ? setting.options.map((option) => option.key) : [];

/** What a 2.9 plan stores on a kubatech HTGR card. */
const KUBATECH_HTGR_SETTINGS = { pebble: "Uranium-235", fill: "10000" };

describe("bartworks HTGR and solar panels by version", () => {
  test("htgr 2.8.1 at a full 720,000 pebbles burns 18,000 per 36,000-tick operation", () => {
    const m = model("htgr", { fuel: "Thorium", pebbles: "720000" }, "2.8.1");
    // TierEU.RECIPE_LuV (:131).
    expect(m.euPerTick).toBe(-30720);
    expect(perSecond(m.inputs, "Coolant")).toBe(4000);
    expect(perSecond(m.outputs, "Hot Coolant")).toBe(4000);
    // floor(720,000 x 0.025 x 1) = 18,000 = 281 balls of 64 and 16 loose, over 1,800 s.
    expect(perSecond(m.inputs, "TRISO pebble (Thorium)")).toBe(18_000 / 1800);
    expect(perSecond(m.outputs, "Burned out TRISO Ball (Thorium)")).toBeCloseTo(281 / 1800, 12);
    expect(perSecond(m.outputs, "Burned out TRISO Pebble (Thorium)")).toBeCloseTo(16 / 1800, 12);
    expect(m.stats.find((line) => line.label === "Helium charge")?.value).toBe("730,000 L, kept");
  });

  test("htgr 2.9 matches kubatech's 5.09.54.205 reactor", () => {
    const m = model("htgr", KUBATECH_HTGR_SETTINGS, "2.9");
    // (long) (TierEU.RECIPE_IV x 0.2) with a full helium charge.
    expect(m.euPerTick).toBe(-1536);
    expect(perSecond(m.inputs, "TRISO Fuel (Uranium 235)")).toBeGreaterThan(0);
    expect(perSecond(m.inputs, "Distilled Water")).toBeGreaterThan(0);
    expect(m.stats.find((line) => line.label === "Helium charge")?.value).toBe("512,000 L");
    expect(getPowerSource("htgr", "2.9")?.settings.map((setting) => setting.id)).toEqual(["pebble", "fill"]);
  });

  test("htgr 2.8.1 Plutonium doubles the coolant", () => {
    const m = model("htgr", { fuel: "Plutonium", pebbles: "720000" }, "2.8.1");
    expect(perSecond(m.inputs, "Coolant")).toBe(8000);
    expect(perSecond(m.outputs, "Hot Coolant")).toBe(8000);
    expect(perSecond(model("htgr", { fuel: "Uranium" }, "2.8.1").inputs, "Coolant")).toBe(6000);
    expect(perSecond(m.outputs, "Burned out TRISO Ball (Plutonium)")).toBeCloseTo(281 / 1800, 12);
  });

  test("htgr 2.8.1 at the 72,000 minimum runs at 1%", () => {
    const m = model("htgr", { fuel: "Thorium", pebbles: "72000" }, "2.8.1");
    // eff = min(1, 100) / 100: 18 pebbles per trunc(72,000 x 0.995) = 71,640 ticks.
    expect(perSecond(m.inputs, "TRISO pebble (Thorium)")).toBeCloseTo(18 / (71_640 / 20), 12);
    expect(perSecond(m.outputs, "Burned out TRISO Ball (Thorium)")).toBe(0);
    expect(perSecond(m.outputs, "Burned out TRISO Pebble (Thorium)")).toBeCloseTo(18 / (71_640 / 20), 12);
    expect(perSecond(m.inputs, "Coolant")).toBe(40);
    // A fill under the minimum reads as the minimum: the reactor will not start below it.
    expect(model("htgr", { pebbles: "1000" }, "2.8.1").stats[0]?.value).toBe("1%");
  });

  test("power-planner-data.json: htgrPebbles 2.8.1 is empty", () => {
    expect(powerTablesFor("2.8.1").htgrPebbles).toEqual([]);
    expect(powerTablesFor("2.9").htgrPebbles).toHaveLength(9);
  });

  test("htgr 2.8.1 names the kubatech settings it drops", () => {
    const warnings = warningsFor("htgr", KUBATECH_HTGR_SETTINGS, "2.8.1");
    // A stored pebble the card reads no fuel from is named with the fuel it burns (a conversion carries the
    // material; this card was never converted).
    expect(warnings).toEqual([
      "Not in GTNH 2.8.1: Uranium-235. Using Thorium.",
      "Not in GTNH 2.8.1: Pebble fill. Using Pebbles kept 720,000.",
    ]);
    // The kubatech ball count is not read as a pebble count: the card runs its own default.
    const m = model("htgr", KUBATECH_HTGR_SETTINGS, "2.8.1");
    expect(perSecond(m.inputs, "TRISO pebble (Thorium)")).toBe(10);
    expect(warningsFor("htgr", KUBATECH_HTGR_SETTINGS, "2.9")).toEqual([]);
  });

  test("solar-panel 2.8.1 starts at LV", () => {
    expect(optionKeys(panelSetting("2.8.1"))[0]).toBe("LV");
    expect(optionKeys(panelSetting("2.8.1"))).toHaveLength(8);
    expect(optionKeys(panelSetting("2.9"))[0]).toBe("ULV");
    const panel = panelSetting("2.8.1");
    expect(panel?.type === "select" && panel.defaultKey).toBe("LV");
  });

  test("solar-panel 2.8.1 names a stored ULV panel and runs LV", () => {
    expect(model("solar-panel", { panel: "ULV" }, "2.8.1").euPerTick).toBe(32);
    expect(warningsFor("solar-panel", { panel: "ULV" }, "2.8.1")).toContain(
      "Not in GTNH 2.8.1: ULV. Using LV Solar Panel (32 EU/t).",
    );
    // MTESolarGenerator.maxEUOutput at 5.09.54.205: the tier 0 panel makes 1 EU/t.
    expect(model("solar-panel", { panel: "ULV" }, "2.9").euPerTick).toBe(1);
    expect(warningsFor("solar-panel", { panel: "ULV" }, "2.9")).toEqual([]);
  });
});
