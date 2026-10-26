import { orderNames, rateOrderKey } from "./rate-order";
import type { FactoryProject, MachineTier, ThroughputResult } from "./types";
import { getSelectedMachineHandler } from "./recipe-rules";
import { applyRecipeInputOverrides } from "./recipe-input-overrides";
import { isCustomRateRecipe } from "./custom-rate";
import { listNodeSections } from "./shared-machine";
import { getVoltageTierIndex, isVoltageTierName } from "./tiers";
import {
  CROP_HARVESTER_INDUSTRIAL_FARM_ID,
  cropsNhEnvironmentFromTiers,
  cropsNhFarmEut,
  cropsNhHarvestTicks,
  cropsNhHarvesterFromTiers,
  cropsNhHarvesterMachineCount,
  cropsNhHarvesterTierName,
  cropsNhIsHandPicked,
  cropsNhManagerEuPerHarvest,
  getCropsNhStats,
  isCropProductionRecipe,
} from "./passive-production";
import {
  getNodePowerReport,
  getNodeSteamReport,
  hasPowerReport,
  type NodePowerState,
} from "@/lib/solver/power-report";
import { getEnergyHatchType } from "@/lib/machines/energy-hatches";
import { planGameVersion } from "@/lib/model/game-version";

type VoltageTier = Exclude<MachineTier, "DEMO">;

/** One board card, even when another card has the identical recipe/settings. */
export interface MachineListEntry {
  nodeId: string;
  label: string;
  handlerId: string;
  powerSourceId?: string;
  count: number;
  hatches: number;
  hatchChip?: string;
  hatchTypeId?: string;
  typedEuT?: number;
  amps?: number;
  isMultiblock: boolean;
  tier?: VoltageTier;
  tierIndex: number;
  euT?: number;
  steamLs?: number;
  madeEuT?: number;
  avgEuT?: number;
  avgSteamLs?: number;
  avgMadeEuT?: number;
  pressure?: "bronze" | "high-pressure";
  state: NodePowerState;
}

const nonnegative = (value: number) => (Number.isFinite(value) ? Math.max(0, value) : 0);

export function buildMachineList(
  project: FactoryProject,
  result: ThroughputResult,
): MachineListEntry[] {
  const gameVersion = planGameVersion(project);
  const recipes = new Map(project.recipes.map((recipe) => [recipe.id, recipe]));
  const solving = project.solveMode === true || project.poolMode === true;
  const entries: MachineListEntry[] = [];
  for (const node of project.nodes) {
    const recipe = recipes.get(node.recipeId);
    if (!node.enabled || !recipe || isCustomRateRecipe(recipe)) continue;
    const handler = getSelectedMachineHandler(recipe, node);
    const cropStats = getCropsNhStats(recipe);
    const crop = cropStats
      ? cropsNhHarvesterFromTiers(
          node.machineConfigTiers,
          node.machineHandlerId,
          cropStats.minSeedBedTier,
          cropStats.subSoil !== undefined,
        )
      : undefined;
    if (crop ? cropsNhIsHandPicked(crop) : isCropProductionRecipe(recipe)) continue;

    const sections = listNodeSections(node).map(({ node: view }) => {
      const raw = recipes.get(view.recipeId);
      const effective = raw ? applyRecipeInputOverrides(raw, view, gameVersion) : undefined;
      const steam = effective ? getNodeSteamReport(effective, view, gameVersion) : undefined;
      return {
        steam,
        report:
          effective && !steam && hasPowerReport(effective)
            ? getNodePowerReport(effective, view, gameVersion)
            : undefined,
        required: nonnegative(result.nodes[view.id]?.theoreticalMachinesRequired ?? 0),
        usage: Math.min(1, nonnegative(result.nodes[view.id]?.utilization ?? 1)),
      };
    });
    const required = sections.reduce((sum, part) => sum + part.required, 0);
    const usage = Math.min(
      1,
      sections.reduce((sum, part) => sum + part.usage, 0),
    );
    const units = solving ? required : nonnegative(node.machineCount);
    // Crop counts on the board are seeds; the list counts the actual harvesters.
    const seeds = solving
      ? Math.max(0, Math.ceil(units - 0.000001))
      : Math.max(0, Math.round(units));
    const count = crop ? cropsNhHarvesterMachineCount(crop, seeds) : units;
    // Parallel processing affects draw, never the number of physical machines.
    const parallel = Math.max(1, node.parallel);
    const runningCount = solving || usage > 0 ? count : 0;
    const report = sections[0]?.report;
    const steam = sections[0]?.steam;
    const peakDraw = Math.max(0, ...sections.map((part) => part.report?.drawEuT ?? 0));
    const average = (draw: (part: (typeof sections)[number]) => number) =>
      sections.reduce(
        (sum, part) => sum + draw(part) * (solving ? part.required : units * part.usage) * parallel,
        0,
      );

    const cropEuT = (() => {
      if (!crop || !cropStats) return undefined;
      if (crop.id === CROP_HARVESTER_INDUSTRIAL_FARM_ID) return cropsNhFarmEut(crop) * count;
      const ticks = cropsNhHarvestTicks(
        cropStats,
        cropsNhEnvironmentFromTiers(node.machineConfigTiers),
      );
      return Number.isFinite(ticks) && ticks > 0
        ? (cropsNhManagerEuPerHarvest(crop) * seeds) / ticks
        : 0;
    })();
    const powerEuT = recipe.power?.euPerTick;
    const madeEuT =
      powerEuT !== undefined && powerEuT >= 0 ? powerEuT * runningCount * parallel : undefined;
    const euT = report
      ? peakDraw * runningCount * parallel
      : cropEuT !== undefined
        ? solving || usage > 0
          ? cropEuT
          : 0
        : powerEuT !== undefined && powerEuT < 0
          ? -powerEuT * runningCount * parallel
          : undefined;
    const avgEuT = report
      ? average((part) => part.report?.drawEuT ?? 0)
      : euT !== undefined
        ? euT * (solving ? 1 : usage)
        : undefined;
    const steamLs = steam
      ? Math.max(...sections.map((part) => part.steam?.drawSteamPerTick ?? 0)) *
        20 *
        runningCount *
        parallel
      : undefined;
    const avgSteamLs = steam
      ? average((part) => (part.steam?.drawSteamPerTick ?? 0) * 20)
      : undefined;
    const cropTier = crop ? (cropsNhHarvesterTierName(crop.tierIndex) as VoltageTier) : undefined;
    // A power card's `tier` setting is a voltage for the singleblock
    // generators but a plain number on the heat exchangers (their pipe tier),
    // which the list must not read as a voltage.
    const powerSetting = recipe.power ? node.machineConfigTiers?.tier : undefined;
    const powerTier = isVoltageTierName(powerSetting) ? powerSetting : undefined;
    const tier = report?.tier ?? cropTier ?? powerTier;
    entries.push({
      nodeId: node.id,
      label: handler.label,
      handlerId: handler.id,
      powerSourceId: recipe.power?.sourceId,
      count,
      hatches: report?.hatches ?? 1,
      hatchChip: report?.hatchChip,
      hatchTypeId: report?.isMultiblock ? getEnergyHatchType(node.energyHatchType).id : undefined,
      typedEuT: report?.isMultiblock && report.typedBudget ? report.poolEuT : undefined,
      amps: report?.amps,
      isMultiblock:
        report?.isMultiblock ??
        steam?.isMultiblock ??
        crop?.id === CROP_HARVESTER_INDUSTRIAL_FARM_ID,
      tier,
      tierIndex: tier ? getVoltageTierIndex(tier) : steam ? 0 : Number.POSITIVE_INFINITY,
      euT,
      avgEuT,
      steamLs,
      avgSteamLs,
      madeEuT,
      avgMadeEuT: madeEuT !== undefined ? madeEuT * (solving ? 1 : usage) : undefined,
      pressure: steam ? (steam.highPressure ? "high-pressure" : "bronze") : undefined,
      state: report?.state ?? "ok",
    });
  }
  // Tier, then EU/t biggest first on the rate key (`rate-order.ts`), then name, then the board's card order: two
  // cards whose draws match to nine digits keep their places when a re-solve moves the last bits. Entries are pushed in
  // card order, so the index is the card order.
  const keyed = entries.map((entry, index) => ({
    entry,
    euT: rateOrderKey(entry.euT ?? 0),
    index,
  }));
  keyed.sort((a, b) => {
    if (a.entry.tierIndex !== b.entry.tierIndex)
      return a.entry.tierIndex < b.entry.tierIndex ? -1 : 1;
    if (a.euT !== b.euT) return b.euT > a.euT ? 1 : -1;
    return orderNames.compare(a.entry.label, b.entry.label) || a.index - b.index;
  });
  return keyed.map((k) => k.entry);
}

/** Keep fractional answers at large counts too; never round up to a build. */
export function formatMachineListCount(count: number): string {
  return count > 0 && count < 0.000001
    ? "<0.000001"
    : count.toLocaleString("en-US", { maximumFractionDigits: 6 });
}
