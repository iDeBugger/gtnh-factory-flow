import { describe, expect, it } from "vitest";
import { DB_TYPE_PARSERS, toJsonTimestamp } from "./parsers";

/**
 * Values read the way PostgREST answered them, so a route's JSON keeps its
 * spelling when its query moves to the direct client.
 */
describe("the value parsers", () => {
  it("spell a timestamptz as JSON does", () => {
    expect(toJsonTimestamp("2026-10-25 17:33:50.431+00")).toBe("2026-10-25T17:33:50.431+00:00");
    expect(toJsonTimestamp("2026-10-25 17:33:50+00")).toBe("2026-10-25T17:33:50+00:00");
    expect(toJsonTimestamp("2026-10-25 17:33:50.123456+00")).toBe(
      "2026-10-25T17:33:50.123456+00:00",
    );
  });

  it("refuse a timestamp from a session not in UTC", () => {
    expect(() => toJsonTimestamp("2026-10-25 19:33:50.431+02")).toThrow(/UTC/);
  });

  it("read a bigint as a number and a timestamptz through the same parser", () => {
    expect(DB_TYPE_PARSERS[20]("1729876543210")).toBe(1729876543210);
    expect(DB_TYPE_PARSERS[1184]).toBe(toJsonTimestamp);
  });
});
