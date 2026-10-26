import type { FactoryProject, MachineHandler, Recipe, RecipeInput } from "./types";
import type { PlanNotice } from "./plan-notice";
import type { RecipeSummary } from "@/lib/datasets/types";
import { listNodeSections } from "./shared-machine";
import { resourceLabel } from "./resources";
import { getRecipeMachineHandlers, isSteamMachineHandler, steamMultiblockMissingHatch } from "./recipe-rules";

/**
 * A slot pick the dataset no longer offers: the body the plan held listed it
 * among that slot's alternatives and the dataset's fresh body does not. Such
 * picks came from a dataset that copied one recipe's substitutes onto every
 * slot of that resource (Distilled Water in a Cutting Machine's Water slot),
 * which the game never accepts. The card keeps the pick until the player or
 * the settling step (`settleRevokedSubstitutes` in the store) changes it.
 */
export interface RevokedSubstitute {
  nodeId: string;
  /** 0 for the card's own recipe, n for its n-th extra recipe. */
  section: number;
  recipeId: string;
  slot: number;
  input: RecipeInput;
  pick: RecipeInput;
}

const sameResource = (a: Pick<RecipeInput, "kind" | "id">, b: Pick<RecipeInput, "kind" | "id">) =>
  a.kind === b.kind && a.id === b.id;

/**
 * The revoked picks of `after` (the plan with the fresh bodies), read against
 * `before` (the same plan with the stored ones). Each card section is read
 * against its own stored recipe, so a migrated id or two stored recipes that
 * migrate to one fresh id are compared slot by slot with what that card held.
 * A slot whose resource changed between the two bodies is left alone: there is
 * nothing to compare it with.
 */
export function findRevokedSubstitutes(before: FactoryProject, after: FactoryProject): RevokedSubstitute[] {
  const storedById = new Map(before.recipes.map((recipe) => [recipe.id, recipe]));
  const freshById = new Map(after.recipes.map((recipe) => [recipe.id, recipe]));
  const beforeNodes = new Map(before.nodes.map((node) => [node.id, node]));
  const revoked: RevokedSubstitute[] = [];
  for (const node of after.nodes) {
    const previous = beforeNodes.get(node.id);
    if (!previous) continue;
    const previousSections = new Map(listNodeSections(previous).map((entry) => [entry.section, entry.node]));
    for (const { section, node: view } of listNodeSections(node)) {
      const stored = storedById.get(previousSections.get(section)?.recipeId ?? "");
      const fresh = freshById.get(view.recipeId);
      if (!stored || !fresh || stored === fresh) continue;
      for (const [slotKey, pick] of Object.entries(view.recipeInputOverrides ?? {})) {
        const slot = Number(slotKey);
        const storedInput = stored.inputs[slot];
        const freshInput = fresh.inputs[slot];
        if (!pick || !storedInput || !freshInput || !sameResource(storedInput, freshInput)) continue;
        if (sameResource(pick, freshInput)) continue;
        const offered = storedInput.alternatives?.some((entry) => sameResource(entry, pick)) ?? false;
        const stillOffered = freshInput.alternatives?.some((entry) => sameResource(entry, pick)) ?? false;
        if (offered && !stillOffered) {
          revoked.push({ nodeId: node.id, section, recipeId: fresh.id, slot, input: freshInput, pick });
        }
      }
    }
  }
  return revoked;
}

/**
 * The recipe a revoked pick really belongs to: the one recipe on the same map
 * whose own slot at that position is the pick (the Cutting Machine's Distilled
 * Water recipe beside its Water one), among the card's twins. Undefined when
 * there is none or more than one.
 */
export function revokedSubstituteTwin(
  recipe: Pick<Recipe, "id" | "machineType" | "source">,
  revoked: Pick<RevokedSubstitute, "slot" | "pick">,
  candidates: RecipeSummary[],
): RecipeSummary | undefined {
  const recipeMap = recipe.source?.recipeMap ?? recipe.machineType;
  const matches = candidates.filter(
    (candidate) =>
      candidate.id !== recipe.id &&
      candidate.recipeMap === recipeMap &&
      candidate.inputs[revoked.slot] !== undefined &&
      sameResource(candidate.inputs[revoked.slot]!, revoked.pick),
  );
  return matches.length === 1 ? matches[0] : undefined;
}

/** The notice line for a card moved onto the recipe that takes its pick. */
export function movedSubstituteLine(card: Pick<Recipe, "name">, pick: Pick<RecipeInput, "id" | "displayName">): string {
  return `${card.name} now runs the recipe that takes ${resourceLabel(pick)}. Its wires stay.`;
}

/** The notice line for a card left as it was, whose pick the game does not take. */
export function keptSubstituteLine(card: Pick<Recipe, "name">, revoked: Pick<RevokedSubstitute, "input" | "pick">): string {
  return `${card.name} takes ${resourceLabel(revoked.pick)} in place of ${resourceLabel(revoked.input)}. The game does not accept that.`;
}

export const REVOKED_SUBSTITUTES_NOTICE = "Some cards used an input the game does not accept there.";

/** The notice line for a card saved on a steam multiblock that cannot take its recipe's fluid. */
export function steamHandlerMovedLine(
  card: Pick<Recipe, "name">,
  saved: Pick<MachineHandler, "label">,
  now: Pick<MachineHandler, "label">,
  missing: "input" | "output" = "input",
): string {
  return `${card.name} now runs on the ${now.label}: the ${saved.label} has no fluid ${missing} hatch.`;
}

export const STEAM_HANDLER_NOTICE = "Some cards moved off a steam machine that has no hatch for their fluid.";

/** A notice with these lines: one more set of lines under the notice already shown, or a notice of its own. */
export function withNoticeLines(
  notice: PlanNotice | null | undefined,
  text: string,
  lines: string[],
): PlanNotice | null {
  if (lines.length === 0) return notice ?? null;
  if (notice) return { ...notice, details: [...notice.details, ...lines] };
  return { text, details: lines };
}

/**
 * Cards saved on a steam multiblock that the fresh body no longer offers for
 * their recipe, because the recipe has a fluid input and the machine has no
 * fluid input hatch (the pipeline and `getRecipeMachineHandlers` leave it off):
 * each with the notice line saying where the card runs now. `before` holds the
 * bodies the plan was saved with, `after` the fresh ones, as for
 * `findRevokedSubstitutes`.
 */
export function findSteamHandlerMoves(
  before: FactoryProject,
  after: FactoryProject,
): Array<{ nodeId: string; line: string }> {
  const storedById = new Map(before.recipes.map((recipe) => [recipe.id, recipe]));
  const freshById = new Map(after.recipes.map((recipe) => [recipe.id, recipe]));
  const beforeNodes = new Map(before.nodes.map((node) => [node.id, node]));
  const moves: Array<{ nodeId: string; line: string }> = [];
  for (const node of after.nodes) {
    const previous = beforeNodes.get(node.id);
    const saved = previous?.machineHandlerId
      ? storedById.get(previous.recipeId)?.machineHandlers?.find((handler) => handler.id === previous.machineHandlerId)
      : undefined;
    const fresh = freshById.get(node.recipeId);
    if (!saved || !fresh || saved.kind !== "multiblock" || !isSteamMachineHandler(saved)) continue;
    const fluidIn = fresh.inputs.some((input) => input.kind === "fluid");
    const fluidOut = fresh.outputs.some((output) => output.kind === "fluid");
    // The app's set covers both versions; the pipeline drops the per-version rest (2.8.1's Squasher and
    // Presser take no input hatch), so a steam machine the fresh body no longer lists left for a fluid too.
    const droppedByDataset = !(fresh.machineHandlers ?? []).some((handler) => handler.id === saved.id);
    const missing =
      steamMultiblockMissingHatch({ kind: saved.kind, machineType: saved.machineType ?? saved.label }, fluidIn, fluidOut) ??
      (droppedByDataset && (fluidIn || fluidOut) ? (fluidIn ? "input" : "output") : undefined);
    if (!missing) continue;
    const offered = getRecipeMachineHandlers(fresh);
    if (offered.some((handler) => handler.id === saved.id) || !offered[0]) continue;
    moves.push({ nodeId: node.id, line: steamHandlerMovedLine(fresh, saved, offered[0], missing) });
  }
  return moves;
}
