import { describe, expect, it } from "vitest";
import type { Recipe } from "@/lib/model/types";
import { hasSameRecipeNumbers, pickRecipeRefMatch, recipeContentRef, scoreRecipeRefCandidate } from "./recipe-ref-match";

function slot(kind: "item" | "fluid", id: string, amount: number) {
  return { kind, id, amount };
}

function recipe(
  id: string,
  inputs: Array<ReturnType<typeof slot> & { consumed?: boolean }>,
  outputs: Array<ReturnType<typeof slot>>,
  extras: Partial<Recipe> = {},
): Recipe {
  return {
    id,
    name: `Blast Furnace: ${outputs[0]?.id ?? "nothing"}`,
    kind: "gregtech_machine",
    category: "gregtech",
    machineType: "Blast Furnace",
    minimumTier: "LV",
    durationTicks: 500,
    eut: 120,
    inputs,
    outputs,
    source: { datasetVersionId: "old", recipeMap: "Blast Furnace", exporter: "gtnh-oracle" },
    ...extras,
  } as Recipe;
}

const IRON_DUST = slot("item", "gregtech:dust.iron", 1);
const COAL_DUST = slot("item", "gregtech:dust.coal", 1);
const CAST_IRON = slot("item", "gregtech:dust.castiron", 1);
const CIRCUIT = { ...slot("item", "gregtech:circuit@11", 1), consumed: false };
const OXYGEN = slot("fluid", "oxygen", 1000);
const STEEL = slot("item", "gregtech:ingot.steel", 1);
const ASHES = slot("item", "gregtech:dust.ashes", 1);
const CO2 = slot("fluid", "carbondioxide", 1000);

/** The plan's recipe, exported under an id the dataset no longer lists. */
const exported = recipe("old:steel-from-dust", [IRON_DUST, COAL_DUST, CIRCUIT, OXYGEN], [STEEL, ASHES, CO2]);

/** The same recipe under this build's id, and its same-named neighbours. */
const sameRecipe = recipe("new:steel-from-dust", [OXYGEN, CIRCUIT, COAL_DUST, IRON_DUST], [ASHES, CO2, STEEL]);
const castIronRecipe = recipe("new:steel-from-cast-iron", [CAST_IRON, CIRCUIT, OXYGEN], [STEEL, ASHES], {
  durationTicks: 100,
});
const slowRecipe = recipe("new:steel-slow", [IRON_DUST, COAL_DUST, CIRCUIT], [STEEL, ASHES], {
  durationTicks: 3000,
  eut: 1920,
});

describe("finding a recipe again after its id changed", () => {
  it("picks the recipe with the same content, whatever order its slots come in", () => {
    const match = pickRecipeRefMatch(recipeContentRef(exported), [
      castIronRecipe,
      slowRecipe,
      sameRecipe,
    ]);
    expect(match?.candidate.id).toBe("new:steel-from-dust");
    expect(match?.exact).toBe(true);
  });

  it("never hands back a same-named recipe that takes other inputs", () => {
    // Before content matching, the first search hit sharing the name and
    // making the same output won: a plan's iron-dust steel furnace came
    // back as the cast-iron one.
    const match = pickRecipeRefMatch(recipeContentRef(exported), [castIronRecipe, slowRecipe]);
    expect(match?.score ?? 0).toBeLessThan(300);
  });

  it("still finds the recipe when only its timing changed between builds", () => {
    const retimed = recipe("new:steel-retimed", [IRON_DUST, COAL_DUST, CIRCUIT, OXYGEN], [STEEL, ASHES, CO2], {
      durationTicks: 480,
    });
    const match = pickRecipeRefMatch(recipeContentRef(exported), [castIronRecipe, retimed]);
    expect(match?.candidate.id).toBe("new:steel-retimed");
    expect(match?.exact).toBe(false);
    expect(match?.score).toBeGreaterThanOrEqual(300);
  });

  it("does not need the name to agree when the content does", () => {
    const renamed = { ...sameRecipe, name: "Blast Furnace: Steel Ingot (renamed)" };
    expect(scoreRecipeRefCandidate(recipeContentRef(exported), renamed)).toBeGreaterThanOrEqual(400);
  });

  it("refuses a candidate that no longer makes what the plan wires off it", () => {
    const noAshes = recipe("new:steel-no-ashes", [IRON_DUST, COAL_DUST, CIRCUIT, OXYGEN], [STEEL, CO2]);
    expect(scoreRecipeRefCandidate(recipeContentRef(exported), noAshes)).toBe(0);
  });

  it("refuses a candidate from another machine's map", () => {
    const elsewhere = recipe("new:arc", [IRON_DUST, COAL_DUST, CIRCUIT, OXYGEN], [STEEL, ASHES, CO2], {
      machineType: "Arc Furnace",
      source: { datasetVersionId: "new", recipeMap: "Arc Furnace", exporter: "gtnh-oracle" },
    });
    expect(scoreRecipeRefCandidate(recipeContentRef(exported), elsewhere)).toBe(0);
  });

  it("skips the ref's own id and breaks ties toward the earliest candidate", () => {
    const self = recipe("old:steel-from-dust", [IRON_DUST, COAL_DUST, CIRCUIT, OXYGEN], [STEEL, ASHES, CO2]);
    const twinA = { ...sameRecipe, id: "new:twin-a" };
    const twinB = { ...sameRecipe, id: "new:twin-b" };
    const match = pickRecipeRefMatch(recipeContentRef(exported), [self, twinA, twinB]);
    expect(match?.candidate.id).toBe("new:twin-a");
  });

  it("ignores non-consumed slots, which the exporter may list or not", () => {
    const withoutCircuit = recipe("new:steel-bare", [IRON_DUST, COAL_DUST, OXYGEN], [STEEL, ASHES, CO2]);
    expect(scoreRecipeRefCandidate(recipeContentRef(exported), withoutCircuit)).toBeGreaterThanOrEqual(400);
  });
});

/**
 * Arcane recipes as RC-2 published them (aspects only, or one wrong item for a shapeless
 * recipe) and as the oracle exports them now, with the grid. The ids are the real ones.
 */
describe("finding an arcane recipe a plan saved before the grid was exported", () => {
  type Slot = [kind: "item" | "aspect", id: string, amount: number];
  const arcane = (id: string, name: string, inputs: Slot[], outputs: Slot[]): Recipe =>
    ({
      id,
      name: `Thaumcraft Arcane Crafting: ${name}`,
      kind: "gregtech_machine",
      category: "thaumcraft",
      machineType: "Thaumcraft Arcane Crafting",
      minimumTier: "NONE",
      durationTicks: 1,
      eut: 0,
      inputs: inputs.map(([kind, slotId, amount]) => ({ kind, id: slotId, amount })),
      outputs: outputs.map(([kind, slotId, amount]) => ({ kind, id: slotId, amount })),
      source: { datasetVersionId: "x", recipeMap: "Thaumcraft Arcane Crafting", exporter: "gtnh-oracle" },
    }) as Recipe;
  const aspect = (tag: string, amount: number): Slot => ["aspect", `thaumcraft:aspect:${tag}`, amount];
  const VIS_READER: Slot = ["item", "automagy:blockvisreader", 1];
  const visCost = ["aer", "terra", "ignis", "aqua", "ordo", "perditio"].map((tag) => aspect(tag, 3));

  const oldVisReader = arcane(
    "oracle:local-2.9.0-beta-2:thaumcraft:arcane:df14c68650e5b3d1",
    "Vis Reader",
    visCost,
    [VIS_READER],
  );
  const newVisReader = arcane(
    "oracle:thaumcraft:arcane:4b2a36407c59a55f",
    "Vis Reader",
    [
      ["item", "thaumcraft:itemthaumometer", 1],
      ["item", "thaumcraft:blockcosmeticsolid@6", 1],
      ["item", "minecraft:quartz", 1],
      ["item", "thaumcraft:blockcosmeticsolid@6", 1],
      ["item", "thaumcraft:blockcosmeticsolid@6", 1],
      ["item", "automagy:blockredcrystal", 1],
      ...visCost,
    ],
    [VIS_READER],
  );

  it("an aspect-only recipe finds its recipe by output and aspect cost", () => {
    const cheaper = arcane("oracle:thaumcraft:arcane:cheaper", "Vis Reader", [
      ["item", "minecraft:quartz", 1],
      ...visCost.map(([kind, id]): Slot => [kind, id, 2]),
    ], [VIS_READER]);
    const match = pickRecipeRefMatch(recipeContentRef(oldVisReader), [cheaper, newVisReader]);
    expect(match?.candidate.id).toBe("oracle:thaumcraft:arcane:4b2a36407c59a55f");
    expect(match?.exact).toBe(false);
    expect(match?.score).toBeGreaterThanOrEqual(300);
  });

  it("counts the gridless recipe and the one with its grid as the same content, a cheaper one not", () => {
    const cheaper = arcane("oracle:thaumcraft:arcane:cheaper", "Vis Reader", [
      ["item", "minecraft:quartz", 1],
      ...visCost.map(([kind, id]): Slot => [kind, id, 2]),
    ], [VIS_READER]);
    expect(hasSameRecipeNumbers(oldVisReader, newVisReader)).toBe(true);
    expect(hasSameRecipeNumbers(oldVisReader, cheaper)).toBe(false);
  });

  it("a shapeless recipe saved with one wrong item finds its recipe", () => {
    const oldPearl = arcane(
      "oracle:local-2.9.0-beta-2:thaumcraft:arcane:445e0c28fc55ef9d",
      "Shattered Avarice Pearl",
      [["item", "choice:674e356f2771cdf6", 1], aspect("perditio", 2)],
      [["item", "automagy:horizontal", 2]],
    );
    const newPearl = arcane(
      "oracle:thaumcraft:arcane:b289f12592a4b6b5",
      "Shattered Avarice Pearl",
      [["item", "automagy:avaricepearl", 1], ["item", "automagy:shardsliver@5", 1], aspect("perditio", 2)],
      [["item", "automagy:horizontal", 2]],
    );
    const match = pickRecipeRefMatch(recipeContentRef(oldPearl), [newPearl]);
    expect(match?.candidate.id).toBe(newPearl.id);
    expect(match?.score).toBeGreaterThanOrEqual(300);
  });

  it("an arcane subclass in the generic Thaumcraft map finds its recipe too, if its one item is in the grid", () => {
    const inThaumcraftMap = (recipe: Recipe): Recipe => ({
      ...recipe,
      machineType: "Thaumcraft",
      source: { ...recipe.source, recipeMap: "Thaumcraft" },
    }) as Recipe;
    const WHITELIST: Slot = ["item", "automagy:enchantedpaper@1", 1];
    const oldCopy = inThaumcraftMap(
      arcane("oracle:local-2.9.0-beta-2:thaumcraft:thaumcraft:1f45a2466bd17978", "Runic Whitelist", [
        ["item", "automagy:enchantedpaper@2", 1],
        aspect("ordo", 2),
      ], [WHITELIST]),
    );
    const newCopy = inThaumcraftMap(
      arcane("oracle:thaumcraft:thaumcraft:new", "Runic Whitelist", [
        ["item", "automagy:enchantedpaper@2", 1],
        ["item", "oredict:dyeWhite", 1],
        aspect("ordo", 2),
      ], [WHITELIST]),
    );
    expect(scoreRecipeRefCandidate(recipeContentRef(oldCopy), newCopy)).toBeGreaterThanOrEqual(300);
    // The saved item is a real one: a candidate without it is another recipe.
    const without = { ...newCopy, inputs: newCopy.inputs.filter((input) => input.id !== "automagy:enchantedpaper@2") };
    without.inputs.push({ kind: "item", id: "minecraft:paper", amount: 1 } as Recipe["inputs"][number]);
    expect(scoreRecipeRefCandidate(recipeContentRef(oldCopy), without)).toBeLessThan(300);
  });

  it("never stands in for another machine's recipe or a recipe with its full grid", () => {
    const crafted = { ...newVisReader, machineType: "Shaped Crafting", source: { recipeMap: "Shaped Crafting" } };
    expect(scoreRecipeRefCandidate(recipeContentRef(oldVisReader), crafted as Recipe)).toBe(0);
    // A ref that already lists the grid is matched by the ordinary tiers only.
    const otherGrid = arcane("oracle:thaumcraft:arcane:other", "Vis Reader", [
      ["item", "minecraft:quartz", 1],
      ["item", "minecraft:glass", 1],
      ...visCost,
    ], [VIS_READER]);
    expect(scoreRecipeRefCandidate(recipeContentRef(newVisReader), otherGrid)).toBeLessThan(300);
  });
});
