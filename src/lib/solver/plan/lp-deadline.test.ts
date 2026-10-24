import { beforeAll, describe, expect, it } from "vitest";
import { initLpEngine } from "../lp-engine";
import { digest } from "./__fixtures__/digest";
import { loadInput } from "./__fixtures__/load";
import { takeLpCount, withLpDeadline } from "./lp";
import { solvePlan } from "./solve-plan";

/**
 * The server's time budget around a plan solve: once it is spent no further
 * LP runs and the plan fails with the budget named; a budget that is not
 * spent changes nothing about the answer.
 */

beforeAll(async () => {
  await initLpEngine();
});

describe("a plan solve under a deadline", () => {
  it("rejects with the time budget note and runs no LP once the deadline has passed", () => {
    takeLpCount();
    const answer = withLpDeadline(0, () => solvePlan(loadInput("benzene")));
    expect(takeLpCount()).toBe(0);
    expect(answer.kind).toBe("failed");
    expect(JSON.stringify(answer)).toContain("time budget");
  });

  it("gives the same answer as no deadline while the budget holds", () => {
    const plain = digest(solvePlan(loadInput("benzene")));
    const budgeted = digest(withLpDeadline(60_000, () => solvePlan(loadInput("benzene"))));
    expect(budgeted).toEqual(plain);
    // The deadline is cleared afterwards: the next solve runs its LPs.
    takeLpCount();
    expect(solvePlan(loadInput("benzene")).kind).toBe("solved");
    expect(takeLpCount()).toBeGreaterThan(0);
  });

  it("keeps the nearer deadline when calls nest", () => {
    takeLpCount();
    const answer = withLpDeadline(60_000, () =>
      withLpDeadline(0, () => solvePlan(loadInput("benzene"))),
    );
    expect(answer.kind).toBe("failed");
    expect(takeLpCount()).toBe(0);
  });
});
