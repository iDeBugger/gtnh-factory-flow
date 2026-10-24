import { describe, expect, it } from "vitest";
import { createEmptyProject } from "@/examples/empty-project";
import { getOverclockedRecipeStats } from "@/lib/solver/overclock";
import { restampAmpMapMinimums } from "./amp-map-stamp";
import { normalizeLoadedProject } from "./project-normalize";
import type { FactoryNode, FactoryProject, Recipe } from "./types";

/** A stored recipe body whose minimum is `declared`; MV for 48 EU/t is the 1 A tier, a stamp of the draw. */
function storedBody(mapId: string, machine: string, eut: number, declared: string): Recipe {
  return {
    id: `${machine}-${eut}`,
    name: machine,
    machineType: machine,
    minimumTier: declared,
    durationTicks: 500,
    eut,
    inputs: [],
    outputs: [],
    metadata: { recipeMapId: mapId },
    machineHandlers: [
      { id: "single", label: machine, kind: "single", machineType: machine, minimumTier: declared, maximumTier: "IV", availableTiers: ["LV", "MV", "HV", "EV", "IV"] },
      { id: "multi", label: "Large Thermal Refinery", kind: "multiblock", machineType: "Large Thermal Refinery", minimumTier: declared },
    ],
  } as Recipe;
}

function plan(recipe: Recipe, gameVersion?: string): FactoryProject {
  const node: FactoryNode = { id: "n", recipeId: recipe.id, overclockTier: "LV", machineCount: 1, parallel: 1, enabled: true, position: { x: 0, y: 0 } } as FactoryNode;
  return { ...createEmptyProject(), ...(gameVersion ? { gameVersion } : {}), recipes: [recipe], nodes: [node] };
}

describe("stored recipe bodies on multi-amp maps are stamped the way the pipeline stamps them", () => {
  it("a stored 48 EU/t thermal centrifuge body stamped MV opens on LV, its multiblock handler on MV", () => {
    const loaded = normalizeLoadedProject(plan(storedBody("gt.recipe.thermalcentrifuge", "Thermal Centrifuge", 48, "MV")));
    const recipe = loaded.recipes[0];
    expect(recipe.minimumTier).toBe("LV");
    expect(recipe.machineHandlers?.map((handler) => handler.minimumTier)).toEqual(["LV", "MV"]);
    expect(getOverclockedRecipeStats(recipe, loaded.nodes[0], "2.9")).toMatchObject({ tier: "LV", minimumTier: "LV" });
  });

  it("keeps the lowest real machine when it is above the amp tier", () => {
    const body = storedBody("gt.recipe.thermalcentrifuge", "Thermal Centrifuge", 48, "MV");
    body.machineHandlers![0].availableTiers = ["MV", "HV"];
    const out = restampAmpMapMinimums(plan(body), "2.9").recipes[0];
    expect(out.machineHandlers?.[0].minimumTier).toBe("MV");
  });

  it("takes the lowest real tier of an unsorted list, ignoring names that are not tiers", () => {
    const body = storedBody("gt.recipe.thermalcentrifuge", "Thermal Centrifuge", 48, "MV");
    body.machineHandlers![0].availableTiers = ["IV", "bogus", "HV", "MV"];
    const out = restampAmpMapMinimums(plan(body), "2.9").recipes[0];
    expect(out.machineHandlers?.[0].minimumTier).toBe("MV");
  });

  it("follows the plan's version: 2.8.1's 3 A arc furnace map restamps, 2.9's 1 A one does not", () => {
    const arc = storedBody("gt.recipe.arcfurnace", "Arc Furnace", 90, "MV");
    expect(normalizeLoadedProject(plan(arc, "2.8.1")).recipes[0].machineHandlers?.[0].minimumTier).toBe("LV");
    const on29 = plan(arc, "2.9");
    expect(restampAmpMapMinimums(on29, "2.9")).toBe(on29);
  });

  it("leaves a real gate above the 1 A tier and a body already stamped this way unchanged", () => {
    const gated = plan(storedBody("gt.recipe.thermalcentrifuge", "Thermal Centrifuge", 48, "HV"));
    expect(restampAmpMapMinimums(gated, "2.9")).toBe(gated);
    const fresh = storedBody("gt.recipe.thermalcentrifuge", "Thermal Centrifuge", 48, "LV");
    fresh.machineHandlers![1].minimumTier = "MV";
    const current = plan(fresh);
    expect(restampAmpMapMinimums(current, "2.9")).toBe(current);
  });
});
