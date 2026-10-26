import type { Expression, ExpressionBuilder, SqlBool } from "kysely";
import type { PlanSearch } from "@/lib/community/search-query";
import type { Database } from "../db";
import { escapeLike } from "./like";

/**
 * The search box's terms (`parsePlanSearch`) as conditions, for the two
 * shelves that take them: community posts and public blueprints, whose
 * searched columns share names and types. Every term is a bound parameter,
 * so the text never becomes a condition of its own whatever it holds.
 */

/** The tables the search language reads. */
export type SearchedTable = "community_plans" | "blueprints";

/** The searched columns, which both tables carry alike. */
type SearchColumns = {
  searched: { name: string; description: string; tags_text: string; author_name: string };
};

/** `%text%` for ilike, the text's own `%`, `_` and backslash matching only themselves. */
export const containing = (text: string) => `%${escapeLike(text)}%`;

/**
 * Each tag narrows to rows whose tags hold it, `@name` to that creator
 * exactly (a bare `@` to nobody), and the free text to rows whose name,
 * description or tags hold it. No term, no condition.
 */
export function searchConditions<T extends SearchedTable>(
  eb: ExpressionBuilder<Database, T>,
  search: PlanSearch,
): Expression<SqlBool>[] {
  // The columns are unqualified and named alike in both tables, so one
  // builder over their shared shape writes the same SQL for either.
  const on = eb as unknown as ExpressionBuilder<SearchColumns, "searched">;
  const where: Expression<SqlBool>[] = [];
  for (const tag of search.tags) {
    where.push(on("tags_text", "ilike", containing(tag)));
  }
  if (search.author) {
    where.push(on("author_name", "=", search.author));
  } else if (search.bareAuthor) {
    // A bare @ narrows to nobody rather than to everything.
    where.push(on("author_name", "=", ""));
  }
  if (search.text) {
    const pattern = containing(search.text);
    where.push(
      on.or([
        on("name", "ilike", pattern),
        on("description", "ilike", pattern),
        on("tags_text", "ilike", pattern),
      ]),
    );
  }
  return where;
}
