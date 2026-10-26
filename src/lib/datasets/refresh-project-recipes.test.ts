import { describe, expect, it, vi } from "vitest";
import type { Recipe } from "@/lib/model/types";
import { pickRecipeRefMatch } from "@/lib/import-export/recipe-ref-match";
import type { DatasetManifest, DatasetVersion } from "./types";
import {
  noteRecipesRefreshed,
  noteRecipesRequested,
  recipesToRefresh,
  resolveProjectRecipes,
  startLandingRefresh,
} from "./refresh-project-recipes";
import { isRestorableRecipe } from "./restorable-recipes";

/**
 * The dataset behind the loader: bodies by id, and the resolve service the way the server
 * answers it (`resolveDatasetRecipeRefs`): candidates in the ref's map that make its first
 * output, scored by `pickRecipeRefMatch`, offered from 300 up.
 */
const datasetRecipes = new Map<string, Recipe>();
/** Every body fetch, as `<dataset version>|<recipe id>`. */
const fetched = vi.hoisted(() => [] as string[]);
vi.mock("./browser-loader", () => ({
  getRecipeDatasetRecipe: async (_manifestUrl: string, version: { id: string }, id: string) => {
    fetched.push(`${version.id}|${id}`);
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

describe("the landing refresh", () => {
  const manifest = {
    schemaVersion: 1,
    latestStableVersion: "local-2.9.0-rc-2",
    versions: [
      { id: "local-2.9.0-rc-2", gtnhVersion: "2.9.0-RC-2" },
      { id: "local-2.8.1", gtnhVersion: "2.8.1" },
    ],
  } as unknown as DatasetManifest;
  const dataset29 = { datasetVersionId: "local-2.9.0-rc-2", gtnhVersion: "2.9.0-RC-2" };
  const dataset281 = { datasetVersionId: "local-2.8.1", gtnhVersion: "2.8.1" };
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

  it("landing refresh never runs across versions", async () => {
    datasetRecipes.clear();
    datasetRecipes.set("r1", { ...recipe("r1", true), source: { datasetVersionId: "local-2.8.1" } });
    fetched.length = 0;
    const plan = { gameVersion: "2.8.1", recipes: [recipe("r1", false)] };
    const checked = new Map<string, boolean>();
    const requested = new WeakSet<Recipe>();
    const apply = vi.fn();
    const run = (dataset: typeof dataset29) =>
      startLandingRefresh({
        dataset,
        manifest,
        manifestUrl: "/m.json",
        project: plan,
        checked,
        requested,
        stillServes: () => true,
        apply,
      });

    // A 2.8.1 plan with the 2.9 dataset active (its own still loading): nothing is asked.
    expect(run(dataset29)).toBeUndefined();
    await flush();
    expect(fetched).toEqual([]);
    expect(apply).not.toHaveBeenCalled();

    // Its dataset lands: one refresh, against 2.8.1.
    expect(run(dataset281)).toBeTypeOf("function");
    await flush();
    expect(fetched).toEqual(["local-2.8.1|r1"]);
    expect(apply).toHaveBeenCalledTimes(1);

    // The same recipes again: nothing more.
    expect(run(dataset281)).toBeUndefined();
  });

  it("drops an answer that lands after the board moved to another version", async () => {
    datasetRecipes.clear();
    datasetRecipes.set("r1", recipe("r1", true));
    const apply = vi.fn();
    let serves = true;
    startLandingRefresh({
      dataset: dataset29,
      manifest,
      manifestUrl: "/m.json",
      project: { recipes: [recipe("r1", false)] },
      checked: new Map(),
      requested: new WeakSet(),
      stillServes: () => serves,
      apply,
    });
    serves = false;
    await flush();
    expect(apply).not.toHaveBeenCalled();
  });

  it("asks a dropped refresh again when its plan is back", async () => {
    datasetRecipes.clear();
    datasetRecipes.set("r1", recipe("r1", false));
    fetched.length = 0;
    const checked = new Map<string, boolean>();
    const requested = new WeakSet<Recipe>();
    const project = { recipes: [recipe("r1", false)] };
    const apply = vi.fn();
    const run = () =>
      startLandingRefresh({
        dataset: dataset29,
        manifest,
        manifestUrl: "/m.json",
        project,
        checked,
        requested,
        stillServes: () => true,
        apply,
      });
    // Dropped by a switch away (the board no longer serves): no retry is asked.
    const retry = vi.fn();
    let serves = false;
    startLandingRefresh({
      dataset: dataset29,
      manifest,
      manifestUrl: "/m.json",
      project,
      checked,
      requested,
      stillServes: () => serves,
      apply,
      retry,
    });
    await flush();
    expect(retry).not.toHaveBeenCalled();
    serves = true;
    // Dropped by an edit on the same plan: a retry is asked at once.
    startLandingRefresh({
      dataset: dataset29,
      manifest,
      manifestUrl: "/m.json",
      project,
      checked,
      requested,
      stillServes: () => serves,
      apply,
      retry,
    })!();
    await flush();
    expect(retry).toHaveBeenCalledTimes(1);
    expect(apply).not.toHaveBeenCalled();
    fetched.length = 0;
    run();
    await flush();
    expect(fetched).toEqual(["local-2.9.0-rc-2|r1"]);
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it("restorable recipes are per dataset", () => {
    const checked = new Map<string, boolean>();
    // The 2.9 dataset's body carries a table; 2.8.1's body of the same id has none.
    noteRecipesRefreshed([recipe("shared", true)], "local-2.9.0-rc-2", checked);
    noteRecipesRefreshed([recipe("shared", false)], "local-2.8.1", checked);
    const on = (datasetVersionId: string) =>
      ({ ...recipe("shared", true), source: { datasetVersionId } }) as Recipe;
    expect(isRestorableRecipe(on("local-2.9.0-rc-2"))).toBe(true);
    expect(isRestorableRecipe(on("local-2.8.1"))).toBe(false);
    // A body with no dataset named is never known to come back.
    expect(isRestorableRecipe(recipe("shared", true))).toBe(false);
  });
});

describe("forgetting a recipe check", () => {
  it("lets the next landing ask for that stored body again", async () => {
    const { forgetRecipeChecks, recipesToRefresh, noteRecipesRequested } = await import("./refresh-project-recipes");
    const recipe = { id: "r", name: "r", machineType: "m", minimumTier: "LV", durationTicks: 1, eut: 0, inputs: [], outputs: [] } as unknown as Recipe;
    const checked = new Map<string, boolean>();
    const requested = new WeakSet<Recipe>();
    noteRecipesRequested([recipe], "v", checked, requested);
    expect(recipesToRefresh([recipe], "v", checked, requested)).toEqual([]);

    forgetRecipeChecks("v", [recipe], { checked, requested });

    expect(recipesToRefresh([recipe], "v", checked, requested)).toEqual([recipe]);
  });
});
