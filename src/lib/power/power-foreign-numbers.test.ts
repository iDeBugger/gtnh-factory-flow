import { describe, expect, test } from "vitest";
import type { GameVersion } from "@/lib/model/game-version";
import { buildPowerRecipe } from "./power-recipe";
import { getPowerSource, powerSourcesFor } from "./registry";

/**
 * A number setting only another version's card declares (2.8.1's HTGR "Pebbles kept", 2.9's "Pebble fill")
 * can sit in a stored plan: a converted card keeps it, and a file may carry any value. Whatever is stored,
 * the card that lacks the setting computes exactly what it computes without it; only the warning line differs.
 */
const PAIRS: Array<[GameVersion, GameVersion]> = [
  ["2.8.1", "2.9"],
  ["2.9", "2.8.1"],
];
const VALUES = (min: number, max: number) => [String(min), String(max), String(max * 10), "-5", "0", "NaN", "abc"];

describe("stored numbers only another version's card declares", () => {
  const cases = PAIRS.flatMap(([declaring, reading]) =>
    powerSourcesFor(declaring).flatMap((source) => {
      const other = getPowerSource(source.id, reading);
      if (!other) return [];
      const own = new Set(other.settings.map((setting) => setting.id));
      return source.settings
        .filter((setting) => setting.type === "number" && !own.has(setting.id))
        .map((setting) => ({ declaring, reading, sourceId: source.id, setting }));
    }),
  );

  test("the sweep finds the HTGR's two pebble numbers", () => {
    expect(cases.map((entry) => `${entry.reading} ${entry.sourceId} ${entry.setting.id}`).sort()).toEqual([
      "2.8.1 htgr fill",
      "2.9 htgr pebbles",
    ]);
  });

  test.each(cases)("$reading $sourceId ignores a stored $setting.id at any value", ({ reading, sourceId, setting }) => {
    if (setting.type !== "number") return;
    const strip = (recipe: ReturnType<typeof buildPowerRecipe>) => ({
      inputs: recipe?.inputs,
      outputs: recipe?.outputs,
      stats: recipe?.power?.stats,
    });
    const plain = strip(buildPowerRecipe(sourceId, undefined, "r", reading));
    for (const value of VALUES(setting.min, setting.max)) {
      const recipe = buildPowerRecipe(sourceId, { [setting.id]: value }, "r", reading);
      expect(strip(recipe), `${setting.id}=${value}`).toEqual(plain);
    }
  });
});
