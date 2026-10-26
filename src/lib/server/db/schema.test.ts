import { readFileSync } from "node:fs";
import type { Kysely } from "kysely";
import { describe, expect, it } from "vitest";
import { generateSchemaTypes, SCHEMA_TYPES_FILE } from "../../../../tools/db/generate-types";
import { json } from "./parsers";
import type { Database } from "./schema";

/**
 * Never called: `npm run typecheck` fails if any marked line compiles, so a
 * generated column or a raw value into jsonb stays a type error.
 */
export function writesTheTypesRefuse(db: Kysely<Database>) {
  return [
    db
      .insertInto("community_plans")
      // @ts-expect-error score is Postgres's (upvotes - downvotes)
      .values({ name: "p", plan: json({}), uploader_key: "k", score: 1 }),
    db
      .updateTable("library_designs")
      // @ts-expect-error plan_bytes is Postgres's (octet_length of the plan)
      .set({ plan_bytes: 10 }),
    db
      .insertInto("community_events")
      // @ts-expect-error the id is an identity column
      .values({ actor_key: "a", action: "b", id: 1 }),
    db
      .updateTable("blueprints")
      // @ts-expect-error a jsonb column takes json(), never a raw array
      .set({ needs: [] }),
    db.updateTable("blueprints").set({ needs: json([]) }),
  ];
}

describe("the row types", () => {
  it("the committed types are the schema's", async () => {
    const committed = readFileSync(SCHEMA_TYPES_FILE, "utf8");
    const generated = await generateSchemaTypes();
    expect(committed === generated, "schema.ts is stale: run npm run db:types").toBe(true);
  }, 60_000);

  it("generated columns cannot be written, nor a raw value into jsonb", () => {
    // The checks are the type errors above; this only keeps them in the suite's files.
    expect(writesTheTypesRefuse).toBeTypeOf("function");
  });
});
