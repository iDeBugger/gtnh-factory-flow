import type { FactoryProject, NodeThroughputResult, ResourceKind } from "@/lib/model/types";
import { makeResourceKey } from "@/lib/model";

type ProjectEdge = FactoryProject["edges"][number];

const RATE_EPSILON = 1e-6;

export interface BareSlot {
  resourceKey: string;
  kind: ResourceKind;
  displayName: string;
}

export interface BareSlots {
  inputs: BareSlot[];
  outputs: BareSlot[];
}

/**
 * Every slot on a card with no wire on it, both ends: the plan is closed, so each one is a hard zero the card
 * marks.
 */
export function findBareSlots(
  nodeResult: NodeThroughputResult,
  incoming: ProjectEdge[],
  outgoing: ProjectEdge[],
): BareSlots | undefined {
  const describe = (
    flow: { kind: ResourceKind; resourceId: string; displayName?: string },
    key: string,
  ): BareSlot => ({ resourceKey: key, kind: flow.kind, displayName: flow.displayName ?? flow.resourceId });

  const wiredOn = (edges: ProjectEdge[], key: string) =>
    edges.some((edge) => makeResourceKey(edge.resourceKind, edge.resourceId) === key);

  const inputs: BareSlot[] = [];
  for (const [key, flow] of Object.entries(nodeResult.inputs)) {
    if (flow.amountPerSecond > RATE_EPSILON && !incoming.some((edge) => makeResourceKey(edge.resourceKind, edge.resourceId) === key)) {
      inputs.push(describe(flow, key));
    }
  }

  const outputs: BareSlot[] = [];
  for (const [key, flow] of Object.entries(nodeResult.outputs)) {
    // An unwired EU port is not a bare slot: unbanked power dissipates in
    // game, so the closed-plan rule waives it (as the solver cores do).
    if (flow.kind === "power") {
      continue;
    }
    if (flow.amountPerSecond > RATE_EPSILON && !wiredOn(outgoing, key)) {
      outputs.push(describe(flow, key));
    }
  }

  return inputs.length > 0 || outputs.length > 0 ? { inputs, outputs } : undefined;
}
