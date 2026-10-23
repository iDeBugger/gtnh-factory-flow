// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatasetManifest, DatasetVersion, RecipeDataset } from "@/lib/datasets/types";
import { PROJECT_SCHEMA_VERSION, type Recipe } from "@/lib/model/types";
import { useFactoryStore } from "@/store/factory-store";
import { queryRecipeDatasetRecipes } from "@/lib/datasets/browser-loader";
import { closeWelcomeTab } from "@/lib/welcome/welcome-tab";
import { RecipeBrowser } from "./RecipeBrowser";

/**
 * The search pinned to a card's machine ("Add another recipe"): it starts with an empty stencil and asks nothing
 * until an item is on Takes or Makes, the answers are that machine's alone, and the pick joins the card.
 */

const datasetVersion: DatasetVersion = {
  id: "pin-version",
  gtnhVersion: "2.9.0",
  channel: "daily",
  publishedAt: "2026-05-25T00:00:00.000Z",
  manifestPath: "manifest.json",
  recipeDatasetPath: "recipes.json",
  sourceInfo: { sourceId: "recex", generatedAt: "2026-05-25T00:00:00.000Z" },
};

const MAP = "Large Chemical Reactor";
const HANDLERS = [{ id: "lcr", label: "Large Chemical Reactor", machineType: MAP, minimumTier: "LV" as const }];

const reaction = (id: string, input: string, output: string): Recipe => ({
  id,
  name: `${MAP}: ${output}`,
  machineType: MAP,
  minimumTier: "LV",
  durationTicks: 20,
  eut: 30,
  inputs: [{ kind: "fluid", id: input, amount: 1000, displayName: input }],
  outputs: [{ kind: "fluid", id: output, amount: 1000, displayName: output }],
  machineHandlers: HANDLERS,
});

const loader = vi.hoisted(() => ({
  second: undefined as unknown,
}));

vi.mock("@/lib/datasets/browser-loader", () => ({
  getRecipeDatasetRecipe: vi.fn(async () => loader.second),
  queryRecipeDatasetRecipes: vi.fn(async () => {
    const recipe = loader.second as Recipe;
    return {
      recipes: [{ ...recipe, recipeMap: "Large Chemical Reactor", slots: [] }],
      total: 1,
      recipeMaps: ["Large Chemical Reactor"],
      offset: 0,
      limit: 120,
      hasMore: false,
    };
  }),
  queryRecipeDatasetResources: vi.fn(async () => ({
    resources: [],
    total: 0,
    offset: 0,
    limit: 6,
    hasMore: false,
  })),
}));

describe("RecipeBrowser pinned to a machine", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    loader.second = reaction("sulfuric", "sulfur_trioxide", "sulfuric_acid");
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    const manifest: DatasetManifest = {
      schemaVersion: 1,
      latestDailyVersion: datasetVersion.id,
      versions: [datasetVersion],
    };
    useFactoryStore.getState().setProject({
      schemaVersion: PROJECT_SCHEMA_VERSION,
      id: "pin-test",
      name: "Pin test",
      fuelProfiles: [],
      recipes: [reaction("electrolysis", "water", "hydrogen")],
      nodes: [
        {
          id: "lcr-card",
          recipeId: "electrolysis",
          machineCount: 1,
          parallel: 1,
          overclockTier: "LV",
          enabled: true,
          position: { x: 0, y: 0 },
        },
      ],
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
    // A pick made while Welcome covers the board goes to a new tab; this one is about the open plan.
    closeWelcomeTab();
    useFactoryStore.getState().browseMachineRecipes("lcr-card");
  });
  afterEach(() => {
    useFactoryStore.getState().clearResourceBrowser();
    cleanup();
  });

  it("starts empty and asks for an item on Takes or Makes, without asking the server", async () => {
    render(<RecipeBrowser onLoadDatasetVersion={() => {}} />);

    expect(
      await screen.findByText(
        "Add an item to Takes or Makes. Only recipes the Large Chemical Reactor runs will show.",
      ),
    ).toBeTruthy();
    // The pin on the stencil, beside the two empty sides.
    const pin = document.querySelector("[data-machine-pin]");
    expect(pin?.textContent).toContain("Large Chemical Reactor");
    expect(pin?.textContent).toContain("Pinned");
    expect(screen.getByText("Takes")).toBeTruthy();
    expect(screen.getByText("Makes")).toBeTruthy();
    expect(screen.queryByLabelText(/^Remove .* from the search$/)).toBeNull();
    // The machine is the window's one tab and its title.
    expect(screen.getAllByRole("tab").map((tab) => tab.getAttribute("aria-label"))).toEqual([MAP]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(queryRecipeDatasetRecipes).not.toHaveBeenCalled();
  });

  it("answers with the machine's recipes once an item is on a side, and the pick joins the card", async () => {
    render(<RecipeBrowser onLoadDatasetVersion={() => {}} />);
    await screen.findByText(/^Add an item to Takes or Makes\./);

    // An item browsed inside the open search keeps the pin: its stencil holds that item.
    act(() => {
      useFactoryStore
        .getState()
        .browseResource({ kind: "fluid", id: "sulfuric_acid", displayName: "Sulfuric Acid" }, "recipes");
    });
    expect(useFactoryStore.getState().recipeBrowserMachinePin?.nodeId).toBe("lcr-card");

    await waitFor(() => {
      expect(queryRecipeDatasetRecipes).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Object),
        expect.objectContaining({
          clauses: [{ role: "makes", kind: "fluid", id: "sulfuric_acid" }],
          mapSelection: { mode: "include", maps: [MAP] },
        }),
        expect.anything(),
      );
    });

    fireEvent.click(await screen.findByLabelText("Add recipe node"));

    await waitFor(() => {
      const card = useFactoryStore.getState().project.nodes;
      expect(card).toHaveLength(1);
      expect(card[0]?.extraRecipes?.map((section) => section.recipeId)).toEqual(["sulfuric"]);
    });
    expect(useFactoryStore.getState().recipeBrowserMachinePin).toBeUndefined();
  });

  it("starts a reopened search over, even on the same item", async () => {
    act(() => useFactoryStore.getState().clearResourceBrowser());
    const acid = { kind: "fluid" as const, id: "sulfuric_acid", displayName: "Sulfuric Acid" };
    act(() => useFactoryStore.getState().browseResource(acid, "recipes"));
    render(<RecipeBrowser onLoadDatasetVersion={() => {}} />);

    fireEvent.click(await screen.findByLabelText("Remove Sulfuric Acid from the search"));
    expect(await screen.findByText("Add an item to either side of the card below.")).toBeTruthy();

    act(() => useFactoryStore.getState().clearResourceBrowser());
    await waitFor(() => expect(document.querySelector('section[aria-label="Recipe search"]')).toBeNull());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    act(() => useFactoryStore.getState().browseResource(acid, "recipes"));
    expect(await screen.findByLabelText("Remove Sulfuric Acid from the search")).toBeTruthy();
  });

  it("unpins from the stencil and keeps what is on it", async () => {
    render(<RecipeBrowser onLoadDatasetVersion={() => {}} />);
    await screen.findByText(/^Add an item to Takes or Makes\./);

    fireEvent.click(screen.getByLabelText("Unpin the Large Chemical Reactor"));

    expect(useFactoryStore.getState().recipeBrowserMachinePin).toBeUndefined();
    expect(await screen.findByText("Add an item to either side of the card below.")).toBeTruthy();
    expect(document.querySelector("[data-machine-pin]")).toBeNull();
  });

  it("keeps the stencil's items through an unpin", async () => {
    render(<RecipeBrowser onLoadDatasetVersion={() => {}} />);
    await screen.findByText(/^Add an item to Takes or Makes\./);
    act(() => {
      useFactoryStore
        .getState()
        .browseResource({ kind: "fluid", id: "sulfuric_acid", displayName: "Sulfuric Acid" }, "uses");
    });
    await screen.findByLabelText("Remove Sulfuric Acid from the search");
    // Moved to Makes by hand, so the stencil is an edit of the browse rather than its seed.
    fireEvent.click(screen.getByLabelText("Swap the takes and makes sides"));

    fireEvent.click(screen.getByLabelText("Unpin the Large Chemical Reactor"));

    expect(useFactoryStore.getState().recipeBrowserMachinePin).toBeUndefined();
    expect(screen.getByLabelText("Remove Sulfuric Acid from the search")).toBeTruthy();
    // Still on Makes: the edit survived.
    const makes = screen.getByText("Makes").closest(".nrw-stencil-side");
    expect(makes?.textContent).toContain("Sulfuric Acid");
  });
});
