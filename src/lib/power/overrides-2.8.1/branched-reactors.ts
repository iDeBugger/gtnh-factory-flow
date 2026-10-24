/** Reactor source ids whose 2.8.1 builder branch changes the source itself, not just its tables. */
export const BRANCHED_REACTORS_2_8_1: string[] = [
  // bartworks' HTGR (sources/reactors.ts bartworksHtgr), not kubatech's.
  "htgr",
  // No ULV panel in 2.8.1.
  "solar-panel",
];
