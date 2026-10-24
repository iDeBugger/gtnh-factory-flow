import { z } from "zod";
import { RESOLVE_RECIPES_MAX_REFS } from "@/lib/datasets/resolve-recipes-limits";

/**
 * The shape check for the refs a plan import sends to `resolve-recipes`,
 * before the resolver touches the index: a ref without outputs would throw
 * inside the matcher (a 500 carrying the minified error text), and a
 * non-string id would become a Map key unchallenged. Objects are loose so the
 * fields the matcher reads but this schema does not name (`consumed`,
 * `chance`) pass through; the caller hands the ORIGINAL array on, never the
 * parsed copy, so nothing is stripped on the way.
 */

const finite = z.number().finite();

const slotSchema = z.looseObject({
  kind: z.string().max(32),
  id: z.string().min(1).max(512),
  amount: finite.optional(),
});

const refSchema = z.looseObject({
  id: z.string().min(1).max(512),
  name: z.string().max(256),
  machineType: z.string().max(256),
  recipeMap: z.string().max(128).optional(),
  rawRecipeId: z.string().max(512).optional(),
  inputs: z.array(slotSchema).max(64).optional(),
  outputs: z.array(slotSchema).max(64),
  durationTicks: finite.optional(),
  eut: finite.optional(),
});

const refsSchema = z.array(refSchema).max(RESOLVE_RECIPES_MAX_REFS);

export type RecipeRefsRefusal = "too-many" | "invalid";

/**
 * `refs` when `body.recipes` is a list of well-formed refs within the count
 * cap (the very array that came in), else why it was refused. A missing list
 * is an empty one, as the resolver always read it.
 */
export function checkRecipeRefs(
  body: unknown,
): { refs: unknown[] } | { refusal: RecipeRefsRefusal } {
  const recipes = (body as { recipes?: unknown } | null)?.recipes ?? [];
  if (!Array.isArray(recipes)) {
    return { refusal: "invalid" };
  }
  if (recipes.length > RESOLVE_RECIPES_MAX_REFS) {
    return { refusal: "too-many" };
  }
  return refsSchema.safeParse(recipes).success ? { refs: recipes } : { refusal: "invalid" };
}
