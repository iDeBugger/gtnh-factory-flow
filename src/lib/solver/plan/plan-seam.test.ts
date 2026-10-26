import { describe, expect, it } from "vitest";
import { calculateThroughput } from "../throughput";
import { mockForced, mockLeftovers, mockPlans, mockUnneeded } from "./__fixtures__/mock-extras";
import { parsePortKey } from "./port-key";

describe("calculateThroughput", () => {
  it("answers with the plan solver's extras", () => {
    const result = calculateThroughput(mockForced.project, { generatedAt: "t" });
    expect(result.plan).toBeDefined();
    expect(result.nodes["mac"]!.theoreticalMachinesRequired).toBeCloseTo(3, 9);
  });
});

describe("mock plan results", () => {
  it("are shaped like the adapter's output", () => {
    for (const mock of mockPlans) {
      const { project, result } = mock;
      expect(project.planMode).toBe(true);
      expect(project.solveMode).toBe(true);
      expect(result.plan).toBeDefined();
      for (const node of project.nodes) {
        expect(result.nodes[node.id], node.id).toBeDefined();
      }
      for (const edge of project.edges) {
        expect(result.edges[edge.id], edge.id).toBeDefined();
      }
      for (const storage of project.storages ?? []) {
        expect(result.storages[storage.id], storage.id).toBeDefined();
      }
    }
  });

  it("name real nodes and ports", () => {
    for (const mock of mockPlans) {
      const nodeIds = new Set(mock.project.nodes.map((n) => n.id));
      const extras = mock.result.plan!;
      for (const forced of extras.forced) {
        expect(nodeIds.has(forced.nodeId)).toBe(true);
        expect(parsePortKey(forced.portKey)?.nodeId).toBe(forced.nodeId);
        expect(forced.perSecond).toBeGreaterThan(0);
      }
      for (const leftover of extras.leftovers) {
        const share = leftover.bearers.reduce((a, b) => a + b.share, 0);
        expect(share).toBeCloseTo(1, 9);
        expect(leftover.bearers.filter((b) => b.solverPick)).toHaveLength(1);
      }
    }
  });

  it("cover forced rows, leftovers and spares, unneeded and unanchored", () => {
    expect(mockForced.result.plan!.forced.map((f) => f.side).sort()).toEqual(["in", "out"]);
    expect(mockLeftovers.result.plan!.leftovers).toHaveLength(2);
    expect(mockLeftovers.result.plan!.leftovers.some((l) => l.custom)).toBe(true);
    expect(mockLeftovers.project.spareShares).toBeDefined();
    expect(mockUnneeded.result.plan!.unneeded).toEqual(["cutter"]);
    expect(mockUnneeded.result.plan!.unanchored.length).toBeGreaterThan(0);
  });

  it("a forced row is the gap at its wire's port", () => {
    const { result, project } = mockForced;
    // The macerator makes 6 dust a second, 3 go down the wire, 3 are forced out.
    const made = result.nodes["mac"]!.outputs["item:Crushed Iron"]!.amountPerSecond;
    const wire = project.edges.find((e) => e.id === "w-dust")!;
    const sent = result.edges[wire.id]!.transferredPerSecond;
    const forced = result.plan!.forced.find((f) => f.nodeId === "mac")!;
    expect(made - sent).toBeCloseTo(forced.perSecond, 9);
  });
});
