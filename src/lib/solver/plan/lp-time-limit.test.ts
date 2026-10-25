import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { initLpEngine, setLpSolveDefaults } from "../lp-engine";
import { loadInput } from "./__fixtures__/load";
import { takeLpCount, withLpDeadline } from "./lp";
import { solvePlan } from "./solve-plan";

/**
 * A model whose LP HiGHS stops on the clock costs one time limit, not one per
 * HiGHS setting: a stand-in engine answers "Time limit reached" to every
 * solve and counts them. Vitest isolates this file, so the stand-in never
 * reaches the doctrine exams.
 */
const highs = { solves: 0 };
vi.mock("highs", () => ({
  default: async () => ({
    solve: () => {
      highs.solves += 1;
      return { Status: "Time limit reached", Columns: {}, Rows: [] };
    },
  }),
}));

describe("a model that hits the time limit", () => {
  beforeAll(async () => {
    expect(await initLpEngine()).toBe(true);
  });

  afterEach(() => {
    setLpSolveDefaults(null);
  });

  it("makes one HiGHS solve per model and fails with the time budget named", () => {
    setLpSolveDefaults({ timeLimitSeconds: 2, maxMipNodes: 20_000 });
    takeLpCount();
    highs.solves = 0;
    const answer = withLpDeadline(60_000, () => solvePlan(loadInput("benzene")));
    const models = takeLpCount();
    expect(answer.kind).toBe("failed");
    expect(JSON.stringify(answer)).toContain("time budget");
    expect(models).toBeGreaterThan(0);
    expect(highs.solves).toBe(models);
  });
});
