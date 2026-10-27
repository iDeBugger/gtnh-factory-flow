import { initLpEngine, setLpSolveDefaults } from "@/lib/solver/lp-engine";
import { lpTimeBudgetHits, withLpDeadline } from "@/lib/solver/plan/lp";
import { calculateThroughput } from "@/lib/solver";
import type { FactoryProject, ThroughputResult } from "@/lib/model/types";

/**
 * Stats are derived on the server from the uploaded plan (`calculateThroughput`).
 * A plan solves integer programs, which only HiGHS can do, so the routes load
 * it first (a no-op after the first load). If it cannot load the solve fails honestly and the stats are the
 * failed plan's, never an error page.
 *
 * The solve runs on the request thread and blocks every other request while
 * it does, so an uploaded plan gets a budget the board never has: one LP
 * stops at `LP_TIME_LIMIT_SECONDS`, and `solvePlanStats` rejects every model
 * past `PLAN_STATS_BUDGET_MS`; a model whose LP hits the limit stops there,
 * so a solve holds the thread at most the budget plus one LP's limit. Past
 * either the stats are the failed plan's and a new post is still stored; a
 * refresh of a stored post's stats keeps the stored ones (`outOfTime`). The
 * limits are set once per process and only here: nothing in this module
 * reaches the browser.
 */

const LP_TIME_LIMIT_SECONDS = 2;
const MAX_MIP_NODES = 20_000;
const PLAN_STATS_BUDGET_MS = 5_000;

let limitsSet = false;

/** Every plan solves on HiGHS: load it before the first stats solve, with the server's limits set. */
export async function ensurePlanEngine(): Promise<void> {
  if (!limitsSet) {
    setLpSolveDefaults({ timeLimitSeconds: LP_TIME_LIMIT_SECONDS, maxMipNodes: MAX_MIP_NODES });
    limitsSet = true;
  }
  await initLpEngine();
}

/**
 * The books of an uploaded plan under the server's time budget, and whether
 * the clock stopped any of its models (the books are then the failed plan's,
 * whatever the plan itself would solve to). `budgetMs` is for tests.
 */
export function solvePlanStats(
  project: FactoryProject,
  budgetMs = PLAN_STATS_BUDGET_MS,
): { result: ThroughputResult; outOfTime: boolean } {
  const before = lpTimeBudgetHits();
  const result = withLpDeadline(budgetMs, () => calculateThroughput(project));
  return { result, outOfTime: lpTimeBudgetHits() > before };
}
