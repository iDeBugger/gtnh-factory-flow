import { describe, expect, it } from "vitest";
import type {
  EdgeThroughput,
  FactoryProject,
  NodeThroughputResult,
  ResourceFlow,
  ThroughputResult,
} from "@/lib/model/types";
import { calculateThroughput } from "@/lib/solver/throughput";
import * as planKit from "@/lib/solver/plan/adapter/test-kit";
import { buildRailPorts, deriveNodeVerdict } from "./node-verdict";

// Unit tests for the verdict/rail derivation: solver numbers in, one honest
// state + cause + action out. Solver behaviour itself is covered elsewhere.

function flow(kind: "item" | "fluid", resourceId: string, amountPerSecond: number): ResourceFlow {
  return {
    key: `${kind}:${resourceId}`,
    kind,
    resourceId,
    displayName: resourceId,
    amountPerSecond,
  } as ResourceFlow;
}

function nodeResult(partial: Partial<NodeThroughputResult>): NodeThroughputResult {
  return {
    nodeId: "N",
    recipeId: "r",
    recipeName: "r",
    inputs: {},
    outputs: {},
    euT: 0,
    requiredRatePerSecond: 0,
    maxRatePerSecond: 1,
    utilization: 1,
    theoreticalMachinesRequired: 1,
    status: "balanced",
    warnings: [],
    ...partial,
  } as NodeThroughputResult;
}

function edgeResult(partial: Partial<EdgeThroughput>): EdgeThroughput {
  return {
    transferredPerSecond: 0,
    demandPerSecond: 0,
    isLimited: false,
    constraint: "full",
    ...partial,
  } as EdgeThroughput;
}

function project(partial: Partial<FactoryProject>): FactoryProject {
  return {
    schemaVersion: 1,
    id: "verdict-test",
    name: "verdict-test",
    fuelProfiles: [],
    storages: [],
    recipes: [],
    nodes: [],
    edges: [],
    ...partial,
  } as unknown as FactoryProject;
}

const machineNode = (id: string, recipeId = "r", extra: Record<string, unknown> = {}) => ({
  id,
  recipeId,
  machineCount: 1,
  parallel: 1,
  overclockTier: "ULV",
  enabled: true,
  position: { x: 0, y: 0 },
  ...extra,
});

const edge = (id: string, source: string, target: string, resourceId = "res") => ({
  id,
  source,
  target,
  resourceKind: "item" as const,
  resourceId,
});

function throughput(
  nodes: Record<string, NodeThroughputResult>,
  edges: Record<string, EdgeThroughput>,
): ThroughputResult {
  return { nodes, edges, storages: {}, resources: {} } as unknown as ThroughputResult;
}

describe("deriveNodeVerdict", () => {
  it("reads balanced, unwired, and off", () => {
    const proj = project({
      recipes: [
        // A slot on the recipe: a card with wireable ports and no wires is
        // what "unwired" means. Slotless machines get their own case below.
        {
          id: "r",
          name: "M",
          machineType: "M",
          minimumTier: "ULV",
          durationTicks: 20,
          eut: 1,
          inputs: [],
          outputs: [{ kind: "item", id: "pe", amount: 1 }],
        },
        // A solar panel's shape: nothing in, nothing out, only power. There
        // is no wire it could take, so it must never read unwired.
        { id: "rSolar", name: "Panel", machineType: "Panel", minimumTier: "ULV", durationTicks: 20, eut: 0, inputs: [], outputs: [] },
      ] as unknown as FactoryProject["recipes"],
      nodes: [
        machineNode("N"),
        machineNode("Lonely"),
        machineNode("Dead", "r", { enabled: false }),
        machineNode("C"),
        machineNode("Panel", "rSolar"),
      ],
      edges: [edge("eOut", "N", "C", "pe")],
    });
    const result = throughput(
      {
        N: nodeResult({ utilization: 1 }),
        Lonely: nodeResult({ nodeId: "Lonely", utilization: 1 }),
        Dead: nodeResult({ nodeId: "Dead", utilization: 0 }),
        Panel: nodeResult({ nodeId: "Panel", utilization: 1 }),
      },
      { eOut: edgeResult({ transferredPerSecond: 10, demandPerSecond: 10 }) },
    );

    expect(deriveNodeVerdict(proj, result, "N").kind).toBe("balanced");
    expect(deriveNodeVerdict(proj, result, "Lonely").kind).toBe("unwired");
    expect(deriveNodeVerdict(proj, result, "Dead").kind).toBe("off");
    expect(deriveNodeVerdict(proj, result, "Panel").kind).toBe("balanced");
  });
});

describe("buildRailPorts", () => {
  const recipeResources = {
    inputs: [
      { kind: "item", id: "eth", amount: 1 },
      { kind: "item", id: "mold", amount: 1, consumed: false },
    ],
    outputs: [{ kind: "item", id: "pe", amount: 1 }],
  } as unknown as Pick<import("@/lib/model/types").Recipe, "inputs" | "outputs">;

  it("skips non-consumed inputs, pools flows, and flags unsupplied ports", () => {
    const proj = project({
      nodes: [machineNode("N"), machineNode("C")],
      edges: [edge("eOut", "N", "C", "pe")],
    });
    const result = throughput(
      {
        N: nodeResult({
          utilization: 0.5,
          demandUtilization: 0.5,
          capableUtilization: 1,
          inputs: { "item:eth": flow("item", "eth", 144), "item:mold": flow("item", "mold", 1) },
          outputs: { "item:pe": flow("item", "pe", 216) },
        }),
      },
      { eOut: edgeResult({ transferredPerSecond: 108, demandPerSecond: 108 }) },
    );
    const verdict = deriveNodeVerdict(proj, result, "N");
    const rails = buildRailPorts(proj, result, "N", recipeResources, verdict);

    expect(rails.inputs.map((port) => port.resourceId)).toEqual(["eth"]);
    expect(rails.inputs[0]!.unsupplied).toBe(true);
    expect(rails.inputs[0]!.handleId).toBe("input:item:eth");
    expect(rails.outputs[0]!.currentPerSecond).toBeCloseTo(108, 6);
    // The card reads UNWIRED (the eth input has no line), not demand-set, so
    // its connected output carries no verdict tone of its own. `calm` belongs
    // to a card that is deliberately throttled, which this one is not.
    expect(rails.outputs[0]!.tone).toBe("ok");
  });

});
