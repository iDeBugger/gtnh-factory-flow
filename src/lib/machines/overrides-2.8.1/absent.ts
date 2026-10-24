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

/** Machines that do not exist in 2.8.1 (`null`). Each entry names the 2.8.1 source that shows it missing. */
export const ABSENT_OVERRIDES: Record<string, Partial<MachineBehaviour> | null> = {
  // GT5U@5.09.51.476 gregtech/loaders/preload/LoaderMetaTileEntities.java:260-572 (registerMultiblockControllers: no MTEExothermicHearth; the class is absent from the tree)
  "Exothermic Hearth": null,
  // GT5U@5.09.51.476 gregtech/loaders/preload/LoaderMetaTileEntities.java:260-572 (registerMultiblockControllers: no MTEEndothermicFridge; the class is absent from the tree)
  "Endothermic Fridge": null,
  // GT5U@5.09.51.476 gtPlusPlus/xmod/gregtech/registration/gregtech/GregtechSteamMultis.java:32 (seven steam multis, no MTESteamFurnaceMulti)
  "Steam Hearth": null,
  // GT5U@5.09.51.476 gregtech/loaders/preload/LoaderMetaTileEntities.java:260-572 (registerMultiblockControllers: no MTESpinmatron; the class is absent from the tree)
  "Spinmatron-2737": null,
  // GT5U@5.09.51.476 gregtech/loaders/preload/LoaderMetaTileEntities.java:260-572 (registerMultiblockControllers: no MTEIndustrialChemicalBath; the class is absent from the tree)
  "Industrial Chemical Bath": null,
  // GT5U@5.09.51.476 gregtech/loaders/preload/LoaderMetaTileEntities.java:260-572 (registerMultiblockControllers: no MTEIndustrialBendingMachine; the class is absent from the tree)
  "Industrial Bending Machine": null,
  // GT5U@5.09.51.476 gregtech/loaders/preload/LoaderMetaTileEntities.java:260-572 (registerMultiblockControllers: no MTEMassSolidifier; the class is absent from the tree)
  "Mass Solidifier": null,
  // GT5U@5.09.51.476 gregtech/loaders/preload/LoaderMetaTileEntities.java:260-572 (registerMultiblockControllers: no MTELatex; the class is absent from the tree)
  "L.A.T.E.X.": null,
  // The kubatech electrode furnace: GT5U@5.09.51.476 has no kubatech arc furnace class. Its only arc furnace multi is
  // GT++'s "High Current Industrial Arc Furnace" (gtPlusPlus/xmod/gregtech/registration/gregtech/GregtechIndustrialArcFurnace.java:22),
  // a different name, so this null never reaches it.
  "Industrial Arc Furnace": null,
  // GT5U@5.09.51.476 tectech/loader/thing/MachineLoader.java:2224-2271 (the tectech multiblock controllers: no
  // MTEBECIONode; tectech/thing/metaTileEntity/multi has no bec package)
  "Bose-Einstein Condensate Teleportation Node": null,
};
