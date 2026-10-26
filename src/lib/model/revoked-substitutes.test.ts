import { describe, expect, it } from "vitest";
import { findRevokedSubstitutes, revokedSubstituteTwin } from "./revoked-substitutes";
import type { FactoryProject, Recipe } from "./types";
import type { RecipeSummary } from "@/lib/datasets/types";

const water = { kind: "fluid", id: "water", displayName: "Water" } as const;
const distilled = { kind: "fluid", id: "ic2distilledwater", displayName: "Distilled Water" } as const;
const leaked = [{ ...water, amount: 1 }, { ...distilled, amount: 1 }];

function cutter(id: string, offered: boolean): Recipe {
  return {
    id,
    name: "Cutting Machine: Oak Planks",
    machineType: "Cutting Machine",
    minimumTier: "LV",
    durationTicks: 20,
    eut: 8,
    inputs: [
      { kind: "item", id: "log", amount: 1 },
      { ...water, amount: 4, ...(offered ? { alternatives: leaked } : {}) },
    ],
    outputs: [{ kind: "item", id: `${id}-planks`, amount: 6 }],
    source: { recipeMap: "Cutting Machine" },
  } as Recipe;
}

const pick = { "1": { ...distilled, amount: 4 } };

function plan(recipes: Recipe[], nodes: FactoryProject["nodes"]): FactoryProject {
  return { schemaVersion: 1, id: "p", name: "p", recipes, nodes, edges: [], fuelProfiles: [] } as unknown as FactoryProject;
}

const card = (id: string, recipeId: string, extra: Partial<FactoryProject["nodes"][number]> = {}) =>
  ({ id, recipeId, machineCount: 1, parallel: 1, position: { x: 0, y: 0 }, ...extra }) as FactoryProject["nodes"][number];

describe("revoked substitutes", () => {
  it("finds a pick the stored body offered and the fresh one does not", () => {
    const before = plan([cutter("c", true)], [card("n", "c", { recipeInputOverrides: pick })]);
    const after = plan([cutter("c", false)], before.nodes);

    expect(findRevokedSubstitutes(before, after)).toEqual([
      expect.objectContaining({ nodeId: "n", section: 0, recipeId: "c", slot: 1, pick: expect.objectContaining({ id: "ic2distilledwater" }) }),
    ]);
  });

  it("keeps a pick the fresh body still offers, and the slot's own resource", () => {
    const before = plan(
      [cutter("c", true)],
      [card("n", "c", { recipeInputOverrides: pick }), card("own", "c", { recipeInputOverrides: { "1": { ...water, amount: 4 } } })],
    );

    expect(findRevokedSubstitutes(before, plan([cutter("c", true)], before.nodes))).toEqual([]);
    expect(findRevokedSubstitutes(before, plan([cutter("c", false)], before.nodes)).map((entry) => entry.nodeId)).toEqual(["n"]);
  });

  it("reads a shared machine's extra section against its own stored recipe", () => {
    const sections = { extraRecipes: [{ recipeId: "c2", recipeInputOverrides: pick }] };
    const before = plan([cutter("c1", false), cutter("c2", true)], [card("n", "c1", sections)]);
    const after = plan([cutter("c1", false), cutter("c2", false)], before.nodes);

    expect(findRevokedSubstitutes(before, after).map((entry) => [entry.section, entry.recipeId])).toEqual([[1, "c2"]]);
  });

  it("follows a migrated id, and two stored recipes migrating to one id each keep their own card", () => {
    // Two stored ids from older builds, one offering the leak and one not, both re-keyed to "fresh".
    const before = plan(
      [cutter("old-a", true), cutter("old-b", false)],
      [card("a", "old-a", { recipeInputOverrides: pick }), card("b", "old-b", { recipeInputOverrides: pick })],
    );
    const after = plan(
      [cutter("fresh", false)],
      before.nodes.map((node) => ({ ...node, recipeId: "fresh" })),
    );

    expect(findRevokedSubstitutes(before, after).map((entry) => [entry.nodeId, entry.recipeId])).toEqual([["a", "fresh"]]);
  });

  it("leaves a slot whose resource changed between the two bodies", () => {
    const before = plan([cutter("c", true)], [card("n", "c", { recipeInputOverrides: pick })]);
    const changed = cutter("c", false);
    changed.inputs[1] = { kind: "fluid", id: "lubricant", amount: 1 };

    expect(findRevokedSubstitutes(before, plan([changed], before.nodes))).toEqual([]);
  });
});

describe("a revoked pick's twin", () => {
  const summary = (id: string, recipeMap: string, slot: string) =>
    ({ id, recipeMap, inputs: [{ kind: "item", id: "log", amount: 1 }, { kind: "fluid", id: slot, amount: 3 }] }) as unknown as RecipeSummary;
  const revoked = { slot: 1, pick: { ...distilled, amount: 4 } };

  it("is the one recipe on the card's map whose own slot is the pick", () => {
    const twins = [summary("dw", "Cutting Machine", "ic2distilledwater"), summary("other", "Industrial Cutting Factory", "ic2distilledwater")];

    expect(revokedSubstituteTwin(cutter("c", false), revoked, twins)?.id).toBe("dw");
  });

  it("is none when the map has none or more than one", () => {
    expect(revokedSubstituteTwin(cutter("c", false), revoked, [summary("x", "Cutting Machine", "water")])).toBeUndefined();
    expect(
      revokedSubstituteTwin(cutter("c", false), revoked, [
        summary("a", "Cutting Machine", "ic2distilledwater"),
        summary("b", "Cutting Machine", "ic2distilledwater"),
      ]),
    ).toBeUndefined();
  });
});
