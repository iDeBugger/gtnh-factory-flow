import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { initLpEngine, LpTimeLimitError, setLpSolveDefaults, solveLpAuto } from "./lp-engine";

/**
 * The server's limits reach HiGHS: a stand-in engine records the options each
 * solve was given and answers what the test says. Vitest isolates this file,
 * so the stand-in and the defaults never leak into the doctrine exams.
 */

const solves: Array<Record<string, number | string | boolean> | undefined> = [];
let status = "Optimal";

vi.mock("highs", () => ({
  default: async () => ({
    solve: (_lp: string, options?: Record<string, number | string | boolean>) => {
      solves.push(options);
      return { Status: status, Columns: { x0: { Primal: 1, Status: "BS" } }, Rows: [] };
    },
  }),
}));

const plain = {
  maximize: [1],
  equalities: [],
  upperBounds: [{ coefficients: new Map([[0, 1]]), rhs: 1 }],
};
const whole = { ...plain, integers: [0] };

describe("the server's solve limits", () => {
  beforeAll(async () => {
    expect(await initLpEngine()).toBe(true);
  });

  afterEach(() => {
    setLpSolveDefaults(null);
    solves.length = 0;
    status = "Optimal";
  });

  it("passes time_limit and mip_max_nodes from the defaults, under the caller's own options", () => {
    expect(solveLpAuto(whole).status).toBe("optimal");
    expect(solves[0]).toBeUndefined();

    setLpSolveDefaults({ timeLimitSeconds: 2, maxMipNodes: 20_000 });
    expect(solveLpAuto(whole).status).toBe("optimal");
    expect(solves[1]).toEqual({ time_limit: 2, mip_max_nodes: 20_000 });
    // A plain LP has no node budget to set.
    solveLpAuto(plain);
    expect(solves[2]).toEqual({ time_limit: 2 });
    solveLpAuto(whole, { maxMipNodes: 5, highsOptions: { presolve: "off" } });
    expect(solves[3]).toEqual({ presolve: "off", time_limit: 2, mip_max_nodes: 5 });
  });

  it("throws, and never falls back to the homegrown simplex, when the time limit stops a solve", () => {
    status = "Time limit reached";
    setLpSolveDefaults({ timeLimitSeconds: 2 });
    expect(() => solveLpAuto(plain)).toThrow(LpTimeLimitError);
    expect(() => solveLpAuto(whole)).toThrow(LpTimeLimitError);
    expect(solves).toHaveLength(2);
  });

  it("reads a stopped solve as before when no clock was asked for", () => {
    status = "Time limit reached";
    expect(solveLpAuto(plain).status).toBe("unbounded");
  });
});
