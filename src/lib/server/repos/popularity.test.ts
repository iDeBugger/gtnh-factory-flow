import { beforeEach, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({ range: vi.fn(), calls: [] as Array<[string, unknown[]]> }));
vi.mock("../db", () => ({
  getCommunityDb: () => {
    const record =
      (name: string) =>
      (...args: unknown[]) => {
        db.calls.push([name, args]);
        return query;
      };
    const query = {
      select: record("select"),
      or: record("or"),
      order: record("order"),
      range: (...args: unknown[]) => {
        db.calls.push(["range", args]);
        return db.range();
      },
    };
    return { from: record("from") };
  },
}));

import { publicPlanPage } from "./popularity";

beforeEach(() => {
  db.calls.length = 0;
  db.range.mockReset();
});

it("reads one page of the public posts by id, `limit` rows from `offset`", async () => {
  db.range.mockResolvedValue({ data: [{ plan: {}, outputs: [] }], error: null });
  expect(await publicPlanPage(20, 10)).toEqual([{ plan: {}, outputs: [] }]);
  expect(db.calls).toEqual([
    ["from", ["community_plans"]],
    ["select", ["plan, outputs"]],
    ["or", ["is_public.eq.true,is_public.is.null"]],
    ["order", ["id", { ascending: true }]],
    ["range", [20, 29]],
  ]);
});

it("reads no rows as an empty page", async () => {
  db.range.mockResolvedValue({ data: null, error: null });
  expect(await publicPlanPage(0, 10)).toEqual([]);
});

it("throws when the database does not answer, so the sweep keeps its last ranking", async () => {
  db.range.mockResolvedValue({ data: null, error: { message: "upstream request timeout" } });
  await expect(publicPlanPage(0, 10)).rejects.toThrow("upstream request timeout");
});
