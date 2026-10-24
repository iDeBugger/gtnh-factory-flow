import { beforeEach, describe, expect, test, vi } from "vitest";
import { PROJECT_SCHEMA_VERSION, type FactoryEdge, type FactoryNode, type FactoryProject, type Recipe } from "@/lib/model/types";
import { pickRecipeRefMatch } from "@/lib/import-export/recipe-ref-match";
import { boardSelectionPayloadSchema } from "@/lib/model/schemas";
import { createCustomRatePlaceholderRecipe } from "@/lib/model/custom-rate";
import { buildPowerRecipe } from "@/lib/power/power-recipe";
import type { DatasetManifest } from "./types";

/** Each served dataset's bodies by id. */
const datasets = vi.hoisted(() => new Map<string, Map<string, unknown>>());
/** The recipe API as the server answers it: bodies by id, and content matches scored the way it scores them. */
vi.mock("./browser-loader", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./browser-loader")>()),
  getRecipeDatasetRecipe: async (_manifestUrl: string, version: { id: string }, id: string) => {
    const found = datasets.get(version.id)?.get(id);
    if (!found) throw new Error(`404 ${id}`);
    return structuredClone(found);
  },
  resolveRecipeDatasetRecipes: async (
    _manifestUrl: string,
    version: { id: string },
    refs: Parameters<typeof pickRecipeRefMatch>[0][],
  ) => ({
    matches: refs.flatMap((ref) => {
      const candidates = [...(datasets.get(version.id)?.values() ?? [])] as Recipe[];
      const match = pickRecipeRefMatch(
        ref,
        candidates.filter((candidate) => candidate.source?.recipeMap === ref.recipeMap),
      );
      return match && match.score >= 300 ? [{ importedId: ref.id, recipeId: match.candidate.id, exact: match.exact }] : [];
    }),
  }),
}));

import { captureBoardSelection, useFactoryStore, type BoardClipboardPayload } from "@/store/factory-store";
import { preparePayloadForPlan } from "./convert-payload-version";

const V29 = "local-2.9.0-rc-2";
const V281 = "local-2.8.1";
const manifest = {
  schemaVersion: 1,
  latestStableVersion: V29,
  versions: [
    { id: V29, gtnhVersion: "2.9.0-RC-2", publishedAt: "2026-10-23T00:00:00.000Z" },
    { id: V281, gtnhVersion: "2.8.1", publishedAt: "2026-10-23T00:00:00.000Z" },
  ],
} as unknown as DatasetManifest;
const source = { manifest, manifestUrl: "/manifest.json" };

function gtRecipe(id: string, datasetVersionId: string, overrides: Partial<Recipe> = {}): Recipe {
  return {
    id,
    name: "Blast Furnace: Raw Silicon Ingot",
    kind: "gregtech_machine",
    machineType: "Blast Furnace",
    minimumTier: "MV",
    durationTicks: 80,
    eut: 120,
    inputs: [{ kind: "item", id: "gregtech:dust:silicon", amount: 1 }],
    outputs: [{ kind: "item", id: "gregtech:ingot:silicon", amount: 1 }],
    source: { datasetVersionId, recipeMap: "Blast Furnace" },
    ...overrides,
  };
}

// Raw Silicon Ingot changed between the versions (80 t on 2.8.1, 400 t on 2.9); the macerator recipe did not.
const silicon281 = gtRecipe("oracle:gregtech:gt-recipe-blastfurnace:c7dfbb47010378b1", V281);
const silicon29 = gtRecipe("oracle:gregtech:gt-recipe-blastfurnace:68b67d723eb95e92", V29, { durationTicks: 400 });
const dustId = "oracle:gregtech:gt-recipe-macerator:aaaa000011112222";
const dust = (datasetVersionId: string) =>
  gtRecipe(dustId, datasetVersionId, {
    name: "Macerator: Silicon Dust",
    machineType: "Macerator",
    durationTicks: 100,
    eut: 2,
    inputs: [{ kind: "item", id: "gregtech:ore:silicon", amount: 1 }],
    outputs: [{ kind: "item", id: "gregtech:dust:silicon", amount: 2 }],
    source: { datasetVersionId, recipeMap: "Macerator" },
  });
datasets.set(V281, new Map([silicon281, dust(V281)].map((recipe) => [recipe.id, recipe])));
datasets.set(V29, new Map([silicon29, dust(V29)].map((recipe) => [recipe.id, recipe])));

function node(id: string, recipeId: string, x = 0): FactoryNode {
  return { id, recipeId, machineCount: 2, parallel: 1, overclockTier: "MV", enabled: true, position: { x, y: 0 } };
}

const wire: FactoryEdge = {
  id: "e1",
  source: "n1",
  target: "n2",
  sourceHandle: "output:item:gregtech%3Adust%3Asilicon:0",
  targetHandle: "input:item:gregtech%3Adust%3Asilicon:0",
  resourceKind: "item",
  resourceId: "gregtech:dust:silicon",
} as FactoryEdge;

function plan(gameVersion: string | undefined, recipes: Recipe[], nodes: FactoryNode[], edges: FactoryEdge[] = []): FactoryProject {
  return {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    ...(gameVersion ? { gameVersion } : {}),
    id: `plan-${gameVersion ?? "old"}`,
    name: "Silicon line",
    planMode: true,
    recipes,
    nodes,
    edges,
    fuelProfiles: [],
  };
}

/** A copy of a 2.9 board: the macerator, the changed blast furnace recipe and the wire between them. */
function copied29(): BoardClipboardPayload {
  const board = plan("2.9", [dust(V29), silicon29], [node("n1", dustId), node("n2", silicon29.id, 300)], [wire]);
  return captureBoardSelection(board, ["n1", "n2"])!;
}

const empty281 = () => plan("2.8.1", [], []);

/** Every recipe body the payload or plan holds that came from the 2.9 dataset. */
const bodiesFrom29 = (recipes: Recipe[]) => recipes.filter((recipe) => recipe.source?.datasetVersionId === V29);

describe("preparePayloadForPlan", () => {
  beforeEach(() => {
    useFactoryStore.setState({ planNotice: null });
  });

  test("a 2.9 clipboard pasted into a 2.8.1 plan keeps no 2.9 body", async () => {
    const payload = copied29();
    expect(payload.gameVersion).toBe("2.9");
    const target = empty281();
    const prepared = await preparePayloadForPlan(payload, target, source);
    expect(prepared.gameVersion).toBe("2.8.1");
    expect(bodiesFrom29(prepared.recipes)).toEqual([]);
    // The unchanged recipe takes 2.8.1's body; the changed one is marked and has no body.
    expect(prepared.recipes.map((recipe) => recipe.id)).toEqual([dustId]);
    expect(prepared.nodes.find((entry) => entry.id === "n1")?.unconverted).toBeUndefined();
    expect(prepared.nodes.find((entry) => entry.id === "n2")?.unconverted).toEqual({
      fromGameVersion: "2.9",
      recipeId: silicon29.id,
      recipeName: silicon29.name,
      machineType: "Blast Furnace",
    });
    // The copy itself is untouched.
    expect(payload.gameVersion).toBe("2.9");
    expect(payload.recipes).toHaveLength(2);

    useFactoryStore.getState().setProject(target);
    const pastedIds = useFactoryStore.getState().pasteBoardItems(prepared, { x: 40, y: 40 });
    expect(pastedIds).toHaveLength(2);
    const after = useFactoryStore.getState().project;
    expect(bodiesFrom29(after.recipes)).toEqual([]);
    expect(after.recipes.map((recipe) => recipe.source?.datasetVersionId)).toEqual([V281]);
    expect(after.nodes).toHaveLength(2);
    expect(after.nodes.filter((entry) => entry.unconverted)).toHaveLength(1);
    expect(after.edges).toHaveLength(1);
    expect(useFactoryStore.getState().planNotice).toBeNull();
  });

  test("a 2.9 blueprint inserted into a 2.8.1 plan keeps no 2.9 body", async () => {
    // A blueprint is the payload as the blueprint API stored it.
    const blueprint = boardSelectionPayloadSchema.parse(copied29()) as BoardClipboardPayload;
    expect(blueprint.gameVersion).toBe("2.9");
    const prepared = await preparePayloadForPlan(blueprint, empty281(), source);
    expect(prepared.gameVersion).toBe("2.8.1");
    expect(bodiesFrom29(prepared.recipes)).toEqual([]);
    expect(prepared.nodes.map((entry) => Boolean(entry.unconverted))).toEqual([false, true]);
  });

  test("a blueprint saved before this (no field) reads 2.9", async () => {
    const { gameVersion: _stamp, ...old } = copied29();
    const blueprint = boardSelectionPayloadSchema.parse(old) as BoardClipboardPayload;
    expect(blueprint.gameVersion).toBeUndefined();
    // On a 2.9 plan (or an old one with no field) it is the plan's own version: nothing changes.
    expect(await preparePayloadForPlan(blueprint, plan(undefined, [], []), source)).toBe(blueprint);
    expect(await preparePayloadForPlan(blueprint, plan("2.9", [], []), source)).toBe(blueprint);
    // On a 2.8.1 plan it converts as a 2.9 payload.
    const prepared = await preparePayloadForPlan(blueprint, empty281(), source);
    expect(bodiesFrom29(prepared.recipes)).toEqual([]);
    expect(prepared.nodes.find((entry) => entry.id === "n2")?.unconverted?.fromGameVersion).toBe("2.9");
  });

  test("a 2.9 power card pasted into a 2.8.1 plan is rebuilt, and a Large Neutralization Engine arrives marked", async () => {
    const power = buildPowerRecipe("large-combustion-engine", undefined, "power:lce", "2.9")!;
    // A copied body that no rebuild would produce: if it lands, the card was copied, not rebuilt.
    const copiedPower = { ...power, outputs: [] };
    // The rebuild is the target plan's version's card.
    const rebuilt = buildPowerRecipe("large-combustion-engine", undefined, "power:lce", "2.8.1")!;
    const lne = buildPowerRecipe("large-neutralization-engine", undefined, "power:lne", "2.9")!;
    const payload: BoardClipboardPayload = {
      gameVersion: "2.9",
      nodes: [node("p", "power:lce"), node("l", "power:lne", 300)],
      storages: [],
      annotations: [],
      pockets: [],
      edges: [],
      recipes: [copiedPower, lne],
    };
    const prepared = await preparePayloadForPlan(payload, empty281(), source);
    expect(prepared.gameVersion).toBe("2.8.1");
    expect(prepared.recipes.find((recipe) => recipe.id === "power:lce")?.outputs).toEqual(rebuilt.outputs);
    expect(prepared.nodes.find((entry) => entry.id === "p")?.unconverted).toBeUndefined();
    expect(prepared.recipes.some((recipe) => recipe.id === "power:lne")).toBe(false);
    expect(prepared.nodes.find((entry) => entry.id === "l")?.unconverted).toEqual(
      expect.objectContaining({ fromGameVersion: "2.9", recipeId: "power:lne", reason: "Not in GTNH 2.8.1." }),
    );
  });

  test("a same-family paste is unchanged", async () => {
    const payload = copied29();
    const before = structuredClone(payload);
    const prepared = await preparePayloadForPlan(payload, plan("2.9", [], []), source);
    expect(prepared).toBe(payload);
    expect(payload).toEqual(before);
  });

  test("a paste from another version before the manifest lands is refused, never marked", async () => {
    const payload = copied29();
    await expect(preparePayloadForPlan(payload, plan("2.8.1", [], []), { manifestUrl: "/manifest.json" })).rejects.toThrow(
      "Recipes are still loading. Try again.",
    );
    // The same version needs no manifest.
    expect(await preparePayloadForPlan(payload, plan("2.9", [], []), {})).toBe(payload);
  });

  test("a paste into a plan whose version is not served marks every dataset card", async () => {
    const dial = createCustomRatePlaceholderRecipe("factoryflow:custom-rate:test");
    const payload: BoardClipboardPayload = {
      ...copied29(),
    };
    payload.recipes = [...payload.recipes, dial];
    payload.nodes = [...payload.nodes, node("dial", dial.id, 600)];
    const target = plan("2.10", [], []);
    const prepared = await preparePayloadForPlan(payload, target, source);
    expect(prepared.gameVersion).toBe("2.10");
    expect(prepared.recipes.map((recipe) => recipe.id)).toEqual([dial.id]);
    expect(prepared.nodes.map((entry) => entry.unconverted?.recipeId)).toEqual([dustId, silicon29.id, undefined]);
    expect(prepared.edges).toEqual(payload.edges);

    useFactoryStore.getState().setProject(target);
    expect(useFactoryStore.getState().pasteBoardItems(prepared, { x: 0, y: 0 })).toHaveLength(3);
    expect(bodiesFrom29(useFactoryStore.getState().project.recipes)).toEqual([]);
  });
});
