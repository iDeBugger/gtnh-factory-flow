import { describe, expect, it } from "vitest";
import { useTestDb } from "@/test-support/test-db";
import { createAccount, searchByPrefix } from "./accounts";

/**
 * The account queries against a real database: a prefix search matches the
 * typed characters only (LIKE's `_` and `%` are escaped), and a name is
 * taken once.
 */

const ME = "44444444-4444-4444-8444-444444444444";

const testDb = useTestDb();

let seeded: Promise<void> | undefined;
function seed(): Promise<void> {
  seeded ??= (async () => {
    await testDb()
      .db.insertInto("community_users")
      .values(
        [
          [ME, "a_me"],
          ["55555555-5555-4555-8555-555555555551", "a_b"],
          ["55555555-5555-4555-8555-555555555552", "axb"],
          ["55555555-5555-4555-8555-555555555553", "a%c"],
          ["55555555-5555-4555-8555-555555555554", "abc"],
          ["55555555-5555-4555-8555-555555555555", "a\\d"],
        ].map(([id, username]) => ({ id, username, password_hash: "x" })),
      )
      .execute();
  })();
  return seeded;
}

const names = (rows: Array<{ username: string }>) => rows.map((row) => row.username);

describe("searchByPrefix", () => {
  it("reads `_` as itself, not any one character", async () => {
    await seed();
    expect(names(await searchByPrefix("a_", ME))).toEqual(["a_b"]);
  });

  it("reads `%` as itself, not any run of characters", async () => {
    await seed();
    expect(names(await searchByPrefix("a%", ME))).toEqual(["a%c"]);
  });

  it("reads a backslash as itself", async () => {
    await seed();
    expect(names(await searchByPrefix("a\\", ME))).toEqual(["a\\d"]);
  });

  it("matches any case, by name, the searcher left out", async () => {
    await seed();
    expect(names(await searchByPrefix("AB", ME))).toEqual(["abc"]);
    expect(names(await searchByPrefix("a_m", ME))).toEqual([]);
  });
});

describe("createAccount", () => {
  it("answers taken for a name that exists", async () => {
    const first = await createAccount("twice_named", "hash");
    expect(first).toMatchObject({ username: "twice_named" });
    expect(await createAccount("twice_named", "hash")).toBe("taken");
  });
});
