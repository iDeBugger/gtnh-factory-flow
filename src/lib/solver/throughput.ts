import { hasStorageTarget } from "../model/storage-target";
import { getChanceMultiplier, isRecipeInputConsumed, makeResourceKey } from "../model/resources";
import type {
  BottleneckReport,
  EdgeThroughput,
  FactoryProject,
  FactoryStorage,
  FuelEstimate,
  NodeThroughputResult,
  Recipe,
  ResourceAmount,
  ResourceFlow,
  ResourceKey,
  ResourceKind,
  StorageThroughputResult,
  ThroughputResult,
} from "../model/types";
import { TICKS_PER_SECOND } from "../model/types";
import { applyRecipeInputOverrides } from "../model/recipe-input-overrides";
import { applyMachineHandlerToRecipe } from "../model/recipe-rules";
import { getMachineOutputMultiplier, getMachineParallelMultiplier, getMachineSettingWarning } from "./machine-effects";
import { getOverclockedRecipeStats } from "./overclock";
import {
  describePowerStall,
  getNodePowerReport,
  hasPowerReport,
  isPowerStalled,
} from "./power-report";
import {
  getRuntimeCalculationOutputs,
  runtimeCalculationWarning,
  selectRuntimeCalculationVariant,
} from "./runtime-calculation";
import { solveGraph } from "./hatch-supply";
import { planGameVersion } from "../model/game-version";
import { unconvertedWarning } from "../model/unconverted-card";
import { planSolve, type PlanUnit } from "./plan";

const EPSILON = 0.000001;

interface SolverOptions {
  generatedAt?: string;
}

type FlowRecord = Record<ResourceKey, ResourceFlow>;

/**
 * The plan's books. Every card gets its nameplate report first (overclock, parallels, power stall, runtime tables);
 * the plan solver (solver/plan) then sizes the plan and writes every rate at the solved scale.
 */
export function calculateThroughput(
  project: FactoryProject,
  options: SolverOptions = {},
): ThroughputResult {
  const gameVersion = planGameVersion(project);
  // SHARED MACHINES (shared-machine.ts): a card running several recipes is
  // solved as one hidden node per recipe section, coupled by one time row in the
  // books. The sections stay in the result under their own ids so the card
  // can read each of them back. Private hatch supplies join as hidden drawers.
  project = solveGraph(project);
  const recipesById = new Map(project.recipes.map((recipe) => [recipe.id, recipe]));
  const nodes: Record<string, NodeThroughputResult> = {};
  const storages: Record<string, StorageThroughputResult> = {};
  const bottlenecks: BottleneckReport[] = [];
  const projectStorages = project.storages ?? [];
  const planUnits: Record<string, PlanUnit> = {};

  for (const storage of projectStorages) {
    storages[storage.id] = {
      storageId: storage.id,
      kind: storage.kind,
      resourceId: storage.resourceId,
      displayName: storage.displayName,
      storedAmount: 0,
      capacity: storage.capacity ?? getDefaultStorageCapacity(storage),
      producedPerSecond: 0,
      consumedPerSecond: 0,
      netPerSecond: 0,
      status: "empty",
    };
  }

  for (const node of project.nodes) {
    const recipe = recipesById.get(node.recipeId);

    // A card (or a shared card's section) whose recipe was not converted to the plan's version is out of the solve,
    // even when a body under its id still resolves: those numbers are not its version's. Its wires are the plan's edge
    // (the plan adapter reads them as outside inputs and outputs), so the plan still solves: a warning, not a failure.
    if (node.unconverted) {
      nodes[node.id] = {
        nodeId: node.id,
        recipeId: node.recipeId,
        recipeName: node.unconverted.recipeName,
        enabled: node.enabled,
        operationRatePerSecond: 0,
        inputs: {},
        outputs: {},
        euT: 0,
        requiredRatePerSecond: 0,
        maxRatePerSecond: 0,
        utilization: 0,
        theoreticalMachinesRequired: 0,
        status: "missing-recipe",
        unconverted: true,
        warnings: [unconvertedWarning(gameVersion)],
      };
      bottlenecks.push({
        id: `missing-recipe:${node.id}`,
        kind: "missing-recipe",
        severity: "warning",
        message: `Node ${node.id} holds recipe ${node.recipeId}, which was not converted.`,
        nodeId: node.id,
      });
      continue;
    }

    if (!recipe) {
      nodes[node.id] = {
        nodeId: node.id,
        recipeId: node.recipeId,
        recipeName: "Missing recipe",
        enabled: node.enabled,
        operationRatePerSecond: 0,
        inputs: {},
        outputs: {},
        euT: 0,
        requiredRatePerSecond: 0,
        maxRatePerSecond: 0,
        utilization: 0,
        theoreticalMachinesRequired: 0,
        status: "missing-recipe",
        warnings: [`Recipe "${node.recipeId}" does not exist.`],
      };
      bottlenecks.push({
        id: `missing-recipe:${node.id}`,
        kind: "missing-recipe",
        severity: "critical",
        message: `Node ${node.id} references missing recipe ${node.recipeId}.`,
        nodeId: node.id,
      });
      continue;
    }

    if (!node.enabled) {
      nodes[node.id] = buildDisabledNodeResult(node.id, recipe);
      continue;
    }

    const nodeRecipe = applyRecipeInputOverrides(recipe, node, gameVersion);
    const effectiveRecipe = applyMachineHandlerToRecipe(nodeRecipe, node, gameVersion);
    const overclockedRecipe = getOverclockedRecipeStats(nodeRecipe, node, gameVersion);
    const runtimeVariant = selectRuntimeCalculationVariant(effectiveRecipe, node, gameVersion);
    const runtimeOutputs = getRuntimeCalculationOutputs(effectiveRecipe, node, gameVersion);
    const machineParallelMultiplier =
      runtimeVariant?.parallel ?? getMachineParallelMultiplier(effectiveRecipe, node, gameVersion);
    // A build the game would refuse to start is flagged, not blanked: rates
    // stay nameplate so ports and wires keep their shape, and the card's power
    // cell says why.
    const powerReport = hasPowerReport(nodeRecipe)
      ? getNodePowerReport(nodeRecipe, node, gameVersion)
      : undefined;
    const powerStall = powerReport && isPowerStalled(powerReport) ? powerReport : undefined;
    const operationRatePerSecond =
      (node.machineCount * node.parallel * machineParallelMultiplier * TICKS_PER_SECOND) /
      overclockedRecipe.durationTicks;
    const inputs: FlowRecord = {};
    const outputs: FlowRecord = {};

    for (const input of nodeRecipe.inputs) {
      if (!isRecipeInputConsumed(input)) {
        continue;
      }

      const amountPerSecond = input.amount * operationRatePerSecond;
      addFlow(inputs, input, amountPerSecond);
    }

    for (const output of runtimeOutputs ?? effectiveRecipe.outputs) {
      const amountPerSecond =
        output.amount *
        getChanceMultiplier(effectiveRecipe, output) *
        (runtimeOutputs
          ? 1
          : getMachineOutputMultiplier(effectiveRecipe, node, output, overclockedRecipe.tier, gameVersion)) *
        operationRatePerSecond;
      addFlow(outputs, output, amountPerSecond);
    }

    const euT =
      overclockedRecipe.eut * node.machineCount * node.parallel * machineParallelMultiplier;
    planUnits[node.id] = {
      durationTicks: overclockedRecipe.durationTicks,
      throughputFactor: node.parallel * machineParallelMultiplier,
    };

    nodes[node.id] = {
      nodeId: node.id,
      recipeId: recipe.id,
      recipeName: recipe.name,
      enabled: true,
      operationRatePerSecond,
      inputs,
      outputs,
      euT,
      powerStalled: Boolean(powerStall),
      requiredRatePerSecond: 0,
      maxRatePerSecond: 0,
      utilization: 0,
      theoreticalMachinesRequired: 0,
      status: "underutilized",
      warnings: [
        powerStall ? describePowerStall(powerStall) : undefined,
        runtimeCalculationWarning(effectiveRecipe, node, gameVersion),
        getMachineSettingWarning(effectiveRecipe, node, gameVersion),
      ].filter((warning): warning is string => Boolean(warning)),
    };
  }

  return planSolve({
    project,
    nodes,
    storages,
    projectStorages,
    bottlenecks,
    options,
    units: planUnits,
    helpers: { buildEdgeResult, refreshStorageResultsFromEdges, calculateFuelEstimate },
  });
}

/**
 * The cheap UI-side question check: any typed amount on any drawer, any pin
 * on any enabled card, no role walk. The notice and the blinking rate line
 * use this on every store write, so it must stay O(n) over ids alone.
 */
export function hasAnySolveNumbers(project: FactoryProject): boolean {
  // Every drawer asks this on every store write (a hover is one), so it is worked out once per project object: the
  // store replaces the project on every edit. 500 drawers over 1,500 nodes were 750,000 checks a hover.
  let known = solveNumbersByProject.get(project);
  if (known === undefined) {
    known = projectHasSolveNumbers(project);
    solveNumbersByProject.set(project, known);
  }
  return known;
}

const solveNumbersByProject = new WeakMap<FactoryProject, boolean>();

function projectHasSolveNumbers(project: FactoryProject): boolean {
  return (
    (project.storages ?? []).some(
      (storage) =>
        hasStorageTarget(storage) &&
        // A byproduct or trash drawer's number is DORMANT (typed while it
        // was a product, kept for the flip back): it asks nothing, so it
        // must not silence the needs-a-number notice.
        storage.drainMode !== "byproduct" &&
        storage.drainMode !== "trash",
    ) || project.nodes.some((node) => node.enabled && (node.solvePin ?? 0) > 0)
  );
}

function buildDisabledNodeResult(nodeId: string, recipe: Recipe): NodeThroughputResult {
  return {
    nodeId,
    recipeId: recipe.id,
    recipeName: recipe.name,
    enabled: false,
    operationRatePerSecond: 0,
    inputs: {},
    outputs: {},
    euT: 0,
    requiredRatePerSecond: 0,
    maxRatePerSecond: 0,
    utilization: 0,
    theoreticalMachinesRequired: 0,
    status: "disabled",
    warnings: [],
  };
}

function addFlow(record: FlowRecord, resource: ResourceAmount, amountPerSecond: number): void {
  const key = makeResourceKey(resource.kind, resource.id);
  const existing = record[key];

  record[key] = {
    key,
    kind: resource.kind,
    resourceId: resource.id,
    displayName: resource.displayName,
    alternatives: resource.alternatives ?? existing?.alternatives,
    amountPerSecond: (existing?.amountPerSecond ?? 0) + amountPerSecond,
  };
}

function refreshStorageResultsFromEdges(
  projectStorages: FactoryStorage[],
  storages: Record<string, StorageThroughputResult>,
  edges: FactoryProject["edges"],
  edgeResults: Record<string, EdgeThroughput>,
): void {
  const storageIds = new Set(projectStorages.map((storage) => storage.id));

  for (const storage of projectStorages) {
    const result = storages[storage.id];
    if (!result) {
      continue;
    }

    result.producedPerSecond = 0;
    result.consumedPerSecond = 0;
    result.netPerSecond = 0;
    result.storedAmount = 0;
    result.status = "empty";
  }

  for (const edge of edges) {
    const edgeResult = edgeResults[edge.id];
    if (!edgeResult) {
      continue;
    }

    if (storageIds.has(edge.target) && !storageIds.has(edge.source)) {
      updateStorageFlow(storages[edge.target], edgeResult.transferredPerSecond, 0);
    } else if (storageIds.has(edge.source) && !storageIds.has(edge.target)) {
      updateStorageFlow(storages[edge.source], 0, edgeResult.transferredPerSecond);
    } else if (storageIds.has(edge.source) && storageIds.has(edge.target)) {
      // A drawer-to-drawer line: outflow for the feeder, inflow for the fed,
      // so both tiles' net figures carry the move.
      updateStorageFlow(storages[edge.target], edgeResult.transferredPerSecond, 0);
      updateStorageFlow(storages[edge.source], 0, edgeResult.transferredPerSecond);
    }
  }

  // Each drawer reports ITS OWN wires, never a total over every drawer of the
  // same item. Project-wide totals are `balances.ts`'s job.
  for (const storageResult of Object.values(storages)) {
    finalizeStorageFlow(storageResult);
  }
}

function buildEdgeResult(
  edge: { id: string; resourceKind: ResourceKind; resourceId: string; label?: string },
  key: ResourceKey,
  demandPerSecond: number,
  transferredPerSecond: number,
  capacities?: {
    nameplateDemandPerSecond: number;
    sourceCapacityPerSecond: number;
    availablePerSecond?: number;
  },
): EdgeThroughput {
  // Falling back to the converged demand keeps callers that have no nameplate
  // context reporting "full" rather than inventing a shortfall.
  const nameplateDemandPerSecond = capacities?.nameplateDemandPerSecond ?? demandPerSecond;
  const sourceCapacityPerSecond = capacities?.sourceCapacityPerSecond ?? transferredPerSecond;

  return {
    availablePerSecond: capacities?.availablePerSecond ?? transferredPerSecond,
    edgeId: edge.id,
    resource: {
      key,
      kind: edge.resourceKind,
      resourceId: edge.resourceId,
      displayName: edge.label,
      amountPerSecond: transferredPerSecond,
    },
    demandPerSecond,
    transferredPerSecond,
    isLimited: transferredPerSecond + EPSILON < demandPerSecond,
    nameplateDemandPerSecond,
    sourceCapacityPerSecond,
    constraint: classifyEdgeConstraint(
      transferredPerSecond,
      nameplateDemandPerSecond,
      sourceCapacityPerSecond,
    ),
  };
}

function classifyEdgeConstraint(
  transferredPerSecond: number,
  nameplateDemandPerSecond: number,
  sourceCapacityPerSecond: number,
): EdgeThroughput["constraint"] {
  if (transferredPerSecond + EPSILON >= nameplateDemandPerSecond) {
    return "full";
  }

  // The consumer is short. Blame the producer only when it has nothing left to
  // give; otherwise both ends have slack and the plan simply wants less.
  return transferredPerSecond + EPSILON >= sourceCapacityPerSecond ? "supply" : "demand";
}

function getDefaultStorageCapacity(storage: FactoryStorage): number {
  return storage.kind === "fluid" ? 4_000_000 : 262_144;
}

function updateStorageFlow(
  storage: StorageThroughputResult | undefined,
  producedPerSecond: number,
  consumedPerSecond: number,
) {
  if (!storage) {
    return;
  }

  storage.producedPerSecond += producedPerSecond;
  storage.consumedPerSecond += consumedPerSecond;
}

function finalizeStorageFlow(storage: StorageThroughputResult) {
  storage.netPerSecond = storage.producedPerSecond - storage.consumedPerSecond;
  storage.storedAmount = Math.max(0, Math.min(storage.capacity, storage.netPerSecond));

  if (storage.producedPerSecond <= EPSILON && storage.consumedPerSecond <= EPSILON) {
    storage.status = "empty";
  } else if (Math.abs(storage.netPerSecond) <= EPSILON) {
    storage.status = "balanced";
  } else if (storage.netPerSecond > 0) {
    storage.status = "filling";
  } else {
    storage.status = "draining";
  }
}

function calculateFuelEstimate(
  project: FactoryProject,
  totalEuT: number,
): FuelEstimate | undefined {
  const selectedFuel = project.fuelProfiles.find(
    (fuel) => fuel.id === project.selectedFuelProfileId,
  );

  if (!selectedFuel) {
    return undefined;
  }

  const totalEuPerSecond = totalEuT * TICKS_PER_SECOND;

  if (selectedFuel.euPerLiter) {
    return {
      fuelProfile: selectedFuel,
      totalEuPerSecond,
      fuelPerSecond: totalEuPerSecond / selectedFuel.euPerLiter,
      unit: "L/s",
    };
  }

  if (selectedFuel.euPerBucket) {
    return {
      fuelProfile: selectedFuel,
      totalEuPerSecond,
      fuelPerSecond: totalEuPerSecond / selectedFuel.euPerBucket,
      unit: "buckets/s",
    };
  }

  return undefined;
}

