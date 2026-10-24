/*
 * Value builders the machine table and its version overrides share. This
 * module imports only types from ./machine-table, so an overrides-2.8.1 file
 * can read these values whatever module loads first.
 */
import type { MachineConfigControl } from "@/lib/model/types";
import type { OverclockRule } from "./machine-table";

export const OVERCLOCK = {
  /** 2x speed for 4x EU/t on every step. */
  normal: (): OverclockRule => ({ maxPerfect: 0, maxNormal: Infinity, multiplier: 4 }),
  /** 4x speed for 4x EU/t, total energy unchanged. */
  perfect: (maxPerfect = Infinity, multiplier = 4): OverclockRule => ({
    maxPerfect,
    maxNormal: 0,
    multiplier,
  }),
  /** Perfect while they last, then normal. */
  perfectThenNormal: (maxPerfect = Infinity): OverclockRule => ({
    maxPerfect,
    maxNormal: Infinity,
    multiplier: 4,
  }),
  /** Duration divided by `speedFactor`, EU/t times 4, on every step. */
  custom: (speedFactor: number): OverclockRule => ({
    maxPerfect: Infinity,
    maxNormal: 0,
    multiplier: speedFactor,
    euMultiplier: 4,
  }),
  /** Extra voltage buys nothing. */
  none: (): OverclockRule => ({ maxPerfect: 0, maxNormal: 0, multiplier: 4 }),
} as const;

/**
 * Builds one of our machine config controls from a plain list of option
 * labels. The option's position IS the value the table's formulas read, so the
 * order here must match the reference's choice list exactly.
 *
 * Icons fall back to a generated id when there is no obvious block to show,
 * which the config UI renders as a labelled slot.
 */
export function choiceControl(
  id: string,
  label: string,
  options: Array<string | { label: string; icon: string; name?: string }>,
  defaultIndex = 0,
): MachineConfigControl {
  const tiers = options.map((option, index) => {
    const optionLabel = typeof option === "string" ? option : option.label;
    const icon =
      typeof option === "string" ? `factoryflow:machine_config/${slug(id)}_${index}` : option.icon;
    return {
      key: slug(optionLabel) || `option-${index}`,
      label: optionLabel,
      resource: {
        kind: "item" as const,
        id: icon,
        amount: 1,
        // The block's full name: the config UI also matches icons by name, and
        // a bare "Tin" could land on some other item called Tin.
        displayName: typeof option === "string" ? optionLabel : (option.name ?? optionLabel),
        tooltip: [label],
        consumed: false,
      },
    };
  });

  return {
    id,
    label,
    minimumKey: tiers[0].key,
    defaultKey: tiers[defaultIndex]?.key ?? tiers[0].key,
    tiers,
  };
}

/**
 * A numeric knob the reference models as an unbounded count (slices, catalysts,
 * laser amperage). We offer a discrete ladder instead, because the config UI is
 * built from tier lists rather than free number entry.
 */
export function countControl(
  id: string,
  label: string,
  values: number[],
  defaultIndex = 0,
): MachineConfigControl {
  return {
    id,
    label,
    minimumKey: String(values[0]),
    defaultKey: String(values[defaultIndex] ?? values[0]),
    tiers: values.map((value) => ({
      key: String(value),
      label: `${value}`,
      resource: {
        kind: "item" as const,
        id: `factoryflow:machine_config/${slug(id)}_${value}`,
        amount: 1,
        displayName: `${label}: ${value}`,
        tooltip: [label],
        consumed: false,
      },
    })),
  };
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}
