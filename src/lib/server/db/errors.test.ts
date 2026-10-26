import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import { isDatabaseError } from "./errors";

/** What the services take for the database's own refusal, as against a bug or a socket error. */

describe("isDatabaseError", () => {
  it("takes a refusal from PGlite or pg, and nothing with a Node error code", async () => {
    const pglite = new PGlite();
    const refused = await pglite.query("select * from no_such_table").then(
      () => undefined,
      (error: unknown) => error,
    );
    await pglite.close();
    expect(refused).toMatchObject({ code: "42P01" });
    expect(isDatabaseError(refused)).toBe(true);
    // pg's DatabaseError carries the same two fields.
    expect(isDatabaseError(Object.assign(new Error("duplicate key"), { code: "23505", severity: "ERROR" }))).toBe(true);

    const epipe = Object.assign(new Error("write EPIPE"), { code: "EPIPE", errno: -32, syscall: "write" });
    expect(isDatabaseError(epipe)).toBe(false);
    expect(isDatabaseError(Object.assign(new Error("not permitted"), { code: "EPERM" }))).toBe(false);
    expect(isDatabaseError(new TypeError("x is undefined"))).toBe(false);
    expect(isDatabaseError(undefined)).toBe(false);
  });
});
