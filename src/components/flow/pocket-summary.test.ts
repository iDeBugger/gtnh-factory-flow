import { describe, expect, it } from "vitest";
import { PROJECT_SCHEMA_VERSION, type FactoryProject } from "@/lib/model/types";
import { countPocketCrossings, pocketCardHeight } from "./pocket-summary";

/**
 * A board holding its OWN source: a mine that needs nothing, feeding a
 * smelter, whose plates leave for a machine outside. The old card ran a
 * members-only solve and called this starving; nothing crosses the border
 * on the way in, so the summary must say so and simply report the plates
 * going out.
 */
function makeSelfFedBoard(): FactoryProject {
  return {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    id: "board-summary-project",
    name: "Board summary test",
    recipes: [
      {
        id: "mine",
        name: "Mine",
        machineType: "Ore Drill",
        minimumTier: "LV",
        durationTicks: 20,
        eut: 30,
        inputs: [],
        outputs: [{ kind: "item", id: "iron_ore", amount: 1 }],
      },
      {
        id: "smelt",
        name: "Smelt",
        machineType: "Electric Furnace",
        minimumTier: "LV",
        durationTicks: 20,
        eut: 30,
        inputs: [{ kind: "item", id: "iron_ore", amount: 1 }],
        outputs: [{ kind: "item", id: "iron_plate", amount: 1 }],
      },
      {
        id: "assemble",
        name: "Assemble",
        machineType: "Assembler",
        minimumTier: "LV",
        durationTicks: 20,
        eut: 30,
        inputs: [{ kind: "item", id: "iron_plate", amount: 1 }],
        // Nothing comes back out of it, so the chain has somewhere to put
        // its plates and the whole board runs.
        outputs: [],
      },
    ],
    nodes: [
      {
        id: "mine-1",
        recipeId: "mine",
        machineCount: 1,
        parallel: 1,
        overclockTier: "LV",
        enabled: true,
        position: { x: 0, y: 0 },
        pocketId: "board-1",
      },
      {
        id: "smelter",
        recipeId: "smelt",
        machineCount: 1,
        parallel: 1,
        overclockTier: "LV",
        enabled: true,
        position: { x: 300, y: 0 },
        pocketId: "board-1",
      },
      {
        id: "assembler",
        recipeId: "assemble",
        machineCount: 1,
        parallel: 1,
        overclockTier: "LV",
        enabled: true,
        position: { x: 900, y: 0 },
      },
    ],
    edges: [
      {
        id: "e-ore",
        source: "mine-1",
        target: "smelter",
        resourceKind: "item",
        resourceId: "iron_ore",
      },
      {
        id: "e-plate",
        source: "smelter",
        target: "assembler",
        resourceKind: "item",
        resourceId: "iron_plate",
      },
    ],
    storages: [],
    annotations: [],
    pockets: [{ id: "board-1", name: "Plates", position: { x: 0, y: 0 } }],
    fuelProfiles: [],
  };
}

describe("countPocketCrossings", () => {




  it("nets a part-covered ingredient down to what is really missing", () => {
    const project = makeSelfFedBoard();
    // A second smelter inside eats more ore than the one mine makes.
    project.nodes.push({
      id: "smelter-2",
      recipeId: "smelt",
      machineCount: 1,
      parallel: 1,
      overclockTier: "LV",
      enabled: true,
      position: { x: 300, y: 400 },
      pocketId: "board-1",
    });

    const lines = countPocketCrossings(project, "board-1");
    expect(lines.needs).toBe(1);
    expect(lines.offers).toBe(1);
  });


  it("counts every list without a solve, for the arranger", () => {
    expect(countPocketCrossings(makeSelfFedBoard(), "board-1")).toEqual({
      needs: 0,
      offers: 1,
      incoming: 0,
      outgoing: 1,
    });
  });
});

describe("pocketCardHeight", () => {
  const lines = (
    needs: number,
    offers: number,
    incoming: number,
    outgoing: number,
  ) => ({ needs, offers, incoming, outgoing });

  it("stands on whole grid cells", () => {
    for (const shape of [
      lines(0, 0, 0, 0),
      lines(1, 0, 0, 0),
      lines(0, 0, 3, 2),
      lines(2, 3, 4, 1),
      lines(9, 9, 9, 9),
    ]) {
      expect(pocketCardHeight(shape) % 20).toBe(0);
    }
  });

  it("charges for each section only when it has something to say", () => {
    const empty = pocketCardHeight(lines(0, 0, 0, 0));
    const oneSection = pocketCardHeight(lines(0, 0, 1, 0));
    const twoSections = pocketCardHeight(lines(1, 0, 1, 0));
    expect(twoSections).toBeGreaterThan(oneSection);
    expect(oneSection).toBeGreaterThanOrEqual(empty);
  });

  it("grows with the busier side, and hides nothing", () => {
    expect(pocketCardHeight(lines(0, 0, 2, 1))).toBeGreaterThan(
      pocketCardHeight(lines(0, 0, 1, 1)),
    );
    // Every line is drawn, however many there are: one row each, forever.
    const one = pocketCardHeight(lines(0, 0, 1, 0));
    expect(pocketCardHeight(lines(0, 0, 9, 0))).toBe(one + 8 * 40);
    expect(pocketCardHeight(lines(0, 0, 40, 0))).toBe(one + 39 * 40);
  });
});
