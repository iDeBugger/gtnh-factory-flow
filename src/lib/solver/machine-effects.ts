import { getFusionStats } from "@/lib/machines/fusion";
import {
  getEecOutputMultiplier,
  getEecSettings,
  isEecRecipe,
} from "@/lib/machines/extreme-entity-crusher";
import { getTgsOutputMultiplier, isTgsRecipe } from "@/lib/machines/tree-growth-simulator";
import { getVatOutputMultiplier, isVatRecipe } from "@/lib/machines/bacterial-vat";
import {
  getRecipeCoilTierControl,
  getRecipeMachineConfigTierControls,
  getRecipeSpecialValue,
} from "@/lib/model/recipe-rules";
import {
  BEE_APIARY_BASE_PRODUCTION_TERM,
  BEE_ENVIRONMENT_CONTROL_ID,
  BEE_INDUSTRIAL_PRODUCTION_CONTROL_ID,
  BEE_INDUSTRIAL_SPEED_CONTROL_ID,
  CROPSNH_REFERENCE_ENVIRONMENT,
  MEGA_APIARY_BATCH_CYCLES,
  cropsNhEnvironmentFromTiers,
  cropsNhExpectedDrop,
  cropsNhGrowthRate,
  cropsNhGrowthSpeedMultiplier,
  cropsNhHarvestRoundMultiplier,
  cropsNhHarvestTicks,
  cropsNhHarvesterEnvironment,
  cropsNhHarvesterFromTiers,
  getBeeBaseProductionTerm,
  getBeeProductionTermModifier,
  getBeeSpeedGeneValueByKey,
  BEE_SPEED_GENE_CONTROL_ID,
  isIndustrialApiaryMachineType,
  getCropsNhStats,
  isBeeFrameSlotControlId,
  isBeeProductionRecipe,
} from "@/lib/model/passive-production";
import {
  BEE_INDUSTRIAL_BASE_EUT,
  beeIndustrialEnergy,
  beeIndustrialEuPerTick,
  beeIndustrialRateFraction,
  beeOutputMultiplier,
  beeProductionWithFrames,
} from "@/lib/model/bee-maths";
import { getVoltageTierForEuT, getVoltageTierIndex } from "@/lib/model/tiers";
import { getHeatDiscountMultiplier } from "./heat";
import { getEffectiveVoltageOrdinal, getNodeRunTier, getPowerPoolEuT } from "./power";
import {
  getMachineBehaviour,
  resolveCoefficient,
  type MachineContext,
} from "@/lib/machines/machine-table";
import type { FactoryNode, MachineTier, Recipe, RecipeOutput } from "@/lib/model/types";
import type { GameVersion } from "@/lib/model/game-version";

type VoltageTier = Exclude<MachineTier, "DEMO">;

/** What the machine table needs to read off a recipe. */
type MachineEffectRecipe = Pick<
  Recipe,
  "machineType" | "source" | "nei" | "machineConfigControls"
> &
  Partial<Pick<Recipe, "minimumTier" | "eut" | "metadata">>;

/** What it needs off the node the user configured. */
type MachineEffectNode = Pick<FactoryNode, "machineConfigTiers" | "coilTier"> &
  Partial<
    Pick<
      FactoryNode,
      | "overclockTier"
      | "machineHandlerId"
      | "energyHatches"
      | "energyHatchType"
      | "powerEuT"
      | "hatchVoltageTier"
      | "hatchAmps"
    >
  >;

/**
 * Reads the machine config tiers a node has selected as the zero-based indices
 * the curated machine table is written against.
 */
export function buildMachineContext(
  recipe: MachineEffectRecipe,
  node: MachineEffectNode,
  gameVersion: GameVersion,
): MachineContext {
  const controls = [
    ...getRecipeMachineConfigTierControls(recipe, node, gameVersion),
    ...(getRecipeCoilTierControl(recipe, node, gameVersion) ? [getRecipeCoilTierControl(recipe, node, gameVersion)!] : []),
  ];

  const find = (controlId: string) => controls.find((entry) => entry.id === controlId);

  return {
    tier: (controlId) => {
      const control = find(controlId);
      if (!control) {
        return 0;
      }
      // The position on the FULL ladder, as the table's formulas are written
      // against ("0 for cupronickel, 3 for TPV"): a control's tier list starts
      // at its minimum, so a per-recipe minimum (the NFR's field restriction
      // coils) must not renumber the rungs above it.
      return (
        (control.minimumIndex ?? 0) +
        Math.max(
          0,
          control.tiers.findIndex((entry) => entry.key === control.current.key),
        )
      );
    },
    value: (controlId) => {
      const control = find(controlId);
      if (!control) {
        return 0;
      }
      // Count knobs key their options by the number itself ("8"), or embed it
      // ("slice-3"). Either way the formulas want the count, not the position.
      const key = control.current.key;
      const parsed = Number(key);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
      const trailing = /(\d+)$/.exec(key);
      if (trailing) {
        return Number(trailing[1]);
      }
      return Math.max(
        0,
        control.tiers.findIndex((entry) => entry.key === key),
      );
    },
    // What GTUtility.getTier(getMaxInputVoltage()) reports: the tier of the
    // SUMMED hatch voltage, so stacked hatches raise the ordinal the
    // "parallels per voltage tier" formulas scale on.
    voltageTier: getEffectiveVoltageOrdinal(recipe, node, getNodeRunTier(recipe as Recipe, node, gameVersion), gameVersion),
    recipeVoltageTier: getVoltageTierIndex(getVoltageTierForEuT(Math.abs(recipe.eut ?? 0))),
    recipeSpecialValue: getRecipeSpecialValue(recipe),
    recipeMap: recipe.source?.recipeMap ?? recipe.machineType,
    recipe: recipe as Partial<Recipe>,
    settings: node.machineConfigTiers,
    gameVersion,
  };
}

export function getMachineOutputMultiplier(
  recipe: Pick<Recipe, "machineType" | "source" | "nei" | "machineConfigControls" | "metadata">,
  node: Pick<FactoryNode, "machineConfigTiers"> & Partial<Pick<FactoryNode, "machineHandlerId">>,
  output: RecipeOutput,
  tier: VoltageTier,
  gameVersion: GameVersion,
): number {
  if (isEecRecipe(recipe)) {
    return getEecOutputMultiplier(
      recipe as Partial<Pick<Recipe, "outputs">> & typeof recipe,
      output,
      getEecSettings(node.machineConfigTiers),
    );
  }
  if (isTgsRecipe(recipe)) {
    // MTETreeFarm: the tier multiplier, each mode's tool, a Forestry sapling's genes.
    return getTgsOutputMultiplier(
      recipe as Partial<Recipe>,
      output,
      node.machineConfigTiers,
      getVoltageTierIndex(tier),
      gameVersion,
    );
  }
  if (isVatRecipe(recipe)) {
    // MTEBioVat: the first fluid out times the output hatch's fill multiplier.
    return getVatOutputMultiplier(recipe as Partial<Recipe>, output, node.machineConfigTiers, gameVersion);
  }
  const cropStats = getCropsNhStats(recipe);
  if (cropStats) {
    const setup = cropsNhHarvesterFromTiers(
      node.machineConfigTiers,
      node.machineHandlerId,
      cropStats.minSeedBedTier,
      cropStats.subSoil !== undefined,
    );
    // A machine-only crop grown in the world drops NOTHING on harvest (the
    // guide's rule: they grow and spread, but only a spade gets seeds out),
    // so a Crop Manager over one produces zero. Only the farm runs it.
    if (cropStats.machineOnly && setup.id !== "crop-industrial-farm") {
      return 0;
    }
    const env = cropsNhHarvesterEnvironment(
      setup,
      cropsNhEnvironmentFromTiers(node.machineConfigTiers),
    );
    if (cropsNhGrowthRate(cropStats, env) <= 0) {
      // Nutrient supply is 25+ under demand: the crop never grows (and risks
      // getting sick), so the farm produces nothing at all.
      return 0;
    }
    // Both harvesters multiply the drop ROUNDS, exactly where the crop's own
    // gain-driven rounds are computed, so this rides on the same ratio.
    const rounds = cropsNhHarvestRoundMultiplier(setup);
    const drop = cropStats.drops.find((entry) => entry.id === output.id);
    if (!drop) {
      return rounds;
    }
    const reference = cropsNhExpectedDrop(cropStats, CROPSNH_REFERENCE_ENVIRONMENT.gain, drop);
    const current = cropsNhExpectedDrop(cropStats, env.gain, drop);
    return (reference > 0 ? current / reference : 1) * rounds;
  }

  const configMultiplier = getRecipeMachineConfigTierControls(recipe, node, gameVersion)
    .filter((control) => !isBeeFrameSlotControlId(control.id))
    .reduce((multiplier, control) => multiplier * (control.current.outputMultiplier ?? 1), 1);

  if (isBeeProductionRecipe(recipe)) {
    const gameMultiplier = getBeeGameOutputMultiplier(recipe, node, output, gameVersion);
    if (gameMultiplier !== undefined) {
      return gameMultiplier;
    }
    return (
      configMultiplier *
      getBeeClimateOutputMultiplier(recipe, node, output, gameVersion) *
      getBeeProductionTermOutputMultiplier(recipe, node, tier, gameVersion) *
      getBeeMegaApiaryBatchMultiplier(recipe, tier)
    );
  }

  return configMultiplier;
}

/**
 * Items per base chance from the game's code (see bee-maths.ts): a chance goes through getFinalChance, a product is
 * rolled twice, Forestry's housings at most once a roll. Undefined for the Mega Apiary (kept on the older scaling)
 * and for an output whose base chance the recipe does not carry.
 */
function getBeeGameOutputMultiplier(
  recipe: Pick<Recipe, "machineType" | "source" | "nei" | "machineConfigControls" | "metadata">,
  node: Pick<FactoryNode, "machineConfigTiers">,
  output: RecipeOutput,
  gameVersion: GameVersion,
): number | undefined {
  if (isMegaApiaryRecipe(recipe)) {
    return undefined;
  }
  const chance = getBeeBaseChance(output);
  if (chance === undefined) {
    return undefined;
  }
  const climate = getBeeClimateOutputMultiplier(recipe, node, output, gameVersion);
  if (climate === 0) {
    return 0;
  }
  const controls = getRecipeMachineConfigTierControls(recipe, node, gameVersion);
  const term = getBeeProductionTerm(recipe, controls);
  if (term <= 0) {
    return 0;
  }
  const industrial = isIndustrialApiaryMachineType(recipe.machineType);
  const speedKey = controls.find((control) => control.id === BEE_SPEED_GENE_CONTROL_ID)?.current
    .key;
  let multiplier = beeOutputMultiplier(chance, getBeeSpeedGeneValueByKey(speedKey), term, {
    specialty: isBeeSpecialtyOutput(output),
    capped: !industrial,
  });
  if (industrial) {
    const accel = controls.find((control) => control.id === BEE_INDUSTRIAL_SPEED_CONTROL_ID);
    const lifespan = Number(recipe.metadata?.beeLifespan);
    multiplier *= beeIndustrialRateFraction(
      beeIndustrialSpeedExponent(accel?.current.key),
      Number.isFinite(lifespan) && lifespan > 0 ? lifespan : undefined,
    );
  }
  return multiplier;
}

function getBeeBaseChance(output: RecipeOutput): number | undefined {
  if (typeof output.chance === "number" && output.chance > 0) {
    return output.chance;
  }
  for (const line of output.tooltip ?? []) {
    const match = /(?:product|specialty) chance:\s*([\d.]+)\s*%/i.exec(line);
    if (match) {
      const percent = Number(match[1]);
      if (percent > 0) {
        return percent / 100;
      }
    }
  }
  return undefined;
}

function isBeeSpecialtyOutput(output: RecipeOutput) {
  return (
    output.byproduct === true ||
    (output.tooltip ?? []).some((line) => /specialty chance|needs preferred climate/i.test(line))
  );
}

function beeIndustrialSpeedExponent(key: string | undefined) {
  if (key === "speed-8-upgraded") {
    return 8;
  }
  const match = /^speed-(\d)$/.exec(key ?? "");
  return match ? Number(match[1]) : 0;
}

/** p + t: the housing's base term, the controls' modifiers, then the frames each against the sum so far. */
function getBeeProductionTerm(
  recipe: Pick<Recipe, "machineType">,
  controls: ReturnType<typeof getRecipeMachineConfigTierControls>,
) {
  const hasUpgradedSpeed8 = controls.some(
    (control) =>
      control.id === BEE_INDUSTRIAL_SPEED_CONTROL_ID && control.current.key === "speed-8-upgraded",
  );
  const frames: string[] = [];
  let term = getBeeBaseProductionTerm(recipe.machineType);
  for (const control of controls) {
    if (isBeeFrameSlotControlId(control.id)) {
      frames.push(control.current.key);
      continue;
    }
    if (hasUpgradedSpeed8 && control.id === BEE_INDUSTRIAL_PRODUCTION_CONTROL_ID) {
      continue;
    }
    term += getBeeProductionTermModifier(control.id, control.current.key);
  }
  // Frames work on p, which is the term less Forestry's t of 1 (the Industrial Apiary takes none).
  return beeProductionWithFrames(term - 1, frames) + 1;
}

function getBeeClimateOutputMultiplier(
  recipe: Pick<Recipe, "machineType" | "source" | "nei" | "machineConfigControls">,
  node: Pick<FactoryNode, "machineConfigTiers">,
  output: RecipeOutput,
  gameVersion: GameVersion,
) {
  if (hasBeeMegaApiaryRequirement(output) && !isMegaApiaryRecipe(recipe)) {
    return 0;
  }

  const climateControl = getRecipeMachineConfigTierControls(recipe, node, gameVersion).find(
    (control) => control.id === BEE_ENVIRONMENT_CONTROL_ID,
  );
  const climateKey = climateControl?.current.key;
  if (climateKey === "wrong") {
    return 0;
  }
  if (climateKey === "tolerated" && hasBeePreferredClimateRequirement(output)) {
    return 0;
  }
  return 1;
}

function hasBeePreferredClimateRequirement(output: RecipeOutput) {
  return output.tooltip?.some((line) => /needs preferred climate/i.test(line)) ?? false;
}

function hasBeeMegaApiaryRequirement(output: RecipeOutput) {
  return output.tooltip?.some((line) => /only be produced in mega apiary/i.test(line)) ?? false;
}

function isMegaApiaryRecipe(recipe: Pick<Recipe, "machineType">) {
  return isMegaApiaryMachineType(recipe.machineType);
}

function getBeeProductionTermOutputMultiplier(
  recipe: Pick<Recipe, "machineType" | "source" | "nei" | "machineConfigControls">,
  node: Pick<FactoryNode, "machineConfigTiers">,
  tier: VoltageTier,
  gameVersion: GameVersion,
) {
  const baseTerm = getBeeBaseProductionTerm(recipe.machineType);
  const controls = getRecipeMachineConfigTierControls(recipe, node, gameVersion);
  const hasUpgradedSpeed8 = controls.some(
    (control) =>
      control.id === BEE_INDUSTRIAL_SPEED_CONTROL_ID && control.current.key === "speed-8-upgraded",
  );
  const configModifier = controls.reduce((sum, control) => {
    if (hasUpgradedSpeed8 && control.id === BEE_INDUSTRIAL_PRODUCTION_CONTROL_ID) {
      return sum;
    }
    return sum + getBeeProductionTermModifier(control.id, control.current.key);
  }, 0);
  const productionTerm =
    baseTerm + configModifier + getBeeMegaApiaryVoltageProductionModifier(recipe, tier);
  if (productionTerm <= 0) {
    return 0;
  }
  return Math.pow(productionTerm / BEE_APIARY_BASE_PRODUCTION_TERM, 0.52);
}

function getBeeMegaApiaryBatchMultiplier(recipe: Pick<Recipe, "machineType">, tier: VoltageTier) {
  if (!isMegaApiaryRecipe(recipe)) {
    return 1;
  }
  return MEGA_APIARY_BATCH_CYCLES * 4 ** getBeeMegaApiaryVoltageOffset(tier);
}

function getBeeMegaApiaryVoltageProductionModifier(
  recipe: Pick<Recipe, "machineType">,
  tier: VoltageTier,
) {
  if (!isMegaApiaryRecipe(recipe)) {
    return 0;
  }
  return getBeeMegaApiaryVoltageOffset(tier);
}

export function getBeeMegaApiaryVoltageOffset(tier: VoltageTier) {
  const offset = getVoltageTierIndex(tier) - getVoltageTierIndex("LuV");
  return Math.max(0, Math.min(3, offset));
}

export function getBeeMegaApiaryTierEutMultiplier(tier: VoltageTier) {
  return 4 ** getBeeMegaApiaryVoltageOffset(tier);
}

export function isMegaApiaryMachineType(machineType: string) {
  return normalizeRecipeMapName(machineType).includes("mega apiary");
}

export function applyMachineOutputMultipliers(
  recipe: Recipe,
  node: Pick<FactoryNode, "machineConfigTiers">,
  tier: VoltageTier,
  gameVersion: GameVersion,
): Recipe {
  const outputs = recipe.outputs.map((output) => {
    const multiplier = getMachineOutputMultiplier(recipe, node, output, tier, gameVersion);
    return multiplier === 1 ? output : { ...output, amount: output.amount * multiplier };
  });

  return outputs.some((output, index) => output !== recipe.outputs[index])
    ? { ...recipe, outputs }
    : recipe;
}

export function getMachineParallelMultiplier(
  recipe: MachineEffectRecipe,
  node: MachineEffectNode,
  gameVersion: GameVersion,
): number {
  return Math.min(
    getMachineStructuralParallels(recipe, node, gameVersion),
    getPoweredParallelLimit(recipe, node, gameVersion),
  );
}

export function getMachineStructuralParallels(
  recipe: MachineEffectRecipe,
  node: MachineEffectNode,
  gameVersion: GameVersion,
): number {
  const fusion = getFusionStats(recipe);
  if (fusion) return fusion.parallels;
  // GT++ "Voltage Tier * n Parallels" scales with the tier the machine runs
  // at; the GT tier ordinal counts ULV as 0, LV as 1, and so on. Stacked
  // hatches raise it, because the game reads the tier of the SUMMED voltage.
  const tierOrdinal = Math.max(
    1,
    getEffectiveVoltageOrdinal(recipe, node, getNodeRunTier(recipe as Recipe, node, gameVersion), gameVersion),
  );
  const behaviour = getMachineBehaviour(recipe.machineType, gameVersion);
  const structural = behaviour
    ? Math.max(
        1,
        Math.floor(resolveCoefficient(behaviour.parallels, buildMachineContext(recipe, node, gameVersion), 1)),
      )
    : getRecipeMachineConfigTierControls(recipe, node, gameVersion).reduce((multiplier, control) => {
        const fixed = control.current.parallelMultiplier ?? 1;
        const perTier = control.current.parallelPerVoltageTier;
        const base = control.current.parallelVoltageBase ?? 0;
        const scaled = Number.isFinite(perTier)
          ? Math.max(1, Math.floor(base + (perTier as number) * tierOrdinal))
          : 1;
        return multiplier * fixed * scaled;
      }, 1);

  return structural;
}

/**
 * How many parallels the supplied voltage can actually pay for.
 *
 * Parallels multiply EU/t one-for-one, so a machine only reaches its
 * structural parallel count when the energy hatch can carry the whole draw.
 * A chem plant with titanium pipe casings offers six parallels, but a 480
 * EU/t recipe on an HV hatch (512 EU/t) can only run one of them.
 */
function getPoweredParallelLimit(recipe: MachineEffectRecipe, node: MachineEffectNode, gameVersion: GameVersion): number {
  const runTier = getNodeRunTier(recipe as Recipe, node, gameVersion);
  const available = getPowerPoolEuT(recipe, node, runTier, gameVersion);
  if (!Number.isFinite(available)) {
    return Number.POSITIVE_INFINITY;
  }

  // Energy discounts land before parallels, so a discounted recipe fits more
  // of them into the same hatch. The heat discount counts too:
  // `ParallelHelper.determineParallel` folds it into `tRecipeEUt` before
  // dividing the available EU, so a hot blast furnace runs more parallels.
  const discountedEuT =
    Math.abs(recipe.eut ?? 0) *
    getMachineEutMultiplier(recipe, node, gameVersion) *
    getHeatDiscountMultiplier(
      recipe,
      node,
      runTier,
      gameVersion,
      getEffectiveVoltageOrdinal(recipe, node, runTier, gameVersion),
    );
  // The hatch is divided by one parallel's draw rounded up to a whole EU/t
  // (GT5U@5.09.54.205 ParallelHelper.java:399, divided at :479;
  // GT5U@5.09.51.476 :399, :476), so 53 EU/t at a 0.8 discount (42.4) costs
  // 43 a parallel and one MV hatch fits 2.
  const recipeEuT = Math.ceil(discountedEuT);
  if (!(recipeEuT > 0)) {
    return Number.POSITIVE_INFINITY;
  }

  return Math.max(1, Math.floor(available / recipeEuT));
}

export function getMachineDurationMultiplier(
  recipe: MachineEffectRecipe,
  node: MachineEffectNode,
  gameVersion: GameVersion,
): number {
  const cropStats = getCropsNhStats(recipe);
  if (cropStats) {
    const setup = cropsNhHarvesterFromTiers(
      node.machineConfigTiers,
      node.machineHandlerId,
      cropStats.minSeedBedTier,
      cropStats.subSoil !== undefined,
    );
    const env = cropsNhHarvesterEnvironment(
      setup,
      cropsNhEnvironmentFromTiers(node.machineConfigTiers),
    );
    const ticks = cropsNhHarvestTicks(cropStats, env);
    const referenceTicks = cropsNhHarvestTicks(cropStats, CROPSNH_REFERENCE_ENVIRONMENT);
    if (!Number.isFinite(ticks) || referenceTicks <= 0) {
      // Non-growing crops are surfaced through a zero output multiplier;
      // keep the duration finite so the solver stays stable.
      return 1;
    }
    // An Industrial Farm cycle banks `progressPerCycle` of a harvest, so its
    // time per harvest is the crop stick's own divided by the growth speed
    // multiplier. A Crop Manager grows at the world's pace and divides by 1.
    return ticks / referenceTicks / cropsNhGrowthSpeedMultiplier(setup);
  }

  // The curated table states speed as a throughput multiplier, so a machine
  // that runs at 200% divides the duration by two.
  const behaviour = getMachineBehaviour(recipe.machineType, gameVersion);
  if (behaviour) {
    const ctx = buildMachineContext(recipe, node, gameVersion);
    if (behaviour.durationMultiplier !== undefined) {
      const multiplier = resolveCoefficient(behaviour.durationMultiplier, ctx, 1);
      return multiplier > 0 ? multiplier : 1;
    }
    const speed = resolveCoefficient(behaviour.speed, ctx, 1);
    return speed > 0 ? 1 / speed : 1;
  }

  const coilControl = getRecipeCoilTierControl(recipe, node, gameVersion);
  const coilMultiplier = coilControl?.current.durationMultiplier ?? 1;
  const configMultiplier = getRecipeMachineConfigTierControls(recipe, node, gameVersion).reduce(
    (multiplier, control) => multiplier * (control.current.durationMultiplier ?? 1),
    1,
  );
  return coilMultiplier * configMultiplier;
}

/** The table's line about a setting its formulas replaced with a default, if any. */
export function getMachineSettingWarning(
  recipe: MachineEffectRecipe,
  node: MachineEffectNode,
  gameVersion: GameVersion,
): string | undefined {
  const behaviour = getMachineBehaviour(recipe.machineType, gameVersion);
  return behaviour?.settingWarning?.(buildMachineContext(recipe, node, gameVersion));
}

export function getMachineEutMultiplier(
  recipe: MachineEffectRecipe,
  node: MachineEffectNode,
  gameVersion: GameVersion,
): number {
  const behaviour = getMachineBehaviour(recipe.machineType, gameVersion);
  if (behaviour) {
    return resolveCoefficient(behaviour.power, buildMachineContext(recipe, node, gameVersion), 1);
  }

  const coilControl = getRecipeCoilTierControl(recipe, node, gameVersion);
  const coilMultiplier = coilControl?.current.eutMultiplier ?? 1;
  const controls = getRecipeMachineConfigTierControls(recipe, node, gameVersion);
  const hasUpgradedSpeed8 = controls.some(
    (control) =>
      control.id === BEE_INDUSTRIAL_SPEED_CONTROL_ID && control.current.key === "speed-8-upgraded",
  );
  if (isIndustrialApiaryMachineType(recipe.machineType)) {
    // MTEIndustrialApiary: (int)(37 * energy * 2^speed) + 32 * 4^(speed - 1). The production upgrades keep their
    // energy under the Upgraded Acceleration, whatever they do to the chance.
    const speedKey = controls.find((control) => control.id === BEE_INDUSTRIAL_SPEED_CONTROL_ID)
      ?.current.key;
    const upgrades = Number(
      controls.find((control) => control.id === BEE_INDUSTRIAL_PRODUCTION_CONTROL_ID)?.current.key,
    );
    const eut = beeIndustrialEuPerTick(
      beeIndustrialSpeedExponent(speedKey),
      beeIndustrialEnergy(Number.isFinite(upgrades) ? upgrades : 0, hasUpgradedSpeed8),
    );
    return (eut / BEE_INDUSTRIAL_BASE_EUT) * coilMultiplier;
  }
  const configMultiplier = controls.reduce((multiplier, control) => {
    if (hasUpgradedSpeed8 && control.id === BEE_INDUSTRIAL_PRODUCTION_CONTROL_ID) {
      return multiplier;
    }
    return multiplier * (control.current.eutMultiplier ?? 1);
  }, 1);
  return coilMultiplier * configMultiplier;
}

function normalizeRecipeMapName(recipeMap: string): string {
  return recipeMap
    .trim()
    .toLowerCase()
    .replace(/\brecipes?\b/g, "")
    .replace(/\brecipe\s+map\b/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
