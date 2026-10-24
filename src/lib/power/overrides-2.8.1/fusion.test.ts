import { expect, test } from "vitest";
import rawData from "../data/power-planner-data.json";
import { powerTablesFor, type FusionRecipeEntry, type PowerTables } from "../planner-data";
import { getPowerSource } from "../registry";
import { buildPowerSettingsReader } from "../types";
import type { GameVersion } from "@/lib/model/game-version";

// 2.8.1 truth: GT5U 5.09.51.476; 2.9 truth: 5.09.54.205 (FusionReactorRecipes.java at each).
const WORKBOOK = (rawData as unknown as PowerTables).fusionRecipes;
const VERSIONS = ["2.8.1", "2.9"] as const;

function row(version: GameVersion, name: string, input1: string, input2: string): FusionRecipeEntry {
  const found = powerTablesFor(version).fusionRecipes.filter(
    (entry) => entry.name === name && entry.input1 === input1 && entry.input2 === input2,
  );
  expect(found).toHaveLength(1);
  return found[0];
}

const key = (entry: FusionRecipeEntry) => `${entry.name}|${entry.input1}|${entry.input2}`;

function differingKeys(rows: FusionRecipeEntry[], base: FusionRecipeEntry[]): string[] {
  expect(rows.map(key)).toEqual(base.map(key));
  return rows
    .filter((entry, index) => JSON.stringify(entry) !== JSON.stringify(base[index]))
    .map(key)
    .sort();
}

const D_T = ["Helium Plasma", "Deuterium", "Tritium"] as const;
const D_HE3 = ["Helium Plasma", "Deuterium", "Helium-3"] as const;
const NITROGEN = ["Nitrogen Plasma", "Molten Beryllium", "Deuterium"] as const;
const DURANIUM = ["Molten Duranium", "Molten Gallium", "Radon"] as const;
const CHROME = ["Molten Chrome", "Molten Vanadium", "Hydrogen"] as const;
const EUROPIUM = ["Molten Europium", "Molten Neodymium", "Hydrogen"] as const;
const OSMIUM = ["Molten Osmium", "Molten Tungsten", "Helium"] as const;
const BISMUTH = ["Bismuth Plasma", "Molten Tantalum", "Zinc Plasma"] as const;
const keys = (...rows: (readonly string[])[]) => rows.map((k) => k.join("|")).sort();

test("power-planner-data.json: fusionRecipes 2.9 is the workbook's 65 rows with eight source corrections", () => {
  expect(WORKBOOK).toHaveLength(65);
  expect(differingKeys(powerTablesFor("2.9").fusionRecipes, WORKBOOK)).toEqual(
    keys(D_T, D_HE3, NITROGEN, DURANIUM, CHROME, EUROPIUM, OSMIUM, BISMUTH),
  );
});

test("power-planner-data.json: fusionRecipes 2.8.1 differs from 2.9 only in the three 5.09.51 literals", () => {
  // 2.8.1 runs every row (its export lists all 65); none is removed.
  expect(
    differingKeys(powerTablesFor("2.8.1").fusionRecipes, powerTablesFor("2.9").fusionRecipes),
  ).toEqual(keys(D_T, NITROGEN, DURANIUM));
});

test("power-planner-data.json: fusionRecipes has no alternative Europium, Americium or Hexanite recipe on either version", () => {
  // 5.09.54.205 FusionReactorRecipes.java:104 (Nd + Pm), :120 (Lu + Pm) and :331 (Redstone +
  // Ichorium) are new since 5.09.51.476. The workbook never listed them; their products have no
  // plasma value, so the fusion card could not offer them.
  for (const version of VERSIONS) {
    const inputs = powerTablesFor(version).fusionRecipes.flatMap((entry) => [entry.input1, entry.input2]);
    expect(inputs).not.toContain("Molten Promethium");
    expect(inputs).not.toContain("Molten Ichorium");
    expect(inputs).not.toContain("Redstone Plasma");
  }
});

test("power-planner-data.json: fusionRecipes 2.8.1 bills D + T helium at 4096 EU/t from 40M EU", () => {
  // 5.09.51.476 :39 .eut(4096), :40 40M.
  const r281 = row("2.8.1", ...D_T);
  expect(r281.drainEutByMark).toEqual([4096, 8192, 16384, 262144, 1048576]);
  expect(r281.compactDrainEutByMark).toEqual([262144, 1048576, 3145728, 67108864, 335544320]);
  expect(r281.startupEu).toBe(40_000_000);
  // 5.09.54.205 :40 RECIPE_IV / 2 = 3840, :41 40M.
  const r29 = row("2.9", ...D_T);
  expect(r29.drainEutByMark).toEqual([3840, 7680, 15360, 245760, 983040]);
  expect(r29.compactDrainEutByMark).toEqual([245760, 983040, 2949120, 62914560, 314572800]);
  expect(r29.startupEu).toBe(40_000_000);
});

test("power-planner-data.json: fusionRecipes 2.8.1 starts D + He-3 helium at 60M EU", () => {
  // 5.09.51.476 :48 and 5.09.54.205 :49: 60M; the workbook swapped it with D + T's 40M.
  for (const version of VERSIONS) {
    const entry = row(version, ...D_HE3);
    expect(entry.startupEu).toBe(60_000_000);
    expect(entry.drainEutByMark).toEqual([1920, 3840, 7680, 122880, 491520]);
  }
});

test("power-planner-data.json: fusionRecipes 2.8.1 shows the Helium Plasma card's 60M startup", () => {
  for (const version of VERSIONS) {
    const source = getPowerSource("fusion-reactor", version)!;
    const settings = { recipe: "Helium Plasma", mark: "1" };
    const model = source.compute(buildPowerSettingsReader(source, settings, version), version);
    expect(model.euPerTick).toBe(-1920);
    expect(model.stats.find((line) => line.label === "Startup")?.value).toBe("60M EU");
  }
});

test("power-planner-data.json: fusionRecipes 2.8.1 bills Be + D nitrogen at 16384 EU/t", () => {
  // 5.09.51.476 :63 .eut(16384); 5.09.54.205 :64 RECIPE_LuV / 2 = 15360.
  const r281 = row("2.8.1", ...NITROGEN);
  expect(r281.drainEutByMark).toEqual([0, 16384, 32768, 262144, 1048576]);
  expect(r281.compactDrainEutByMark).toEqual([0, 1048576, 4194304, 50331648, 268435456]);
  const r29 = row("2.9", ...NITROGEN);
  expect(r29.drainEutByMark).toEqual([0, 15360, 30720, 245760, 983040]);
  expect(r29.compactDrainEutByMark).toEqual([0, 983040, 3932160, 47185920, 251658240]);
});

test("power-planner-data.json: fusionRecipes 2.8.1 bills Ga + Rn duranium at 16384 EU/t", () => {
  // 5.09.51.476 :192 .eut(16384); 5.09.54.205 :209 RECIPE_LuV / 2 = 15360.
  const r281 = row("2.8.1", ...DURANIUM);
  expect(r281.drainEutByMark).toEqual([16384, 32768, 65536, 1048576, 4194304]);
  expect(r281.compactDrainEutByMark).toEqual([1048576, 4194304, 12582912, 268435456, 1342177280]);
  const r29 = row("2.9", ...DURANIUM);
  expect(r29.drainEutByMark).toEqual([15360, 30720, 61440, 983040, 3932160]);
  expect(r29.compactDrainEutByMark).toEqual([983040, 3932160, 11796480, 251658240, 1258291200]);
});

test("power-planner-data.json: fusionRecipes 2.8.1 bills Vanadium + Hydrogen chrome at 24576 EU/t", () => {
  // 5.09.51.476 :184 and 5.09.54.205 :201: 24576; the workbook's reactor columns bill 24578.
  for (const version of VERSIONS) {
    const entry = row(version, ...CHROME);
    expect(entry.drainEutByMark).toEqual([24576, 49152, 98304, 1572864, 6291456]);
    expect(entry.compactDrainEutByMark).toEqual([1572864, 6291456, 18874368, 402653184, 2013265920]);
  }
});

test("power-planner-data.json: fusionRecipes 2.8.1 bills Neodymium + Hydrogen europium at 24576 EU/t", () => {
  // 5.09.51.476 :95 and 5.09.54.205 :96: 24576; the workbook's reactor columns bill 24578.
  for (const version of VERSIONS) {
    const entry = row(version, ...EUROPIUM);
    expect(entry.drainEutByMark).toEqual([24576, 49152, 98304, 1572864, 6291456]);
    expect(entry.compactDrainEutByMark).toEqual([1572864, 6291456, 18874368, 402653184, 2013265920]);
  }
});

test("power-planner-data.json: fusionRecipes 2.8.1 bills Tungsten + Helium osmium at 24578 EU/t on the compact reactor too", () => {
  // 5.09.51.476 :136 and 5.09.54.205 :153: 24578; the workbook's compact columns bill 24576.
  for (const version of VERSIONS) {
    const entry = row(version, ...OSMIUM);
    expect(entry.drainEutByMark).toEqual([24578, 49156, 98312, 1572992, 6291968]);
    expect(entry.compactDrainEutByMark).toEqual([1572992, 6291968, 18875904, 402685952, 2013429760]);
  }
});

test("power-planner-data.json: fusionRecipes 2.8.1 bills Bismuth Plasma at 6291456 EU/t on the MK-III compact", () => {
  // 98304 EU/t from 350M (5.09.51.476 :256-257, 5.09.54.205 :273-274); MK-III runs 64 x
  // extraPara 1 (MTELargeFusionComputer3.java:139). The workbook billed Silver Plasma's 49152.
  for (const version of VERSIONS) {
    const entry = row(version, ...BISMUTH);
    expect(entry.drainEutByMark).toEqual([0, 0, 98304, 393216, 1572864]);
    expect(entry.compactDrainEutByMark).toEqual([0, 0, 6291456, 50331648, 301989888]);
  }
});

test("power-planner-data.json: fusionRecipes compact reactors run 64 x extraPara parallels at the recipe's mark", () => {
  // goodgenerator MTELargeFusionComputer{1..5}.extraPara, the same at both tags: MK-n runs n
  // extra parallels, one fewer for each startup band (160M, 320M, 640M, 5.12G) the recipe
  // reaches among the first n - 1, never under 1.
  const BANDS = [160e6, 320e6, 640e6, 5120e6];
  const extraPara = (mark: number, startup: number) =>
    Math.max(1, mark - BANDS.slice(0, mark - 1).filter((band) => startup >= band).length);
  for (const version of VERSIONS) {
    for (const entry of powerTablesFor(version).fusionRecipes) {
      const at = entry.minMark - 1;
      expect(entry.compactDrainEutByMark[at], `${version} ${key(entry)}`).toBe(
        64 * extraPara(entry.minMark, entry.startupEu) * entry.drainEutByMark[at]!,
      );
    }
  }
});

function card(sourceId: string, version: GameVersion, settings: Record<string, string>) {
  const source = getPowerSource(sourceId, version)!;
  return source.compute(buildPowerSettingsReader(source, settings, version), version);
}

test("fusion card: the D + T choice draws 4096 EU/t on 2.8.1 and 3840 EU/t on 2.9 at Mk I", () => {
  // 5.09.51.476 FusionReactorRecipes.java:39 .eut(4096); 5.09.54.205 :40 RECIPE_IV / 2.
  const settings = { recipe: "Helium Plasma (Deuterium + Tritium)", mark: "1" };
  const r281 = card("fusion-reactor", "2.8.1", settings);
  expect(r281.euPerTick).toBe(-4096);
  expect(r281.inputs.map((flow) => flow.name)).toEqual(["Deuterium", "Tritium"]);
  expect(r281.stats.find((line) => line.label === "Startup")?.value).toBe("40M EU");
  expect(card("fusion-reactor", "2.9", settings).euPerTick).toBe(-3840);
});

test("fusion card: draws above Mk I read the mark's column on both versions", () => {
  // Mk III runs D + T at 4x its Mk I draw on the plain reactor (drainEutByMark[2]).
  const dt = { recipe: "Helium Plasma (Deuterium + Tritium)", mark: "3" };
  expect(card("fusion-reactor", "2.8.1", dt).euPerTick).toBe(-16384);
  expect(card("fusion-reactor", "2.9", dt).euPerTick).toBe(-15360);
  // Bismuth's own mark is III: the compact runs 64 x 1 parallels of 98304 EU/t (MTELargeFusionComputer3.java:139).
  for (const version of VERSIONS) {
    const bismuth = card("compact-fusion-reactor", version, { recipe: "Bismuth Plasma", mark: "3" });
    expect(bismuth.euPerTick, version).toBe(-6291456);
    expect(bismuth.inputs.map((flow) => flow.name), version).toEqual(["Molten Tantalum", "Zinc Plasma"]);
    expect(card("compact-fusion-reactor", version, { recipe: "Bismuth Plasma", mark: "4" }).euPerTick, version).toBe(
      -50331648,
    );
    expect(card("compact-fusion-reactor", version, { recipe: "Bismuth Plasma", mark: "2" }).euPerTick, version).toBe(0);
  }
});
