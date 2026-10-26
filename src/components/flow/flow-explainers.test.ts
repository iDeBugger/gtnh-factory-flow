import { describe, expect, it } from "vitest";
import type {
  EdgeThroughput,
  FactoryProject,
  NodeThroughputResult,
  ResourceFlow,
  ThroughputResult,
} from "@/lib/model/types";
import { buildRailPorts, deriveNodeVerdict } from "./node-verdict";
import { formatSlotRateOrNull } from "./flow-explainers";

// Rate wording and port rows: solver numbers in. Fixtures mirror node-verdict.test.ts.

function flow(
  kind: "item" | "fluid",
  resourceId: string,
  amountPerSecond: number,
): ResourceFlow {
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
    id: "explainer-test",
    name: "explainer-test",
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

const edge = (
  id: string,
  source: string,
  target: string,
  resourceId = "res",
  resourceKind: "item" | "fluid" = "item",
) => ({ id, source, target, resourceKind, resourceId });

function throughput(
  nodes: Record<string, NodeThroughputResult>,
  edges: Record<string, EdgeThroughput>,
): ThroughputResult {
  return { nodes, edges, storages: {}, resources: {} } as unknown as ThroughputResult;
}

const towerRecipes = [
  { id: "r", name: "Oil", machineType: "Distillation Tower", minimumTier: "HV", durationTicks: 20, eut: 1, inputs: [], outputs: [] },
  { id: "lcr", name: "Desulf", machineType: "LCR", minimumTier: "HV", durationTicks: 20, eut: 1, inputs: [], outputs: [] },
] as unknown as FactoryProject["recipes"];

/** The real sulfuric-gas board: tower flat out at 5.143, LCR needs 32. */
function sulfuricFixture() {
  const proj = project({
    recipes: towerRecipes,
    nodes: [machineNode("Tower"), machineNode("LCR", "lcr")],
    edges: [edge("eGas", "Tower", "LCR", "sulfuricgas", "fluid")],
  });
  const result = throughput(
    {
      Tower: nodeResult({
        nodeId: "Tower",
        utilization: 1,
        capableUtilization: 1,
        demandUtilization: 1,
        outputs: { "fluid:sulfuricgas": flow("fluid", "sulfuricgas", 5.143) },
      }),
      LCR: nodeResult({
        nodeId: "LCR",
        utilization: 0.16,
        capableUtilization: 0.16,
        demandUtilization: 1,
        inputs: { "fluid:sulfuricgas": flow("fluid", "sulfuricgas", 32) },
      }),
    },
    {
      eGas: edgeResult({
        transferredPerSecond: 5.143,
        demandPerSecond: 5.143,
        nameplateDemandPerSecond: 32,
        availablePerSecond: 5.143,
        constraint: "supply",
      }),
    },
  );
  return { proj, result };
}

describe("format helpers", () => {
  it("suppresses numbers below the display noise floor", () => {
    expect(formatSlotRateOrNull(0.0002, "fluid")).toBeNull();
    expect(formatSlotRateOrNull(0, "item")).toBeNull();
    expect(formatSlotRateOrNull(0.5, "item")).toBe("0.5/s");
  });
});

describe("buildRailPorts — a card the plan runs at almost nothing", () => {
  it("keeps the row of a wired port (its wire is drawn to it), and drops an unwired one", () => {
    const { proj } = sulfuricFixture();
    // An edit elsewhere left the tower at almost nothing: every flow under the noise floor.
    const result = throughput(
      {
        Tower: nodeResult({
          nodeId: "Tower",
          utilization: 0,
          theoreticalMachinesRequired: 0.0000001,
          outputs: {
            "fluid:sulfuricgas": flow("fluid", "sulfuricgas", 0.0000001),
            "fluid:spare": flow("fluid", "spare", 0.0000001),
          },
        }),
        LCR: nodeResult({ nodeId: "LCR" }),
      },
      { eGas: edgeResult({}) },
    );
    const verdict = deriveNodeVerdict(proj, result, "Tower");
    const rails = buildRailPorts(
      proj,
      result,
      "Tower",
      {
        inputs: [],
        outputs: [
          { kind: "fluid", id: "sulfuricgas", amount: 1 },
          { kind: "fluid", id: "spare", amount: 1 },
        ],
      } as unknown as Parameters<typeof buildRailPorts>[3],
      verdict,
    );
    expect(rails.outputs.map((port) => port.key)).toEqual(["fluid:sulfuricgas"]);
    expect(rails.outputs[0]!.connected).toBe(true);
  });
});

