import { isCustomRateRecipe } from "@/lib/model/custom-rate";
import { pinRuleOf } from "@/lib/model/pin-rule";
import { compareByRate } from "@/lib/model/rate-order";
import { isFluidTankRecipe } from "@/lib/model/fluid-tank";
import { buildMachineList } from "@/lib/model/machine-list";
import type {
  FactoryPocket,
  FactoryProject,
  ResourceKind,
  ThroughputResult,
} from "@/lib/model/types";
import { buildResourceLookup, splitResultNodeId, type RailResource } from "../rail/rail-model";

/**
 * What a collapsed group's summary card says (docs/groups.md, "What the summary says"): from the plan-wide solve,
 * never a solve of the group alone, over its members and every group nested in it.
 *
 * - machines: each machine card's build count (solved count rounded up, a pinned count as pinned); a shared machine
 *   once; drawers, notes and planning cards are not machines;
 * - EU/t: the members' power as the overview counts it (peak or average, its dial);
 * - in and out: per resource, the members' solved consumption minus their solved production (the card's own
 *   numbers: count times per-machine rate), busiest first.
 */

const EPS = 1e-6;

export interface GroupFlow {
  key: string;
  kind: ResourceKind;
  resourceId: string;
  resource: RailResource;
  /** Units a second (EU a second for power). */
  perSecond: number;
}

export interface GroupSummary {
  machines: number;
  euT: number;
  inputs: GroupFlow[];
  outputs: GroupFlow[];
}

/** Every group nested under `pocketId`, itself included. */
export function groupFamily(pockets: readonly FactoryPocket[], pocketId: string): Set<string> {
  const family = new Set<string>([pocketId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const pocket of pockets) {
      if (
        pocket.parentPocketId !== undefined &&
        family.has(pocket.parentPocketId) &&
        !family.has(pocket.id)
      ) {
        family.add(pocket.id);
        grew = true;
      }
    }
  }
  return family;
}

export function computeGroupSummaries(
  project: FactoryProject,
  result: ThroughputResult | undefined,
  pocketIds: readonly string[],
  peak: boolean,
): Map<string, GroupSummary> {
  const out = new Map<string, GroupSummary>();
  if (pocketIds.length === 0) return out;
  const pockets = project.pockets ?? [];
  const recipes = new Map(project.recipes.map((recipe) => [recipe.id, recipe]));
  const nodesById = new Map(project.nodes.map((node) => [node.id, node]));
  const lookup = buildResourceLookup(project);
  const entries = result ? buildMachineList(project, result) : [];
  // A failed solve leaves each card's nominal single craft in its result: not flows of the plan.
  const answered = result !== undefined && result.plan?.failure === undefined;

  for (const pocketId of pocketIds) {
    const family = groupFamily(pockets, pocketId);
    const inside = (cardId: string) => {
      const owner = nodesById.get(cardId)?.pocketId;
      return owner !== undefined && family.has(owner);
    };

    let machines = 0;
    let euT = 0;
    for (const entry of entries) {
      if (!inside(entry.nodeId)) continue;
      const node = nodesById.get(entry.nodeId);
      if (isFluidTankRecipe(recipes.get(node?.recipeId ?? ""))) continue;
      const pin = node?.solvePin;
      const rule = node ? pinRuleOf(node) : "any";
      const pinned = rule !== "any" && pin !== undefined && pin > 0;
      // An Up to card builds what runs (the solver's read-out), an Exactly card its set count.
      const running = rule === "upTo" ? result?.plan?.upTo?.[entry.nodeId]?.reached : undefined;
      if (!pinned && !(entry.count > 1e-9)) continue;
      machines += Math.ceil((running ?? (pinned ? pin : entry.count)) - 1e-9);
      euT += (peak ? entry.euT : entry.avgEuT) ?? 0;
    }

    const net = new Map<
      string,
      { kind: ResourceKind; resourceId: string; label?: string; value: number }
    >();
    if (answered) {
      for (const node of Object.values(result!.nodes)) {
        if (!node.enabled) continue;
        const { cardId } = splitResultNodeId(node.nodeId);
        if (!inside(cardId)) continue;
        if (isCustomRateRecipe(recipes.get(node.recipeId))) continue;
        // A machine at zero keeps its nameplate rates (its port rows read them) but moves nothing.
        if (!((node.theoreticalMachinesRequired ?? 0) > 1e-9)) continue;
        const running = Math.min(1, Math.max(0, node.utilization ?? 1));
        for (const [flows, sign] of [
          [node.inputs, 1],
          [node.outputs, -1],
        ] as const) {
          for (const flow of Object.values(flows)) {
            const entry = net.get(flow.key);
            const amount = sign * flow.amountPerSecond * running;
            if (entry) entry.value += amount;
            else
              net.set(flow.key, {
                kind: flow.kind,
                resourceId: flow.resourceId,
                label: flow.displayName,
                value: amount,
              });
          }
        }
      }
    }

    const inputs: GroupFlow[] = [];
    const outputs: GroupFlow[] = [];
    for (const [key, entry] of net) {
      if (Math.abs(entry.value) <= EPS) continue;
      const known = lookup.get(key);
      const resource: RailResource = {
        ...(known ?? { kind: entry.kind, id: entry.resourceId }),
        displayName: known?.displayName ?? entry.label ?? entry.resourceId,
      };
      const flow = {
        key,
        kind: entry.kind,
        resourceId: entry.resourceId,
        resource,
        perSecond: Math.abs(entry.value),
      };
      (entry.value > 0 ? inputs : outputs).push(flow);
    }
    // Busiest first, rates equal within float noise by the name the card prints, then key (`rate-order.ts`): a new
    // target never swaps two rows that read the same.
    const busiest = (a: GroupFlow, b: GroupFlow) =>
      compareByRate(
        { rate: a.perSecond, name: a.resource.displayName ?? a.resourceId, key: a.key },
        { rate: b.perSecond, name: b.resource.displayName ?? b.resourceId, key: b.key },
      );
    inputs.sort(busiest);
    outputs.sort(busiest);
    out.set(pocketId, { machines, euT, inputs, outputs });
  }
  return out;
}

/** Rows the summary card draws: the longer list (at least one: the "Nothing goes in or out." line). */
export function summaryRows(summary: GroupSummary | undefined): number {
  if (!summary) return 1;
  return Math.max(1, summary.inputs.length, summary.outputs.length);
}
