/*
 * Import rule for every overrides-2.8.1 file: import only types from
 * ../machine-table (`import type`). machine-table.ts loads these files through
 * version-overrides.ts, so a value read from it here is still uninitialised
 * when this file runs, whichever module loads first. A value an entry needs
 * (an overclock rule, a control) goes in a separate module that imports
 * neither machine-table.ts nor these files. load-order.test.ts loads every
 * file first in turn and fails on a break.
 */
import type { MachineBehaviour } from "../machine-table";
import { ABSENT_OVERRIDES } from "./absent";
import { FLOAT_COEFFICIENT_OVERRIDES } from "./float-coefficients";
import { GTPP_FLAT_OVERRIDES } from "./gtpp-flat";
import { GTPP_KNOB_OVERRIDES } from "./gtpp-knobs";
import { MEGA_OVERRIDES } from "./mega";

type OverrideGroup = Record<string, Partial<MachineBehaviour> | null>;

/**
 * One override map from the group files. A machine belongs to one group, so
 * two groups naming it is an error: a later group would silently replace the
 * earlier one's fields.
 */
export function mergeOverrideGroups(groups: Record<string, OverrideGroup>): OverrideGroup {
  const merged: OverrideGroup = {};
  const owner = new Map<string, string>();
  for (const [group, entries] of Object.entries(groups)) {
    for (const [name, entry] of Object.entries(entries)) {
      const first = owner.get(name);
      if (first !== undefined) {
        throw new Error(`${name} is overridden in both ${first} and ${group}`);
      }
      owner.set(name, group);
      merged[name] = entry;
    }
  }
  return merged;
}

/** Every machine table entry that differs in 2.8.1, keyed by the table's canonical names. */
export const MACHINE_OVERRIDES_2_8_1: OverrideGroup = mergeOverrideGroups({
  "float-coefficients": FLOAT_COEFFICIENT_OVERRIDES,
  mega: MEGA_OVERRIDES,
  "gtpp-flat": GTPP_FLAT_OVERRIDES,
  "gtpp-knobs": GTPP_KNOB_OVERRIDES,
  absent: ABSENT_OVERRIDES,
});
