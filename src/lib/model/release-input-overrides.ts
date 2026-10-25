import type { FactoryProject, Recipe, RecipeInput } from "./types";
import { splitSectionHandleId } from "./shared-machine";

/**
 * Lets go of the slot picks `shouldRelease` names, on every card and every
 * shared-machine section, and of the wires that brought a released resource
 * to that section when no row there takes it any more. The slot goes back to
 * its own resource; unwired drawers stay where they are.
 */
export function releaseInputOverrides(
  project: FactoryProject,
  shouldRelease: (recipe: Recipe, input: RecipeInput, override: RecipeInput, slot: number) => boolean,
): FactoryProject {
  const recipesById = new Map(project.recipes.map((recipe) => [recipe.id, recipe]));
  // `${cardId}#${section}` -> the resources let go of in that section, and
  // whether a row there still takes each one.
  const released = new Map<string, Map<string, boolean>>();

  const heal = (
    cardId: string,
    section: number,
    recipeId: string,
    overrides: Record<string, RecipeInput> | undefined,
  ): Record<string, RecipeInput> | undefined => {
    const recipe = recipesById.get(recipeId);
    if (!overrides || !recipe) {
      return overrides;
    }
    const kept: Record<string, RecipeInput> = {};
    const dropped: RecipeInput[] = [];
    for (const [slot, override] of Object.entries(overrides)) {
      const input = recipe.inputs[Number(slot)];
      if (override && input && shouldRelease(recipe, input, override, Number(slot))) {
        dropped.push(override);
        continue;
      }
      kept[slot] = override;
    }
    if (dropped.length === 0) {
      return overrides;
    }
    const stillTaken = new Map<string, boolean>();
    for (const product of dropped) {
      stillTaken.set(
        `${product.kind}:${product.id}`,
        recipe.inputs.some((input, index) => {
          const row = kept[String(index)] ?? input;
          return row.kind === product.kind && row.id === product.id;
        }),
      );
    }
    released.set(`${cardId}#${section}`, stillTaken);
    return Object.keys(kept).length > 0 ? kept : undefined;
  };

  const nodes = project.nodes.map((node) => {
    const overrides = heal(node.id, 0, node.recipeId, node.recipeInputOverrides);
    let extrasChanged = false;
    const extraRecipes = node.extraRecipes?.map((extra, index) => {
      const healed = heal(node.id, index + 1, extra.recipeId, extra.recipeInputOverrides);
      if (healed === extra.recipeInputOverrides) {
        return extra;
      }
      extrasChanged = true;
      const { recipeInputOverrides: _dropped, ...rest } = extra;
      void _dropped;
      return healed ? { ...rest, recipeInputOverrides: healed } : rest;
    });
    if (overrides === node.recipeInputOverrides && !extrasChanged) {
      return node;
    }
    const { recipeInputOverrides: _dropped, ...rest } = node;
    void _dropped;
    return {
      ...rest,
      ...(overrides ? { recipeInputOverrides: overrides } : {}),
      ...(extrasChanged ? { extraRecipes } : {}),
    };
  });
  if (released.size === 0) {
    return project;
  }

  const edges = project.edges.filter((edge) => {
    const section = splitSectionHandleId(edge.targetHandle).section;
    const stillTaken = released
      .get(`${edge.target}#${section}`)
      ?.get(`${edge.resourceKind}:${edge.resourceId}`);
    return stillTaken !== false;
  });
  return { ...project, nodes, edges };
}

/**
 * Lets go of substitutes the dataset no longer offers: a pick the stored body
 * listed in that slot's alternatives and the dataset's fresh body does not.
 * `storedById` maps each refreshed recipe's id to the body the plan held. The
 * slot's own resource and every substitute the fresh body still lists stay,
 * and so does a slot whose resource changed (nothing to compare it with).
 * Such picks came from a dataset that copied one recipe's substitutes onto
 * every slot of that resource (Molten Tin offered in a Fluid Solidifier's
 * solder slot), which the game never accepts.
 */
export function releaseRevokedSubstitutes(project: FactoryProject, storedById: Map<string, Recipe>): FactoryProject {
  if (storedById.size === 0) {
    return project;
  }
  return releaseInputOverrides(project, (recipe, input, override, slot) => {
    const stored = storedById.get(recipe.id)?.inputs[slot];
    if (!stored || stored.kind !== input.kind || stored.id !== input.id) {
      return false;
    }
    if (override.kind === input.kind && override.id === input.id) {
      return false;
    }
    const isOverride = (entry: Pick<RecipeInput, "kind" | "id">) =>
      entry.kind === override.kind && entry.id === override.id;
    return Boolean(stored.alternatives?.some(isOverride)) && !input.alternatives?.some(isOverride);
  });
}
