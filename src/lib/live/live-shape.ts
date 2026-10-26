import { isPowerRecipe } from "@/lib/power/power-recipe";
import type { FactoryProject, Recipe } from "@/lib/model/types";
import type { LiveOp, LivePlan, LiveThing } from "./ops";

/**
 * A plan as live edits see it: the editor's project with everything that is
 * not a person's doing taken out, so a diff of two shapes is exactly what
 * someone did. Both sides of every diff are shaped the same way, and so is
 * a snapshot before it becomes the confirmed plan, so no op ever names a
 * field left out here:
 *
 * - `metadata`: this device's stamps and the owner's post link.
 * - `name`: the design's name is the account row's, changed through the
 *   library, never as a plan edit.
 * - `view`: how each person dresses the board.
 * - `gameVersion`: set when the plan is made and never edited; a live
 *   service built before the field would refuse it as a meta op.
 * - GregTech recipes' `runtimeCalculation` tables: the dataset puts them back
 *   on landing (`recipesToRefresh`), as for the account copy.
 *
 * Shapes are cached by object identity, so an edit that leaves a thing alone
 * leaves its shape the same object and the diff skips it without comparing.
 */

const DROPPED_FIELDS = ["metadata", "name", "view", "gameVersion"] as const;

const shapedPlans = new WeakMap<object, LivePlan>();
const shapedRecipeLists = new WeakMap<object, unknown[]>();
const shapedRecipes = new WeakMap<object, Recipe>();

function shapeRecipe(recipe: Recipe): Recipe {
  if (isPowerRecipe(recipe) || !recipe.runtimeCalculation?.sourceKind?.startsWith("gregtech-")) {
    return recipe;
  }
  let shaped = shapedRecipes.get(recipe);
  if (!shaped) {
    const { runtimeCalculation, ...rest } = recipe;
    void runtimeCalculation;
    shaped = rest as Recipe;
    shapedRecipes.set(recipe, shaped);
  }
  return shaped;
}

function shapeRecipes(recipes: unknown): unknown {
  if (!Array.isArray(recipes)) {
    return recipes;
  }
  let shaped = shapedRecipeLists.get(recipes);
  if (!shaped) {
    shaped = recipes.map((recipe) =>
      recipe && typeof recipe === "object" ? shapeRecipe(recipe as Recipe) : recipe,
    );
    shapedRecipeLists.set(recipes, shaped);
  }
  return shaped;
}

/** The plan as live edits see it (see above). Never mutate the result. */
export function liveShape(plan: FactoryProject | LivePlan): LivePlan {
  const source = plan as LivePlan;
  let shaped = shapedPlans.get(source);
  if (!shaped) {
    const next: LivePlan = { ...source };
    for (const field of DROPPED_FIELDS) {
      delete next[field];
    }
    if ("recipes" in next) {
      next.recipes = shapeRecipes(next.recipes);
    }
    shaped = next;
    shapedPlans.set(source, shaped);
  }
  return shaped;
}

function recipeIdsOf(card: Record<string, unknown>, into: Set<string>): void {
  if (typeof card.recipeId === "string") {
    into.add(card.recipeId);
  }
  if (Array.isArray(card.extraRecipes)) {
    for (const section of card.extraRecipes) {
      if (section && typeof section === "object" && typeof (section as { recipeId?: unknown }).recipeId === "string") {
        into.add((section as { recipeId: string }).recipeId);
      }
    }
  }
}

function idsOf(list: unknown): Set<string> {
  const ids = new Set<string>();
  if (Array.isArray(list)) {
    for (const thing of list) {
      if (thing && typeof thing === "object" && typeof (thing as { id?: unknown }).id === "string") {
        ids.add((thing as { id: string }).id);
      }
    }
  }
  return ids;
}

/**
 * An edit's ops with a put in front for every recipe its cards name that the shared plan does not hold. The dataset's
 * refresh re-keys a card's recipe on this screen only (quietly: a plan from the game names its recipes
 * `gtnhplanner:<card>`), so a card copied or re-pointed here would otherwise name a recipe nobody else has.
 */
export function withRecipesTheyName(ops: LiveOp[], shared: LivePlan, next: LivePlan): LiveOp[] {
  const named = new Set<string>();
  for (const op of ops) {
    if (op.o === "put" && op.c === "nodes") recipeIdsOf(op.v, named);
    else if (op.o === "patch" && op.c === "nodes") recipeIdsOf(op.f, named);
  }
  if (named.size === 0) {
    return ops;
  }
  const held = idsOf(shared.recipes);
  for (const op of ops) {
    if (op.o === "put" && op.c === "recipes") held.add(op.id);
  }
  const missing = [...named].filter((id) => !held.has(id));
  if (missing.length === 0) {
    return ops;
  }
  const recipes = Array.isArray(next.recipes) ? (next.recipes as LiveThing[]) : [];
  const puts: LiveOp[] = [];
  for (const id of missing) {
    const recipe = recipes.find((entry) => entry && entry.id === id);
    if (recipe) puts.push({ o: "put", c: "recipes", id, v: recipe });
  }
  return puts.length > 0 ? [...puts, ...ops] : ops;
}
