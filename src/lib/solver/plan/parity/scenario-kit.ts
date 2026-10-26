/**
 * The S1 parity scenarios (`scenarios.json`) as website plans, and the board's reading of a solved plan the way the
 * clean card, the drawers and the overview rail show it. The mod builds the same scenarios as its own graphs
 * (a throwaway JUnit, S1ParityTest) and records its answer and its board in `fixtures/mod-answers.json`.
 */
import { buildRailPorts, deriveNodeVerdict } from "@/components/flow/node-verdict";
import { buildRailModel } from "@/components/flow/clean/rail/rail-model";
import { buildNotices } from "@/components/flow/clean/rail/notices";
import { portRowPerSecond } from "@/components/flow/clean/clean-model";
import { CUSTOM_RATE_MACHINE_TYPE } from "../../../model/custom-rate";
import { FLUID_TANK_MACHINE_TYPE, FLUID_TANK_MAP } from "../../../model/fluid-tank";
import { makeResourceHandleId } from "@/components/flow/resource-handles";
import {
  PROJECT_SCHEMA_VERSION,
  type FactoryEdge,
  type FactoryNode,
  type FactoryProject,
  type FactoryStorage,
  type Recipe,
  type ResourceKind,
  type ThroughputResult,
} from "../../../model/types";
import { makePortKey } from "../port-key";

export interface ScenarioMachine {
  id: number;
  name: string;
  kind?: "custom-supply" | "custom-request" | "tank";
  dur: number;
  in: Array<[string, number]>;
  out: Array<[string, number]>;
  pin?: number;
  inRates?: Record<string, number>;
  outRates?: Record<string, number>;
}

export interface Scenario {
  name: string;
  machines: ScenarioMachine[];
  /** [edge id, from machine, from output, to machine, to input] */
  wires?: Array<[number, number, number, number, number]>;
  drawers?: Array<{
    id: number;
    kind: "SOURCE" | "PRODUCT" | "TRASH";
    rule: "ANY" | "AT_LEAST" | "EXACTLY" | "AT_MOST";
    rate: number;
    res: string;
    links: Array<[number, number]>;
  }>;
  shared?: Array<{ sections: number[]; pin?: number }>;
}

export const uuid = (n: number): string => `00000000-0000-0000-0000-${n.toString(16).padStart(12, "0")}`;

const resourceOf = (name: string): { kind: ResourceKind; id: string } =>
  name.startsWith("f:") ? { kind: "fluid", id: name.slice(2) } : { kind: "item", id: name };

const RULE: Record<string, FactoryStorage["targetMode"]> = {
  AT_LEAST: "at-least",
  EXACTLY: "exact",
  AT_MOST: "at-most",
};

/** Where a mod machine lives on the website: its card and its section (a shared machine's recipes are sections). */
export interface Placement {
  card: string;
  section: number;
  /** The id the website's books give it (`card#r<n>` for a section past the first). */
  resultId: string;
}

export function buildScenario(s: Scenario): { project: FactoryProject; placement: Map<number, Placement> } {
  const placement = new Map<number, Placement>();
  for (const group of s.shared ?? []) {
    group.sections.forEach((m, section) => {
      const card = uuid(group.sections[0]!);
      placement.set(m, { card, section, resultId: section === 0 ? card : `${card}#r${section}` });
    });
  }
  for (const m of s.machines) {
    if (!placement.has(m.id)) placement.set(m.id, { card: uuid(m.id), section: 0, resultId: uuid(m.id) });
  }
  const byId = new Map(s.machines.map((m) => [m.id, m]));

  const recipes: Recipe[] = s.machines.map((m) => {
    const custom = m.kind === "custom-supply" || m.kind === "custom-request";
    const tank = m.kind === "tank";
    const amount = ([name, qty]: [string, number]) => ({ ...resourceOf(name), amount: qty, displayName: name });
    return {
      id: `r${m.id}`,
      name: m.name,
      machineType: custom ? CUSTOM_RATE_MACHINE_TYPE : tank ? FLUID_TANK_MACHINE_TYPE : "Mock Machine",
      minimumTier: custom || tank ? "NONE" : "LV",
      durationTicks: m.dur,
      eut: custom || tank ? 0 : 30,
      inputs: m.in.map(amount),
      outputs: m.out.map(amount),
      ...(custom ? { source: { recipeMap: "custom-rate" } } : tank ? { source: { recipeMap: FLUID_TANK_MAP } } : {}),
    } as Recipe;
  });

  const handle = (side: "input" | "output", m: ScenarioMachine, index: number): string => {
    const [name] = (side === "input" ? m.in : m.out)[index]!;
    const at = placement.get(m.id)!;
    const plain = makeResourceHandleId(side, resourceOf(name));
    return at.section > 0 ? `r${at.section}:${plain}` : plain;
  };

  const nodes: FactoryNode[] = [];
  for (const m of s.machines) {
    const at = placement.get(m.id)!;
    if (at.section > 0) continue;
    const group = (s.shared ?? []).find((g) => g.sections[0] === m.id);
    const portRates: Record<string, number> = {};
    for (const [i, rate] of Object.entries(m.outRates ?? {})) portRates[handle("output", m, Number(i))] = rate;
    for (const [i, rate] of Object.entries(m.inRates ?? {})) portRates[handle("input", m, Number(i))] = rate;
    const pin = group ? group.pin : m.pin;
    const custom = m.kind === "custom-supply" || m.kind === "custom-request";
    nodes.push({
      id: at.card,
      recipeId: `r${m.id}`,
      machineCount: 1,
      parallel: 1,
      overclockTier: custom || m.kind === "tank" ? "NONE" : "LV",
      enabled: true,
      position: { x: 0, y: 0 },
      // The recorded answers are the mod's, which still pins exactly (docs/up-to.md: until both sides agree).
      ...(pin !== undefined ? { solvePin: pin, solvePinExact: true } : {}),
      ...(Object.keys(portRates).length > 0 ? { portRates } : {}),
      ...(group ? { extraRecipes: group.sections.slice(1).map((id) => ({ recipeId: `r${id}` })) } : {}),
      ...(custom
        ? {
            customRate: {
              perSecond: (m.kind === "custom-supply" ? m.out : m.in)[0]![1],
              mode: m.kind === "custom-supply" ? ("supply" as const) : ("request" as const),
            },
          }
        : {}),
    } as FactoryNode);
  }

  const edges: FactoryEdge[] = [];
  for (const [id, from, out, to, into] of s.wires ?? []) {
    const src = byId.get(from)!;
    const dst = byId.get(to)!;
    const res = resourceOf(src.out[out]![0]);
    edges.push({
      id: uuid(id),
      source: placement.get(from)!.card,
      target: placement.get(to)!.card,
      sourceHandle: handle("output", src, out),
      targetHandle: handle("input", dst, into),
      resourceKind: res.kind,
      resourceId: res.id,
    });
  }

  const storages: FactoryStorage[] = [];
  for (const d of s.drawers ?? []) {
    const res = resourceOf(d.res);
    const rule = RULE[d.rule];
    storages.push({
      id: uuid(d.id),
      kind: res.kind,
      resourceId: res.id,
      displayName: d.res,
      position: { x: 0, y: 0 },
      ...(rule ? { targetMode: rule, targetPerSecond: d.rate } : {}),
      ...(d.kind === "TRASH" ? { drainMode: "trash" } : {}),
    } as FactoryStorage);
    d.links.forEach(([node, port], i) => {
      const m = byId.get(node)!;
      const source = d.kind === "SOURCE";
      edges.push({
        id: `${uuid(d.id)}-link${i}`,
        source: source ? uuid(d.id) : placement.get(node)!.card,
        target: source ? placement.get(node)!.card : uuid(d.id),
        ...(source ? { targetHandle: handle("input", m, port) } : { sourceHandle: handle("output", m, port) }),
        resourceKind: res.kind,
        resourceId: res.id,
      } as FactoryEdge);
    });
  }

  const project = {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    id: s.name,
    name: s.name,
    recipes,
    nodes,
    storages,
    edges,
    fuelProfiles: [],
  } as unknown as FactoryProject;
  return { project, placement };
}

export interface PortReading {
  name: string;
  /** The row's number. */
  shown: number;
  /** The forced row under it (0 when none). */
  extra: number;
}

export interface CardReading {
  count: number;
  pinned: boolean;
  unset: boolean;
  inputs: PortReading[];
  outputs: PortReading[];
}

export interface BoardReading {
  cards: Map<number, CardReading>;
  drawers: Map<number, { rate: number; unset: boolean }>;
  totals: {
    inputs: Record<string, number>;
    outputs: Record<string, number>;
    internal: Record<string, number>;
    /** The overview's machine lines: card id to count. */
    machines: Record<string, number>;
  };
  /** The notices bar, by kind (`no-pin`, `unmet:<drawer>`, `overshoot`, ...). */
  notices: string[];
}

/**
 * What the board shows for each machine of the scenario: the clean card's count, its "(set count)" and pinned
 * marks (`clean-model.ts` / `use-special.ts countView`), each port row's number and forced row
 * (`buildRailPorts` + `buildPortView`), the drawers' rates and prompts, and the rail's inputs and outputs.
 */
export function readBoard(
  s: Scenario,
  project: FactoryProject,
  placement: Map<number, Placement>,
  result: ThroughputResult,
): BoardReading {
  const plan = result.plan;
  const cards = new Map<number, CardReading>();
  const recipes = new Map(project.recipes.map((r) => [r.id, r]));
  for (const m of s.machines) {
    const at = placement.get(m.id)!;
    const node = project.nodes.find((n) => n.id === at.card)!;
    const recipe = recipes.get(`r${m.id}`)!;
    const nodeResult = result.nodes[at.resultId];
    const verdict = deriveNodeVerdict(project, result, at.resultId);
    const rails = buildRailPorts(project, result, at.resultId, recipe, verdict, { handleSection: at.section });
    const forced = new Map<string, number>();
    for (const entry of plan?.forced ?? []) {
      if (entry.nodeId === at.resultId) forced.set(entry.portKey, entry.perSecond);
    }
    const port = (side: "i" | "o") => (p: (typeof rails.inputs)[number]): PortReading => {
      const plain = p.handleId.replace(/^r\d+:/, "");
      const extra = forced.get(makePortKey(at.resultId, side, plain)) ?? 0;
      return { name: p.displayName, shown: portRowPerSecond(p, extra), extra };
    };
    // A shared machine's card count is its pin; each section reads its own count.
    const pin = at.section === 0 && !(s.shared ?? []).some((g) => g.sections.includes(m.id)) ? node.solvePin : undefined;
    const pinned = pin !== undefined && pin > 0;
    const unsetId = at.section === 0 ? at.card : at.resultId;
    const unset =
      plan !== undefined &&
      !pinned &&
      (plan.unanchored.includes(unsetId) || plan.unneeded.includes(unsetId) || plan.unneeded.includes(at.resultId));
    cards.set(m.id, {
      count: pinned ? pin : (nodeResult?.theoreticalMachinesRequired ?? 0),
      pinned,
      unset,
      inputs: rails.inputs.map(port("i")),
      outputs: rails.outputs.map(port("o")),
    });
  }
  const drawers = new Map<number, { rate: number; unset: boolean }>();
  for (const d of s.drawers ?? []) {
    const id = uuid(d.id);
    const storage = result.storages[id];
    drawers.set(d.id, {
      rate: Math.abs(storage?.netPerSecond ?? 0),
      unset: plan?.unanchored.includes(id) ?? false,
    });
  }
  const rail = buildRailModel(project, result);
  const totals: BoardReading["totals"] = { inputs: {}, outputs: {}, internal: {}, machines: {} };
  for (const line of rail.inputs) if (line.amount > 1e-9) totals.inputs[line.label] = line.amount;
  for (const line of rail.outputs) if (line.amount > 1e-9) totals.outputs[line.label] = line.amount;
  for (const line of rail.internal) if (line.amount > 1e-9) totals.internal[line.label] = line.amount;
  for (const line of rail.machines) totals.machines[line.nodeId] = line.count;
  const notices = buildNotices(project, result).map((n) => n.id.replace(/^(overshoot|unwired|ignored):.*/, "$1"));
  return { cards, drawers, totals, notices };
}
