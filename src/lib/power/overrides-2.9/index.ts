/**
 * 2.9's corrections to the workbook tables: where the extracted workbook disagrees with
 * GT5U 5.09.54.205. Every other version builds on these before its own overrides.
 */
import type { PowerTables } from "../planner-data";
import { BOILERS_2_9 } from "./boilers";
import { FUSION_2_9 } from "./fusion";

export const POWER_DATA_OVERRIDES_2_9: Partial<PowerTables> = {
  ...FUSION_2_9,
  ...BOILERS_2_9,
};
