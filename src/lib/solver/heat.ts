import {
  getRecipeCoilTierControl,
  getRecipeSpecialValue,
} from "@/lib/model/recipe-rules";
import { getMachineBehaviour } from "@/lib/machines/machine-table";
import { powInt } from "@/lib/machines/java-float";
import { getVoltageTierIndex } from "@/lib/model/tiers";
import type { FactoryNode, MachineTier, Recipe } from "@/lib/model/types";
import type { GameVersion } from "@/lib/model/game-version";

const VOLTAGE_TIER_INDEX_MV = 2;

type VoltageTier = Exclude<MachineTier, "DEMO">;
type HeatRecipeInput = Partial<
  Pick<Recipe, "machineType" | "source" | "nei" | "machineConfigControls" | "metadata">
>;

export interface HeatOverclockStats {
  heatOverclockSteps: number;
  regularOverclockSteps: number;
  heatDiscountMultiplier: number;
}

/**
 * The machines that overclock on heat, straight from their Java.
 *
 * Each one hands `OverclockCalculator` a machine heat and gets a perfect
 * overclock per 1800 K of excess over the recipe's requirement, and - if it
 * asks for the discount - 5% off EU/t per 900 K. What differs per machine is
 * how the machine heat is computed, and the table's `heat` config records it:
 *
 *   - The Electric Blast Furnace, Mega Blast Furnace and Exothermic Hearth add
 *     100 K per voltage tier above MV on top of the coils (`voltageBonus`).
 *   - Volcanus and the Utupu-Tanuri use the raw coil heat, nothing added.
 *   - Zyngen counts its coils double (`coilHeatMultiplier: 2`), because its
 *     bonus is one perfect overclock per 900 K rather than 1800, and takes no
 *     EU discount at all (`discount: false`).
 *
 * Every other coil in GTNH buys something else - speed on the chem plant and
 * pyrolyse oven, an EU discount on the oil cracker and coke oven - or nothing,
 * as on the large chemical reactor, whose lone cupronickel block is pure
 * structure. The list has to be explicit because every coil block carries a
 * heat capacity whether or not the machine reads it, and every recipe carries
 * a "Special value" line whose meaning depends on the recipe map.
 */
export function isHeatOverclockMachine(machineType: string | undefined, gameVersion: GameVersion): boolean {
  // Match the machine, never the recipe map: an Industrial Arc Furnace running
  // a blast furnace recipe overclocks on its electrodes, not on heat.
  return getMachineBehaviour(machineType, gameVersion)?.overclock === "heat";
}

export function getHeatOverclockStats(
  recipe: HeatRecipeInput,
  node: Pick<FactoryNode, "coilTier" | "machineConfigTiers" | "machineHandlerId">,
  tier: VoltageTier,
  overclockSteps: number,
  gameVersion: GameVersion,
  /**
   * The voltage-tier ordinal the +100 K bonus reads, which stacked hatches
   * can push above the hatch tier (`getTier` of the SUMMED hatch voltage).
   * Defaults to the tier's own ordinal.
   */
  voltageOrdinal?: number,
): HeatOverclockStats {
  const specialValue = getRecipeSpecialValue(recipe);
  const coilControl = recipe.machineType
    ? getRecipeCoilTierControl(
        {
          machineType: recipe.machineType,
          source: recipe.source,
          nei: recipe.nei,
          machineConfigControls: recipe.machineConfigControls,
        },
        node,
        gameVersion,
      )
    : undefined;
  // A requirement of zero is a real number, not a gap: dehydrator recipes are
  // low temperature and start from 0 K, so every coil clears them outright.
  // Only the machine list keeps this off machines with no heat mechanic; the
  // value itself is trusted whenever the machine is one that reads it.
  if (
    specialValue === undefined ||
    specialValue < 0 ||
    !coilControl?.current.heat ||
    !isHeatOverclockMachine(recipe.machineType, gameVersion)
  ) {
    return {
      heatOverclockSteps: 0,
      regularOverclockSteps: overclockSteps,
      heatDiscountMultiplier: 1,
    };
  }

  const heatConfig = getMachineBehaviour(recipe.machineType, gameVersion)?.heat;
  const coilHeat = coilControl.current.heat * (heatConfig?.coilHeatMultiplier ?? 1);
  // Only the blast furnaces and the Exothermic Hearth add 100 K per voltage
  // tier above MV; Volcanus and the Utupu-Tanuri read their coils raw.
  const effectiveOrdinal = voltageOrdinal ?? getVoltageTierIndex(tier);
  const machineHeat = heatConfig?.voltageBonus
    ? coilHeat + 100 * Math.max(0, effectiveOrdinal - VOLTAGE_TIER_INDEX_MV)
    : coilHeat;
  const heatExcess = Math.max(0, machineHeat - specialValue);
  const heatOverclockSteps = Math.min(overclockSteps, Math.floor(heatExcess / 1800));

  return {
    heatOverclockSteps,
    regularOverclockSteps: overclockSteps - heatOverclockSteps,
    heatDiscountMultiplier:
      // OverclockCalculator.calculateHeatDiscountMultiplier: GTUtility.powInt(0.95, excess / 900)
      // (GT5U@5.09.54.205 OverclockCalculator.java:346-349, GT5U@5.09.51.476 :327-330).
      heatConfig?.discount === false ? 1 : powInt(0.95, Math.floor(heatExcess / 900)),
  };
}

/**
 * The heat discount alone, for callers that need it before the overclock is
 * settled. The game folds it into the recipe's EU/t before parallels are paid
 * for (`ParallelHelper.determineParallel`), so a hot enough blast furnace fits
 * more parallels into the same hatch.
 */
export function getHeatDiscountMultiplier(
  recipe: HeatRecipeInput,
  node: Pick<FactoryNode, "coilTier" | "machineConfigTiers" | "machineHandlerId">,
  tier: VoltageTier,
  gameVersion: GameVersion,
  voltageOrdinal?: number,
): number {
  return getHeatOverclockStats(recipe, node, tier, 0, gameVersion, voltageOrdinal).heatDiscountMultiplier;
}
