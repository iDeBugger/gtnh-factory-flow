import { describe, expect, test } from "vitest";
import { createCropFarmPlaceholderRecipe } from "@/lib/model/passive-production";
import type { FactoryNode, Recipe } from "@/lib/model/types";
import { buildPowerRecipe, resynthesizePowerRecipes } from "./power-recipe";
import { searchPowerSources } from "./power-search";
import { getPowerSource, powerSourcesFor } from "./registry";

function card(id: string, recipeId: string): FactoryNode {
  return { id, recipeId, position: { x: 0, y: 0 }, machineCount: 1 } as FactoryNode;
}

/** A plan of `gameVersion` holding one Large Neutralization Engine card, its recipe built where the source exists. */
function planWithLneCard(gameVersion: string): { gameVersion: string; nodes: FactoryNode[]; recipes: Recipe[] } {
  const recipe = buildPowerRecipe("large-neutralization-engine", undefined, "power:lne", "2.9")!;
  return { gameVersion, nodes: [card("l", recipe.id)], recipes: [recipe] };
}

function planWithCropFarmPlaceholder(gameVersion: string) {
  const recipe = createCropFarmPlaceholderRecipe();
  return { gameVersion, nodes: [card("f", recipe.id)], recipes: [recipe] };
}

describe("power sources absent in 2.8.1", () => {
  test("large-neutralization-engine absent in 2.8.1 is not offered", () => {
    expect(getPowerSource("large-neutralization-engine", "2.8.1")).toBeUndefined();
    expect(getPowerSource("large-neutralization-engine", "2.9")).toBeDefined();
    expect(powerSourcesFor("2.8.1").some((source) => source.id === "large-neutralization-engine")).toBe(false);
    expect(searchPowerSources("neutralization", "2.8.1").some((hit) => hit.source.id === "large-neutralization-engine")).toBe(false);
    expect(searchPowerSources("neutralization", "2.9").some((hit) => hit.source.id === "large-neutralization-engine")).toBe(true);
  });

  test("large-neutralization-engine absent in 2.8.1 marks a converted card, never computed", () => {
    const out = resynthesizePowerRecipes(planWithLneCard("2.8.1"), "2.8.1");
    expect(out.nodes[0].unconverted).toEqual({
      fromGameVersion: "2.9",
      recipeId: "power:lne",
      recipeName: "Large Neutralization Engine",
      machineType: "Large Neutralization Engine",
      reason: "Not in GTNH 2.8.1.",
    });
    // The 2.9 body goes: a marked card never shows another version's numbers.
    expect(out.recipes).toEqual([]);
    const on29 = resynthesizePowerRecipes(planWithLneCard("2.9"), "2.9");
    expect(on29.nodes[0].unconverted).toBeFalsy();
    expect(on29.recipes.map((recipe) => recipe.id)).toEqual(["power:lne"]);
  });

  test("large-neutralization-engine absent in 2.8.1 keeps a card already marked as it is", () => {
    const plan = planWithLneCard("2.8.1");
    const marker = { fromGameVersion: "2.9", recipeId: "power:lne", recipeName: "x", machineType: "y", reason: "Not in GTNH 2.8.1." };
    plan.nodes[0] = { ...plan.nodes[0], unconverted: marker };
    expect(resynthesizePowerRecipes(plan, "2.8.1").nodes[0].unconverted).toBe(marker);
  });

  test("crop maths absent in 2.8.1 leaves the empty placeholder as it is", () => {
    const plan = planWithCropFarmPlaceholder("2.8.1");
    expect(resynthesizePowerRecipes(plan, "2.8.1")).toEqual(plan);
    const plan29 = planWithCropFarmPlaceholder("2.9");
    expect(resynthesizePowerRecipes(plan29, "2.9")).toEqual(plan29);
  });
});
