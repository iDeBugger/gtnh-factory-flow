/**
 * 2.8.1's power tables: the parts merged into one override set for POWER_DATA_OVERRIDES.
 * Each part owns its tables; a table named in two parts is a mistake and throws on load.
 */
import type { PowerTables } from "../planner-data";
import { BOILERS_2_8_1 } from "./boilers";
import { FUELS_2_8_1 } from "./fuels";
import { FUSION_2_8_1 } from "./fusion";
import { REACTORS_2_8_1 } from "./reactors";

export function mergePowerOverrideParts(
  parts: Record<string, Partial<PowerTables>>,
): Partial<PowerTables> {
  const merged: Partial<PowerTables> = {};
  const owner = new Map<string, string>();
  for (const [part, tables] of Object.entries(parts)) {
    for (const table of Object.keys(tables)) {
      const first = owner.get(table);
      if (first) {
        throw new Error(`2.8.1 power table "${table}" is overridden in both ${first} and ${part}.`);
      }
      owner.set(table, part);
    }
    Object.assign(merged, tables);
  }
  return merged;
}

export const POWER_DATA_OVERRIDES_2_8_1: Partial<PowerTables> = mergePowerOverrideParts({
  "fuels.ts": FUELS_2_8_1,
  "boilers.ts": BOILERS_2_8_1,
  "reactors.ts": REACTORS_2_8_1,
  "fusion.ts": FUSION_2_8_1,
});
