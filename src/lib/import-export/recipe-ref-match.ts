import type { Recipe, RecipeInput, RecipeOutput, ResourceKind } from "@/lib/model/types";

/**
 * What an imported plan knows about a recipe the dataset no longer lists.
 *
 * Recipe ids are minted per dataset build and are not stable across
 * rebuilds. The only durable identity a recipe has is what it does: which
 * slots it takes and makes, how long it runs and what it draws. That is what
 * a ref carries and what a candidate is scored against.
 */
export interface RecipeRefSlot {
  kind: ResourceKind;
  id: string;
  amount?: number;
}

export interface RecipeContentRef {
  id: string;
  name: string;
  machineType: string;
  recipeMap?: string;
  rawRecipeId?: string;
  inputs?: RecipeRefSlot[];
  outputs: RecipeRefSlot[];
  durationTicks?: number;
  eut?: number;
}

export type RecipeRefCandidate = Pick<
  Recipe,
  "id" | "name" | "machineType" | "inputs" | "outputs" | "durationTicks" | "eut"
> & { source?: { recipeMap?: string } };

export interface RecipeRefMatch<T extends RecipeRefCandidate> {
  candidate: T;
  /** Every slot, amount, tick and EU agrees: the same recipe under a new id. */
  exact: boolean;
  score: number;
}

const EXACT_SCORE = 400;

function slotKey(slot: RecipeRefSlot): string {
  return `${slot.kind}:${slot.id}`;
}

function slotAmountKey(slot: RecipeRefSlot): string {
  return `${slotKey(slot)}:${slot.amount ?? 0}`;
}

function consumedInputs(inputs: RecipeInput[] | RecipeRefSlot[] | undefined): RecipeRefSlot[] {
  return (inputs ?? []).filter(
    (input) => (input as RecipeInput).consumed !== false,
  ) as RecipeRefSlot[];
}

function sameMultiset(left: string[], right: string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.every((entry, index) => entry === sortedRight[index]);
}

function sameSet(left: Set<string>, right: Set<string>): boolean {
  return left.size === right.size && [...left].every((entry) => right.has(entry));
}

function overlapRatio(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 && right.size === 0) {
    return 1;
  }
  let shared = 0;
  for (const entry of left) {
    if (right.has(entry)) {
      shared += 1;
    }
  }
  return shared / (left.size + right.size - shared);
}

/** Outputs the plan expects must all still come out: a wire lands on each. */
export function outputsAreCompatible(
  importedOutputs: Array<Pick<RecipeOutput, "kind" | "id">>,
  candidateOutputs: Array<Pick<RecipeOutput, "kind" | "id">>,
): boolean {
  if (importedOutputs.length === 0) {
    return true;
  }
  const candidateResources = new Set(candidateOutputs.map(slotKey));
  return importedOutputs.every((output) => candidateResources.has(slotKey(output)));
}

/**
 * How well a dataset recipe stands in for the ref. 0 means it cannot.
 *
 * Tiers, highest first: the same content down to amounts, ticks and EU; the
 * same resources in and out; the same outputs with the inputs mostly
 * shared. The name and machine type only break ties inside a tier, so a
 * renamed output never hides the recipe that still makes it, and two
 * recipes sharing a name (the two Steel Ingot blast furnace recipes) are
 * told apart by what they take.
 */
export function scoreRecipeRefCandidate(
  ref: RecipeContentRef,
  candidate: RecipeRefCandidate,
): number {
  const candidateMap = candidate.source?.recipeMap;
  if (
    ref.recipeMap &&
    candidateMap &&
    candidateMap !== ref.recipeMap &&
    candidate.machineType !== ref.machineType
  ) {
    return 0;
  }
  if (!outputsAreCompatible(ref.outputs, candidate.outputs)) {
    return 0;
  }

  const refInputs = consumedInputs(ref.inputs);
  const candidateInputs = consumedInputs(candidate.inputs);
  const refInputIds = new Set(refInputs.map(slotKey));
  const candidateInputIds = new Set(candidateInputs.map(slotKey));
  const refOutputIds = new Set(ref.outputs.map(slotKey));
  const candidateOutputIds = new Set(candidate.outputs.map(slotKey));
  const refKnowsInputs = ref.inputs !== undefined;

  let score: number;
  const sameInputIds = !refKnowsInputs || sameSet(refInputIds, candidateInputIds);
  const sameOutputIds = sameSet(refOutputIds, candidateOutputIds);
  const sameTiming =
    (ref.durationTicks === undefined || ref.durationTicks === candidate.durationTicks) &&
    (ref.eut === undefined || ref.eut === candidate.eut);
  const sameAmounts =
    (!refKnowsInputs ||
      sameMultiset(refInputs.map(slotAmountKey), candidateInputs.map(slotAmountKey))) &&
    sameMultiset(ref.outputs.map(slotAmountKey), candidate.outputs.map(slotAmountKey));

  if (sameInputIds && sameOutputIds && sameAmounts && sameTiming && refKnowsInputs) {
    score = EXACT_SCORE;
  } else if (sameInputIds && sameOutputIds) {
    score = 300 + (sameTiming ? 50 : 0) + (sameAmounts ? 25 : 0);
  } else if (isGridlessArcaneMatch(ref, refInputs, candidate, candidateInputs)) {
    score = 300 + (sameTiming ? 50 : 0);
  } else {
    const ratio = refKnowsInputs ? overlapRatio(refInputIds, candidateInputIds) : 0;
    score = 100 + Math.round(ratio * 100) + (sameOutputIds ? 20 : 0) + (sameTiming ? 10 : 0);
  }

  if (candidate.name === ref.name) {
    score += 3;
  }
  if (candidate.machineType === ref.machineType) {
    score += 2;
  }
  return score;
}

/**
 * The maps whose slot positions are part of the recipe (a crafting pattern, an arcane grid): the same items in
 * another layout are another recipe. Everywhere else a slot's position is only where NEI drew it.
 */
const POSITIONAL_MAPS = new Set(["Shaped Crafting", "Thaumcraft Arcane Crafting", "Thaumcraft"]);

/**
 * What the recipe's content id is made of (normalize-oracle-export.mjs `recipeContentKey`): the map, every slot's
 * kind, id, amount, consumed flag, chance and grid cell, the ticks, EU and special value, plus the programmed
 * circuit. Two bodies with the same key are one recipe with the same numbers.
 */
function recipeNumbersKey(recipe: Recipe): string {
  const map = recipe.source?.recipeMap ?? recipe.machineType;
  const positional = POSITIONAL_MAPS.has(map);
  const slot = (entry: RecipeInput | RecipeOutput) =>
    [
      entry.kind,
      entry.id,
      entry.amount,
      (entry as RecipeInput).consumed === false ? "nc" : "",
      (entry as RecipeOutput).chance ?? "",
      positional && entry.kind !== "aspect" && entry.neiSlot ? `${entry.neiSlot.x},${entry.neiSlot.y}` : "",
    ].join("|");
  return JSON.stringify({
    map,
    inputs: recipe.inputs.map(slot).sort(),
    outputs: recipe.outputs.map(slot).sort(),
    durationTicks: recipe.durationTicks ?? null,
    eut: recipe.eut ?? null,
    specialValue: recipe.specialValue ?? null,
    programmedCircuit: recipe.programmedCircuit ?? null,
  });
}

/**
 * Whether the candidate is the stored recipe with the same numbers, for anything that must not change a plan's
 * numbers (a conversion to another game version). Every field of the content key must agree. One exception: an
 * arcane recipe saved by an old export with its vis cost and no items at all is the candidate that adds the grid,
 * when the output and the exact aspect cost agree. A stored arcane recipe that has items is compared in full.
 */
export function hasSameRecipeNumbers(stored: Recipe, candidate: Recipe): boolean {
  if (recipeNumbersKey(stored) === recipeNumbersKey(candidate)) {
    return true;
  }
  if (stored.inputs.some((slot) => slot.kind !== "aspect")) {
    return false;
  }
  const storedInputs = consumedInputs(stored.inputs);
  const ref = recipeContentRef(stored);
  return (
    stored.durationTicks === candidate.durationTicks &&
    stored.eut === candidate.eut &&
    stored.outputs.every((output) => output.chance === undefined) &&
    candidate.outputs.every((output) => output.chance === undefined) &&
    isGridlessArcaneMatch(ref, storedInputs, candidate, consumedInputs(candidate.inputs))
  );
}

// Maps holding Thaumcraft arcane workbench recipes: the arcane map, and the generic
// Thaumcraft map, where arcane subclasses (Automagy's filter copy, Witching Gadgets'
// photo developing) land.
const ARCANE_MAPS = new Set(["Thaumcraft Arcane Crafting", "Thaumcraft"]);

/**
 * Arcane recipes were once exported with their vis cost and no grid: no items, or for a
 * shapeless recipe one item that was often wrong. Their ids changed when the grid came in,
 * and no content tier can match a ref missing the items. Such a ref (at most one item, while
 * the candidate has more) still names its recipe by what it makes and its exact aspect cost.
 *
 * This stays on for good: a plan saved against such a dataset can be opened or imported at
 * any time. A ref's one real item must still be in the candidate's grid; only an old
 * `choice:` pseudo-item (an ingredient list read as alternatives) is let through unchecked.
 */
function isGridlessArcaneMatch(
  ref: RecipeContentRef,
  refInputs: RecipeRefSlot[],
  candidate: RecipeRefCandidate,
  candidateInputs: RecipeRefSlot[],
): boolean {
  if (ref.machineType !== candidate.machineType || !ARCANE_MAPS.has(ref.machineType)) {
    return false;
  }
  const isAspect = (slot: RecipeRefSlot) => slot.kind === "aspect";
  const refItems = refInputs.filter((slot) => !isAspect(slot));
  const candidateItems = candidateInputs.filter((slot) => !isAspect(slot));
  const candidateItemIds = new Set(candidateItems.map(slotKey));
  return (
    refItems.length <= 1 &&
    candidateItems.length > refItems.length &&
    refItems.every((slot) => slot.id.startsWith("choice:") || candidateItemIds.has(slotKey(slot))) &&
    sameMultiset(
      refInputs.filter(isAspect).map(slotAmountKey),
      candidateInputs.filter(isAspect).map(slotAmountKey),
    ) &&
    sameMultiset(ref.outputs.map(slotAmountKey), candidate.outputs.map(slotAmountKey))
  );
}

/**
 * The best stand-in among the candidates, ties going to the earliest, so the
 * pick is the same every time the same plan is imported.
 */
export function pickRecipeRefMatch<T extends RecipeRefCandidate>(
  ref: RecipeContentRef,
  candidates: Iterable<T>,
): RecipeRefMatch<T> | undefined {
  let best: RecipeRefMatch<T> | undefined;
  for (const candidate of candidates) {
    if (candidate.id === ref.id) {
      continue;
    }
    const score = scoreRecipeRefCandidate(ref, candidate);
    if (score === 0 || (best && score <= best.score)) {
      continue;
    }
    best = { candidate, score, exact: score >= EXACT_SCORE };
  }
  return best;
}

/** The ref an exported recipe body turns into. */
export function recipeContentRef(recipe: Recipe): RecipeContentRef {
  return {
    id: recipe.id,
    name: recipe.name,
    machineType: recipe.machineType,
    recipeMap: recipe.source?.recipeMap,
    rawRecipeId: recipe.source?.rawRecipeId,
    inputs: recipe.inputs.map((input) => ({
      kind: input.kind,
      id: input.id,
      amount: input.amount,
      ...(input.consumed === false ? { consumed: false } : {}),
    })),
    outputs: recipe.outputs.map((output) => ({
      kind: output.kind,
      id: output.id,
      amount: output.amount,
    })),
    durationTicks: recipe.durationTicks,
    eut: recipe.eut,
  };
}
