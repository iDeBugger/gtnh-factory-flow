import { getRecipeMapAmperage } from "@/lib/machines/recipe-map-amperage";
import type { GameVersion } from "./game-version";
import { getRecipeAvailableVoltageTiers, getVoltageTierForEuT, getVoltageTierIndex, isVoltageTierName } from "./tiers";
import type { FactoryProject, MachineHandler, MachineTier, Recipe } from "./types";

/**
 * The minimum tier of a stored recipe body on a recipe map with more than one amp, as the pipeline stamps it
 * (normalize-oracle-export.mjs, instantiateRecipeMachineHandlers): the recipe at the tier whose voltage times the
 * map's amps covers its EU/t, a singleblock handler at that tier or its lowest real machine if higher, because the
 * game finds the recipe at the machine's voltage times the map's amps. A stamp at or below the EU/t's 1 A tier is
 * read as a stamp of the draw and restamped; one above it is a real gate and stands. A card whose recipe the
 * landing refresh does not re-find keeps its stored body, so this is where such a body gets the game's tier.
 */
function restamp(
  declared: string,
  eut: number,
  mapAmps: number,
  lowestMachine: Exclude<MachineTier, "DEMO"> | undefined,
): string {
  if (!isVoltageTierName(declared)) return declared;
  if (getVoltageTierIndex(declared) > getVoltageTierIndex(getVoltageTierForEuT(eut))) return declared;
  const ampTier = getVoltageTierForEuT(eut / mapAmps);
  return lowestMachine && getVoltageTierIndex(lowestMachine) > getVoltageTierIndex(ampTier)
    ? lowestMachine
    : ampTier;
}

function restampRecipe(recipe: Recipe, gameVersion: GameVersion): Recipe {
  if (recipe.power) return recipe;
  const mapAmps = getRecipeMapAmperage(recipe.metadata?.recipeMapId, gameVersion);
  if (mapAmps <= 1) return recipe;
  const minimumTier = restamp(recipe.minimumTier, recipe.eut, mapAmps, undefined);
  let handlersChanged = false;
  const machineHandlers = recipe.machineHandlers?.map((handler): MachineHandler => {
    if (handler.kind !== undefined && handler.kind !== "single") return handler;
    const stamped = restamp(handler.minimumTier, handler.eut ?? recipe.eut, mapAmps, getRecipeAvailableVoltageTiers(handler)?.[0]);
    if (stamped === handler.minimumTier) return handler;
    handlersChanged = true;
    return { ...handler, minimumTier: stamped };
  });
  if (minimumTier === recipe.minimumTier && !handlersChanged) return recipe;
  return { ...recipe, minimumTier, ...(handlersChanged ? { machineHandlers } : {}) };
}

/** Every stored recipe body on a multi-amp map, restamped (`restamp`); the same project when none changes. */
export function restampAmpMapMinimums(project: FactoryProject, gameVersion: GameVersion): FactoryProject {
  let changed = false;
  const recipes = project.recipes.map((recipe) => {
    const next = restampRecipe(recipe, gameVersion);
    if (next !== recipe) changed = true;
    return next;
  });
  return changed ? { ...project, recipes } : project;
}
