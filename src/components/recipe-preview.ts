import type { RecipeSummary } from "@/lib/datasets/types";
import { resourceMatchesInput } from "@/lib/model";
import type { Recipe, ResourceAmount } from "@/lib/model/types";

export type PreviewContextResource = Pick<
  ResourceAmount,
  "kind" | "id" | "displayName" | "iconPath" | "iconAtlas" | "dominantColor"
>;

export function summaryToPreviewRecipe(summary: RecipeSummary): Recipe {
  return {
    id: summary.id,
    name: summary.name,
    kind: summary.kind,
    category: summary.category,
    machineType: summary.machineType,
    minimumTier: summary.minimumTier,
    durationTicks: summary.durationTicks,
    eut: summary.eut,
    inputs: summary.inputs,
    outputs: summary.outputs,
    programmedCircuit: summary.programmedCircuit,
    specialValue: summary.specialValue,
    machineHandlers: summary.machineHandlers,
    machineConfigControls: summary.machineConfigControls,
    source: summary.source ?? (summary.recipeMap ? { recipeMap: summary.recipeMap } : undefined),
    metadata: summary.metadata,
    nei: summary.nei,
  };
}

export function contextualizePreviewRecipe(
  recipe: Recipe,
  resource: PreviewContextResource | undefined,
): Recipe {
  if (!resource) {
    return recipe;
  }

  let changed = false;
  const inputs = recipe.inputs.map((input) => {
    if (!resourceMatchesInput(resource, input)) {
      return input;
    }

    if (input.kind !== resource.kind) {
      return input;
    }

    changed = true;
    // A slot that stands for the browsed item (an oredict entry, a list of choices) shows it.
    // A slot that IS the item keeps its own name and picture: one item id can carry several
    // NBT variants (shulker box colours, wands), each named and drawn by its own slot.
    const face = input.id === resource.id ? { ...resource, ...ownFace(input) } : resource;
    return {
      ...input,
      kind: resource.kind,
      id: resource.id,
      displayName: face.displayName ?? input.displayName,
      iconPath: face.iconPath ?? input.iconPath,
      iconAtlas: face.iconAtlas ?? input.iconAtlas,
      dominantColor: face.dominantColor ?? input.dominantColor,
      alternatives: undefined,
    };
  });
  const outputs = recipe.outputs.map((output) => {
    if (output.kind !== resource.kind || output.id !== resource.id) {
      return output;
    }

    // The output is the browsed item itself: its own name and picture win (see the inputs),
    // and the browsed face only fills what the slot lacks.
    changed = true;
    return {
      ...output,
      displayName: output.displayName ?? resource.displayName,
      iconPath: output.iconPath ?? resource.iconPath,
      iconAtlas: output.iconAtlas ?? resource.iconAtlas,
      dominantColor: output.dominantColor ?? resource.dominantColor,
    };
  });

  return changed ? { ...recipe, inputs, outputs } : recipe;
}

/** The face fields a slot carries itself, without the ones it leaves unset. */
function ownFace(slot: ResourceAmount): Partial<PreviewContextResource> {
  return Object.fromEntries(
    (["displayName", "iconPath", "iconAtlas", "dominantColor"] as const)
      .filter((key) => slot[key] !== undefined)
      .map((key) => [key, slot[key]]),
  );
}
