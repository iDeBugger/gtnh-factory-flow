/**
 * Fixes to the workbook's fusion table where it disagrees with the game on every version,
 * plus the row-change machinery each version's fusion override uses.
 *
 * The workbook's `fusionRecipes` rows are drain and output columns per reactor mark. Each
 * mark's drain is the recipe's EU/t times a factor set by the mark, the recipe's voltage tier
 * and (on the compact reactor) its startup band: 64 x `extraPara(startup)` parallels at the
 * recipe's own mark (goodgenerator MTELargeFusionComputer{1..5}.extraPara). A column billed
 * from the wrong EU/t is fixed by scaling every mark by `to / from`, which holds while both
 * values share a voltage tier and the startup band does not move.
 */
import type { FusionRecipeEntry } from "./planner-data";

export type FusionDrainColumn = "drainEutByMark" | "compactDrainEutByMark";

export interface FusionRebill {
  column: FusionDrainColumn;
  from: number;
  to: number;
}

export interface FusionRowChange {
  /** The row's product and its two inputs, as the workbook names them. */
  name: string;
  input1: string;
  input2: string;
  startupEu?: number;
  rebill?: FusionRebill[];
}

/** Rebill both reactors' drain columns from one EU/t to another. */
export function rebillBoth(from: number, to: number): FusionRebill[] {
  return [
    { column: "drainEutByMark", from, to },
    { column: "compactDrainEutByMark", from, to },
  ];
}

function rebillColumn(row: FusionRecipeEntry, { column, from, to }: FusionRebill): Array<number | null> {
  return row[column].map((value) => {
    if (!value) {
      return value;
    }
    // A value that is not a whole multiple of `from` was billed from another EU/t: the change
    // no longer describes the row, so fail loudly instead of guessing.
    if (!Number.isInteger(value / from)) {
      throw new Error(`Fusion change: ${row.name} ${column} ${value} is not billed from ${from} EU/t.`);
    }
    return (value / from) * to;
  });
}

/** `rows` with `changes` applied, in order; the input rows are never mutated. */
export function applyFusionChanges(
  rows: readonly FusionRecipeEntry[],
  changes: readonly FusionRowChange[],
): FusionRecipeEntry[] {
  const result = rows.map((row) => ({ ...row }));
  for (const change of changes) {
    const row = result.find(
      (entry) =>
        entry.name === change.name && entry.input1 === change.input1 && entry.input2 === change.input2,
    );
    if (!row) {
      throw new Error(
        `Fusion change names a missing row: ${change.name} (${change.input1} + ${change.input2}).`,
      );
    }
    if (change.startupEu !== undefined) {
      row.startupEu = change.startupEu;
    }
    for (const rebill of change.rebill ?? []) {
      row[rebill.column] = rebillColumn(row, rebill);
    }
  }
  return result;
}

/** Workbook rows that are wrong against the game on both 5.09.51.476 and 5.09.54.205. */
export const FUSION_SOURCE_CORRECTIONS: FusionRowChange[] = [
  // D + He-3 starts at 60M EU; the workbook swapped it with D + T's 40M.
  // GT5U@5.09.51.476 gregtech/loaders/postload/recipes/FusionReactorRecipes.java:48
  // GT5U@5.09.54.205 gregtech/loaders/postload/recipes/FusionReactorRecipes.java:49
  { name: "Helium Plasma", input1: "Deuterium", input2: "Helium-3", startupEu: 60_000_000 },
  // D + T starts at 40M EU.
  // GT5U@5.09.51.476 gregtech/loaders/postload/recipes/FusionReactorRecipes.java:40
  // GT5U@5.09.54.205 gregtech/loaders/postload/recipes/FusionReactorRecipes.java:41
  { name: "Helium Plasma", input1: "Deuterium", input2: "Tritium", startupEu: 40_000_000 },
  // Tantalum + Zinc Plasma bismuth runs at 98304 EU/t from 350M EU: the MK-III compact runs
  // 64 x 1 parallels, so 6291456 EU/t. The workbook's compact column is Silver Plasma's 49152.
  // GT5U@5.09.51.476 gregtech/loaders/postload/recipes/FusionReactorRecipes.java:256
  // GT5U@5.09.54.205 gregtech/loaders/postload/recipes/FusionReactorRecipes.java:273
  // GT5U@5.09.51.476 goodgenerator/blocks/tileEntity/MTELargeFusionComputer3.java:139
  {
    name: "Bismuth Plasma",
    input1: "Molten Tantalum",
    input2: "Zinc Plasma",
    rebill: [{ column: "compactDrainEutByMark", from: 49152, to: 98304 }],
  },
  // Vanadium + Hydrogen chrome runs at 24576 EU/t; the workbook's reactor columns bill 24578.
  // GT5U@5.09.51.476 gregtech/loaders/postload/recipes/FusionReactorRecipes.java:184
  // GT5U@5.09.54.205 gregtech/loaders/postload/recipes/FusionReactorRecipes.java:201
  {
    name: "Molten Chrome",
    input1: "Molten Vanadium",
    input2: "Hydrogen",
    rebill: [{ column: "drainEutByMark", from: 24578, to: 24576 }],
  },
  // Tungsten + Helium osmium runs at 24578 EU/t; the workbook's compact columns bill 24576.
  // GT5U@5.09.51.476 gregtech/loaders/postload/recipes/FusionReactorRecipes.java:136
  // GT5U@5.09.54.205 gregtech/loaders/postload/recipes/FusionReactorRecipes.java:153
  {
    name: "Molten Osmium",
    input1: "Molten Tungsten",
    input2: "Helium",
    rebill: [{ column: "compactDrainEutByMark", from: 24576, to: 24578 }],
  },
  // Neodymium + Hydrogen europium runs at 24576 EU/t; the workbook's reactor columns bill 24578.
  // GT5U@5.09.51.476 gregtech/loaders/postload/recipes/FusionReactorRecipes.java:95
  // GT5U@5.09.54.205 gregtech/loaders/postload/recipes/FusionReactorRecipes.java:96
  {
    name: "Molten Europium",
    input1: "Molten Neodymium",
    input2: "Hydrogen",
    rebill: [{ column: "drainEutByMark", from: 24578, to: 24576 }],
  },
];
