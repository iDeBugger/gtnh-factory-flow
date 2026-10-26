import { describe, expect, it } from "vitest";
import { getMachineBehaviour, machineTableNames, OVERCLOCK } from "./machine-table";
import datasetMachineNames from "./__fixtures__/dataset-machine-names.json";
import { getOverclockedRecipeStats } from "@/lib/solver/overclock";
import type { GameVersion } from "@/lib/model/game-version";

/**
 * Every machine name a card can carry in each served dataset: each handler's
 * machineType, and the map's name on a recipe without handlers (a map with one
 * machine family). Regenerate after a dataset rebuild:
 * node tools/audits/extract-dataset-machine-names.mjs public/datasets/gtnh/<id> <version> \
 *   src/lib/machines/__fixtures__/dataset-machine-names.json
 */
const NAMES = datasetMachineNames as Record<GameVersion, string[]>;
const VERSIONS = Object.keys(NAMES) as GameVersion[];

/**
 * Table machines no card of that version is named after, and why. A machine
 * that is a map's only one carries the map's name, so it needs that name as
 * an alias; nothing here may stand for a missing alias.
 */
const UNMATCHED: Record<GameVersion, Record<string, string>> = {
  "2.9": {
    "Auto Workbench": "synthesized on crafting maps by recipe-rules.ts, never a dataset handler",
    "Short Circuit Heater": "the UV+ arc furnaces, folded into the Arc Furnace singleblock family",
    "Mega Blast Furnace": "MTEMegaBlastFurnaceLegacy in 2.9, replaced by the Exothermic Hearth; no NEI catalyst",
    "Fluid Shaper": "deprecated in 2.9 (ItemList.Machine_Fluid_Shaper); no NEI catalyst",
  },
  "2.8.1": {
    "Auto Workbench": "synthesized on crafting maps by recipe-rules.ts, never a dataset handler",
    "Short Circuit Heater": "the UV+ arc furnaces, folded into the Arc Furnace singleblock family",
    "Industrial 3D Copying Machine": "5.09.51 has no Industrial Chisel map to export",
  },
};

function unmatchedTableMachines(gameVersion: GameVersion): string[] {
  const reached = new Set(NAMES[gameVersion].map((name) => getMachineBehaviour(name, gameVersion)));
  return machineTableNames().filter((name) => {
    const behaviour = getMachineBehaviour(name, gameVersion);
    return behaviour !== undefined && !reached.has(behaviour);
  });
}

describe("the machine table against the datasets", () => {
  it("has a fixture for each served version", () => {
    expect(VERSIONS.sort()).toEqual(["2.8.1", "2.9"]);
  });

  for (const gameVersion of ["2.9", "2.8.1"] as const) {
    it(`reaches every table machine from a ${gameVersion} card name`, () => {
      expect(unmatchedTableMachines(gameVersion).sort()).toEqual(Object.keys(UNMATCHED[gameVersion]).sort());
    });
  }

  it("finds a map's only machine under the map's name", () => {
    // Milling and Flotation Cell are GT++ maps on both versions with one machine each.
    for (const gameVersion of ["2.9", "2.8.1"] as const) {
      expect(getMachineBehaviour("Milling", gameVersion)).toBe(getMachineBehaviour("IsaMill Grinding Machine", gameVersion));
      expect(getMachineBehaviour("Flotation Cell", gameVersion)).toBe(
        getMachineBehaviour("Flotation Cell Regulator", gameVersion),
      );
    }
    expect(getMachineBehaviour("Industrial Chisel", "2.9")).toBe(getMachineBehaviour("Industrial 3D Copying Machine", "2.9"));
    expect(getMachineBehaviour("Cable Coating", "2.9")).toBe(getMachineBehaviour("L.A.T.E.X.", "2.9"));
    expect(getMachineBehaviour("Primitive Blast Furnace", "2.8.1")).toBe(
      getMachineBehaviour("Bricked Blast Furnace", "2.8.1"),
    );
  });

  it("runs an IsaMill recipe on perfect overclocks", () => {
    // A Milling recipe as the dataset ships it: the map's name and no handlers.
    // 7680 EU/t on a ZPM hatch leaves two steps; perfect ones quarter the
    // duration each (MTEIsaMill), where normal ones would halve it.
    const milling = { machineType: "Milling", minimumTier: "IV", durationTicks: 1200, eut: 7680 };
    for (const gameVersion of ["2.9", "2.8.1"] as const) {
      expect(getMachineBehaviour("Milling", gameVersion)?.overclock).toEqual(OVERCLOCK.perfect());
      const stats = getOverclockedRecipeStats(milling, { overclockTier: "ZPM" }, gameVersion);
      expect(stats.overclockSteps).toBe(2);
      expect(stats.durationTicks).toBe(75);
    }
  });
});
