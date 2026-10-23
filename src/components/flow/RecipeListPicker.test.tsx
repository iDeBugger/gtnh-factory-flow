// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatasetManifest, RecipeSummary } from "@/lib/datasets/types";
import type { Recipe } from "@/lib/model/types";
import { useFactoryStore } from "@/store/factory-store";
import { RecipeListPicker } from "./RecipeListPicker";

const loader = vi.hoisted(() => ({ getRecipeDatasetRecipe: vi.fn() }));
vi.mock("@/lib/datasets/browser-loader", async (original) => ({
  ...(await original<typeof import("@/lib/datasets/browser-loader")>()),
  getRecipeDatasetRecipe: loader.getRecipeDatasetRecipe,
}));

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

function datasetVersion(id: string, gtnhVersion: string) {
  return {
    id,
    gtnhVersion,
    channel: "stable" as const,
    publishedAt: "2026-10-20T00:00:00.000Z",
    manifestPath: "/datasets/gtnh/datasets.manifest.json",
    recipeDatasetPath: `/datasets/gtnh/${id}/recipes.json.gz`,
    sourceInfo: { sourceId: "recex" as const, generatedAt: "2026-10-20T00:00:00.000Z" },
  };
}
const manifest: DatasetManifest = {
  schemaVersion: 1,
  latestStableVersion: "local-2.9.0-rc-2",
  versions: [datasetVersion("local-2.9.0-rc-2", "2.9.0-RC-2"), datasetVersion("local-2.8.1", "2.8.1")],
};
const wheat: RecipeSummary = {
  id: "crop-wheat",
  name: "Crop Farm: Wheat",
  inputs: [],
  outputs: [{ kind: "item", id: "wheat", amount: 1, displayName: "Wheat" }],
} as unknown as RecipeSummary;

let cacheKey = 0;
function renderPicker(onPick = vi.fn()) {
  const load = vi.fn(async () => [wheat]);
  render(
    <div>
      <RecipeListPicker
        cacheKey={`crops-${++cacheKey}`}
        load={load}
        noun="crops"
        toggleSelector="[data-none]"
        onPick={onPick}
        onClose={() => undefined}
        tileResource={(crop) => crop.outputs[0]}
        hover={() => null}
      />
    </div>,
  );
  return { load, onPick };
}

beforeEach(() => {
  loader.getRecipeDatasetRecipe.mockReset();
  useFactoryStore.setState({
    datasetManifest: manifest,
    selectedDatasetVersionId: "local-2.9.0-rc-2",
    project: { ...useFactoryStore.getState().project, gameVersion: undefined },
  });
});
afterEach(() => cleanup());

describe("a card's crop and mob list across versions", () => {
  it("lists nothing and reads as loading while the plan's own version loads", async () => {
    useFactoryStore.setState({ project: { ...useFactoryStore.getState().project, gameVersion: "2.8.1" } });
    const { load } = renderPicker();
    await act(async () => undefined);
    expect(load).not.toHaveBeenCalled();
    expect(screen.getByText("Loading crops...")).toBeTruthy();
  });

  it("says so on a plan for a version this site has none for", async () => {
    useFactoryStore.setState({ project: { ...useFactoryStore.getState().project, gameVersion: "2.10" } });
    renderPicker();
    await act(async () => undefined);
    expect(screen.getByText("Recipes for GTNH 2.10 are not on this site.")).toBeTruthy();
  });

  it("a pick whose body arrives after a switch to another version's tab is refused, with the recipe book's line", async () => {
    let release: (recipe: Recipe) => void = () => undefined;
    loader.getRecipeDatasetRecipe.mockImplementation(() => new Promise<Recipe>((resolve) => (release = resolve)));
    const { onPick } = renderPicker();
    await act(async () => undefined);
    fireEvent.click(screen.getByText("Wheat"));
    act(() => {
      useFactoryStore.setState({
        selectedDatasetVersionId: "local-2.8.1",
        project: { ...useFactoryStore.getState().project, gameVersion: "2.8.1" },
      });
    });
    await act(async () => {
      release({ id: "crop-wheat", source: { datasetVersionId: "local-2.9.0-rc-2" } } as unknown as Recipe);
    });
    expect(onPick).not.toHaveBeenCalled();
    expect(screen.getByText("This recipe is from another GTNH version.")).toBeTruthy();
  });
});
