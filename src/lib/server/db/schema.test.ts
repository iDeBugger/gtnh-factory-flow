import { readFileSync } from "node:fs";
import type { Kysely } from "kysely";
import { describe, expect, it } from "vitest";
import { generateSchemaTypes, SCHEMA_TYPES_FILE } from "../../../../tools/db/generate-types";
import { json } from "./parsers";
import type { Database } from "./schema";

/**
 * Never called: `npm run typecheck` fails if any marked line compiles. Each
 * directive sits on the one property that must be refused, inside an
 * otherwise valid write, so an unrelated error elsewhere in the call (a new
 * required column, a renamed one) cannot satisfy it.
 */
export function writesTheTypesRefuse(db: Kysely<Database>) {
  return [
    db.insertInto("community_plans").values({
      name: "p",
      plan: json({}),
      uploader_key: "k",
      // @ts-expect-error score is Postgres's (upvotes - downvotes)
      score: 1,
    }),
    db.updateTable("library_designs").set({
      name: "n",
      // @ts-expect-error plan_bytes is Postgres's (octet_length of the plan)
      plan_bytes: 10,
    }),
    db.insertInto("community_events").values({
      actor_key: "a",
      action: "b",
      // @ts-expect-error the id is an identity column
      id: 1,
    }),
    db.updateTable("blueprints").set({
      name: "n",
      // @ts-expect-error a jsonb column takes json(), never a raw array
      needs: [],
    }),
    db.updateTable("blueprints").set({ name: "n", needs: json([]) }),
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
