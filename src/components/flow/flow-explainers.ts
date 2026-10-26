import type { FactoryProject } from "@/lib/model/types";
import { formatCompact, formatPowerValue } from "@/lib/model";
import {
  energyPerUnitDisplaySuffix,
  energyPerUnitDisplayValue,
  isEnergyRateUnit,
  rateMultiplierForKind,
  rateSuffixForKind,
  rateUnitMultiplier,
  rateUnitPrecisionScale,
} from "@/lib/model/rate-unit";
import { parseResourceHandleId } from "./resource-handles";
import type { RailPort } from "./node-verdict";

/** How ports and wires word their rates, in the board's rate unit. */

type ProjectEdge = FactoryProject["edges"][number];

/**
 * Port rates go through the compact ladder: a mega multiblock moving
 * 1,440,000 L/s has to fit a 118px chip, and a chanced output at 0.004/s has
 * to stay visible instead of rounding to a flat 0.00.
 */
export function formatSlotRate(value: number, kind: string): string {
  return `${formatSlotRateBare(value, kind)}${rateSuffixForKind(kind)}`;
}

export function formatSlotRateBare(value: number, kind = "item"): string {
  const shown = value * rateMultiplierForKind(kind);
  return kind === "power" ? formatPowerValue(shown) : formatCompact(shown);
}

/**
 * The ink of an energy reading, wherever one is drawn (card ports on both
 * sides, the panel's Inputs and Outputs, the search chips): the accent
 * amber, sibling of the panel's red-300 and emerald-300, and it means this
 * one thing. It is the only figure that is not a rate, so it is the only
 * figure that does not wear the muted rate ink.
 */
export const ENERGY_READING_TEXT = "text-amber-300";

/** "200 EU/Item" / "2.5 EU/L" - or "6.25 A LV/Item" under the amps dial: a canvas energy reading. */
export function formatEnergyPerUnit(euPerUnit: number, kind: string): string {
  return `${formatPowerValue(energyPerUnitDisplayValue(euPerUnit))}${energyPerUnitDisplaySuffix(kind)}`;
}

/**
 * The same reading in two pieces, for surfaces that draw the unit as a
 * smaller, greyer tail after the number: "200" and "EU/Item". The number
 * is the reading; the unit only has to be there.
 */
export function formatEnergyPerUnitParts(
  euPerUnit: number,
  kind: string,
): { value: string; unit: string } {
  return {
    value: formatPowerValue(energyPerUnitDisplayValue(euPerUnit)),
    unit: energyPerUnitDisplaySuffix(kind).trim(),
  };
}

/** The tail: a size down, in a greyed gold - the subtitle shade under the number's. */
export const ENERGY_UNIT_TEXT = "ml-0.5 font-medium text-[#8c7d4c]";

/**
 * This port reads as energy per unit right now: the EU unit is on and the
 * port has books behind it. Unsolved ports and EU ports keep their
 * per-second reading whatever the unit says.
 */
export function portReadsEnergy(port: Pick<RailPort, "energyPerUnit">): boolean {
  return isEnergyRateUnit() && port.energyPerUnit !== undefined;
}

/** The one line under a port's name, in whichever unit the board is read in. */
export function formatPortRate(
  port: Pick<RailPort, "energyPerUnit" | "kind">,
  currentPerSecond: number,
): string {
  return portReadsEnergy(port)
    ? formatEnergyPerUnit(port.energyPerUnit!, port.kind)
    : formatSlotRate(currentPerSecond, port.kind);
}

/**
 * Noise floor: anything that would render as a bare zero doesn't render at
 * all. This is what kills "−0.000 kL/s" badges forever.
 */
export function formatSlotRateOrNull(value: number, kind: string): string | null {
  if (!Number.isFinite(value) || value * rateUnitMultiplier() < 0.0005 * rateUnitPrecisionScale()) {
    return null;
  }
  return formatSlotRate(value, kind);
}

/** Whether an edge plugs into a port carrying this resource on this side. */
export function edgeTouchesResource(
  edge: ProjectEdge,
  side: "input" | "output",
  kind: string,
  resourceId: string,
): boolean {
  const handle = side === "input" ? edge.targetHandle : edge.sourceHandle;
  const parsed = parseResourceHandleId(handle);
  if (parsed && parsed.kind === kind && parsed.resourceId === resourceId) {
    return true;
  }
  return edge.resourceKind === kind && edge.resourceId === resourceId;
}

