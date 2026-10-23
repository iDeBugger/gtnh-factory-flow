import { describe, expect, it } from "vitest";
import { diffPlans, type LivePlan } from "./ops";
import { liveShape, withRecipesTheyName } from "./live-shape";

const recipe = (id: string) => ({ id, machineName: "Electric Blast Furnace", inputs: [], outputs: [] });
const card = (id: string, recipeId: string) => ({ id, recipeId, position: { x: 0, y: 0 } });

describe("withRecipesTheyName", () => {
  // The game names a card's recipe gtnhplanner:<card>; this screen re-keyed it to the dataset's id, quietly.
  const shared: LivePlan = { recipes: [recipe("gtnhplanner:a")], nodes: [card("a", "gtnhplanner:a")] };
  const here: LivePlan = { recipes: [recipe("dataset:ebf")], nodes: [card("a", "dataset:ebf")] };

  it("sends the recipe a copied card names when the shared plan lacks it", () => {
    const next = { ...here, nodes: [...(here.nodes as object[]), card("b", "dataset:ebf")] };
    const ops = withRecipesTheyName(diffPlans(here, next), shared, next);
    expect(ops[0]).toEqual({ o: "put", c: "recipes", id: "dataset:ebf", v: recipe("dataset:ebf") });
    expect(ops.slice(1)).toEqual(diffPlans(here, next));
  });

  it("adds nothing when the shared plan holds the recipe or the edit names none", () => {
    const moved = { ...here, nodes: [{ ...card("a", "dataset:ebf"), position: { x: 20, y: 0 } }] };
    expect(withRecipesTheyName(diffPlans(here, moved), shared, moved)).toEqual(diffPlans(here, moved));
    const copied = { ...shared, nodes: [...(shared.nodes as object[]), card("b", "gtnhplanner:a")] };
    expect(withRecipesTheyName(diffPlans(shared, copied), shared, copied)).toEqual(diffPlans(shared, copied));
  });

  it("covers a shared machine's later recipes", () => {
    const next = {
      ...here,
      recipes: [recipe("dataset:ebf"), recipe("dataset:two")],
      nodes: [{ ...card("a", "dataset:ebf"), extraRecipes: [{ recipeId: "dataset:two" }] }],
    };
    const ops = withRecipesTheyName(diffPlans(here, next), shared, next);
    expect(ops.flatMap((op) => (op.o === "put" && op.c === "recipes" ? [op.id] : []))).toEqual(["dataset:two"]);
  });
});

describe("liveShape", () => {
  // Set when a plan is made and never edited; a live service built before the field would refuse it as a meta op.
  it("leaves out the plan's game version", () => {
    const plan: LivePlan = { gameVersion: "2.8.1", recipes: [], nodes: [] };
    expect(liveShape(plan).gameVersion).toBeUndefined();
    expect(diffPlans(liveShape({ recipes: [], nodes: [] }), liveShape(plan))).toEqual([]);
    expect(diffPlans(liveShape(plan), liveShape({ ...plan, gameVersion: "2.9" }))).toEqual([]);
  });
});
