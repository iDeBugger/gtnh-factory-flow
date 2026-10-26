import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { normalizeLoadedProject } from "@/lib/model/project-normalize";
import { makeResourceKey } from "@/lib/model/resources";
import { listNodeSections, sectionNodeId } from "@/lib/model/shared-machine";
import type { FactoryProject } from "@/lib/model/types";
import { calculateThroughput } from "@/lib/solver";
import { buildRailModel } from "./clean/rail/rail-model";
import { buildRailPorts, deriveNodeVerdict } from "./node-verdict";

/**
 * An Up to card below its count: a silicon line whose blast furnace makes 720 ingots an hour, so the vacuum freezer
 * after it (Up to 1) runs 0.73 of its machine and both chemical reactors 0.75 of theirs. A card's flows are already
 * the solved ones, so its port rows, the overview and the wires all read them as they are: how full the card is of
 * its count must never scale them a second time.
 */
const project = normalizeLoadedProject(
  JSON.parse(
    readFileSync(new URL("./__fixtures__/up-to-silicon-line.json", import.meta.url), "utf8"),
  ) as FactoryProject,
);
const result = calculateThroughput(project);
const freezer = "node-e06ad164-9e85-4633-86de-0d54aa6ea512";
const hotIngot = makeResourceKey("item", "gregtech:gt.metaitem.01@12856");
const ingot = makeResourceKey("item", "gregtech:gt.metaitem.01@11856");
const perHour = (perSecond: number) => perSecond * 3600;

function rails(nodeId: string) {
  const node = project.nodes.find((entry) => entry.id === nodeId)!;
  const recipe = project.recipes.find((entry) => entry.id === node.recipeId)!;
  return buildRailPorts(project, result, nodeId, recipe, deriveNodeVerdict(project, result, nodeId));
}

describe("an Up to card below its count reads its solved rates once", () => {
  it("the freezer is starved to 0.73 of its one machine", () => {
    expect(result.plan?.upTo?.[freezer]).toMatchObject({ capacity: 1, reason: "STARVED" });
    expect(result.plan!.upTo![freezer]!.reached).toBeCloseTo(0.73, 9);
  });

  it("the freezer's rows show what its wires carry: 720 ingots an hour in and out", () => {
    const { inputs, outputs } = rails(freezer);
    expect(perHour(inputs.find((port) => port.key === hotIngot)!.currentPerSecond)).toBeCloseTo(720, 6);
    expect(perHour(outputs.find((port) => port.key === ingot)!.currentPerSecond)).toBeCloseTo(720, 6);
  });

  it("every card's wired output row equals the flow on its wires", () => {
    for (const node of project.nodes) {
      for (const port of rails(node.id).outputs) {
        const wired = project.edges.filter(
          (edge) => edge.source === node.id && makeResourceKey(edge.resourceKind, edge.resourceId) === port.key,
        );
        if (wired.length === 0) continue;
        const carried = wired.reduce((sum, edge) => sum + result.edges[edge.id]!.transferredPerSecond, 0);
        expect(port.currentPerSecond, `${node.id} ${port.key}`).toBeCloseTo(carried, 9);
      }
    }
  });

  it("the overview lists the plan's 720 ingots an hour", () => {
    const line = buildRailModel(project, result).outputs.find((entry) => entry.key === ingot);
    expect(perHour(line!.amount)).toBeCloseTo(720, 6);
  });
});

describe("a shared card below its Up to count reads every recipe's rates once", () => {
  it("its first recipe's rows show what it makes, as the others' do", () => {
    // The card's read-out is filed under its first recipe: that recipe must not read the card's level a second time.
    const shared = normalizeLoadedProject(
      JSON.parse(
        readFileSync(new URL("./__fixtures__/alumina-line-shared-reactor.json", import.meta.url), "utf8"),
      ) as FactoryProject,
    );
    const card = shared.nodes.find((node) => node.id === "node-5f49041d-0bc1-4ef6-8cea-ad435b3d2add")!;
    card.solvePin = 20;
    const solved = calculateThroughput(shared);
    expect(solved.plan!.upTo![card.id]!.reached).toBeLessThan(1);
    const sections = listNodeSections(card);
    expect(sections.length).toBeGreaterThan(1);
    for (const { section, node: view } of sections) {
      const id = section === 0 ? card.id : sectionNodeId(card.id, section);
      const recipe = shared.recipes.find((entry) => entry.id === view.recipeId)!;
      const { outputs } = buildRailPorts(
        shared,
        solved,
        id,
        recipe,
        deriveNodeVerdict(shared, solved, id),
        section === 0 ? undefined : { handleSection: section },
      );
      expect(outputs.length).toBeGreaterThan(0);
      for (const port of outputs) {
        const made = Object.values(solved.nodes[id]!.outputs).find((flow) => flow.key === port.key)!;
        expect(port.currentPerSecond, `${id} ${port.key}`).toBeCloseTo(made.amountPerSecond, 9);
      }
    }
  });
});
