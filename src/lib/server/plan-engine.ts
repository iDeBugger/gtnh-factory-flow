import { initLpEngine, setLpSolveDefaults } from "@/lib/solver/lp-engine";
import { withLpDeadline } from "@/lib/solver/plan/lp";
import { calculateThroughput } from "@/lib/solver";
import type { FactoryProject, ThroughputResult } from "@/lib/model/types";

/**
 * Stats are derived on the server from the uploaded plan (`calculateThroughput`).
 * A plan-mode plan solves integer programs, which only HiGHS can do, so the
 * routes load it first (a no-op for every other plan and after the first
 * load). If it cannot load the solve fails honestly and the stats are the
 * failed plan's, never an error page.
 *
 * The solve runs on the request thread and blocks every other request while
 * it does, so an uploaded plan gets a budget the board never has: one LP
 * stops at `LP_TIME_LIMIT_SECONDS`, and `solvePlanStats` rejects every model
 * past `PLAN_STATS_BUDGET_MS`; a model whose LP hits the limit stops there,
 * so a solve holds the thread at most the budget plus one LP's limit. Past
 * either the stats are the failed plan's
 * and the post is still stored. The limits are set once per process and
 * only here: nothing in this module reaches the browser.
 */

const LP_TIME_LIMIT_SECONDS = 2;
const MAX_MIP_NODES = 20_000;
const PLAN_STATS_BUDGET_MS = 5_000;

let limitsSet = false;

export async function ensurePlanEngine(project: Pick<FactoryProject, "planMode">): Promise<void> {
  if (!limitsSet) {
    setLpSolveDefaults({ timeLimitSeconds: LP_TIME_LIMIT_SECONDS, maxMipNodes: MAX_MIP_NODES });
    limitsSet = true;
  }
  if (project.planMode) {
    await initLpEngine();
  }
}

/** The books of an uploaded plan under the server's time budget. */
export function solvePlanStats(project: FactoryProject): ThroughputResult {
  return withLpDeadline(PLAN_STATS_BUDGET_MS, () => calculateThroughput(project));
}
