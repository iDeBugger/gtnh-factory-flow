// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Recipe } from "@/lib/model/types";
import type { DatasetManifest, DatasetVersion, RecipeDataset } from "@/lib/datasets/types";
import { PROJECT_SCHEMA_VERSION } from "@/lib/model/types";
import { useFactoryStore } from "@/store/factory-store";
import { RecipeBrowser, contextualizePreviewRecipe } from "./RecipeBrowser";
import { queryRecipeDatasetRecipes } from "@/lib/datasets/browser-loader";

const datasetVersion: DatasetVersion = {
  id: "test-version",
  gtnhVersion: "2.9.0",
  channel: "daily",
  publishedAt: "2026-05-25T00:00:00.000Z",
  manifestPath: "manifest.json",
  recipeDatasetPath: "recipes.json",
  sourceInfo: {
    sourceId: "recex",
    generatedAt: "2026-05-25T00:00:00.000Z",
  },
};

const browserLoaderMock = vi.hoisted(() => {
  const fullRecipe = {
    id: "coke-oven-log",
    name: "Coke Oven: Charcoal",
    machineType: "Coke Oven",
    minimumTier: "MV",
    durationTicks: 256,
    eut: 96,
    inputs: [
      {
        kind: "item",
        id: "gregtech:gt.integrated_circuit@1",
        amount: 0,
        displayName: "Integrated Circuit",
        consumed: false,
        neiSlot: { x: 44, y: 35 },
      },
      {
        kind: "item",
        id: "oredict:logWood",
        amount: 16,
        displayName: "Ore Dictionary: logWood",
        iconPath: "/items/oak-log.png",
        tooltip: ["Ore Dictionary: logWood"],
        neiSlot: { x: 62, y: 35 },
      },
    ],
    outputs: [{ kind: "item", id: "minecraft:coal@1", amount: 20, displayName: "Charcoal" }],
  };

  return {
    getRecipeDatasetRecipe: vi.fn(async () => fullRecipe),
    queryRecipeDatasetRecipes: vi.fn(async () => ({
      recipes: [
        {
          ...fullRecipe,
          recipeMap: "Coke Oven",
          slots: [],
          inputs: [
            {
              kind: "item",
              id: "minecraft:log@1",
              amount: 16,
              displayName: "Spruce Log",
              iconPath: "/items/spruce-log.png",
              tooltip: ["Spruce Log"],
              neiSlot: { x: 62, y: 35 },
            },
          ],
        },
      ],
      total: 1,
      recipeMaps: ["Coke Oven"],
      offset: 0,
      limit: 120,
      hasMore: false,
    })),
  };
});

vi.mock("@/lib/datasets/browser-loader", () => ({
  getRecipeDatasetRecipe: browserLoaderMock.getRecipeDatasetRecipe,
  queryRecipeDatasetRecipes: browserLoaderMock.queryRecipeDatasetRecipes,
  queryRecipeDatasetResources: vi.fn(async () => ({
    resources: [],
    total: 0,
    offset: 0,
    limit: 6,
    hasMore: false,
  })),
}));

describe("RecipeBrowser", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    class TestResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    }

    vi.stubGlobal("ResizeObserver", TestResizeObserver);

    const manifest: DatasetManifest = {
      schemaVersion: 1,
      latestDailyVersion: datasetVersion.id,
      versions: [datasetVersion],
    };

    useFactoryStore.getState().setProject({
      schemaVersion: PROJECT_SCHEMA_VERSION,
      id: "recipe-browser-test",
      name: "Recipe browser test",
      fuelProfiles: [],
      recipes: [],
      nodes: [],
      edges: [],
    });
    useFactoryStore.getState().setDatasetManifest(manifest, "/datasets/manifest.json");
    // The browser asks only while the active dataset serves the open plan's version.
    useFactoryStore.getState().setDataset({
      datasetVersionId: datasetVersion.id,
      gtnhVersion: datasetVersion.gtnhVersion,
      resources: [],
      recipes: [],
    } as unknown as RecipeDataset);
    useFactoryStore.getState().browseResource(
      {
        kind: "item",
        id: "minecraft:log@1",
        displayName: "Spruce Log",
      },
      "uses",
    );
  });

  it("keeps the concrete Spruce Log context when adding a recipe from the recipe book", async () => {
    render(<RecipeBrowser onLoadDatasetVersion={() => {}} />);

    // The map name now shows twice: category rail row + category header.
    await screen.findAllByText("Coke Oven");
    await waitFor(() => {
      expect(queryRecipeDatasetRecipes).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Object),
        expect.objectContaining({ mode: "uses" }),
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    });

    fireEvent.click(await screen.findByLabelText("Add recipe node"));

    await waitFor(() => {
      const node = useFactoryStore.getState().project.nodes[0];
      expect(node?.recipeInputOverrides?.["1"]).toEqual(
        expect.objectContaining({
          id: "minecraft:log@1",
          displayName: "Spruce Log",
          iconPath: "/items/spruce-log.png",
          tooltip: ["Spruce Log"],
          alternatives: undefined,
        }),
      );
    });
    expect(useFactoryStore.getState().project.recipes[0]?.inputs[1]).toEqual(
      expect.objectContaining({
        id: "oredict:logWood",
      }),
    );
  });

  it("refuses a pick whose body arrives after a switch to a tab on another version", async () => {
    let release: (recipe: unknown) => void = () => {};
    const body = await browserLoaderMock.getRecipeDatasetRecipe();
    browserLoaderMock.getRecipeDatasetRecipe.mockImplementationOnce(
      () => new Promise((resolve) => (release = resolve)) as never,
    );
    render(<RecipeBrowser onLoadDatasetVersion={() => {}} />);
    fireEvent.click(await screen.findByLabelText("Add recipe node"));
    // The player moves to a 2.8.1 tab while the 2.9 body is on its way.
    useFactoryStore.setState((state) => ({ project: { ...state.project, gameVersion: "2.8.1" } }));
    release({ ...body, source: { datasetVersionId: datasetVersion.id } });
    await waitFor(() => {
      expect(useFactoryStore.getState().pendingRecipeAdds.at(-1)?.error).toBe(
        "This recipe is from another GTNH version.",
      );
    });
    expect(useFactoryStore.getState().project.nodes).toHaveLength(0);
  });

  it("asks nothing and reads as loading while the plan's own dataset loads", async () => {
    // A 2.8.1 tab with the 2.9 dataset still active: no 2.9 recipe is offered for it.
    useFactoryStore.setState((state) => ({ project: { ...state.project, gameVersion: "2.8.1" } }));
    render(<RecipeBrowser onLoadDatasetVersion={() => {}} />);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(queryRecipeDatasetRecipes).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("Add recipe node")).toBeNull();
  });

  it("says a plan's version has no recipes on this site, instead of loading", async () => {
    useFactoryStore.setState((state) => ({ project: { ...state.project, gameVersion: "2.10" } }));
    render(<RecipeBrowser onLoadDatasetVersion={() => {}} />);
    expect(await screen.findAllByText("Recipes for GTNH 2.10 are not on this site.")).not.toHaveLength(0);
    expect(queryRecipeDatasetRecipes).not.toHaveBeenCalled();
  });

  it("keeps filled-cell recipe slots renderable when browsing by equivalent fluid", () => {
    const recipe: Recipe = {
      id: "fluid-canner-empty-oxygen-cell",
      name: "Fluid Canner: Oxygen",
      machineType: "Fluid Canner",
      minimumTier: "ULV",
      durationTicks: 16,
      eut: 1,
      inputs: [
        {
          kind: "item",
          id: "gregtech:gt.metaitem.01@32000",
          amount: 1,
          displayName: "Oxygen Cell",
          iconPath: "/items/oxygen-cell.png",
          alternatives: [{ kind: "fluid", id: "oxygen", displayName: "Oxygen" }],
          neiSlot: { x: 34, y: 17 },
        },
      ],
      outputs: [
        { kind: "item", id: "gregtech:gt.metaitem.01@32001", amount: 1, displayName: "Empty Cell" },
        { kind: "fluid", id: "oxygen", amount: 1000, displayName: "Oxygen" },
      ],
      nei: {
        slots: [
          { side: "input", kind: "item", slotIndex: 0, x: 34, y: 17 },
          { side: "output", kind: "item", slotIndex: 0, x: 88, y: 17 },
          { side: "output", kind: "fluid", slotIndex: 0, x: 88, y: 53 },
        ],
      },
    };

    const preview = contextualizePreviewRecipe(recipe, {
      kind: "fluid",
      id: "oxygen",
      displayName: "Oxygen",
      iconPath: "/fluids/oxygen.png",
    });

    expect(preview.inputs[0]).toEqual(
      expect.objectContaining({
        kind: "item",
        id: "gregtech:gt.metaitem.01@32000",
        displayName: "Oxygen Cell",
        iconPath: "/items/oxygen-cell.png",
      }),
    );
  });
});
