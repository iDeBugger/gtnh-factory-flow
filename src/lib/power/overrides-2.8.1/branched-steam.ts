/** Steam source ids whose 2.8.1 builder branch changes the source itself, not just its tables. */
export const BRANCHED_STEAM_2_8_1: string[] = [
  // One fuel select and the old base outputs (sources/steam-makers.ts, MTELargeBoiler at 5.09.51.476).
  "large-bronze-boiler",
  "large-steel-boiler",
  "large-titanium-boiler",
  "large-tungstensteel-boiler",
];
