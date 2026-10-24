import { hasAmperageOverclock } from "./power-input-rules";
import { getFusionStats } from "@/lib/machines/fusion";
import { getEecMetadata, getEecSettings, getEecStats } from "@/lib/machines/extreme-entity-crusher";
import { getTgsStats, isTgsRecipe } from "@/lib/machines/tree-growth-simulator";
import {
  GT_VOLTAGE_TIERS,
  getRecipeMinimumVoltageTier,
  getVoltageTierIndex,
  getVoltageTierMaxEuT,
} from "@/lib/model/tiers";
import { applyMachineHandlerToRecipe } from "@/lib/model/recipe-rules";
import { getHeatOverclockStats } from "./heat";
import { getEffectiveVoltageOrdinal, getNodePowerAmps, getNodeRunTier, isMultiblockRecipe } from "./power";
import {
  buildMachineContext,
  getBeeMegaApiaryTierEutMultiplier,
  getMachineDurationMultiplier,
  getMachineEutMultiplier,
  getMachineParallelMultiplier,
  isMegaApiaryMachineType,
} from "./machine-effects";
import {
  getMachineBehaviour,
  HEAT_OVERCLOCK,
  OVERCLOCK,
  resolveOverclockSpec,
  type OverclockRule,
} from "@/lib/machines/machine-table";

import { getCropsNhStats, isIndustrialApiaryMachineType } from "@/lib/model/passive-production";
import type { FactoryNode, MachineTier, Recipe } from "@/lib/model/types";
import type { GameVersion } from "@/lib/model/game-version";
import {
  resolveRuntimeTier,
  runtimeOverclockSteps,
  selectRuntimeCalculationVariant,
} from "./runtime-calculation";

type VoltageTier = Exclude<MachineTier, "DEMO">;
type OverclockRecipeInput = Pick<Recipe, "durationTicks" | "eut" | "minimumTier"> &
  Partial<
    Pick<
      Recipe,
      | "machineType"
      | "source"
      | "nei"
      | "machineHandlers"
      | "machineProfile"
      | "machineConfigControls"
      | "runtimeCalculation"
      | "metadata"
    >
  >;

export interface OverclockedRecipeStats {
  tier: VoltageTier;
  minimumTier: VoltageTier;
  overclockSteps: number;
  /**
   * How many of the steps are perfect (machine or heat) overclocks, taken
   * FIRST; the rest are normal steps. Runtime-ladder machines report 0: the
   * game's export never says which kind its ladder took.
   */
  perfectOverclockSteps: number;
  /** A perfect step's duration divisor. A normal step always halves. */
  perfectSpeedFactor: number;
  /** A perfect step's EU/t multiplier. A normal step always pays 4×. */
  perfectEuFactor: number;
  durationTicks: number;
  /** One recipe's share of the machine's bill. */
  eut: number;
  /**
   * The whole bill for every parallel, a whole EU/t as the game ceils it. Set
   * on the overclock-calculator path; read it rather than `eut x parallels`,
   * which can land a hair off the whole number.
   */
  machineEuT?: number;
}

/** The step shape every non-curated branch reports: plain ×4/÷2 counting. */
const PLAIN_OVERCLOCK_STEPS = {
  perfectOverclockSteps: 0,
  perfectSpeedFactor: 4,
  perfectEuFactor: 4,
} as const;

export function getOverclockedRecipeStats(
  recipe: OverclockRecipeInput,
  node: Pick<
    FactoryNode,
    "overclockTier" | "coilTier" | "machineHandlerId" | "machineConfigTiers"
  > &
    Partial<
      Pick<
        FactoryNode,
        "energyHatches" | "energyHatchType" | "powerEuT" | "hatchVoltageTier" | "hatchAmps" | "powerInputMode"
      >
    >,
  gameVersion: GameVersion,
): OverclockedRecipeStats {
  // A power card's rates are the model's own (src/lib/power): no handler
  // stats, no overclock ladder, no steam rebilling - the recipe as written.
  if ((recipe as Recipe).power) {
    return {
      tier: getRecipeMinimumVoltageTier(recipe),
      minimumTier: getRecipeMinimumVoltageTier(recipe),
      overclockSteps: 0,
      ...PLAIN_OVERCLOCK_STEPS,
      durationTicks: recipe.durationTicks,
      eut: recipe.eut,
    };
  }
  const effectiveRecipe = recipe.machineType
    ? applyMachineHandlerToRecipe(recipe as Recipe, node, gameVersion)
    : recipe;
  const minimumTier = getRecipeMinimumVoltageTier(effectiveRecipe);
  const fusion = getFusionStats(effectiveRecipe);
  if (fusion) {
    return {
      tier: fusion.tier, minimumTier,
      overclockSteps: fusion.steps, perfectOverclockSteps: fusion.steps,
      perfectSpeedFactor: fusion.factor, perfectEuFactor: fusion.factor,
      durationTicks: quantiseDurationToTicks(fusion.durationTicks, true), eut: fusion.eut,
    };
  }
  // A multiblock's pick stands even below the recipe's minimum - an
  // underpowered build is shown as one (power-report.ts names the state),
  // never silently promoted. A singleblock is floored at the minimum, because
  // a lower machine does not exist to be built.
  const tier = getNodeRunTier(effectiveRecipe, node, gameVersion);
  const eec = getEecMetadata(effectiveRecipe);
  if (eec) {
    // kubatech's own overclock, infernals and ritual; the duration returned
    // is per kill, with the past-floor output multiplier folded in.
    const stats = getEecStats(
      eec,
      getEecSettings(node.machineConfigTiers),
      getVoltageTierMaxEuT(tier) * getNodePowerAmps(effectiveRecipe, node, gameVersion),
    );
    return {
      tier,
      minimumTier,
      overclockSteps: stats.steps,
      perfectOverclockSteps: stats.steps,
      perfectSpeedFactor: 4,
      perfectEuFactor: 4,
      durationTicks: stats.durationTicks,
      eut: stats.eut,
    };
  }
  if (isTgsRecipe(effectiveRecipe)) {
    // MTETreeFarm: 100 ticks at any voltage, VP[t] EU/t, t the tier of the hatches' V x A rounded up. The tier
    // reported is t, which the output multiplier reads.
    const tgs = getTgsStats(getVoltageTierMaxEuT(tier) * getNodePowerAmps(effectiveRecipe, node, gameVersion));
    return {
      tier: GT_VOLTAGE_TIERS[tgs.t]?.tier ?? tier,
      minimumTier,
      overclockSteps: 0,
      ...PLAIN_OVERCLOCK_STEPS,
      durationTicks: tgs.durationTicks,
      eut: tgs.eut,
    };
  }
  const overclockSteps = Math.max(0, getVoltageTierIndex(tier) - getVoltageTierIndex(minimumTier));
  const runtimeVariant = selectRuntimeCalculationVariant(effectiveRecipe, node, gameVersion);
  if (runtimeVariant) {
    const runtimeTier = resolveRuntimeTier(runtimeVariant, tier);
    return {
      tier: runtimeTier,
      minimumTier,
      overclockSteps: runtimeOverclockSteps(runtimeTier, minimumTier),
      ...PLAIN_OVERCLOCK_STEPS,
      durationTicks: runtimeVariant.durationTicks,
      eut: runtimeVariant.eut,
    };
  }
  if (getCropsNhStats(effectiveRecipe)) {
    // A crop grows at the world's pace: voltage buys nothing on a crop card,
    // so a 0 EU recipe must not "afford" free overclock steps. The crop's own
    // knobs (environment, harvester) move the duration through the machine
    // duration multiplier instead.
    return {
      tier,
      minimumTier,
      overclockSteps: 0,
      ...PLAIN_OVERCLOCK_STEPS,
      durationTicks: Math.max(
        1,
        effectiveRecipe.durationTicks *
          getMachineDurationMultiplier(effectiveRecipe as Recipe, node, gameVersion),
      ),
      eut: effectiveRecipe.eut,
    };
  }
  if (effectiveRecipe.machineType && isIndustrialApiaryMachineType(effectiveRecipe.machineType)) {
    const durationMultiplier = getMachineDurationMultiplier(effectiveRecipe as Recipe, node, gameVersion);
    const eutMultiplier = getMachineEutMultiplier(effectiveRecipe as Recipe, node, gameVersion);
    return {
      tier: minimumTier,
      minimumTier,
      overclockSteps: 0,
      ...PLAIN_OVERCLOCK_STEPS,
      durationTicks: Math.max(1, effectiveRecipe.durationTicks * durationMultiplier),
      eut: effectiveRecipe.eut * eutMultiplier,
    };
  }
  if (effectiveRecipe.machineType && isMegaApiaryMachineType(effectiveRecipe.machineType)) {
    const eutMultiplier =
      getMachineEutMultiplier(effectiveRecipe as Recipe, node, gameVersion) *
      getBeeMegaApiaryTierEutMultiplier(tier);
    return {
      tier,
      minimumTier,
      overclockSteps,
      ...PLAIN_OVERCLOCK_STEPS,
      durationTicks: effectiveRecipe.durationTicks,
      eut: effectiveRecipe.eut * eutMultiplier,
    };
  }

  const durationMultiplier = effectiveRecipe.machineType
    ? getMachineDurationMultiplier(effectiveRecipe as Recipe, node, gameVersion)
    : 1;
  const eutMultiplier = effectiveRecipe.machineType
    ? getMachineEutMultiplier(effectiveRecipe as Recipe, node, gameVersion)
    : 1;

  // The heat discount is independent of how many steps end up taken, and the
  // parallel budget needs it first: ParallelHelper folds it into the draw.
  const effectiveVoltageOrdinal = getEffectiveVoltageOrdinal(effectiveRecipe, node, tier, gameVersion);
  const heatDiscountMultiplier = getHeatOverclockStats(
    effectiveRecipe,
    node,
    tier,
    0,
    gameVersion,
    effectiveVoltageOrdinal,
  ).heatDiscountMultiplier;

  // Parallels are spent before overclocks: they multiply EU/t one-for-one, so
  // only the voltage headroom left over after every parallel is paid for can
  // buy an overclock. A chem plant running six parallels of a 480 EU/t recipe
  // draws 2880 EU/t, which already fills an IV hatch - no overclock, however
  // far above the recipe's HV minimum the machine is powered.
  const parallels = effectiveRecipe.machineType
    ? getMachineParallelMultiplier(effectiveRecipe as Recipe, node, gameVersion)
    : 1;
  // Multiplied in OverclockCalculator's order (recipeEUt x parallel x
  // eutModifier x heat, GT5U@5.09.54.205 OverclockCalculator.java:382,
  // GT5U@5.09.51.476 :341): the step count truncates or rounds this draw, so
  // the last bit can decide a step (9 EU/t x 60 at 0.95 is 513, not 512.99...).
  const parallelEuT =
    Math.abs(effectiveRecipe.eut) * parallels * eutMultiplier * heatDiscountMultiplier;

  // Overclocks counted the way OverclockCalculator counts them: whole
  // power-of-four steps of the machine's power over the recipe's draw, and
  // nothing else - a multiblock overclocks on amperage, so stacked hatches
  // buy steps past the hatches' own tier. The machine's power is its tier
  // voltage times its working amps (hatch count for a multiblock, the
  // machine's own amperage for a singleblock - the arc furnaces work with 3),
  // and a recipe drawing under 32 EU/t is billed as 32: "Treat ULV as LV for
  // overclocking". How each side is rounded first depends on the version:
  // see overclockTiersAbove.
  const subTickCapable = canSubTick(effectiveRecipe, gameVersion);
  const machinePower = getVoltageTierMaxEuT(tier) * getNodePowerAmps(effectiveRecipe, node, gameVersion);
  const quantise =
    getMachineBehaviour(effectiveRecipe.machineType, gameVersion)?.quantiseDuration ?? quantiseDurationToTicks;

  let affordableSteps = Number.isFinite(machinePower)
    ? overclockTiersAbove(machinePower, parallelEuT, gameVersion)
    : Number.POSITIVE_INFINITY;

  // A singleblock is additionally capped by voltage tier, measured against the
  // recipe's RAW EU/t - `OverclockCalculator` skips this limit for multiblocks
  // because they overclock on amperage. For 1A machines the two limits agree,
  // so this only bites machines like the arc furnace whose amps outrun their
  // voltage tier.
  if (
    (!subTickCapable || !hasAmperageOverclock(effectiveRecipe.machineType, gameVersion)) &&
    Number.isFinite(machinePower)
  ) {
    const machineVoltageTier = Math.max(
      ceilLog4((subTickCapable ? getVoltageTierMaxEuT(tier) : machinePower) / 8),
      1,
    );
    const recipeVoltageTier = Math.max(ceilLog4(Math.abs(effectiveRecipe.eut) / 8), 1);
    affordableSteps = Math.min(affordableSteps, machineVoltageTier - recipeVoltageTier);
  }

  const affordable = Math.max(0, affordableSteps);
  // How many of the affordable steps heat pays for, now that the count is
  // settled; the rest are the machine's ordinary steps.
  const heatOverclock = getHeatOverclockStats(
    effectiveRecipe,
    node,
    tier,
    affordable,
    gameVersion,
    effectiveVoltageOrdinal,
  );
  const rule = resolveOverclockRule(effectiveRecipe, node, heatOverclock.heatOverclockSteps, gameVersion);

  // Perfect steps are taken first, then normal ones. A perfect step divides
  // duration by the rule's multiplier and usually raises EU/t by the same,
  // but rules may charge a different EU factor per step (arc electrodes are
  // billed 4x however much speed the step buys); a normal step halves
  // duration for 4x EU/t.
  const perfectSteps = Math.min(rule.maxPerfect, affordable);
  const normalSteps = Math.min(rule.maxNormal, affordable - perfectSteps);
  const rawDuration =
    (effectiveRecipe.durationTicks / rule.multiplier ** perfectSteps / 2 ** normalSteps) * durationMultiplier;
  const steps = perfectSteps + normalSteps;
  const stepEuFactor = (rule.euMultiplier ?? rule.multiplier) ** perfectSteps * 4 ** normalSteps;
  const machineEuT = billedMachineEuT(
    effectiveRecipe.eut,
    parallels,
    eutMultiplier,
    heatOverclock.heatDiscountMultiplier,
    stepEuFactor,
  );

  return {
    tier,
    minimumTier,
    overclockSteps: steps,
    perfectOverclockSteps: perfectSteps,
    perfectSpeedFactor: rule.multiplier,
    perfectEuFactor: rule.euMultiplier ?? rule.multiplier,
    durationTicks: quantise(rawDuration, subTickCapable),
    eut: Number.isFinite(parallels) && parallels > 0 ? machineEuT / parallels : machineEuT,
    machineEuT,
  };
}

/**
 * What the game bills the machine: the draw of every parallel together,
 * overclocked, rounded up to a whole EU/t, so a 143 EU/t recipe at a 0.9
 * discount bills 129 and 30 EU/t at 2.8.1's 0.8F bills 25. The product runs in
 * Java's order. GT5U@5.09.54.205 OverclockCalculator.java:382 recipePower,
 * ceiled at :421 (:388 without overclocks); GT5U@5.09.51.476 :341, ceiled at
 * :406 (:347). The parallel is the machine's own, not the sub-tick multiplied
 * count: setCurrentParallel keeps the smaller (.205 :285, .476 :275).
 */
function billedMachineEuT(
  eut: number,
  parallels: number,
  eutMultiplier: number,
  heatDiscount: number,
  stepEuFactor: number,
): number {
  if (!(parallels > 0) || !Number.isFinite(parallels)) {
    return eut * heatDiscount * eutMultiplier * stepEuFactor;
  }
  return Math.ceil(eut * parallels * eutMultiplier * heatDiscount * stepEuFactor);
}

/** Java's `Long.MAX_VALUE / 100`: past it `getTiersAbove` stops scaling. */
const UNSCALED_POWER = 9223372036854775807 / 100;

/**
 * Whole power-of-four steps the machine's power buys over the recipe's draw
 * (discounted and times its parallels), a draw under 32 EU/t billed as 32. One
 * count serves both the time per recipe and the parallels a recipe faster than
 * a tick turns into, as in the game.
 *
 * 2.8.1 truncates both sides to longs (GT5U@5.09.51.476
 * OverclockCalculator.java:343 for the time, :433 for the sub-tick parallels,
 * clamped at :466): a discounted 128.7 EU/t draw counts as 128 and fits one
 * step in 512.
 *
 * 2.9 rounds both sides to 0.01 EU/t and divides (GT5U@5.09.54.205
 * OverclockCalculator.java:513 getTiersAbove, called at :384 and :446): 128.7
 * fits no step in 512, while 128.004 or 128 plus float noise does.
 */
export function overclockTiersAbove(machinePower: number, parallelEuT: number, gameVersion: GameVersion): number {
  if (gameVersion === "2.8.1") {
    // A whole divisor floors the same whether the dividend is truncated first or not.
    return floorLog4(Math.floor(machinePower / Math.max(Math.floor(parallelEuT), 32)));
  }
  if (machinePower < parallelEuT) return -1;
  if (machinePower >= UNSCALED_POWER) return floorLog4(Math.floor(machinePower / Math.max(parallelEuT, 32)));
  return floorLog4(Math.floor(Math.round(machinePower * 100) / Math.max(Math.round(parallelEuT * 100), 3200)));
}

/** The draw `overclockTiersAbove` divides by, as the game rounds it, for the card's working lines. */
export function overclockDrawEuT(parallelEuT: number, gameVersion: GameVersion): number {
  return gameVersion === "2.8.1"
    ? Math.max(Math.floor(parallelEuT), 32)
    : Math.max(Math.round(parallelEuT * 100), 3200) / 100;
}

/** Whole power-of-four steps that fit in `ratio`: 0 for anything under 4. */
function floorLog4(ratio: number): number {
  let steps = 0;
  for (let power = 4; power <= ratio; power *= 4) {
    steps += 1;
  }
  return steps;
}

/** Smallest `n` with `4^n >= ratio`, the game's `log4ceil`. */
function ceilLog4(ratio: number): number {
  let steps = 0;
  let power = 1;
  while (power < ratio) {
    steps += 1;
    power *= 4;
  }
  return steps;
}

/**
 * A recipe runs in whole ticks, and the leftover is not wasted the same way by
 * every machine.
 *
 * Above one tick, GT truncates: a recipe computed at 18.75 ticks runs in 18,
 * which quietly favours the player. Everything truncates, singleblock or not.
 *
 * Below one tick, a machine cannot run a recipe faster than the game's clock.
 * A multiblock spends the leftover on extra parallels instead: ParallelHelper
 * multiplies its parallels by `calculateMultiplierUnderOneTick`, which is
 * `ceil(1 / duration)`, so 0.625 ticks runs TWO recipes a tick (not 1.6) and
 * 0.156 runs seven. Rounding the duration DOWN to the nearest natural
 * fraction (1/2, 1/7) reproduces that once the parallels are multiplied in.
 * A singleblock has no parallels to spend it on, so it sits at one tick and
 * the rest is simply lost.
 */
export function quantiseDurationToTicks(durationTicks: number, subTickCapable: boolean): number {
  if (!Number.isFinite(durationTicks) || durationTicks <= 0) {
    return 1;
  }
  if (durationTicks > 1) {
    return Math.floor(durationTicks);
  }
  return subTickCapable ? 1 / Math.ceil(1 / durationTicks) : 1;
}

/**
 * Whether this machine converts sub-tick speed into parallels.
 *
 * A handler exported with the recipe knows its own kind, so it decides. When
 * the recipe carries no handlers at all, `getRecipeMachineHandlers` invents one
 * and stamps it `single` as a placeholder; that is not evidence, so fall back
 * to the curated table, whose entries are multiblocks unless marked
 * `kind: "single"` (the arc furnace family). Anything unrecognised stays at
 * the one-tick floor rather than suddenly claiming more output.
 */
function canSubTick(effectiveRecipe: OverclockRecipeInput, gameVersion: GameVersion): boolean {
  return isMultiblockRecipe(effectiveRecipe, gameVersion);
}

/**
 * Which overclock rule applies: the curated table's, the heat machines' rule
 * derived from coil heat, or the dataset's perfect-overclock flag for machines
 * the table does not cover yet.
 */
function resolveOverclockRule(
  recipe: OverclockRecipeInput,
  node: Pick<FactoryNode, "machineConfigTiers" | "coilTier" | "overclockTier">,
  heatOverclockSteps: number,
  gameVersion: GameVersion,
): OverclockRule {
  const behaviour = getMachineBehaviour(recipe.machineType, gameVersion);
  const spec = behaviour
    ? resolveOverclockSpec(behaviour, buildMachineContext(recipe as Recipe, node, gameVersion))
    : undefined;

  if (spec === HEAT_OVERCLOCK) {
    // Coil heat above the recipe's requirement buys perfect steps, then normal.
    return OVERCLOCK.perfectThenNormal(heatOverclockSteps);
  }
  if (spec) {
    return spec;
  }
  return recipe.machineProfile?.perfectOverclock ? OVERCLOCK.perfect() : OVERCLOCK.normal();
}

