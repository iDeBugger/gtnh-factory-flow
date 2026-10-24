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
import { f32 } from "../java-float";

/** The heating coil control id, as machine-table.ts names it. */
const COIL = "heatingCoil";

/** 2.8.1 mega multiblocks that differ from 2.9. Each entry names its 2.8.1 class and line. */
export const MEGA_OVERRIDES: Record<string, Partial<MachineBehaviour> | null> = {
  // GT5U@5.09.51.476 bartworks/common/tileentities/multis/mega/MTEMegaChemicalReactor.java:55 extends
  // MegaMultiBlockBase, whose setProcessingLogicPower (MegaMultiBlockBase.java:136) runs on getMaxInputEu() at
  // 1 A. 2.9's class (5.09.54.205 MTEMegaChemicalReactor.java:52) keeps the base hatch power.
  "Mega Chemical Reactor": { fullPowerPool: true },
  // GT5U@5.09.51.476 bartworks/common/tileentities/multis/mega/MTEMegaOilCracker.java:223: the small cracker's
  // additive, capped discount in float, 1.0F - min(0.1F * (coil + 1), 0.5F). 2.9 compounds 0.9 per coil tier
  // (5.09.54.205 MTEMegaOilCracker.java:468). 256 parallels and the mega power pool are the same.
  "Mega Oil Cracker": {
    power: (c) => f32(1 - Math.min(f32(f32(0.1) * (c.tier(COIL) + 1)), f32(0.5))),
  },
  // GT5U@5.09.51.476 bartworks/common/tileentities/multis/mega/MTEMegaDistillTower.java:250 runs the distillation
  // tower map only; its processing logic (line 392) sets no speed or EU bonus and getMaxParallelRecipes (line 397)
  // is a flat 256. No distillery mode, so no height knob and no note about it. speed and power stay stated as 1 so
  // the machine still seeds from the map's base stats (machineTableSeedsFromBase). The dataset's height knob stays
  // hidden: its multipliers are made up in both versions.
  "Mega Distillation Tower": {
    speed: 1,
    power: 1,
    parallels: 256,
    controlsFor: () => [],
    note: undefined,
  },
  // GT5U@5.09.51.476 goodgenerator/blocks/tileEntity/MTEFuelRefineFactory.java:204: no getMaxParallelRecipes, so
  // one parallel, and setProcessingLogicPower (line 226) runs on getMaxInputEu() at 1 A. The perfect-overclock cap
  // of coil tier minus the recipe's (line 219) is the same as 2.9.
  "Naquadah Fuel Refinery": { parallels: 1, fullPowerPool: true },
};
