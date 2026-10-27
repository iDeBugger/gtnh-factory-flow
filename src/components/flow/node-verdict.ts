import type {
  EdgeThroughput,
  FactoryProject,
  NodeThroughputResult,
  Recipe,
  ResourceAmount,
  ResourceKind,
  ThroughputResult,
} from "@/lib/model/types";
import { isBeeSpeciesInput, isFreeRecipeInput, isOreDictionaryResource, isRecipeInputConsumed, makeResourceKey, resourceLabel } from "@/lib/model";
import { solveGraph } from "@/lib/solver/hatch-supply";
import { findBareSlots } from "./bare-slots";
import { collectTrashNodeIds } from "@/lib/model/trash";
import { describeStorage, getStorageRoles } from "@/lib/model/storage-role";
import { makeResourceHandleId, sectionHandleId } from "./resource-handles";
import { sectionOwnerId } from "@/lib/model/shared-machine";
import { getInputSupplyHatch, isHatchSuppliedInput } from "@/lib/model/hatch-supply";
import { energyPerUnit } from "@/lib/model/rate-unit";

type ProjectEdge = FactoryProject["edges"][number];

/**
 * The node-level verdict, read off the solved plan: off, no recipe, UNWIRED (some slot has no wire, so the machine
 * is at zero and the card marks every bare slot; a SOURCE or DRAIN drawer counts as a connection), or running
 * (`balanced`) versus not needed by anything set (`demand-set`). Why a plan cannot be met is the plan solver's to say
 * (its notices and readouts), never the card's.
 */
export type NodeVerdictKind = "off" | "no-recipe" | "unwired" | "demand-set" | "balanced";

export interface NodeVerdict {
  kind: NodeVerdictKind;
  /** Clamped display percentage, 0-100. */
  pct: number;
  /**
   * Unwired: every slot with no wire on it, both ends, so the card can mark
   * them all rather than crowning one. These are the things to go and connect.
   */
  bare?: {
    inputs: Array<{ resourceKey: string; kind: ResourceKind; displayName: string }>;
    outputs: Array<{ resourceKey: string; kind: ResourceKind; displayName: string }>;
  };
}

/** Half a percent: below this, converged solver states are just float noise. */
const VERDICT_EPSILON = 0.005;
const RATE_EPSILON = 1e-6;

function clamp01(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(Math.max(value, 0), 1);
}

/**
 * What the consumer on this edge truly asks for. The solver's converged
 * `demandPerSecond` is self-damped (it collapses to whatever was shipped), so
 * the honest ask is the nameplate one whenever the consumer is genuinely
 * starved of capability: flagged by the solver (constraint "supply") or read
 * off the consumer itself, since damping can keep the flag from ever being
 * raised. Deliberately throttled consumers (demand-set) never beg. Everything
 * the UI says about hunger must go through here, never the damped figure.
 */
function honestEdgeAskPerSecond(
  edgeResult: EdgeThroughput | undefined,
  targetResult?: NodeThroughputResult,
  edge?: Pick<ProjectEdge, "resourceKind" | "resourceId" | "targetHandle">,
): number {
  if (!edgeResult) {
    return 0;
  }
  const nameplate = edgeResult.nameplateDemandPerSecond ?? 0;
  const damped = edgeResult.demandPerSecond ?? 0;
  if (edgeResult.constraint === "supply") {
    return Math.max(nameplate, damped);
  }
  if (targetResult) {
    const capable = clamp01(targetResult.capableUtilization, 1);
    const demand = clamp01(targetResult.demandUtilization, capable);
    const demandSet = demand < capable - VERDICT_EPSILON && demand < 1 - VERDICT_EPSILON;
    // Beg at nameplate ONLY on the consumer's actually-limiting input.
    // A starved machine's OTHER lines ask for what it can really eat —
    // apples-and-oranges: short on oranges at 50% means the apple line
    // honestly asks for half the apples, and the apple maker is FINE.
    const limitsThisLine =
      edge === undefined ||
      targetResult.limitingInputKey === undefined ||
      makeResourceKey(edge.resourceKind, edge.resourceId) === targetResult.limitingInputKey ||
      targetResult.limitingInputTiedKeys?.includes(
        makeResourceKey(edge.resourceKind, edge.resourceId),
      ) === true;
    if (!demandSet && capable < 1 - VERDICT_EPSILON && limitsThisLine) {
      return Math.max(nameplate, damped);
    }
  }
  return damped;
}

/**
 * What a buffer can honestly hand ONE of its consumers. A tank with no reserve
 * cannot deliver more than it receives, so once the asks on it exceed its
 * inflow, that inflow is a real ceiling (the shortage moved one hop upstream).
 * While the tank covers everyone it stays Infinity, so a buffer never becomes
 * a false ceiling. A tank with no inbound lines is hand-stocked: never dry.
 */
function bufferRelaySupplyPerSecond(
  project: FactoryProject,
  result: ThroughputResult | undefined,
  storageId: string,
  edgeId: string,
): number {
  const index = getBufferRelayIndex(project, result);
  // No inbound lines: hand-stocked, assumed never dry.
  if ((index.inflowEdges.get(storageId) ?? 0) === 0) {
    return Number.POSITIVE_INFINITY;
  }
  const inflow = index.inflow.get(storageId) ?? 0;
  const asks = index.asks.get(storageId) ?? 0;
  // Still covering everyone: not a ceiling, and must never become a false one.
  if (asks <= inflow + RATE_EPSILON) {
    return Number.POSITIVE_INFINITY;
  }
  const ownAsk = index.edgeAsk.get(edgeId) ?? 0;
  return inflow * (asks > RATE_EPSILON ? ownAsk / asks : 1);
}

/**
 * Per-buffer inflow and asks, resolved in one pass over the edges. Built once
 * per (project, result) pair so per-node callers look up in O(1); scanning
 * per buffer-fed input would cost O(nodes × edges) every solver tick.
 */
interface BufferRelayIndex {
  inflow: Map<string, number>;
  inflowEdges: Map<string, number>;
  asks: Map<string, number>;
  edgeAsk: Map<string, number>;
}

// Keyed on object identity: the solver hands out a fresh result per tick, so a
// stale index can never outlive the numbers it was built from.
const bufferRelayIndexCache = new WeakMap<
  FactoryProject,
  { result: ThroughputResult | undefined; index: BufferRelayIndex }
>();

function getBufferRelayIndex(
  project: FactoryProject,
  result: ThroughputResult | undefined,
): BufferRelayIndex {
  const cached = bufferRelayIndexCache.get(project);
  if (cached && cached.result === result) {
    return cached.index;
  }
  const index: BufferRelayIndex = {
    inflow: new Map(),
    inflowEdges: new Map(),
    asks: new Map(),
    edgeAsk: new Map(),
  };
  const storageIds = new Set((project.storages ?? []).map((storage) => storage.id));
  if (storageIds.size > 0) {
    for (const edge of project.edges) {
      if (storageIds.has(edge.target)) {
        index.inflowEdges.set(edge.target, (index.inflowEdges.get(edge.target) ?? 0) + 1);
        index.inflow.set(
          edge.target,
          (index.inflow.get(edge.target) ?? 0) +
            (result?.edges[edge.id]?.transferredPerSecond ?? 0),
        );
      }
      if (storageIds.has(edge.source)) {
        const ask = honestEdgeAskPerSecond(
          result?.edges[edge.id],
          result?.nodes[edge.target],
          edge,
        );
        index.edgeAsk.set(edge.id, ask);
        index.asks.set(edge.source, (index.asks.get(edge.source) ?? 0) + ask);
      }
    }
  }
  bufferRelayIndexCache.set(project, { result, index });
  return index;
}

/** A machine that could turn at all: powered, and inputs allowing something. */
function isMachineAbleToRun(nodeResult: NodeThroughputResult | undefined): boolean {
  if (!nodeResult) {
    return true;
  }
  if (nodeResult.powerStalled) {
    return false;
  }
  return clamp01(nodeResult.capableUtilization, 1) > VERDICT_EPSILON;
}

/**
 * What ONE inbound line can honestly deliver, buffers included. Call this
 * rather than bare honestEdgeAvailablePerSecond: that defaults a buffer
 * source to Infinity, and without its fourth argument every buffer-fed input
 * looks infinitely supplied and can never be named the bottleneck.
 */
function honestInboundAvailablePerSecond(
  project: FactoryProject,
  result: ThroughputResult | undefined,
  edge: ProjectEdge,
  sourceIsStorage: boolean,
  sourceHasSoleOutlet: boolean,
): number {
  // The sole-outlet uplift assumes the producer could ramp to full blast. A
  // producer at a dead stop for its own reasons (no power, inputs that allow
  // nothing) cannot, so its line delivers nothing and the machine it starves
  // can name who stopped it.
  const sourceCanRamp = sourceIsStorage || isMachineAbleToRun(result?.nodes[edge.source]);
  return honestEdgeAvailablePerSecond(
    result?.edges[edge.id],
    sourceIsStorage,
    sourceHasSoleOutlet && sourceCanRamp,
    sourceIsStorage
      ? bufferRelaySupplyPerSecond(project, result, edge.source, edge.id)
      : Number.POSITIVE_INFINITY,
  );
}

/**
 * What a supply line could honestly deliver:
 * - a non-dry buffer grants whatever is asked (Infinity: never a cap);
 * - a machine line whose producer has this as its sole outlet can deliver
 *   the producer's full-blast capacity (`sourceCapacityPerSecond`);
 * - otherwise the allocation figure, least trusted: the ask coupling drags
 *   innocent lines' allocations down to the binder's level.
 */
function honestEdgeAvailablePerSecond(
  edgeResult: EdgeThroughput | undefined,
  sourceIsStorage: boolean,
  sourceHasSoleOutlet = false,
  /** From bufferRelaySupplyPerSecond: a tank that runs dry IS a ceiling. */
  bufferSupplyPerSecond = Number.POSITIVE_INFINITY,
): number {
  if (sourceIsStorage && edgeResult?.constraint !== "supply") {
    return bufferSupplyPerSecond;
  }
  const allocated = edgeResult?.availablePerSecond ?? edgeResult?.transferredPerSecond ?? 0;
  if (sourceHasSoleOutlet && edgeResult?.sourceCapacityPerSecond !== undefined) {
    return Math.max(allocated, edgeResult.sourceCapacityPerSecond);
  }
  return allocated;
}

/** How many outgoing lines each source has per resource — the sole-outlet test. */
function countSourceOutlets(project: FactoryProject): Map<string, number> {
  const counts = new Map<string, number>();
  for (const edge of project.edges) {
    const key = `${edge.source}|${edge.resourceKind}|${edge.resourceId}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function edgeSourceHasSoleOutlet(outletCounts: Map<string, number>, edge: ProjectEdge): boolean {
  return (outletCounts.get(`${edge.source}|${edge.resourceKind}|${edge.resourceId}`) ?? 0) === 1;
}

export function deriveNodeVerdict(
  project: FactoryProject,
  result: ThroughputResult | undefined,
  nodeId: string,
): NodeVerdict {
  // Every story below reads the graph the solve ran on (shared sections, hatch supplies).
  project = solveGraph(project);
  const node = project.nodes.find((entry) => entry.id === nodeId);
  if (!node || node.enabled === false) {
    return { kind: "off", pct: 0 };
  }

  const nodeResult = result?.nodes[nodeId];
  if (!nodeResult || nodeResult.status === "missing-recipe") {
    return { kind: "no-recipe", pct: 0 };
  }

  const utilization = clamp01(nodeResult.utilization, 0);
  const pct = Math.round(utilization * 1000) / 10;

  const incoming = project.edges.filter((edge) => edge.target === nodeId);
  const outgoing = project.edges.filter((edge) => edge.source === nodeId);

  // UNWIRED outranks everything below it. In a closed plan a slot with no
  // wire is a hard zero at whichever end it sits, and needs no arithmetic to
  // explain.
  const bare = findBareSlots(nodeResult, incoming, outgoing);
  // A machine whose recipe has NO slots at all (a solar panel: nothing in,
  // EU out through no port) has nothing to wire, so "unwired" would nag
  // about a wire that cannot exist. It runs; the ordinary readings apply.
  const recipe = project.recipes.find((entry) => entry.id === node.recipeId);
  const hasSlots = (recipe?.inputs.length ?? 0) > 0 || (recipe?.outputs.length ?? 0) > 0;
  if (bare || (hasSlots && incoming.length === 0 && outgoing.length === 0)) {
    // The second clause catches a SLOTTED card with no wires whose slots
    // the solver has no flows for. There are no bare slots to mark, but
    // "unwired" is still the only true thing to say about it.
    return { kind: "unwired", pct, bare };
  }

  // The books are the solved plan: a solved machine runs by construction; one at zero is simply not needed by
  // anything set, a quiet reading, never an alarm.
  return utilization > VERDICT_EPSILON ? { kind: "balanced", pct } : { kind: "demand-set", pct };
}

/** Every card with a slot still to connect, in one O(nodes + edges) pass rather than a verdict per card. */
export function findUnwiredNodeIds(
  project: FactoryProject,
  result: ThroughputResult | undefined,
): string[] {
  project = solveGraph(project);
  const incomingBy = new Map<string, ProjectEdge[]>();
  const outgoingBy = new Map<string, ProjectEdge[]>();
  for (const edge of project.edges) {
    const into = incomingBy.get(edge.target);
    if (into) {
      into.push(edge);
    } else {
      incomingBy.set(edge.target, [edge]);
    }
    const from = outgoingBy.get(edge.source);
    if (from) {
      from.push(edge);
    } else {
      outgoingBy.set(edge.source, [edge]);
    }
  }

  const ids: string[] = [];
  for (const node of project.nodes) {
    if (node.enabled === false) {
      continue;
    }
    const nodeResult = result?.nodes[node.id];
    if (!nodeResult || nodeResult.status === "missing-recipe") {
      continue;
    }
    const incoming = incomingBy.get(node.id) ?? [];
    const outgoing = outgoingBy.get(node.id) ?? [];
    // Same rule as the verdict: a machine whose recipe has no slots at all
    // (a solar panel) has nothing to wire, so the checklist skips it.
    const recipe = project.recipes.find((entry) => entry.id === node.recipeId);
    const hasSlots = (recipe?.inputs.length ?? 0) > 0 || (recipe?.outputs.length ?? 0) > 0;
    if (
      findBareSlots(nodeResult, incoming, outgoing) ||
      (hasSlots && incoming.length === 0 && outgoing.length === 0)
    ) {
      // A shared machine's section answers as its card: the card is what
      // the notice rings and flies to.
      const owner = sectionOwnerId(node.id);
      if (!ids.includes(owner)) {
        ids.push(owner);
      }
    }
  }
  return ids;
}

/**
 * The plug block seated through the node's wall on an output: the ASKER's
 * story, in the asker's frame. Any number of plugs can be hungry at once —
 * couplings are independent contracts, there is no "worst output".
 */
export interface PortPlug {
  /**
   * hungry  = askers want more than they get
   * fed     = every asker gets what it asks for (green)
   * dump    = only dead ends attached — a trash can, or buffers nothing ever
   *           draws from — so there is no ask to satisfy, just a place flow
   *           goes. `dumpKind` says which place, because a tank that fills up
   *           and a can that destroys the flow are not the same news.
   *
   * A buffer that HAS consumers is not a dump: it relays their asks one hop
   * upstream ("a recipe that crafts itself — the input is the output"), so
   * it participates in hungry/fed like any machine asker.
   */
  state: "hungry" | "fed" | "dump";
  /**
   * Where a `dump` actually ends: a trash can (destroyed), a tank (fluid
   * buffer), or a store (item buffer). Absent on every other state.
   */
  dumpKind?: "trash" | "tank" | "store";
  /** One machine's name, "N machines", "via <buffer>", or the dump's name. */
  askerName: string;
  /** Distinct machine consumers on this port (0 when buffers only). */
  askerMachines: number;
  askPerSecond: number;
  getPerSecond: number;
  /** get/ask, clamped 0..1 — the plug bar's fill. */
  coveredFraction: number;
  /** ask/get when hungry (Infinity when nothing flows yet). */
  timesShort?: number;
}

/**
 * A buffer's relayed ask: what everything drawing FROM the buffer honestly
 * wants, one hop through. `share` divides it among the buffer's suppliers by
 * their current contribution (equal split before anything flows).
 */
function relayedBufferAskPerSecond(
  project: FactoryProject,
  result: ThroughputResult | undefined,
  storageId: string,
  supplierRate: number,
): number {
  let consumersAsk = 0;
  let outgoing = 0;
  for (const edge of project.edges) {
    if (edge.source !== storageId) {
      continue;
    }
    outgoing += 1;
    consumersAsk += honestEdgeAskPerSecond(result?.edges[edge.id], result?.nodes[edge.target], edge);
  }
  if (outgoing === 0) {
    return -1;
  }

  let inflowTotal = 0;
  let inflowEdges = 0;
  for (const edge of project.edges) {
    if (edge.target !== storageId) {
      continue;
    }
    inflowEdges += 1;
    inflowTotal += result?.edges[edge.id]?.transferredPerSecond ?? 0;
  }
  const share =
    inflowTotal > RATE_EPSILON ? supplierRate / inflowTotal : 1 / Math.max(1, inflowEdges);
  return consumersAsk * share;
}

/**
 * One rail port per unique resource a node can exchange: the wire, the live
 * rate, and the health readout share a single surface. Ports pool repeated
 * recipe slots exactly the way the solver pools their flows.
 */
export interface RailPort {
  supplyHatch?: string;
  hatchSupplied?: boolean;
  side: "input" | "output";
  key: string;
  kind: ResourceKind;
  resourceId: string;
  displayName: string;
  /** Canonical (index-less) handle id; edges of any vintage resolve onto it. */
  handleId: string;
  /** Recipe entry backing the port, for icon rendering. */
  resource?: ResourceAmount;
  connected: boolean;
  /**
   * Consumed input with no line attached. Nothing declares where it comes
   * from, so the machine cannot run.
   */
  unsupplied: boolean;
  /**
   * An inert free-input row (a bee's species, a recipe's free input), so a bare slot here is not a to-do item. Outputs read this to keep
   * the NO TAKER mark off a slot the plan has an answer for.
   */
  boundaryFree: boolean;
  currentPerSecond: number;
  nameplatePerSecond: number;
  /**
   * The WANT mark on the bar. Outputs: what all consumers would take at THEIR
   * full speed (honest asks, can exceed nameplate). Inputs: the draw at the
   * speed downstream asks of this machine.
   */
  wantedPerSecond: number;
  /**
   * The supply-side ceiling. Outputs: full blast × what the inputs allow.
   * Inputs: what the connected lines could deliver if this machine drank
   * freely (can exceed nameplate — spare upstream).
   */
  couldPerSecond: number;
  fillFraction: number;
  tone: "ok" | "bind" | "calm";
  /** Outputs only: the asker-side coupling, when anything is plugged in. */
  plug?: PortPlug;
  badge?: { kind: "short" | "asked"; perSecond: number };
  /**
   * The EU this card spends per unit crossing this port (its EU/t over the
   * port's flow, both from the same books): per unit MADE on an output, per
   * unit EATEN on an input. The "EU" rate unit shows it in place of the
   * rate; every other unit ignores it.
   */
  energyPerUnit?: number;
  /**
   * Free in the game (free-input.ts): drawn so the player knows to set it
   * down, but nothing to wire, nothing to supply, no rate and no bar. Every
   * figure above is zero and no handle is rendered for it.
   */
  free?: boolean;
}

export function buildRailPorts(
  project: FactoryProject,
  result: ThroughputResult | undefined,
  nodeId: string,
  displayRecipe: Pick<Recipe, "inputs" | "outputs">,
  verdict: NodeVerdict,
  /** A shared machine section: its ports wear this section prefix on their handles. */
  options?: { handleSection?: number },
): { inputs: RailPort[]; outputs: RailPort[] } {
  const handleFor = (side: "input" | "output", resource: { kind: ResourceKind; id: string }) =>
    sectionHandleId(options?.handleSection ?? 0, makeResourceHandleId(side, resource));
  project = solveGraph(project);
  const nodeResult = result?.nodes[nodeId];
  const utilization = clamp01(nodeResult?.utilization, 0);
  const demand = clamp01(nodeResult?.demandUtilization, utilization);
  const capable = clamp01(nodeResult?.capableUtilization, 1);
  const incoming = project.edges.filter((edge) => edge.target === nodeId);
  const outgoing = project.edges.filter((edge) => edge.source === nodeId);
  const storagesById = new Map((project.storages ?? []).map((storage) => [storage.id, storage]));
  // A trash can asks for nothing — it eats whatever arrives. Counting it as a
  // machine asker made every trashed output read as a happily fed coupling.
  const trashNodeIds = collectTrashNodeIds(project);
  const nodesById = new Map(project.nodes.map((entry) => [entry.id, entry]));
  const recipesById = new Map(project.recipes.map((entry) => [entry.id, entry]));
  const outletCounts = countSourceOutlets(project);
  const hatchNode = nodesById.get(nodeId);
  const hatchRecipe = hatchNode ? recipesById.get(hatchNode.recipeId) : undefined;
  const machineNameOf = (id: string): string => {
    const node = nodesById.get(id);
    const recipe = node ? recipesById.get(node.recipeId) : undefined;
    return recipe?.machineType ?? recipe?.name ?? "Machine";
  };
  const storageRoles = getStorageRoles(project);
  const storageNameOf = (id: string): string => {
    const storage = storagesById.get(id);
    return storage ? describeStorage(storage, storageRoles.get(id)) : "Drawer";
  };
  const buildSide = (side: "input" | "output"): RailPort[] => {
    const isInput = side === "input";
    // A card out of the solve because its recipe was not converted has no flows: its ports are its stand-in's slots,
    // one per resource its wires carry.
    const flows = nodeResult?.unconverted ? undefined : isInput ? nodeResult?.inputs : nodeResult?.outputs;
    const resources = isInput ? displayRecipe.inputs : displayRecipe.outputs;
    const sideEdges = isInput ? incoming : outgoing;
    const ports: RailPort[] = [];
    const seen = new Set<string>();

    const pushPort = (
      key: string,
      kind: ResourceKind,
      resourceId: string,
      displayName: string | undefined,
      nameplate: number,
    ) => {
      if (seen.has(key)) {
        return;
      }
      seen.add(key);

      const slot = resources.find(
        (entry) => entry.kind === kind && entry.id === resourceId,
      );
      // The first member supplies stable color/art for non-animated contexts.
      // Keep the group identity and label; ResourceIcon cycles only its artwork.
      const face = slot && isOreDictionaryResource(slot)
        ? slot.alternatives?.find((entry) => entry.kind === slot.kind && !isOreDictionaryResource(entry))
        : undefined;
      const resource = slot && face ? {
        ...slot,
        displayName: resourceLabel(slot),
        iconPath: face.iconPath,
        iconAtlas: face.iconAtlas,
        dominantColor: face.dominantColor,
        tooltip: face.tooltip,
      } : slot;
      if (isInput && resource && !isRecipeInputConsumed(resource)) {
        return;
      }

      const edges = sideEdges.filter(
        (edge) => makeResourceKey(edge.resourceKind, edge.resourceId) === key,
      );
      const connected = edges.length > 0;
      let transferred = 0;
      let available = 0;
      let machineAsk = 0;
      let machineGet = 0;
      let storageGet = 0;
      const machineTargets = new Set<string>();
      const relayTargets = new Set<string>();
      const dumpTargets = new Set<string>();
      const trashTargets = new Set<string>();
      for (const edge of edges) {
        const edgeResult = result?.edges[edge.id];
        const rate = edgeResult?.transferredPerSecond ?? 0;
        transferred += rate;
        if (isInput) {
          available += honestInboundAvailablePerSecond(
            project,
            result,
            edge,
            storagesById.has(edge.source),
            edgeSourceHasSoleOutlet(outletCounts, edge),
          );
        } else if (trashNodeIds.has(edge.target)) {
          // The can drinks the leftovers at whatever rate they arrive; there
          // is no ask behind it to be a percentage of.
          storageGet += rate;
          trashTargets.add(edge.target);
        } else if (storagesById.has(edge.target)) {
          const relayed = relayedBufferAskPerSecond(project, result, edge.target, rate);
          if (relayed < 0) {
            // Dead end: nothing draws from the buffer — a dump, not an ask.
            storageGet += rate;
            dumpTargets.add(edge.target);
          } else {
            // The buffer relays its consumers' asks one hop upstream.
            machineAsk += Math.max(relayed, rate);
            machineGet += rate;
            relayTargets.add(edge.target);
          }
        } else {
          machineAsk += honestEdgeAskPerSecond(edgeResult, result?.nodes[edge.target], edge);
          machineGet += rate;
          machineTargets.add(edge.target);
        }
      }
      const wantedByLines = machineAsk + storageGet;

      const askRate = nameplate * Math.min(demand, 1);

      let tone: RailPort["tone"] = "ok";
      let fillFraction: number;
      let currentPerSecond: number;
      let wantedPerSecond: number;
      let couldPerSecond: number;
      let badge: RailPort["badge"];

      if (isInput) {
        currentPerSecond = connected ? transferred : nameplate * utilization;
        wantedPerSecond = askRate;
        couldPerSecond = connected ? available : nameplate;
        fillFraction = connected
          ? clamp01(askRate > RATE_EPSILON ? available / askRate : 1, 1)
          : 1;
        if (!connected) {
          // Every bare slot marked, not one crowned: they are all equally the
          // reason, and the card shows the whole list of wires to draw.
          tone = "bind";
          badge = { kind: "short", perSecond: nameplate };
        } else if (verdict.kind === "demand-set") {
          tone = "calm";
        }
      } else {
        currentPerSecond = nameplate * utilization;
        wantedPerSecond = connected ? wantedByLines : 0;
        couldPerSecond = nameplate * capable;
        fillFraction = utilization;
        // The chip is the MACHINE's story only: at full speed it reads green
        // no matter how loudly the plugs beg — "everything here is amazing,
        // it's the plug that says where's my stuff". One machine, one color.
        if (!connected) {
          // The mirror of a bare input: a product with no taker stops the
          // machine just as dead, so it is marked just as loudly. Checked
          // first because it outranks both readings below it.
          tone = "bind";
        } else if (verdict.kind === "demand-set") {
          tone = "calm";
        }
      }

      // The plug: the asker-side coupling, independent per output. Relay
      // buffers count as askers (their consumers' asks pass through); only
      // dead-end buffers are a dump.
      let plug: RailPort["plug"];
      if (!isInput && connected) {
        const demanders = machineTargets.size + relayTargets.size;
        const ask = demanders > 0 ? machineAsk : storageGet;
        const get = demanders > 0 ? machineGet : storageGet;
        const hungry =
          demanders > 0 && ask > get + Math.max(RATE_EPSILON, ask * VERDICT_EPSILON);
        plug = {
          state: demanders === 0 ? "dump" : hungry ? "hungry" : "fed",
          // A can beside a buffer is still a can: destruction is the louder
          // fact, so it names the coupling.
          dumpKind:
            demanders > 0
              ? undefined
              : trashTargets.size > 0
                ? "trash"
                : kind === "fluid"
                  ? "tank"
                  : "store",
          askerName:
            machineTargets.size === 1 && relayTargets.size === 0
              ? machineNameOf([...machineTargets][0]!)
              : machineTargets.size === 0 && relayTargets.size === 1
                ? `via ${storageNameOf([...relayTargets][0]!)}`
                : demanders > 0
                  ? `${demanders} takers`
                  : trashTargets.size > 0 && dumpTargets.size === 0
                    ? trashTargets.size === 1
                      ? "Trash Can"
                      : `${trashTargets.size} trash cans`
                    : dumpTargets.size === 1 && trashTargets.size === 0
                      ? storageNameOf([...dumpTargets][0]!)
                      : `${dumpTargets.size + trashTargets.size} dead ends`,
          askerMachines: machineTargets.size,
          askPerSecond: ask,
          getPerSecond: get,
          coveredFraction: ask > RATE_EPSILON ? clamp01(get / ask, 1) : 1,
          timesShort: hungry ? (get > RATE_EPSILON ? ask / get : Number.POSITIVE_INFINITY) : undefined,
        };
      }

      ports.push({
        side,
        key,
        kind,
        resourceId,
        supplyHatch: isInput && hatchNode && hatchRecipe
          ? getInputSupplyHatch(hatchRecipe, hatchNode, { kind, id: resourceId }) : undefined,
        hatchSupplied: Boolean(isInput && hatchNode && hatchRecipe
          && isHatchSuppliedInput(hatchRecipe, hatchNode, { kind, id: resourceId })),
        displayName: isOreDictionaryResource({ id: resourceId })
          ? resourceLabel(slot ?? { id: resourceId })
          : displayName ?? resource?.displayName ?? resourceId,
        handleId: handleFor(side, { kind, id: resourceId }),
        resource,
        connected,
        unsupplied: isInput && !connected,
        boundaryFree: false,
        currentPerSecond,
        nameplatePerSecond: nameplate,
        wantedPerSecond,
        couldPerSecond,
        fillFraction,
        tone,
        plug,
        badge,
        // A flow-less port (no books yet) has no power to divide; a power
        // port IS the EU, so it never reads as EU per EU. Inputs carry it
        // too - the EU spent per unit eaten - drawn in a much quieter gold.
        energyPerUnit:
          kind !== "power" && flows && nodeResult
            ? energyPerUnit(nodeResult.euT, nameplate)
            : undefined,
      });
    };

    if (flows) {
      // A wired port keeps its row at any rate: its row holds the handle the wire is drawn to, and a card the plan runs
      // at almost nothing (an edit elsewhere) would otherwise lose it, leaving the wire undrawn while the plan runs it.
      const wiredKeys = new Set<string>(sideEdges.map((edge) => makeResourceKey(edge.resourceKind, edge.resourceId)));
      for (const [key, flow] of Object.entries(flows)) {
        if (flow.amountPerSecond <= RATE_EPSILON && !wiredKeys.has(key)) {
          continue;
        }
        pushPort(key, flow.kind, flow.resourceId, flow.displayName, flow.amountPerSecond);
      }
    } else {
      for (const resource of resources) {
        pushPort(
          makeResourceKey(resource.kind, resource.id),
          resource.kind,
          resource.id,
          resource.displayName,
          0,
        );
      }
    }

    // Free-in-the-game inputs never reach the solver's flows and pushPort
    // skips them as non-consumed, so they are added last as inert rows:
    // the item and its name, every figure zero, no handle to wire. A bee
    // card's species rides here too: it is all that names the bee.
    if (isInput) {
      for (const resource of resources) {
        const key = makeResourceKey(resource.kind, resource.id);
        if (!(isFreeRecipeInput(resource) || isBeeSpeciesInput(resource)) || seen.has(key)) {
          continue;
        }
        seen.add(key);
        ports.push({
          side,
          key,
          kind: resource.kind,
          resourceId: resource.id,
          displayName: resource.displayName ?? resource.id,
          handleId: handleFor(side, { kind: resource.kind, id: resource.id }),
          resource,
          connected: false,
          unsupplied: false,
          boundaryFree: true,
          currentPerSecond: 0,
          nameplatePerSecond: 0,
          wantedPerSecond: 0,
          couldPerSecond: 0,
          fillFraction: 0,
          tone: "calm",
          free: true,
        });
      }
    }

    return ports;
  };

  return { inputs: buildSide("input"), outputs: buildSide("output") };
}

