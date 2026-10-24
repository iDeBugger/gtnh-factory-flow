// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { ReactFlowProvider, type NodeProps } from "@xyflow/react";
import { PROJECT_SCHEMA_VERSION, type FactoryProject, type UnconvertedRecipe } from "@/lib/model/types";
import { unconvertedCardRecipes } from "@/lib/model/unconverted-card";
import { useFactoryStore } from "@/store/factory-store";
import { RecipeNodeSwitch } from "./clean/CleanRecipeNode";
import type { RecipeFlowNode } from "./RecipeNode";

vi.mock("@/lib/compact-view", () => ({ isCompactViewport: () => false }));

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  // Every card mounted in full: the virtual board is not under test here.
  window.localStorage.setItem("gtnh-factory-flow.no-virtual", "1");
});
afterEach(cleanup);

const marker: UnconvertedRecipe = {
  fromGameVersion: "2.8.1",
  recipeId: "macerate-281",
  recipeName: "Macerate ore",
  machineType: "Macerator",
};

const card = (id: string, recipeId: string, x: number) => ({
  id,
  recipeId,
  machineCount: 1,
  parallel: 1,
  overclockTier: "LV" as const,
  enabled: true,
  position: { x, y: 0 },
});

/** src -> mid (not converted) -> sink, on a 2.9 plan. */
function plan(): FactoryProject {
  return {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    id: "unconverted-plan",
    name: "Unconverted",
    fuelProfiles: [],
    gameVersion: "2.9",
    planMode: true,
    solveMode: true,
    recipes: [
      {
        id: "ore-source",
        name: "Ore",
        machineType: "Miner",
        minimumTier: "LV",
        durationTicks: 20,
        eut: 0,
        inputs: [],
        outputs: [{ kind: "item", id: "ore", amount: 1, displayName: "Iron Ore" }],
      },
      {
        id: "press",
        name: "Press",
        machineType: "Press",
        minimumTier: "LV",
        durationTicks: 40,
        eut: 8,
        inputs: [{ kind: "item", id: "dust", amount: 1, displayName: "Iron Dust" }],
        outputs: [{ kind: "item", id: "plate", amount: 1 }],
      },
    ],
    nodes: [card("src", "ore-source", 0), { ...card("mid", "macerate-281", 440), unconverted: marker }, card("sink", "press", 880)],
    edges: [
      { id: "e-ore", source: "src", target: "mid", resourceKind: "item", resourceId: "ore" },
      { id: "e-dust", source: "mid", target: "sink", resourceKind: "item", resourceId: "dust" },
    ],
    storages: [],
  } as unknown as FactoryProject;
}

function renderCard(project: FactoryProject) {
  const recipe = unconvertedCardRecipes(project).get("mid")!;
  const projectNode = project.nodes.find((node) => node.id === "mid")!;
  const props = {
    id: "mid",
    data: { projectNode, recipe, result: useFactoryStore.getState().lastResult?.nodes["mid"] },
    selected: false,
  } as unknown as NodeProps<RecipeFlowNode>;
  return render(
    <ReactFlowProvider>
      <RecipeNodeSwitch {...props} />
    </ReactFlowProvider>,
  );
}

describe("a card whose recipe was not converted", () => {
  it("is drawn from its marker and its wires, with one stand-in per card and marker", () => {
    const project = plan();
    const recipe = unconvertedCardRecipes(project).get("mid")!;
    expect(recipe).toMatchObject({ id: "macerate-281", name: "Macerate ore", machineType: "Macerator" });
    expect(recipe.inputs.map((slot) => [slot.id, slot.displayName])).toEqual([["ore", "Iron Ore"]]);
    expect(recipe.outputs.map((slot) => [slot.id, slot.displayName])).toEqual([["dust", "Iron Dust"]]);
    // A rebuild with the same wires keeps the identity, and a wire elsewhere keeps the whole map; a new wire is a
    // new port.
    const map = unconvertedCardRecipes(project);
    expect(unconvertedCardRecipes({ ...project, nodes: [...project.nodes] }).get("mid")).toBe(recipe);
    const elsewhere = {
      ...project,
      edges: [...project.edges, { id: "e-x", source: "src", target: "sink", resourceKind: "item" as const, resourceId: "ore" }],
    };
    expect(unconvertedCardRecipes(elsewhere)).toBe(map);
    const rewired = {
      ...project,
      edges: [
        ...project.edges,
        { id: "e-plate", source: "mid", target: "sink", resourceKind: "item" as const, resourceId: "plate" },
      ],
    };
    expect(unconvertedCardRecipes(rewired).get("mid")!.outputs.map((slot) => slot.id)).toEqual(["dust", "plate"]);
    // No marked card: one shared empty map.
    const clean = { ...project, nodes: project.nodes.map((node) => ({ ...node, unconverted: undefined })) };
    expect(unconvertedCardRecipes(clean)).toBe(unconvertedCardRecipes(clean));
    expect(unconvertedCardRecipes(clean).size).toBe(0);
  });

  it("renders its machine name, the line and an amber frame, with ports matching its wires", () => {
    const project = plan();
    useFactoryStore.getState().setProject(project);
    const { container, getByText } = renderCard(project);
    const root = container.querySelector(".cc-card")!;
    expect(root.hasAttribute("data-unconverted")).toBe(true);
    expect(container.querySelector(".cc-name")?.textContent).toBe("Macerator");
    expect(getByText("Not in GTNH 2.9. Pick a recipe.")).toBeTruthy();
    const handles = [...container.querySelectorAll("[data-resource-handle-id]")].map((el) =>
      el.getAttribute("data-resource-handle-id"),
    );
    expect(new Set(handles)).toEqual(new Set(["input:item:ore", "output:item:dust"]));
  });

  it("zoomed out, its shell wears the marker too, with no prompt", () => {
    const project = plan();
    useFactoryStore.getState().setProject(project);
    // The virtual board on: a card nobody has brought near the camera is a shell.
    window.localStorage.removeItem("gtnh-factory-flow.no-virtual");
    try {
      const { container } = renderCard(project);
      const shell = container.querySelector("[data-shell]")!;
      expect(shell).not.toBeNull();
      expect(shell.hasAttribute("data-unconverted")).toBe(true);
      expect(shell.hasAttribute("data-unset")).toBe(false);
    } finally {
      window.localStorage.setItem("gtnh-factory-flow.no-virtual", "1");
    }
  });

  it("a press on the line opens the recipe search seeded from its wires", () => {
    const project = plan();
    useFactoryStore.getState().setProject(project);
    const { getByText } = renderCard(project);
    fireEvent.click(getByText("Not in GTNH 2.9. Pick a recipe."));
    const state = useFactoryStore.getState();
    expect(state.recipeBrowserRefactorNodeId).toBe("mid");
    expect(state.recipeBrowserSeed).toEqual([
      expect.objectContaining({ role: "takes", kind: "item", id: "ore", displayName: "Iron Ore" }),
      expect.objectContaining({ role: "makes", kind: "item", id: "dust", displayName: "Iron Dust" }),
    ]);
  });
});
