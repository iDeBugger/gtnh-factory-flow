import { describe, expect, test, vi } from "vitest";
import type { GameVersion } from "@/lib/model/game-version";
import { powerSettingsSelectModel } from "@/components/flow/clean/special/power-settings";
import { buildPowerRecipe, powerSettingWarnings } from "./power-recipe";
import {
  buildPowerSettingsReader,
  storedSelectValue,
  type PowerSelectSetting,
  type PowerSourceDefinition,
} from "./types";

// 2.8.1's chemical fuels are 2.9's less Fluoroantimonic Acid; every other table is 2.9's.
vi.mock("@/lib/power/overrides-2.8.1/index", async (importOriginal) => {
  const original = await importOriginal<typeof import("./overrides-2.8.1/index")>();
  const data = (await import("./data/power-planner-data.json")).default as unknown as {
    chemFuels: Array<{ name: string }>;
  };
  return {
    ...original,
    POWER_DATA_OVERRIDES_2_8_1: {
      chemFuels: data.chemFuels.filter((fuel) => fuel.name !== "Fluoroantimonic Acid"),
    },
  };
});

function definition(settings: PowerSourceDefinition["settings"]): PowerSourceDefinition {
  return {
    id: "test-source",
    name: "Test Source",
    group: "reactors",
    blurb: "A test source.",
    settings,
    compute: () => ({ euPerTick: 0, inputs: [], outputs: [], stats: [] }),
  };
}

function selectDef(spec: {
  id: string;
  legacyIds?: string[];
  legacyUnsetKeys?: string[];
  options: string[];
}) {
  const setting: PowerSelectSetting = {
    type: "select",
    id: spec.id,
    label: "Fuel",
    options: spec.options.map((key) => ({ key, label: key })),
    defaultKey: spec.options[0],
    legacyIds: spec.legacyIds,
    legacyUnsetKeys: spec.legacyUnsetKeys,
  };
  return { ...definition([setting]), settings: [setting] };
}

// A source whose 2.8.1 build has no pebble setting, as a card a version lacks a knob of.
function testSource(gameVersion: GameVersion): PowerSourceDefinition {
  return definition([
    { type: "number", id: "count", label: "Count", min: 1, max: 9, step: 1, defaultValue: 1 },
    ...(gameVersion === "2.9"
      ? [{ type: "toggle" as const, id: "pebble", label: "Pebble", defaultOn: false }]
      : []),
  ]);
}

function warningsFor(
  build: (gameVersion: GameVersion) => PowerSourceDefinition,
  values: Record<string, string>,
  gameVersion: GameVersion,
): string[] {
  const source = build(gameVersion);
  return powerSettingWarnings(
    source,
    build("2.9"),
    buildPowerSettingsReader(source, values, gameVersion),
    gameVersion,
  );
}

describe("power settings reader by game version", () => {
  test("a stored option missing in 2.8.1 is named on the card", () => {
    const recipe = buildPowerRecipe("acid-generator", { fuel: "Fluoroantimonic Acid" }, "r", "2.8.1");
    expect(recipe?.power?.warnings).toContain(
      "Not in GTNH 2.8.1: Fluoroantimonic Acid. Using Sulfuric Acid.",
    );
    expect(buildPowerRecipe("acid-generator", { fuel: "Bogus" }, "r", "2.9")?.power?.warnings ?? []).toEqual([]);
    // 2.9 still has the fuel: the twin burns it with no warning.
    expect(
      buildPowerRecipe("acid-generator", { fuel: "Fluoroantimonic Acid" }, "r", "2.9")?.power?.warnings ?? [],
    ).toEqual([]);
  });

  test("a stored setting missing in 2.8.1 is named on the card", () => {
    expect(warningsFor(testSource, { pebble: "x" }, "2.8.1")).toContain("Not in GTNH 2.8.1: Pebble. Not used.");
    expect(warningsFor(testSource, { pebble: "x" }, "2.9")).toEqual([]);
  });

  test("a version-only number is named only for the setting declared to stand in for it", () => {
    // 2.8.1's card has a number of its own, unrelated to the 2.9 toggle stored here: the toggle is not used.
    const withOwnNumber = (gameVersion: GameVersion) => {
      const base = testSource(gameVersion);
      return gameVersion === "2.9"
        ? base
        : { ...base, settings: [...base.settings, { type: "number" as const, id: "own", label: "Own", min: 1, max: 9, step: 1, defaultValue: 3 }] };
    };
    expect(warningsFor(withOwnNumber, { pebble: "1" }, "2.8.1")).toEqual(["Not in GTNH 2.8.1: Pebble. Not used."]);
  });

  test("a stored id no version declares is not named", () => {
    expect(warningsFor(testSource, { stray: "1", count: "2" }, "2.8.1")).toEqual([]);
  });

  test("a select reads its legacy ids in order when its own id is unset", () => {
    const def = selectDef({ id: "fuel", legacyIds: ["liquidFuel", "solidFuel"], options: ["A", "B"] });
    expect(buildPowerSettingsReader(def, { liquidFuel: "A", solidFuel: "B" }, "2.8.1").select("fuel")).toBe("A");
    expect(buildPowerSettingsReader(def, { solidFuel: "B" }, "2.8.1").select("fuel")).toBe("B");
    expect(buildPowerSettingsReader(def, { fuel: "B", liquidFuel: "A" }, "2.8.1").select("fuel")).toBe("B");
    // A legacy id is a setting the definition knows, never an unknown one.
    expect(buildPowerSettingsReader(def, { solidFuel: "B" }, "2.8.1").unknownSettings()).toEqual([]);
  });

  test("a card's select shows the value its model reads through legacy ids", () => {
    const def = selectDef({ id: "fuel", legacyIds: ["liquidFuel"], options: ["A", "B"] });
    const stored = { liquidFuel: "B" };
    expect(storedSelectValue(def.settings[0], stored)).toBe("B");
    expect(powerSettingsSelectModel(def, stored, "fuel")?.current).toBe("B");
    expect(buildPowerSettingsReader(def, stored, "2.8.1").select("fuel")).toBe("B");
  });

  test("a value read through a legacy id that 2.8.1 lacks is named", () => {
    const def = selectDef({ id: "fuel", legacyIds: ["liquidFuel"], options: ["A", "B"] });
    expect(buildPowerSettingsReader(def, { liquidFuel: "C" }, "2.8.1").missing()).toEqual([
      { settingId: "fuel", stored: "C", used: "A" },
    ]);
    expect(buildPowerSettingsReader(def, { liquidFuel: "C" }, "2.9").missing()).toEqual([]);
  });

  test("a legacy key counts only when its option is here", () => {
    const setting: PowerSelectSetting = {
      type: "select",
      id: "fuel",
      label: "Fuel",
      options: [{ key: "A", label: "A" }],
      defaultKey: "A",
      legacyKeys: { old: "A", gone: "B" },
    };
    const def = definition([setting]);
    expect(buildPowerSettingsReader(def, { fuel: "old" }, "2.8.1").missing()).toEqual([]);
    expect(buildPowerSettingsReader(def, { fuel: "gone" }, "2.8.1").missing()).toEqual([
      { settingId: "fuel", stored: "gone", used: "A" },
    ]);
  });

  // GT5U 5.09.51.476 MTELargeBoiler.checkProcessing: a boiler burns liquids first
  // (MTELargeBoiler.java:275-309) and then solids (:311); a superheated boiler skips liquids
  // (:275). So a merged fuel select reads liquidFuel then solidFuel, and a liquid with no option
  // (a superheated boiler's solids-only list) or "None" gives way to the stored solid.
  test("a superheated boiler with a stored liquid and solid burns the solid, and says so as merged fuels", () => {
    const def = selectDef({
      id: "fuel",
      legacyIds: ["liquidFuel", "solidFuel"],
      legacyUnsetKeys: ["None"],
      options: ["Charcoal", "Coal"],
    });
    const read = buildPowerSettingsReader(def, { liquidFuel: "Creosote Oil", solidFuel: "Coal" }, "2.8.1");
    expect(read.select("fuel")).toBe("Coal");
    expect(read.missing()).toEqual([]);
    expect(read.merged()).toEqual([
      { settingId: "fuel", stored: ["Creosote Oil", "Coal"], absent: ["Creosote Oil"], used: "Coal" },
    ]);
    expect(storedSelectValue(def.settings[0], { liquidFuel: "Creosote Oil", solidFuel: "Coal" })).toBe("Coal");
    expect(buildPowerSettingsReader(def, { liquidFuel: "Creosote Oil", solidFuel: "Coal" }, "2.9").select("fuel")).toBe("Coal");
  });

  test("a boiler with no liquid picked burns its stored solid", () => {
    const def = selectDef({
      id: "fuel",
      legacyIds: ["liquidFuel", "solidFuel"],
      legacyUnsetKeys: ["None"],
      options: ["None", "Creosote Oil", "Coal"],
    });
    const read = buildPowerSettingsReader(def, { liquidFuel: "None", solidFuel: "Coal" }, "2.8.1");
    expect(read.select("fuel")).toBe("Coal");
    expect(read.missing()).toEqual([]);
    // A liquid the boiler burns still comes first, as in the Java.
    expect(
      buildPowerSettingsReader(def, { liquidFuel: "Creosote Oil", solidFuel: "Coal" }, "2.8.1").select("fuel"),
    ).toBe("Creosote Oil");
    // Only "None" stored: nothing picked, read as "None" itself with no warning.
    const none = buildPowerSettingsReader(def, { liquidFuel: "None" }, "2.8.1");
    expect(none.select("fuel")).toBe("None");
    expect(none.missing()).toEqual([]);
  });

  test("a legacy fuel with no option and no later one is named", () => {
    const def = selectDef({ id: "fuel", legacyIds: ["liquidFuel", "solidFuel"], options: ["Coal"] });
    expect(buildPowerSettingsReader(def, { liquidFuel: "Creosote Oil", solidFuel: "Gone" }, "2.8.1").missing()).toEqual([
      { settingId: "fuel", stored: "Creosote Oil", used: "Coal" },
    ]);
  });

  test("an option that is also a legacy key reads as itself and is not named", () => {
    const setting: PowerSelectSetting = {
      type: "select",
      id: "fuel",
      label: "Fuel",
      options: [{ key: "A", label: "A" }, { key: "B", label: "B" }],
      defaultKey: "A",
      legacyKeys: { B: "Gone" },
    };
    const read = buildPowerSettingsReader(definition([setting]), { fuel: "B" }, "2.8.1");
    expect(read.select("fuel")).toBe("B");
    expect(read.missing()).toEqual([]);
  });

  test("on 2.9 a stored value is named only when another version's card offers it", () => {
    const here = selectDef({ id: "fuel", options: ["A", "B"] });
    const there = selectDef({ id: "fuel", options: ["A", "C"] });
    const read = (values: Record<string, string>) => buildPowerSettingsReader(here, values, "2.9", { others: [there] }).missing();
    expect(read({ fuel: "C" })).toEqual([{ settingId: "fuel", stored: "C", used: "A" }]);
    // A key no version offers is an old 2.9 plan's, read as the default as before.
    expect(read({ fuel: "Gone" })).toEqual([]);
  });

  test("another version's choice under its own id is named while the card's own select is unset", () => {
    const def = selectDef({ id: "pebble", options: ["Glowstone", "Thorium"] });
    const other = { ...selectDef({ id: "fuel", options: ["Thorium"] }) };
    const context = { others: [other], foreignIds: { pebble: ["fuel"] } };
    expect(buildPowerSettingsReader(def, { fuel: "Thorium" }, "2.9", context).missing()).toEqual([
      { settingId: "pebble", stored: "Thorium", used: "Glowstone" },
    ]);
    // Never read across, and gone once the card's own select is set.
    expect(buildPowerSettingsReader(def, { fuel: "Thorium" }, "2.9", context).select("pebble")).toBe("Glowstone");
    expect(buildPowerSettingsReader(def, { fuel: "Thorium", pebble: "Thorium" }, "2.9", context).missing()).toEqual([]);
    expect(buildPowerSettingsReader(def, { fuel: "Thorium" }, "2.8.1", context).unknownSettings()).toEqual([]);
  });

  test("a select that reads one of two stored legacy fuels says which", () => {
    const def = selectDef({
      id: "fuel",
      legacyIds: ["liquidFuel", "solidFuel"],
      legacyUnsetKeys: ["None"],
      options: ["None", "Creosote Oil", "Coal"],
    });
    const merged = (values: Record<string, string>) => buildPowerSettingsReader(def, values, "2.8.1").merged();
    expect(merged({ liquidFuel: "Creosote Oil", solidFuel: "Coal" })).toEqual([
      { settingId: "fuel", stored: ["Creosote Oil", "Coal"], absent: [], used: "Creosote Oil" },
    ]);
    expect(merged({ liquidFuel: "None", solidFuel: "Coal" })).toEqual([]);
    expect(merged({ fuel: "Coal", liquidFuel: "Creosote Oil", solidFuel: "Coal" })).toEqual([]);
    // No stored value has an option: missing() names it instead.
    expect(merged({ liquidFuel: "Gone", solidFuel: "Lost" })).toEqual([]);
  });
});
