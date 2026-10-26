import { PostgrestClient } from "@supabase/postgrest-js";
import { beforeAll, describe, expect, it } from "vitest";
import type { DbClient } from "../community";
import { postgrestCases } from "./postgrest-cases";

/**
 * The stand-in's query cases against a real PostgREST: the Docker stack's,
 * reached on a port the rehearsal override publishes. It WRITES and DELETES
 * rows, so point it only at a throwaway database.
 *
 *   REAL_POSTGREST_URL=http://127.0.0.1:<port> REAL_POSTGREST_TOKEN=<service token> \
 *     npx vitest run src/lib/server/local-db/postgrest-real.local.test.ts --config vitest.local.config.ts
 *
 * Skipped when either variable is unset.
 */

const url = process.env.REAL_POSTGREST_URL?.replace(/\/+$/, "");
const token = process.env.REAL_POSTGREST_TOKEN;

describe.skipIf(!url || !token)("a real PostgREST", () => {
  let db: DbClient;

  beforeAll(async () => {
    db = new PostgrestClient(url!, { headers: { Authorization: `Bearer ${token}` } });
    // Every table the cases write, emptied first; the rest go with them by cascade.
    for (const [table, column] of [
      ["community_plans", "id"],
      ["community_users", "id"],
      ["community_events", "id"],
    ] as const) {
      const { error } = await db.from(table).delete().not(column, "is", null);
      expect(error).toBeNull();
    }
  });

  it("refuses a request without the service token", async () => {
    const response = await fetch(`${url}/community_users?select=id`);
    expect(response.status).toBe(401);
  });

  for (const testCase of postgrestCases(() => db)) {
    it(testCase.name, () => testCase.run());
  }
});
