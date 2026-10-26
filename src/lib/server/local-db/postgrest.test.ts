import { PostgrestClient } from "@supabase/postgrest-js";
import { afterAll, beforeAll, describe, it } from "vitest";
import type { DbClient } from "../community";
import { openLocalDatabase, type LocalDatabase } from "./database";
import { postgrestCases } from "./postgrest-cases";

/**
 * The local database answers the server's PostgREST client the way PostgREST
 * does, for every query shape the server code sends (`postgrest-cases.ts`,
 * each case named after the route it mirrors).
 */

let local: LocalDatabase;
let db: DbClient;

beforeAll(async () => {
  local = await openLocalDatabase();
  db = new PostgrestClient("http://local-db.test/rest/v1", {
    headers: { Authorization: "Bearer key" },
    fetch: (input, init) => local.handle(new Request(input, init)),
  });
}, 60_000);

afterAll(async () => {
  await local?.close();
});

describe("the local database's PostgREST stand-in", () => {
  for (const testCase of postgrestCases(() => db)) {
    it(testCase.name, () => testCase.run());
  }
});
