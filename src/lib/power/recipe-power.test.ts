import { describe, expect, it } from "vitest";
import type { Recipe } from "@/lib/model/types";
import { buildPowerRecipe } from "./power-recipe";
import { powerCardForRecipe } from "./recipe-power";
import { resolvePowerResource } from "./planner-data";

function htgrPage(fuelName: string): Recipe {
  const fuel = resolvePowerResource(`TRISO Fuel (${fuelName})`, "2.9")!;
  const burned = resolvePowerResource(`Burned Out TRISO Fuel (${fuelName})`, "2.9")!;
  return {
    id: "kubatech-htgr-uranium",
    name: "HTGR",
    machineType: "HTGR",
    minimumTier: "ZPM",
    durationTicks: 20,
    eut: 0,
    inputs: [{ kind: "item", id: "gregtech:gt.metaitem.01@2000", amount: 1, displayName: "Dust" }],
    outputs: [
      { kind: "item", id: "kubatech:htgr_item_mixture", amount: 1, displayName: "Mixture" },
      { kind: "item", id: fuel.id, amount: 1, displayName: fuel.displayName },
      { kind: "item", id: burned.id, amount: 1, displayName: burned.displayName },
    ],
    source: { recipeMap: "kubatech.htgrrecipes" },
  } as Recipe;
}

describe("a recipe whose machine is a power card", () => {
  it("turns an HTGR fuel page into the HTGR card burning that fuel", () => {
    const card = powerCardForRecipe(htgrPage("Uranium 235"), "2.9");
    expect(card?.sourceId).toBe("htgr");
    expect(card?.settings.pebble).toMatch(/^Uranium.235$/);
    // The card takes the finished fuel and gives back the burned fuel, not the page's whole making.
    const built = buildPowerRecipe(card!.sourceId, card!.settings, "r1", "2.9")!;
    expect(built.inputs.some((input) => input.displayName?.startsWith("TRISO Fuel"))).toBe(true);
    expect(
      built.outputs.some((output) => output.displayName?.startsWith("Burned Out TRISO Fuel")),
    ).toBe(true);
    expect(built.inputs.some((input) => input.id === "gregtech:gt.metaitem.01@2000")).toBe(false);
  });

  it("leaves any other recipe alone", () => {
    const other = {
      ...htgrPage("Uranium 235"),
      machineType: "Assembler",
      source: { recipeMap: "Assembler" },
      id: "a",
    };
    expect(powerCardForRecipe(other, "2.9")).toBeUndefined();
  });

  it("turns a 2.8.1 bartworks HTGR page into bartworks' card on that fuel", () => {
    // As the 2.8.1 export has it: 64 pebbles of one fuel in, one burned ball out.
    const page = {
      id: "oracle:gregtech:bw-recipe-htgr:f63d774e9047d6d3",
      name: "High Temperature Gas-cooled Reactor: Burned out TRISO Ball (Uranium)",
      machineType: "High Temperature Gas-cooled Reactor",
      minimumTier: "LV",
      durationTicks: 20,
      eut: 0,
      inputs: [{ kind: "item", id: "bartworks:bw.htgrmaterials@11", amount: 64, displayName: "TRISO pebble (Uranium)" }],
      outputs: [{ kind: "item", id: "bartworks:bw.htgrmaterials@12", amount: 1, displayName: "Burned out TRISO Ball (Uranium)" }],
      source: { recipeMap: "High Temperature Gas-cooled Reactor" },
    } as Recipe;
    expect(powerCardForRecipe(page, "2.8.1")).toEqual({ sourceId: "htgr", settings: { fuel: "Uranium" } });
    // A kubatech page on 2.8.1 names no bartworks pebble, and a bartworks page on 2.9 no kubatech fuel.
    expect(powerCardForRecipe(htgrPage("Uranium 235"), "2.8.1")).toBeUndefined();
    expect(powerCardForRecipe(page, "2.9")).toBeUndefined();
  });
});
