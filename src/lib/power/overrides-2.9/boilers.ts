/**
 * 2.9's large boiler solid fuel tables: burn time computed from GT5U 5.09.54.205's Java over the
 * workbook's fuel values. The liquid tables stay as extracted.
 */
import rawData from "../data/power-planner-data.json";
import type { PowerFuelEntry, PowerTables } from "../planner-data";

const tables = rawData as unknown as PowerTables;

/** runtimeBoost of each MTELargeBoilerBase subclass, in Java int math. */
const RUNTIME_BOOST: Record<string, (ticks: number) => number> = {
  // GT5U@5.09.54.205 gregtech/common/tileentities/machines/multi/MTELargeBoilerBronze.java:57
  bronzeSolid: (ticks) => ticks * 2,
  // GT5U@5.09.54.205 gregtech/common/tileentities/machines/multi/MTELargeBoilerSteel.java:57
  steelSolid: (ticks) => ticks,
  // GT5U@5.09.54.205 gregtech/common/tileentities/machines/multi/MTELargeBoilerTitanium.java:57
  titaniumSolid: (ticks) => Math.trunc((ticks * 3) / 10),
  // GT5U@5.09.54.205 gregtech/common/tileentities/machines/multi/MTELargeBoilerTungstenSteel.java:57
  tungstensteelSolid: (ticks) => Math.trunc((ticks * 15) / 100),
};

/**
 * LargeBoilerFuelBackend.getBurntimeRatioTicks (GT5U@5.09.54.205
 * gregtech/api/recipe/maps/LargeBoilerFuelBackend.java:143-149): s = ticks / divider seconds,
 * s x max(1, 1 + ln(s / 10) x 0.025) as a BigDecimal of the exact double, rounded HALF_UP to
 * 2 places, x 20, intValue. toFixed rounds the exact double to the nearest hundredth with ties
 * up, which is HALF_UP for a positive value; the x 20 runs on whole hundredths so no double
 * product can land a hair under an integer.
 */
export function burntimeRatioTicks(ticks: number, divider: number): number {
  const seconds = ticks / divider;
  const boosted = seconds * Math.max(1, 1 + Math.log(seconds / 10) * 0.025);
  const hundredths = Number(boosted.toFixed(2).replace(".", ""));
  return Math.trunc((hundredths * 20) / 100);
}

/**
 * Burn ticks per item: fuel value / 80 (int), through getBurntimeRatioTicks(ticks, 20), then
 * runtimeBoost (GT5U@5.09.54.205 gregtech/common/tileentities/machines/multi/MTELargeBoilerBase.java:334-339,
 * :369). Every fuel value in the rows is a multiple of 80, so the carried remainder (excessFuel,
 * :335-337) never adds a tick.
 */
export function largeBoilerSolidTicks2_9(table: string, fuelValue: number): number {
  const boost = RUNTIME_BOOST[table];
  if (!boost) {
    throw new Error(`No large boiler solid table ${table}.`);
  }
  return boost(burntimeRatioTicks(Math.trunc(fuelValue / 80), 20));
}

function solidRows(table: string): PowerFuelEntry[] {
  return tables.boilerFuels[table].map((row) => ({
    ...row,
    burnTime: largeBoilerSolidTicks2_9(table, row.euPerItem ?? 0) / 20,
  }));
}

export const BOILERS_2_9: Pick<PowerTables, "boilerFuels"> = {
  boilerFuels: {
    ...tables.boilerFuels,
    ...Object.fromEntries(Object.keys(RUNTIME_BOOST).map((table) => [table, solidRows(table)])),
  },
};
