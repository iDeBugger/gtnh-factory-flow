import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
} from "kysely";
import { describe, expect, it } from "vitest";
import { parsePlanSearch } from "@/lib/community/search-query";
import type { Database } from "../db/schema";
import { searchConditions, type SearchedTable } from "./search";

/** Compiles only: no database is reached. */
const db = new Kysely<Database>({
  dialect: {
    createAdapter: () => new PostgresAdapter(),
    createDriver: () => new DummyDriver(),
    createIntrospector: (kysely) => new PostgresIntrospector(kysely),
    createQueryCompiler: () => new PostgresQueryCompiler(),
  },
});

/** The where clause and parameters the search adds to a read of `table`, or undefined when it adds none. */
function compiled(table: SearchedTable, raw: string) {
  let conditions = 0;
  const query = db
    .selectFrom(table)
    .select("id")
    .where((eb) => {
      const where = searchConditions(eb, parsePlanSearch(raw));
      conditions = where.length;
      return eb.and(where);
    })
    .compile();
  return conditions === 0
    ? undefined
    : { where: query.sql.slice(query.sql.indexOf(" where ") + 7), parameters: query.parameters };
}

describe("searchConditions", () => {
  it("narrows by every tag, then the creator, then the text, the same for posts and blueprints", () => {
    const expected = {
      where:
        '("tags_text" ilike $1 and "tags_text" ilike $2 and "author_name" = $3 and ("name" ilike $4 or "description" ilike $5 or "tags_text" ilike $6))',
      parameters: ["%oil%", "%diesel%", "brkge", "%fuel%", "%fuel%", "%fuel%"],
    };
    expect(compiled("community_plans", "#oil #diesel @brkge fuel")).toEqual(expected);
    expect(compiled("blueprints", "#oil #diesel @brkge fuel")).toEqual(expected);
  });

  it("keeps the text in its parameters whatever it holds", () => {
    const plain = compiled("blueprints", "steel")!;
    for (const raw of ["x,y)z,is_public.eq.false", "x' or '1'='1", 'a"b{c}', "$1; drop table blueprints"]) {
      const search = compiled("blueprints", raw)!;
      expect(search.where, raw).toBe(plain.where);
      expect(new Set(search.parameters).size, raw).toBe(1);
    }
  });

  it("escapes LIKE's own characters in a term that reaches it", () => {
    const query = db
      .selectFrom("blueprints")
      .select("id")
      .where((eb) =>
        eb.and(searchConditions(eb, { tags: ["a_b"], author: "", bareAuthor: false, text: "50%\\" })),
      )
      .compile();
    expect(query.parameters).toEqual(["%a\\_b%", "%50\\%\\\\%", "%50\\%\\\\%", "%50\\%\\\\%"]);
  });

  it("adds nothing for an empty search and narrows a bare @ to nobody", () => {
    expect(compiled("blueprints", "   ")).toBeUndefined();
    expect(compiled("blueprints", "@")).toEqual({ where: '"author_name" = $1', parameters: [""] });
  });
});
