/**
 * The bridge from a power source to the rest of the app: each power card
 * OWNS a synthesized one-second recipe in project.recipes (the custom-rate
 * precedent), so ports, wires, the solver, boards and import/export all
 * treat it as an ordinary machine. Settings live on the node
 * (machineConfigTiers); changing one rewrites the recipe through
 * buildPowerRecipe, and normalizeLoadedProject resynthesizes on load so
 * stored plans always carry the current math.
 */
import type { FactoryNode, Recipe, RecipeInput, RecipeOutput } from "@/lib/model/types";
import { DEFAULT_GAME_VERSION, gameVersionLabel, type GameVersion } from "@/lib/model/game-version";
import { resolvePowerResource } from "./planner-data";
import { ABSENT_POWER_SOURCES, getPowerSource } from "./registry";
import { powerReaderContext } from "./version-settings";
import {
  buildPowerSettingsReader,
  type PowerFlowLine,
  type PowerModel,
  type PowerSettingsReader,
  type PowerSourceDefinition,
} from "./types";
import { formatAmount } from "./sources/helpers";

export const POWER_RECIPE_CATEGORY = "power-source";

/**
 * EU as a RESOURCE: the one canonical power resource every generator's
 * recipe outputs. It rides ports, wires, drawers and the solve like any
 * resource; nothing consumes it (kind matching is strict), so its wires
 * only ever land on drawers. Flows are per-second like every flow - the
 * display layer alone converts to EU/t.
 */
export const POWER_EU_RESOURCE = {
  kind: "power",
  id: "eu",
  displayName: "EU",
  // The power amber: the POWER button's own text-amber-400, so wires and
  // tints match the button that starts the whole wing.
  dominantColor: "#fbbf24",
} as const;

export interface RecipePowerInfo {
  sourceId: string;
  /** Net EU/t of one machine at the baked settings; negative = parasitic. */
  euPerTick: number;
  stats: Array<{ label: string; value: string }>;
  warnings?: string[];
}

export function isPowerRecipe(
  recipe: Pick<Recipe, "power" | "category"> | undefined,
): recipe is Recipe & { power: RecipePowerInfo } {
  return Boolean(recipe?.power);
}

function flowToSlot(flow: PowerFlowLine, gameVersion: GameVersion): (RecipeInput & RecipeOutput) | undefined {
  const resource = resolvePowerResource(flow.name, gameVersion);
  if (!resource || !(flow.perSecond > 0)) {
    return undefined;
  }
  return {
    kind: resource.kind,
    id: resource.id,
    amount: flow.perSecond,
    displayName: resource.displayName,
    iconPath: resource.iconPath,
    dominantColor: resource.dominantColor,
  };
}

/** The flows the resource map cannot wire, shown as stat lines instead. */
function unresolvedFlowStats(model: PowerModel, gameVersion: GameVersion): Array<{ label: string; value: string }> {
  const lines: Array<{ label: string; value: string }> = [];
  for (const [flows, direction] of [
    [model.inputs, "in"],
    [model.outputs, "out"],
  ] as const) {
    for (const flow of flows) {
      if (!resolvePowerResource(flow.name, gameVersion) && flow.perSecond > 0) {
        lines.push({
          label: flow.name,
          value: `${formatAmount(flow.perSecond)}${flow.unit === "L" ? " L" : ""}/s ${direction}`,
        });
      }
    }
  }
  return lines;
}

/**
 * What a converted plan's card stores that this version lacks, as card warnings: each select
 * value with no option here names the option used instead, another version's choice this card
 * lacks is named the same way, several stored fuels read as one name the one used, and settings
 * this version does not have are named once by their label on `reference` (the same source on
 * 2.9) or on `others` (the source in the other versions). A stored id
 * `reference` does not declare either is no setting of any version and is not named.
 */
export function powerSettingWarnings(
  source: PowerSourceDefinition,
  reference: PowerSourceDefinition | undefined,
  read: PowerSettingsReader,
  gameVersion: GameVersion,
  others: readonly PowerSourceDefinition[] = [],
): string[] {
  const warnings: string[] = [];
  const optionLabel = (settingId: string, key: string) => {
    const setting = source.settings.find((entry) => entry.id === settingId);
    return (setting?.type === "select" && setting.options.find((option) => option.key === key)?.label) || key;
  };
  for (const { settingId, stored, used } of read.missing()) {
    warnings.push(`Not in GTNH ${gameVersion}: ${stored}. Using ${optionLabel(settingId, used)}.`);
  }
  // Only 2.8.1's boilers merge two stored fuels into one select (2.9's liquid and solid).
  for (const { settingId, used } of read.merged()) {
    warnings.push(`GTNH ${gameVersion} boilers burn one fuel at a time. Using ${optionLabel(settingId, used)}.`);
  }
  const labels = read
    .unknownSettings()
    .map((id) => [reference, ...others].flatMap((def) => def?.settings ?? []).find((setting) => setting.id === id)?.label)
    .filter((label): label is string => Boolean(label));
  if (labels.length > 0) {
    warnings.push(`Not in GTNH ${gameVersion}: ${labels.join(", ")}.`);
  }
  return warnings;
}

/**
 * The recipe for one power card at the given settings. Amount per craft is
 * amount per second: the recipe runs one craft a second, like custom rate
 * cards, so the solver needs no special case.
 */
export function buildPowerRecipe(
  sourceId: string,
  settings: Record<string, string> | undefined,
  recipeId: string,
  gameVersion: GameVersion,
): Recipe | undefined {
  const source = getPowerSource(sourceId, gameVersion);
  if (!source) {
    return undefined;
  }
  const context = powerReaderContext(sourceId, gameVersion);
  const read = buildPowerSettingsReader(source, settings, gameVersion, context);
  const model = source.compute(read, gameVersion);
  const settingWarnings = powerSettingWarnings(
    source,
    getPowerSource(sourceId, "2.9"),
    read,
    gameVersion,
    context.others,
  );
  const warnings =
    settingWarnings.length > 0 ? [...(model.warnings ?? []), ...settingWarnings] : model.warnings;
  const inputs = model.inputs.map((flow) => flowToSlot(flow, gameVersion)).filter(Boolean) as RecipeInput[];
  const outputs = model.outputs.map((flow) => flowToSlot(flow, gameVersion)).filter(Boolean) as RecipeOutput[];
  // The EU output port, FIRST on the rail (a generator's product is power).
  // Marked byproduct so primaryOutput never crowns it over a material
  // output, and per second (x20) like every flow.
  if (model.euPerTick > 0) {
    outputs.unshift({
      ...POWER_EU_RESOURCE,
      amount: model.euPerTick * 20,
      byproduct: true,
    });
  }

  return {
    id: recipeId,
    name: source.name,
    kind: "custom",
    category: POWER_RECIPE_CATEGORY,
    machineType: source.name,
    minimumTier: "NONE",
    durationTicks: 20,
    eut: 0,
    inputs,
    outputs,
    notes: source.blurb,
    source: { recipeMap: "power-source" },
    power: {
      sourceId,
      euPerTick: model.euPerTick,
      stats: [...model.stats, ...unresolvedFlowStats(model, gameVersion)],
      warnings,
    },
  };
}

/**
 * Every power card's recipe rebuilt from its node's settings. Runs in the
 * load funnel so saved plans always carry the current math and resource
 * mapping; a recipe whose source id is unknown (a newer plan on an older
 * build) is left exactly as saved. A card whose source the version does not
 * have (`ABSENT_POWER_SOURCES`) is marked `unconverted` with the reason and
 * its recipe body dropped, as a conversion marks it: it never shows another
 * version's numbers.
 */
export function resynthesizePowerRecipes<
  Project extends { nodes: FactoryNode[]; recipes: Recipe[] },
>(project: Project, gameVersion: GameVersion): Project {
  let changed = false;
  project = markAbsentPowerCards(project, gameVersion);
  // A power card OWNS its recipe. Saved plans can hold two nodes on one
  // power recipe (a clone that did not remint), where one card's settings
  // would rewrite the other's output. Every node past the first gets its
  // own recipe id here, rebuilt below from its OWN settings.
  let nodes = project.nodes;
  const powerIds = new Set(
    project.recipes.filter((recipe) => isPowerRecipe(recipe)).map((recipe) => recipe.id),
  );
  const seenPowerRecipe = new Set<string>();
  const splitRecipes: Recipe[] = [];
  nodes = nodes.map((node) => {
    if (!powerIds.has(node.recipeId)) {
      return node;
    }
    if (!seenPowerRecipe.has(node.recipeId)) {
      seenPowerRecipe.add(node.recipeId);
      return node;
    }
    const shared = project.recipes.find((recipe) => recipe.id === node.recipeId);
    if (!shared || !isPowerRecipe(shared)) {
      return node;
    }
    const copyId = `${shared.id}:split:${node.id}`;
    splitRecipes.push({ ...shared, id: copyId });
    changed = true;
    return { ...node, recipeId: copyId };
  });
  const allRecipes = splitRecipes.length > 0 ? [...project.recipes, ...splitRecipes] : project.recipes;

  const settingsByRecipeId = new Map<string, Record<string, string> | undefined>();
  const powerRecipeIds = new Set<string>();
  for (const node of nodes) {
    settingsByRecipeId.set(node.recipeId, node.machineConfigTiers);
  }
  const recipes = allRecipes.map((recipe) => {
    if (!isPowerRecipe(recipe)) {
      return recipe;
    }
    powerRecipeIds.add(recipe.id);
    const rebuilt = buildPowerRecipe(
      recipe.power.sourceId,
      settingsByRecipeId.get(recipe.id),
      recipe.id,
      gameVersion,
    );
    if (!rebuilt) {
      return recipe;
    }
    changed = true;
    return rebuilt;
  });
  // Power slots are exact, so a power node never legitimately carries input
  // overrides. Any found in a saved plan are dropped: they would repaint the
  // rebuilt slots and pin the card to one fuel through every fuel switch.
  nodes = nodes.map((node) => {
    if (!powerRecipeIds.has(node.recipeId) || node.recipeInputOverrides === undefined) {
      return node;
    }
    changed = true;
    return { ...node, recipeInputOverrides: undefined };
  });
  return changed ? { ...project, recipes, nodes } : project;
}

/**
 * Cards on a power source `gameVersion` lacks, marked with the reason; the bodies go. Absent lists are relative to
 * the default version, which has every source, so that is the version a marked card's recipe came from.
 */
function markAbsentPowerCards<Project extends { nodes: FactoryNode[]; recipes: Recipe[] }>(
  project: Project,
  gameVersion: GameVersion,
): Project {
  const absent = ABSENT_POWER_SOURCES[gameVersion];
  if (!absent?.length) return project;
  const absentRecipes = new Map<string, Recipe>();
  for (const recipe of project.recipes) {
    if (isPowerRecipe(recipe) && absent.includes(recipe.power.sourceId)) absentRecipes.set(recipe.id, recipe);
  }
  if (absentRecipes.size === 0) return project;
  const reason = `Not in ${gameVersionLabel(gameVersion)}.`;
  const nodes = project.nodes.map((node): FactoryNode => {
    const recipe = absentRecipes.get(node.recipeId);
    if (!recipe || node.unconverted) return node;
    return {
      ...node,
      unconverted: {
        fromGameVersion: DEFAULT_GAME_VERSION,
        recipeId: recipe.id,
        recipeName: recipe.name,
        machineType: recipe.machineType,
        reason,
      },
    };
  });
  return { ...project, nodes, recipes: project.recipes.filter((recipe) => !absentRecipes.has(recipe.id)) };
}
