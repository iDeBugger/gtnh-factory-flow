import type { FactoryProject } from "@/lib/model/types";
import { formatCompact, formatPowerValue } from "@/lib/model";
import {
  energyPerUnitDisplaySuffix,
  energyPerUnitDisplayValue,
  isEnergyRateUnit,
  rateMultiplierForKind,
  rateSuffixForKind,
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

/**
 * This port reads as energy per unit right now: the EU unit is on and the
 * port has books behind it. Unsolved ports and EU ports keep their
 * per-second reading whatever the unit says.
 */
export function portReadsEnergy(port: Pick<RailPort, "energyPerUnit">): boolean {
  return isEnergyRateUnit() && port.energyPerUnit !== undefined;
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

