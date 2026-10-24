import { describe, expect, test } from "vitest";
import { BRANCHED_IN_2_8_1 } from "./overrides-2.8.1/branched";
import { mergePowerOverrideParts } from "./overrides-2.8.1";
import {
  POWER_DATA_OVERRIDES,
  powerPlannerData,
  powerTablesFor,
  type PowerTables,
} from "./planner-data";
import { dumpSources } from "./power-dump";
import { buildAllSources, getPowerSource, powerSourcesFor } from "./registry";
import type { PowerSourceDefinition } from "./types";

describe("power by game version", () => {
  test("powerTablesFor 2.9 is the JSON with only 2.9's source corrections", () => {
    powerTablesFor("2.8.1");
    const tables = powerTablesFor("2.9");
    // Every table but the corrected ones is the JSON's own; the corrections are 2.9's overrides.
    for (const name of Object.keys(powerPlannerData) as (keyof PowerTables)[]) {
      const expected = POWER_DATA_OVERRIDES["2.9"]?.[name] ?? powerPlannerData[name];
      expect(tables[name], name).toBe(expected);
    }
    expect(Object.keys(POWER_DATA_OVERRIDES["2.9"] ?? {})).toEqual([
      "fusionRecipes",
      "boilerFuels",
    ]);
    expect(powerTablesFor("2.9")).toBe(tables);
  });

  test("powerTablesFor swaps whole tables and leaves the rest as 2.9's", () => {
    const tables = powerTablesFor("2.8.1", { "2.8.1": { rocketFuels: [] } });
    expect(tables.rocketFuels).toEqual([]);
    expect(tables.gasFuels).toBe(powerPlannerData.gasFuels);
    expect(powerTablesFor("2.8.1")).not.toBe(tables);
  });

  test("power sources for 2.9 match the golden", async () => {
    // One source per line, so a change reads as a per-source diff; `vitest -u` rewrites it.
    const lines = dumpSources(powerSourcesFor("2.9"), "2.9").map((source) =>
      JSON.stringify(source),
    );
    await expect(`[\n${lines.join(",\n")}\n]\n`).toMatchFileSnapshot(
      "./__fixtures__/power-sources-2.9.json",
    );
  });

  test("the 2.8.1 builders with no overrides build what 2.9 builds", () => {
    // Builder branches added by 6.16-6.18 must keep this true only where they read no data;
    // a task whose branch changes a source lists that id in BRANCHED_IN_2_8_1.
    const strip = (s: PowerSourceDefinition[]) =>
      s.filter((d) => !BRANCHED_IN_2_8_1.includes(d.id));
    expect(dumpSources(strip(buildAllSources(powerPlannerData, "2.8.1")), "2.8.1")).toEqual(
      dumpSources(strip(buildAllSources(powerPlannerData, "2.9")), "2.9"),
    );
  });

  test("an absent source id is left out of the list", () => {
    const ids = buildAllSources(powerPlannerData, "2.8.1", ["htgr"]).map((source) => source.id);
    expect(ids).not.toContain("htgr");
    expect(ids).toContain("thtr");
  });

  test("each version's sources are built once and kept apart", () => {
    const later = powerSourcesFor("2.8.1");
    expect(powerSourcesFor("2.8.1")).toBe(later);
    expect(powerSourcesFor("2.9")).not.toBe(later);
    expect(getPowerSource("htgr", "2.9")).toBe(
      powerSourcesFor("2.9").find((source) => source.id === "htgr"),
    );
  });

  test("a power table overridden in two 2.8.1 parts throws", () => {
    expect(() =>
      mergePowerOverrideParts({ "a.ts": { gasFuels: [] }, "b.ts": { gasFuels: [] } }),
    ).toThrow(/gasFuels.*a\.ts.*b\.ts/);
  });
});
