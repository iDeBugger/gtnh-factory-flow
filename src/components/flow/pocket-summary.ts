import { BOARD_GRID } from "@/lib/board-grid";
import { makeResourceKey } from "@/lib/model/resources";
import type {
  FactoryPocket,
  FactoryProject,
  ResourceAmount,
  ResourceBalance,
  ThroughputResult,
} from "@/lib/model/types";

/**
 * What a MINIMIZED board says about itself.
 *
 * A minimized board is a SUMMARY, not a machine: you cannot wire to it, it
 * has no ports, and it makes no claim about being fed. It reports what is
 * inside (machines, cards, power) and what crosses its border right now, both
 * straight from the plan-wide solve. Do not run a scoped solve over the
 * members: cutting the outside world off would call a board holding its own
 * source starving and one exporting a byproduct clogged.
 */

/** One resource crossing a minimized board's border, in one direction. */
export interface PocketCrossing {
  key: string;
  kind: ResourceBalance["kind"];
  resourceId: string;
  displayName?: string;
  iconPath?: string;
  iconAtlas?: ResourceAmount["iconAtlas"];
  dominantColor?: string;
  /** What is really moving, summed over the wires or over the machines. */
  ratePerSecond: number;
  /** How many wires carry it. Zero on a need or an offer: those are not wires. */
  wireCount: number;
}

const RATE_EPSILON = 1e-6;

/*
 * No cap: a board with forty crossings draws forty lines. A summary that
 * hides half of itself behind "and 12 more" is not a summary.
 */

/** The four lists a minimized card stacks, by length. */
export interface PocketCardLines {
  needs: number;
  offers: number;
  incoming: number;
  outgoing: number;
}

/** Cells one two-column section costs, its label row included; 0 when empty. */
export function sectionCells(left: number, right: number): number {
  const rows = Math.max(left, right);
  return rows === 0 ? 0 : 1 + 2 * rows;
}

/**
 * How tall a minimized card stands, from its list lengths alone.
 *
 * The card and the auto-arranger both call this, so the layout can size a
 * minimized board before it has ever been measured on screen: head row,
 * the board's own needs and offers, what crosses its border, and the stat
 * footer.
 */
export function pocketCardHeight(lines: PocketCardLines): number {
  const balance = sectionCells(lines.needs, lines.offers);
  const crossings = sectionCells(lines.incoming, lines.outgoing);
  // A rule between the two, when there are two: they answer different
  // questions and must not read as one long list.
  const rule = balance > 0 && crossings > 0 ? 1 : 0;
  const body = balance + rule + crossings;
  // A board with nothing to say still gets a line saying so.
  return BOARD_GRID * (2 + (body === 0 ? 2 : body) + 2);
}

/** Every board nested under `pocketId`, itself included. */
function pocketFamily(allPockets: FactoryPocket[], pocketId: string): Set<string> {
  const family = new Set<string>([pocketId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const entry of allPockets) {
      if (
        entry.parentPocketId !== undefined &&
        family.has(entry.parentPocketId) &&
        !family.has(entry.id)
      ) {
        family.add(entry.id);
        grew = true;
      }
    }
  }
  return family;
}

/** The cards living inside a board, nested boards included. */
function pocketMemberIds(project: FactoryProject, pocketId: string): Set<string> {
  const family = pocketFamily(project.pockets ?? [], pocketId);
  const members = new Set<string>();
  for (const node of project.nodes) {
    if (node.pocketId !== undefined && family.has(node.pocketId)) {
      members.add(node.id);
    }
  }
  for (const storage of project.storages ?? []) {
    if (storage.pocketId !== undefined && family.has(storage.pocketId)) {
      members.add(storage.id);
    }
  }
  return members;
}

/**
 * How many distinct resources cross a board's border each way.
 *
 * Structural: no solve, no rates. The auto-arranger sizes a minimized card
 * with this before any of it is on screen, and the card draws exactly this
 * many rows, so the two agree without one having to wait for the other.
 */
export function countPocketCrossings(
  project: FactoryProject,
  pocketId: string,
): PocketCardLines {
  const members = pocketMemberIds(project, pocketId);
  const incoming = new Set<string>();
  const outgoing = new Set<string>();
  for (const edge of project.edges) {
    const sourceInside = members.has(edge.source);
    const targetInside = members.has(edge.target);
    if (sourceInside === targetInside) {
      continue;
    }
    (targetInside ? incoming : outgoing).add(`${edge.resourceKind}:${edge.resourceId}`);
  }
  const balance = computeBoardBalance(project, members, new Map(), undefined);
  return {
    needs: balance.needs.length,
    offers: balance.offers.length,
    incoming: incoming.size,
    outgoing: outgoing.size,
  };
}

/**
 * What a board's CONTENTS want and what they make, wires ignored and netted
 * against each other: a board whose own mine feeds its own macerator asks the
 * world for no ore. What survives is what the board would need brought in and
 * what it would have to give away.
 *
 * Rates are FULL SPEED, because a stalled board still needs what it is
 * missing; the border crossings show what is really moving. With no solve in
 * hand the recipe amounts stand in: the arranger only needs the number of
 * lines. Drawers are not counted: a drawer inside is a bank, not a source or
 * a sink, as the plan's own panel treats one.
 */
function computeBoardBalance(
  project: FactoryProject,
  memberIds: ReadonlySet<string>,
  icons: Map<string, ResourceIconMeta>,
  result: ThroughputResult | undefined,
): { needs: PocketCrossing[]; offers: PocketCrossing[] } {
  const net = new Map<
    string,
    { kind: ResourceBalance["kind"]; resourceId: string; net: number }
  >();
  const add = (kind: ResourceBalance["kind"], resourceId: string, perSecond: number) => {
    const key = makeResourceKey(kind, resourceId);
    const entry = net.get(key);
    if (entry) {
      entry.net += perSecond;
    } else {
      net.set(key, { kind, resourceId, net: perSecond });
    }
  };

  for (const node of project.nodes) {
    if (!memberIds.has(node.id)) {
      continue;
    }
    const nodeResult = result?.nodes[node.id];
    if (nodeResult) {
      // FULL SPEED here, unlike everything else on this card: this list is
      // what the board needs to run. Scaling by utilization would erase the
      // needs of a board stalled BECAUSE those needs are unmet.
      for (const flow of Object.values(nodeResult.outputs)) {
        add(flow.kind, flow.resourceId, flow.amountPerSecond);
      }
      for (const flow of Object.values(nodeResult.inputs)) {
        add(flow.kind, flow.resourceId, -flow.amountPerSecond);
      }
      continue;
    }
    // No solve: the recipe's own amounts, which is enough for the signs and
    // the number of lines.
    const recipe = project.recipes.find((entry) => entry.id === node.recipeId);
    if (!recipe) {
      continue;
    }
    for (const output of recipe.outputs) {
      add(output.kind, output.id, output.amount * node.machineCount);
    }
    for (const input of recipe.inputs) {
      add(input.kind, input.id, -input.amount * node.machineCount);
    }
  }

  const line = (
    kind: ResourceBalance["kind"],
    resourceId: string,
    ratePerSecond: number,
  ): PocketCrossing => {
    const key = makeResourceKey(kind, resourceId);
    const icon = icons.get(key);
    return {
      key,
      kind,
      resourceId,
      displayName: icon?.displayName,
      iconPath: icon?.iconPath,
      iconAtlas: icon?.iconAtlas,
      dominantColor: icon?.dominantColor,
      ratePerSecond,
      wireCount: 0,
    };
  };

  const needs = new Map<string, PocketCrossing>();
  const offers = new Map<string, PocketCrossing>();
  for (const entry of net.values()) {
    const key = makeResourceKey(entry.kind, entry.resourceId);
    if (entry.net < -RATE_EPSILON) {
      needs.set(key, line(entry.kind, entry.resourceId, -entry.net));
    } else if (entry.net > RATE_EPSILON) {
      offers.set(key, line(entry.kind, entry.resourceId, entry.net));
    }
  }
  return { needs: sortCrossings(needs), offers: sortCrossings(offers) };
}

/** Busiest first, then by name, so the card's order is stable and useful. */
function sortCrossings(crossings: Map<string, PocketCrossing>): PocketCrossing[] {
  return [...crossings.values()].sort((left, right) => {
    if (right.ratePerSecond !== left.ratePerSecond) {
      return right.ratePerSecond - left.ratePerSecond;
    }
    return (left.displayName ?? left.resourceId).localeCompare(
      right.displayName ?? right.resourceId,
    );
  });
}

type ResourceIconMeta = Pick<
  ResourceAmount,
  "displayName" | "iconPath" | "iconAtlas" | "dominantColor"
>;

