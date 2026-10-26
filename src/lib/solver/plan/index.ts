import type { ThroughputResult } from "../../model/types";
import type { PlanSolveArgs } from "./adapter/args";
import { planSolveAdapter } from "./adapter/solve";

export * from "./types";
export { makePortKey, parsePortKey } from "./port-key";
export { LEFTOVER_KEY_SEPARATOR, makeLeftoverKey, splitLeftoverKey } from "./port-key";
export { compareIds, comparePortRef } from "./ids";
export type { PlanHelpers, PlanSolveArgs, PlanUnit } from "./adapter/args";
export { getSolveCore, setSolveCore, type SolveCore } from "./adapter/engine";

/**
 * The plan-mode entry, called from the dispatch seam in `calculateThroughput`
 * for a project with `planMode`: the adapter turns the expanded project into
 * the solver core's input and the core's answer back into books
 * (`adapter/`). A core that throws is a failed solve, never a crash.
 */
export function planSolve(args: PlanSolveArgs): ThroughputResult {
  return planSolveAdapter(args);
}
