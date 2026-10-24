import type { FactoryEdge, FactoryNode, FactoryProject, MachineHandler, MachineTier, Recipe, UnconvertedRecipe } from "@/lib/model/types";
import { GT_VOLTAGE_TIERS, getVoltageTierIndex } from "@/lib/model/tiers";
import { splitSectionHandleId } from "@/lib/model/shared-machine";
import { gameVersionLabel, gameVersionOfDataset, planGameVersion, type GameVersion } from "@/lib/model/game-version";
import { isCustomRateRecipe } from "@/lib/model/custom-rate";
import { FLUID_TANK_EMPTY_MAP } from "@/lib/model/fluid-tank";
import { CROP_FARM_PLACEHOLDER_RECIPE_ID, CROP_FARM_RECIPE_MAP } from "@/lib/model/passive-production";
import { getRecipeMachineHandlers } from "@/lib/model/recipe-rules";
import { isPowerRecipe, resynthesizePowerRecipes } from "@/lib/power/power-recipe";
import { hasSameRecipeNumbers, recipeContentRef } from "@/lib/import-export/recipe-ref-match";
import { remapMigratedRecipeReferences } from "@/lib/import-export/recipe-migration";
import { getRecipeDatasetRecipe, resolveRecipeDatasetRecipes } from "./browser-loader";
import type { DatasetVersion } from "./types";

export type { UnconvertedRecipe };

export interface ConversionTarget {
  manifestUrl: string;
  version: DatasetVersion;
}

/** Plan names are capped at this many characters where a player types one. */
const PLAN_NAME_LIMIT = 80;

/**
 * Cards the target version cannot run at all: a power source or a recipe map it lacks. They are not looked for
 * there: each is marked with the reason, so the player reads "not in this version" rather than "no match". Keyed
 * by the target; a machine only the source version has and that is not listed here is simply unmatched.
 */
const ABSENT_IN_VERSION: Record<GameVersion, { powerSources: Set<string>; recipeMaps: Set<string> }> = {
  "2.8.1": {
    powerSources: new Set(["large-neutralization-engine"]),
    recipeMaps: new Set([CROP_FARM_RECIPE_MAP]),
  },
};

/**
 * Machine handler ids renamed between 2.8.1 and 2.9 whose names differ by more than a tier mark, so the family
 * pairing below cannot see them. Each pair is one machine (the same recipes, one id swapped for the other, the
 * same tiers), from comparing the handler lists of recipes with the same id in both datasets. A pair that only
 * looks alike (GT++'s High Current Industrial Arc Furnace and kubatech's Industrial Arc Furnace) is not listed:
 * pairing them would move a card onto another machine's numbers.
 */
const SAME_MACHINE_HANDLERS: Array<[string, string]> = [
  ["fusion-control-computer-mark-i", "fusion-control-computer-mk-i"],
  ["fusion-control-computer-mark-ii", "fusion-control-computer-mk-ii"],
  ["fusion-control-computer-mark-iii", "fusion-control-computer-mk-iii"],
  ["compact-fusion-computer-mk-i-prototype", "compact-fusion-computer-mk-i"],
  ["compact-fusion-computer-mk-iv-prototype", "compact-fusion-computer-mk-iv"],
  ["high-pressure-alloy-smelter", "high-pressure-steam-alloy-smelter"],
  ["large-sifter-control-block", "large-sifter"],
  // The pipeline exports no handler list for a map with one machine family, so 2.8.1's Multiblock Centrifuge
  // recipes name the synthesized "multiblock-centrifuge": the map's one machine, its Industrial Centrifuge.
  // A recipe map with no list in one version and a list in the other is this one alone in the served datasets.
  ["multiblock-centrifuge", "industrial-centrifuge"],
];
const HANDLER_TWIN = new Map(SAME_MACHINE_HANDLERS.flatMap(([a, b]) => [[a, b] as const, [b, a] as const]));

/**
 * The plan's own recipes: nothing in a dataset stands for them, so a conversion keeps them as written (a demo
 * recipe, a custom rate card, an empty fluid tank, the empty crop farm). Power cards are handled apart.
 */
export function isPlanOwnRecipe(recipe: Recipe): boolean {
  return (
    Boolean(recipe.isDemo) ||
    isCustomRateRecipe(recipe) ||
    recipe.source?.recipeMap === FLUID_TANK_EMPTY_MAP ||
    recipe.id === CROP_FARM_PLACEHOLDER_RECIPE_ID
  );
}

/**
 * The target dataset's bodies for `recipes`, keyed by the source recipe id. By id first (both served datasets key
 * recipes by content, so an id found there is the same recipe with the same numbers), then by content, accepting
 * only a body with the same content key (`hasSameRecipeNumbers`): a recipe whose ticks, EU, special value,
 * amounts, chances or catalysts changed between versions is unmatched, never swapped for one with other numbers.
 * No name search. A failure to reach the match service, or to fetch a body it named, throws: a conversion must
 * not mark cards unconverted because the network dropped.
 */
export async function matchRecipesToVersion(
  recipes: Recipe[],
  target: ConversionTarget,
): Promise<{ bodies: Map<string, Recipe>; unmatched: Set<string> }> {
  const { manifestUrl, version } = target;
  const bodies = new Map<string, Recipe>();
  const byId = await Promise.allSettled(
    recipes.map((recipe) => getRecipeDatasetRecipe(manifestUrl, version, recipe.id)),
  );
  const stale = new Map<string, Recipe>();
  recipes.forEach((recipe, index) => {
    const result = byId[index];
    if (result?.status === "fulfilled") {
      bodies.set(recipe.id, result.value);
    } else {
      stale.set(recipe.id, recipe);
    }
  });
  if (stale.size > 0) {
    const resolved = await resolveRecipeDatasetRecipes(manifestUrl, version, [...stale.values()].map(recipeContentRef));
    const fetched = await Promise.all(
      resolved.matches.map(async (match) => ({
        importedId: match.importedId,
        body: await getRecipeDatasetRecipe(manifestUrl, version, match.recipeId),
      })),
    );
    for (const { importedId, body } of fetched) {
      const stored = stale.get(importedId);
      if (stored && hasSameRecipeNumbers(stored, body)) {
        bodies.set(importedId, body);
      }
    }
  }
  const unmatched = new Set(recipes.filter((recipe) => !bodies.has(recipe.id)).map((recipe) => recipe.id));
  return { bodies, unmatched };
}

/** `"<name> (GTNH <v>)"` within the name limit; a suffix from an earlier conversion is replaced, not stacked. */
function convertedPlanName(name: string, version: GameVersion): string {
  const suffix = ` (${gameVersionLabel(version)})`;
  const base = name.replace(/ \(GTNH [^()]*\)$/, "").trimEnd();
  return `${base.slice(0, Math.max(0, PLAN_NAME_LIMIT - suffix.length)).trimEnd()}${suffix}`;
}

/** The handlers a recipe lists: the exported list as written (every tier's own id), else the synthesized ones. */
function handlersOf(recipe: Recipe): MachineHandler[] {
  return recipe.machineHandlers?.length ? recipe.machineHandlers : getRecipeMachineHandlers(recipe);
}

/**
 * A machine's name without its tier mark: "Naquadah Reactor Mark" (2.8.1 folds Mark I to V into one id) and
 * "Naquadah Reactor Mk-III" are one family, as are "Acid Generator MV" and "Acid Generator".
 */
function machineFamilyKey(label: string): string {
  return label
    .toLowerCase()
    .replace(/\s*\((?:ulv|lv|mv|hv|ev|iv|luv|zpm|uv|uhv|uev|uiv|umv|uxv|opv|max)\)$/, "")
    .replace(/\s+(?:ulv|lv|mv|hv|ev|iv|luv|zpm|uv|uhv|uev|uiv|umv|uxv|opv|max)$/, "")
    .replace(/\s+(?:mark|mk)(?:[\s-]*[ivx]+)?$/, "")
    .replace(/\s+[ivx]+$/, "")
    .trim();
}

type VoltageTier = Exclude<MachineTier, "DEMO">;

function handlerTiers(handler: MachineHandler): VoltageTier[] {
  const listed = handler.availableTiers?.length ? handler.availableTiers : [handler.minimumTier];
  return GT_VOLTAGE_TIERS.map((entry) => entry.tier).filter((tier) => listed.includes(tier));
}

/** The tier of the machine a card stands on: its tier on the handler's ladder, else the ladder's lowest rung. */
function cardTier(node: FactoryNode, handler: MachineHandler): VoltageTier | undefined {
  const tiers = handlerTiers(handler);
  const requested = GT_VOLTAGE_TIERS.find((entry) => entry.tier === node.overclockTier)?.tier;
  const atOrBelow = requested && tiers.findLast((tier) => getVoltageTierIndex(tier) <= getVoltageTierIndex(requested));
  return atOrBelow || tiers[0];
}

/**
 * The machine a card runs on, as the target recipe names it: its chosen handler, or the source recipe's first
 * (the default) when it chose none. Found by id; by a known rename; or as the one handler of the same family
 * (`machineFamilyKey`) at the card's tier among singleblocks, which pairs 2.8.1's folded "Mark" families and tiered acid generators
 * with 2.9's per-tier and folded ones. `missing` names the source machine when the target recipe has none of these.
 */
function targetHandlerFor(
  node: FactoryNode,
  sourceRecipe: Recipe | undefined,
  targetRecipe: Recipe,
): { handlerId?: string; missing?: string } {
  const sourceHandlers = sourceRecipe ? handlersOf(sourceRecipe) : [];
  const chosen = node.machineHandlerId ?? sourceHandlers[0]?.id;
  if (!chosen) return {};
  const targetHandlers = handlersOf(targetRecipe);
  if (targetHandlers.some((handler) => handler.id === chosen)) return { handlerId: chosen };
  const twin = HANDLER_TWIN.get(chosen);
  if (twin && targetHandlers.some((handler) => handler.id === twin)) return { handlerId: twin };
  const sourceHandler = sourceHandlers.find((handler) => handler.id === chosen);
  if (!sourceHandler) return { missing: chosen };
  // Singleblocks only: their tiers are real machines. A multiblock's tier is the recipe's, so a family match
  // there would pair one reactor mark with another (Compact Fusion Mk-I with Mk-II).
  if (sourceHandler.kind === "single") {
    const family = machineFamilyKey(sourceHandler.label);
    const tier = cardTier(node, sourceHandler);
    const sameMachine = targetHandlers.filter(
      (handler) =>
        handler.kind === "single" &&
        machineFamilyKey(handler.label) === family &&
        tier !== undefined &&
        handlerTiers(handler).includes(tier),
    );
    if (sameMachine.length === 1) return { handlerId: sameMachine[0]!.id };
  }
  return { missing: sourceHandler.label };
}

type Marked = { reason?: string; machineType?: string };

/**
 * A copy of the plan for the target dataset's game version. Matched recipes take the target's fresh body, and
 * their cards' overrides, handlers and wire handles follow it (`remapMigratedRecipeReferences`). A card keeps its
 * machine: a handler renamed between versions moves to the new id, and a card left on the default handler is
 * pinned to the same machine when the target lists another one first. A card is marked `unconverted` (keeping its
 * id, count, pins, tier, config and wires) when its recipe is unmatched, or its machine is not in the target
 * version for that recipe; a body no unmarked card uses is removed, so a marked card never shows another
 * version's numbers. Plan-own recipes stay; power cards are rebuilt for the target version. The input is never
 * modified.
 */
export async function convertProjectToVersion(
  project: FactoryProject,
  target: ConversionTarget,
): Promise<{
  project: FactoryProject;
  unconverted: Array<{ nodeId: string; section: number; recipe: UnconvertedRecipe }>;
}> {
  const source = structuredClone(project);
  const fromGameVersion = planGameVersion(source);
  const toGameVersion = gameVersionOfDataset(target.version);
  const absent = ABSENT_IN_VERSION[toGameVersion];
  const notInTarget = `Not in ${gameVersionLabel(toGameVersion)}.`;

  const absentRecipes = new Set<string>();
  const toMatch: Recipe[] = [];
  for (const recipe of source.recipes) {
    if (isPlanOwnRecipe(recipe)) continue;
    const isAbsent = isPowerRecipe(recipe)
      ? absent?.powerSources.has(recipe.power.sourceId)
      : absent?.recipeMaps.has(recipe.source?.recipeMap ?? recipe.machineType);
    if (isAbsent) {
      absentRecipes.add(recipe.id);
    } else if (!isPowerRecipe(recipe)) {
      toMatch.push(recipe);
    }
  }
  const { bodies, unmatched } = await matchRecipesToVersion(toMatch, target);
  const sourceById = new Map(source.recipes.map((recipe) => [recipe.id, recipe] as const));

  // Which sections are marked and why (by node id, then section), and each card's machine on the target.
  const marks = new Map<string, Map<number, Marked>>();
  const handlerChoice = new Map<string, string>();
  const usedByUnmarked = new Set<string>();
  const usedByMarked = new Set<string>();
  for (const node of source.nodes) {
    const sections = [node.recipeId, ...(node.extraRecipes ?? []).map((extra) => extra.recipeId)];
    const nodeMarks = new Map<number, Marked>();
    sections.forEach((recipeId, section) => {
      if (absentRecipes.has(recipeId)) {
        nodeMarks.set(section, { reason: notInTarget });
        return;
      }
      if (unmatched.has(recipeId)) {
        nodeMarks.set(section, {});
        return;
      }
      const body = bodies.get(recipeId);
      if (body) {
        // The card's machine runs every section; section 0's recipe names the default.
        const { handlerId, missing } = targetHandlerFor(node, sourceById.get(node.recipeId), body);
        if (missing) {
          nodeMarks.set(section, { reason: notInTarget, machineType: missing });
          usedByMarked.add(recipeId);
          return;
        }
        if (section === 0 && handlerId) handlerChoice.set(node.id, handlerId);
      }
      usedByUnmarked.add(recipeId);
    });
    if (nodeMarks.size > 0) marks.set(node.id, nodeMarks);
  }
  const dropped = (recipeId: string) =>
    absentRecipes.has(recipeId) ||
    unmatched.has(recipeId) ||
    (usedByMarked.has(recipeId) && !usedByUnmarked.has(recipeId));

  const recipes: Recipe[] = [];
  const kept = new Set<string>();
  const migration = new Map<string, string>();
  for (const recipe of source.recipes) {
    if (dropped(recipe.id)) continue;
    const body = bodies.get(recipe.id) ?? recipe;
    if (body.id !== recipe.id) migration.set(recipe.id, body.id);
    // Two stored recipes can resolve to one target recipe (an old id beside its current one): one body.
    if (kept.has(body.id)) continue;
    kept.add(body.id);
    recipes.push(body);
  }

  // Each card on the machine the target names; a card whose machine is gone keeps the one it chose.
  const placed = source.nodes.map((node): FactoryNode => {
    const handlerId = handlerChoice.get(node.id);
    if (!handlerId || marks.get(node.id)?.has(0)) return node;
    const body = bodies.get(node.recipeId);
    const defaultId = body && handlersOf(body)[0]?.id;
    if (node.machineHandlerId === undefined && handlerId === defaultId) return node;
    return { ...node, machineHandlerId: handlerId };
  });
  const remapped = remapMigratedRecipeReferences(
    {
      ...source,
      gameVersion: toGameVersion,
      name: convertedPlanName(source.name, toGameVersion),
      recipes,
      nodes: placed,
    },
    migration,
  );

  const unconverted: Array<{ nodeId: string; section: number; recipe: UnconvertedRecipe }> = [];
  const markerFor = (recipeId: string, mark: Marked): UnconvertedRecipe => {
    const stored = sourceById.get(recipeId);
    return {
      fromGameVersion,
      recipeId,
      recipeName: stored?.name ?? recipeId,
      machineType: mark.machineType ?? stored?.machineType ?? "",
      ...(mark.reason ? { reason: mark.reason } : {}),
    };
  };
  const originalById = new Map(source.nodes.map((node) => [node.id, node] as const));
  const nodes = remapped.nodes.map((node): FactoryNode => {
    const nodeMarks = marks.get(node.id);
    const original = originalById.get(node.id);
    if (!nodeMarks || !original) return node;
    let marked: FactoryNode = node;
    const zero = nodeMarks.get(0);
    if (zero) {
      const recipe = markerFor(original.recipeId, zero);
      // A marked section stays as it was built (recipe id, machine, slot overrides), none of it remapped onto a
      // body it no longer has.
      marked = { ...marked, recipeId: original.recipeId, unconverted: recipe };
      if (original.machineHandlerId) marked.machineHandlerId = original.machineHandlerId;
      else delete marked.machineHandlerId;
      if (original.recipeInputOverrides) marked.recipeInputOverrides = original.recipeInputOverrides;
      else delete marked.recipeInputOverrides;
      unconverted.push({ nodeId: node.id, section: 0, recipe });
    }
    if (marked.extraRecipes?.length) {
      marked = {
        ...marked,
        extraRecipes: marked.extraRecipes.map((extra, index) => {
          const mark = nodeMarks.get(index + 1);
          const originalExtra = original.extraRecipes?.[index];
          if (!mark || !originalExtra) return extra;
          const recipe = markerFor(originalExtra.recipeId, mark);
          unconverted.push({ nodeId: node.id, section: index + 1, recipe });
          return { ...originalExtra, unconverted: recipe };
        }),
      };
    }
    return marked;
  });

  // A wire's end on a marked section keeps the handle it had; the end on a converted card follows the remap.
  const originalEdges = new Map(source.edges.map((edge) => [edge.id, edge] as const));
  const isMarkedEnd = (nodeId: string, handleId: string | undefined) =>
    marks.get(nodeId)?.has(splitSectionHandleId(handleId).section) ?? false;
  const edges = remapped.edges.map((edge): FactoryEdge => {
    const original = originalEdges.get(edge.id);
    if (!original) return edge;
    const keepSource = isMarkedEnd(original.source, original.sourceHandle);
    const keepTarget = isMarkedEnd(original.target, original.targetHandle);
    if (!keepSource && !keepTarget) return edge;
    return {
      ...edge,
      ...(keepSource ? { sourceHandle: original.sourceHandle } : {}),
      ...(keepTarget ? { targetHandle: original.targetHandle } : {}),
    };
  });

  return { project: resynthesizePowerRecipes({ ...remapped, nodes, edges }), unconverted };
}
