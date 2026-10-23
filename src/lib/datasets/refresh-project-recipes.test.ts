import { describe, expect, it, vi } from "vitest";
import type { Recipe } from "@/lib/model/types";
import { pickRecipeRefMatch } from "@/lib/import-export/recipe-ref-match";
import type { DatasetVersion } from "./types";
import {
  noteRecipesRefreshed,
  noteRecipesRequested,
  recipesToRefresh,
  resolveProjectRecipes,
} from "./refresh-project-recipes";

/**
 * The dataset behind the loader: bodies by id, and the resolve service the way the server
 * answers it (`resolveDatasetRecipeRefs`): candidates in the ref's map that make its first
 * output, scored by `pickRecipeRefMatch`, offered from 300 up.
 */
const datasetRecipes = new Map<string, Recipe>();
vi.mock("./browser-loader", () => ({
  getRecipeDatasetRecipe: async (_manifestUrl: string, _version: unknown, id: string) => {
    const found = datasetRecipes.get(id);
    if (!found) throw new Error(`404 ${id}`);
    return found;
  },
  resolveRecipeDatasetRecipes: async (
    _manifestUrl: string,
    _version: unknown,
    refs: Parameters<typeof pickRecipeRefMatch>[0][],
  ) => ({
    matches: refs.flatMap((ref) => {
      const candidates = [...datasetRecipes.values()].filter(
        (candidate) =>
          candidate.source?.recipeMap === ref.recipeMap &&
          candidate.outputs.some((output) => output.id === ref.outputs[0]?.id),
      );
      const match = pickRecipeRefMatch(ref, candidates);
      return match && match.score >= 300
        ? [{ importedId: ref.id, recipeId: match.candidate.id, exact: match.exact }]
        : [];
    }),
  }),
}));

const table = {
  sourceKind: "gregtech-overclock-calculator",
  status: "computed",
  oracleEligible: true,
  variants: [{ id: "lv", durationTicks: 100, eut: 30 }],
} as const;
const recipe = (id: string, withTable: boolean) =>
  ({ id, inputs: [], outputs: [], ...(withTable ? { runtimeCalculation: table } : {}) }) as unknown as Recipe;

describe("recipesToRefresh", () => {
  it("fetches each id once per dataset version", () => {
    const checked = new Map<string, boolean>();
    const requested = new WeakSet<Recipe>();
    const first = [recipe("a", true), recipe("b", false)];
    expect(recipesToRefresh(first, "v1", checked, requested)).toEqual(first);
    noteRecipesRequested(first, "v1", checked, requested);
    noteRecipesRefreshed([recipe("a", true), recipe("b", false)], "v1", checked);
    // Same ids again, as new objects with their bodies intact: nothing to do.
    expect(recipesToRefresh([recipe("a", true), recipe("b", false)], "v1", checked, requested)).toEqual([]);
    // A new dataset version checks again.
    expect(recipesToRefresh([recipe("a", true)], "v2", checked, requested)).toHaveLength(1);
  });

  it("fetches again when a synced plan brings a recipe back without its table", () => {
    // A plan pulled from the account travels without GregTech tables, and
    // its recipes can be ids this page already refreshed for another plan.
    const checked = new Map<string, boolean>();
    const requested = new WeakSet<Recipe>();
    noteRecipesRequested([recipe("a", true), recipe("b", false)], "v1", checked, requested);
    noteRecipesRefreshed([recipe("a", true), recipe("b", false)], "v1", checked);
    const pulled = [recipe("a", false), recipe("b", false)];
    expect(recipesToRefresh(pulled, "v1", checked, requested).map((entry) => entry.id)).toEqual(["a"]);
    // The same bare object is never sent twice.
    noteRecipesRequested([pulled[0]!], "v1", checked, requested);
    expect(recipesToRefresh(pulled, "v1", checked, requested)).toEqual([]);
  });
});

describe("resolveProjectRecipes", () => {
  type Slot = [kind: "item" | "aspect", id: string, amount: number];
  const arcane = (id: string, inputs: Slot[]): Recipe =>
    ({
      id,
      name: "Thaumcraft Arcane Crafting: Vis Reader",
      kind: "gregtech_machine",
      category: "thaumcraft",
      machineType: "Thaumcraft Arcane Crafting",
      minimumTier: "NONE",
      durationTicks: 1,
      eut: 0,
      inputs: inputs.map(([kind, slotId, amount]) => ({ kind, id: slotId, amount })),
      outputs: [{ kind: "item", id: "automagy:blockvisreader", amount: 1 }],
      source: { datasetVersionId: "x", recipeMap: "Thaumcraft Arcane Crafting", exporter: "gtnh-oracle" },
    }) as Recipe;
  const visCost = ["aer", "terra", "ignis", "aqua", "ordo", "perditio"].map(
    (tag): Slot => ["aspect", `thaumcraft:aspect:${tag}`, 3],
  );

  it("moves a plan's RC-2 arcane card, saved without its grid, onto the recipe with the grid", async () => {
    // The ids are the real ones: RC-2's aspect-only Vis Reader and this build's.
    const saved = arcane("oracle:local-2.9.0-beta-2:thaumcraft:arcane:df14c68650e5b3d1", visCost);
    const current = arcane("oracle:thaumcraft:arcane:4b2a36407c59a55f", [
      ["item", "thaumcraft:itemthaumometer", 1],
      ["item", "thaumcraft:blockcosmeticsolid@6", 1],
      ["item", "minecraft:quartz", 1],
      ["item", "thaumcraft:blockcosmeticsolid@6", 1],
      ["item", "thaumcraft:blockcosmeticsolid@6", 1],
      ["item", "automagy:blockredcrystal", 1],
      ...visCost,
    ]);
    datasetRecipes.clear();
    datasetRecipes.set(current.id, current);
    const version = { id: "local-2.9.0-rc-2" } as DatasetVersion;

    const { refreshed, migration } = await resolveProjectRecipes("/manifest.json", version, [saved]);

    expect(migration).toEqual({ [saved.id]: current.id });
    expect(refreshed.map((recipe) => recipe.id)).toEqual([current.id]);
    expect(refreshed[0]?.inputs.filter((input) => input.kind === "item")).toHaveLength(6);
  });
});
