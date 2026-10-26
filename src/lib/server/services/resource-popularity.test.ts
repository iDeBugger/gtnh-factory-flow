import { beforeEach, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({ page: vi.fn() }));
vi.mock("@/lib/server/services/config", () => ({ isDatabaseConfigured: () => true }));
// The mock answers each page as the repository does; the repository throws its error.
vi.mock("@/lib/server/repos/popularity", () => ({
  publicPlanPage: async (offset: number, limit: number) => {
    const { data, error } = (await db.page(offset, limit)) as { data: unknown[] | null; error: { message: string } | null };
    if (error) {
      throw new Error(error.message);
    }
    return data ?? [];
  },
}));

import {
  getResourcePopularity,
  refreshResourcePopularity,
  resetResourcePopularityForTests,
} from "./resource-popularity";

const plan = {
  nodes: [{ recipeId: "r1" }],
  recipes: [{ id: "r1", inputs: [], outputs: [{ kind: "item", id: "minecraft:iron_ingot" }] }],
};

beforeEach(() => {
  resetResourcePopularityForTests();
  db.page.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

it("answers at once while the sweep is still out, instead of waiting on the database", async () => {
  // 2026-09-24: Supabase stalled and every item list request sat ~90 s
  // behind the sweep, because "Most popular" is the default sort.
  let land!: (value: { data: unknown[]; error: null }) => void;
  db.page.mockReturnValue(new Promise((resolve) => (land = resolve)));

  expect(getResourcePopularity().size).toBe(0);
  expect(getResourcePopularity().size).toBe(0);
  expect(db.page).toHaveBeenCalledTimes(1);

  land({ data: [{ plan, outputs: [] }], error: null });
  await refreshResourcePopularity();
  expect(getResourcePopularity().get("item:minecraft:iron_ingot")).toBeGreaterThan(0);
});

it("keeps the last good ranking when a sweep fails, and waits before trying again", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    db.page.mockResolvedValueOnce({ data: [{ plan, outputs: [] }], error: null });
    await refreshResourcePopularity();
    const good = getResourcePopularity();
    expect(good.size).toBe(1);
    expect(db.page).toHaveBeenCalledTimes(1);

    // Due again after six hours; the database is down this time.
    vi.advanceTimersByTime(6 * 60 * 60 * 1000 + 1);
    db.page.mockResolvedValue({ data: null, error: { message: "upstream request timeout" } });
    expect(getResourcePopularity()).toBe(good);
    await refreshResourcePopularity();
    expect(db.page).toHaveBeenCalledTimes(2);
    expect(getResourcePopularity()).toBe(good);

    // The failure is remembered: asking again soon does not touch the database.
    vi.advanceTimersByTime(10 * 60 * 1000);
    getResourcePopularity();
    expect(db.page).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(21 * 60 * 1000);
    getResourcePopularity();
    expect(db.page).toHaveBeenCalledTimes(3);
    await refreshResourcePopularity();
  } finally {
    vi.useRealTimers();
  }
});

it("reads ten posts a statement, stepping by ten, until a short page", async () => {
  const full = { data: Array.from({ length: 10 }, () => ({ plan, outputs: [] })), error: null };
  db.page
    .mockResolvedValueOnce(full)
    .mockResolvedValueOnce(full)
    .mockResolvedValueOnce({ data: [{ plan, outputs: [] }], error: null });
  await refreshResourcePopularity();
  expect(db.page.mock.calls).toEqual([
    [0, 10],
    [10, 10],
    [20, 10],
  ]);
});

it("stops after a thousand posts", async () => {
  db.page.mockResolvedValue({
    data: Array.from({ length: 10 }, () => ({ plan, outputs: [] })),
    error: null,
  });
  await refreshResourcePopularity();
  expect(db.page).toHaveBeenCalledTimes(100);
  expect(db.page).toHaveBeenLastCalledWith(990, 10);
});
