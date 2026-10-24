/**
 * Reactor tables (HTGR pebbles, LFTR salts, LNR fuels) that differ in 2.8.1.
 * Each entry replaces 2.9's whole table, and each row cites its source as `// GT5U@5.09.51.476 <path>:<line>`.
 */
import type { PowerTables } from "../planner-data";

export const REACTORS_2_8_1: Partial<PowerTables> = {
  // GT5U@5.09.51.476 bartworks/common/tileentities/multis/MTEHighTempGasCooledReactor.java:555
  // 2.8.1's HTGR is bartworks', with its own three fuels in sources/reactors.ts; kubatech's
  // pebbles (and their recipe pages) are 2.9 only.
  htgrPebbles: [],
};
