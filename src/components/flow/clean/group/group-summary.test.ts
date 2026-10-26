import { describe, expect, it } from "vitest";
import { PHENOL_STEPS, phenolPlan } from "@/lib/model/__fixtures__/phenol-281";
import { calculateThroughput } from "@/lib/solver/throughput";
import { mockUnneeded } from "@/lib/solver/plan/__fixtures__/mock-extras";
import { computeGroupSummaries } from "./group-summary";

describe("a group summary's machines", () => {
  const withPocket = () => {
    const project = structuredClone(mockUnneeded.project);
    project.pockets = [{ id: "g", name: "G" }] as typeof project.pockets;
    project.nodes.find((n) => n.id === "comp")!.pocketId = "g";
    return project;
  };

  it("counts what an Up to card runs, rounded up", () => {
    const plan = {
      ...mockUnneeded.result.plan!,
      upTo: { comp: { capacity: 6, reached: 4.5, reason: null } },
    };
    const sum = computeGroupSummaries(withPocket(), { ...mockUnneeded.result, plan }, ["g"], true);
    expect(sum.get("g")!.machines).toBe(5);
  });

  it("counts an Exactly card at its set count", () => {
    const project = withPocket();
    project.nodes.find((n) => n.id === "comp")!.solvePinExact = true;
    const plan = {
      ...mockUnneeded.result.plan!,
      upTo: { comp: { capacity: 6, reached: 4.5, reason: null } },
    };
    const sum = computeGroupSummaries(project, { ...mockUnneeded.result, plan }, ["g"], true);
    expect(sum.get("g")!.machines).toBe(6);
  });
});

describe("a group summary's lists", () => {
  it("keeps one order while Phenol is raised a step at a time: biggest first, equal rates A to Z", () => {
    const orders = new Set<string>();
    for (const perSecond of PHENOL_STEPS) {
      const project = phenolPlan(perSecond);
      project.pockets = [{ id: "g", name: "G" }] as typeof project.pockets;
      for (const node of project.nodes) node.pocketId = "g";
      const result = calculateThroughput(project, { generatedAt: "fixed" });
      const summary = computeGroupSummaries(project, result, ["g"], true).get("g")!;
      orders.add(
        JSON.stringify({
          inputs: summary.inputs.map((f) => f.resource.displayName),
          outputs: summary.outputs.map((f) => f.resource.displayName),
        }),
      );
    }
    expect([...orders].map((o) => JSON.parse(o))).toEqual([
      {
        inputs: ["Chlorine", "Benzene", "Ethylene", "Oxygen"],
        outputs: ["Diluted Hydrochloric Acid", "Phenol", "Vinyl Chloride"],
      },
    ]);
  });
});
