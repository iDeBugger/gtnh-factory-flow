import { describe, expect, it } from "vitest";
import { parseFactoryProjectJson, serializeFactoryProject } from "@/lib/import-export/factory-json";
import { applyRecipeInputOverrides } from "./recipe-input-overrides";
import type { FactoryProject } from "./types";

// A card's pick among the items a slot takes (recipeInputOverrides, by the recipe's input index) must come back from
// a save, a plan link or another tool's post as it went out: an ore-name slot (oredict:) picked to a member, a
// concrete slot picked to one of its alternatives (how the mod writes a pick), and the legacy group-as-choice
// override that applies nothing but is never lost.
function project(): FactoryProject {
  return {
    schemaVersion: 1,
    id: "p",
    name: "Picks",
    recipes: [
      {
        id: "ebf",
        name: "Steel Ingot",
        machineType: "Electric Blast Furnace",
        minimumTier: "MV",
        durationTicks: 500,
        eut: 120,
        inputs: [
          {
            kind: "item",
            id: "oredict:plankWood",
            amount: 3,
            displayName: "Ore Dictionary: plankWood",
            alternatives: [
              { kind: "item", id: "minecraft:planks@0", amount: 1, displayName: "Oak Planks" },
              { kind: "item", id: "minecraft:planks@1", amount: 3, displayName: "Spruce Planks" },
            ],
          },
          {
            kind: "item",
            id: "gregtech:gt.metaitem.01@2300",
            amount: 1,
            displayName: "Coal Dust",
            alternatives: [
              {
                kind: "item",
                id: "gregtech:gt.metaitem.01@2201",
                amount: 1,
                displayName: "Carbon Dust",
              },
            ],
          },
          {
            kind: "item",
            id: "oredict:logWood",
            amount: 1,
            displayName: "Ore Dictionary: logWood",
          },
        ],
        outputs: [
          {
            kind: "item",
            id: "gregtech:gt.metaitem.01@11305",
            amount: 1,
            displayName: "Steel Ingot",
          },
        ],
      },
    ],
    nodes: [
      {
        id: "n1",
        recipeId: "ebf",
        machineCount: 1,
        parallel: 1,
        overclockTier: "MV",
        enabled: true,
        position: { x: 0, y: 0 },
        recipeInputOverrides: {
          "0": { kind: "item", id: "minecraft:planks@1", amount: 3, displayName: "Spruce Planks" },
          "1": {
            kind: "item",
            id: "gregtech:gt.metaitem.01@2201",
            amount: 1,
            displayName: "Carbon Dust",
          },
          // The old category wire saved the group itself as the choice.
          "2": {
            kind: "item",
            id: "oredict:logWood",
            amount: 1,
            displayName: "Ore Dictionary: logWood",
          },
        },
      },
    ],
    storages: [],
    edges: [],
    annotations: [],
    pockets: [],
    fuelProfiles: [],
  } as unknown as FactoryProject;
}

describe("recipeInputOverrides round trip", () => {
  it("keeps every pick through a save and a load", () => {
    const loaded = parseFactoryProjectJson(serializeFactoryProject(project()));
    const overrides = loaded.nodes[0]!.recipeInputOverrides!;
    expect(Object.keys(overrides).sort()).toEqual(["0", "1", "2"]);
    expect(overrides["0"]).toMatchObject({ id: "minecraft:planks@1", amount: 3 });
    expect(overrides["1"]).toMatchObject({ id: "gregtech:gt.metaitem.01@2201" });
    // A second pass changes nothing.
    const again = parseFactoryProjectJson(serializeFactoryProject(loaded));
    expect(again.nodes[0]!.recipeInputOverrides).toEqual(overrides);
  });

  it("applies a pick to its slot and keeps the slot's amount (an ore-name member carries the slot's own)", () => {
    const loaded = parseFactoryProjectJson(serializeFactoryProject(project()));
    const effective = applyRecipeInputOverrides(loaded.recipes[0]!, loaded.nodes[0]!, "2.9");
    expect(effective.inputs[0]).toMatchObject({ id: "minecraft:planks@1", amount: 3 });
    expect(effective.inputs[1]).toMatchObject({ id: "gregtech:gt.metaitem.01@2201" });
    // The legacy group-as-choice override applies nothing.
    expect(effective.inputs[2]).toMatchObject({ id: "oredict:logWood" });
  });
});
