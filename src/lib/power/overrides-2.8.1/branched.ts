/**
 * Source ids a 2.8.1 builder branch changes without any table: the version-equality test
 * leaves them out, since for them 2.8.1 is meant to differ from 2.9. Each part is owned by
 * the builder it lists.
 */
import { BRANCHED_REACTORS_2_8_1 } from "./branched-reactors";
import { BRANCHED_STEAM_2_8_1 } from "./branched-steam";
import { BRANCHED_TURBINES_2_8_1 } from "./branched-turbines";

export const BRANCHED_IN_2_8_1: string[] = [
  ...BRANCHED_STEAM_2_8_1,
  ...BRANCHED_TURBINES_2_8_1,
  ...BRANCHED_REACTORS_2_8_1,
];
