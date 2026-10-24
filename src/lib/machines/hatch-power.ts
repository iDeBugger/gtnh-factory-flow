/**
 * How a multiblock's setProcessingLogicPower reads its energy hatches where it is not the base
 * class's rule. The base (GT5U@5.09.54.205 MTEMultiBlockBase.java:1150-1155, GT5U@5.09.51.476
 * :1020-1025) works one lone regular hatch at 1 A and otherwise at getMaxInputAmps, 2 A a hatch.
 *
 * - "full-pool": `setAvailableVoltage(getMaxInputEu())` at 1 A, the sum of every hatch's whole
 *   rating, so a lone hatch gives its full 2 A and the summed voltage is the parallel ordinal. The
 *   machine table states the same rule as `fullPowerPool` for its own entries.
 * - "no-single-amp-clamp": `getAverageInputVoltage()` at `getMaxInputAmps()` with no single-hatch
 *   clause, so a lone hatch works at 2 A while the voltage stays one hatch's.
 *
 * Every class that overrides setProcessingLogicPower at each tag was read; the ones with a fixed
 * voltage (fusion, steam, space elevator, godforge, Neutron Activator, Transcendent Plasma Mixer)
 * are not hatch builds, and the Precise Assembler and Spinmatron keep the lone-hatch clamp. The BEC
 * Teleportation Node (2.9 only) is a machine table entry: its whole pool, rounded up to a tier's
 * voltage, at 1 A (`roundsPoolUpToTier`).
 * Leaf module: it imports nothing, so the machine table and the solver can both read it.
 */
type HatchPowerRule = "full-pool" | "no-single-amp-clamp";

type Version = "2.9" | "2.8.1";

const HATCH_POWER: Record<Version, Record<string, HatchPowerRule>> = {
  "2.9": {
    // GT5U@5.09.54.205 gregtech/common/tileentities/machines/multi/MTEExothermicHearth.java:306-310
    "Exothermic Hearth": "full-pool",
    // GT5U@5.09.54.205 gregtech/common/tileentities/machines/multi/MTEEndothermicFridge.java:445-451
    "Endothermic Fridge": "full-pool",
    // GT5U@5.09.54.205 goodgenerator/blocks/tileEntity/MTEComponentAssemblyLine.java:310-314
    "Component Assembly Line": "full-pool",
    // GT5U@5.09.54.205 gregtech/common/tileentities/machines/multi/MTENanoForge.java:533-538
    "Nano Forge": "full-pool",
    // GT5U@5.09.54.205 gregtech/common/tileentities/machines/multi/foundry/MTEExoFoundry.java:676-683
    "Exo-Foundry": "full-pool",
    // GT5U@5.09.54.205 gtPlusPlus/xmod/gregtech/common/tileentities/machines/multi/production/MTEQuantumForceTransformer.java:504-508
    "Quantum Force Transformer": "no-single-amp-clamp",
    // GT5U@5.09.54.205 kubatech/tileentity/gregtech/multiblock/MTEIndustrialArcFurnace.java:593-602
    "Industrial Arc Furnace": "no-single-amp-clamp",
  },
  "2.8.1": {
    // GT5U@5.09.51.476 goodgenerator/blocks/tileEntity/MTEComponentAssemblyLine.java:315-319
    "Component Assembly Line": "full-pool",
    // GT5U@5.09.51.476 gregtech/common/tileentities/machines/multi/MTENanoForge.java:568-573
    "Nano Forge": "full-pool",
    // GT5U@5.09.51.476 bartworks/common/tileentities/multis/mega/MTEMegaVacuumFreezer.java:69 extends
    // MegaMultiBlockBase, whose setProcessingLogicPower is MegaMultiBlockBase.java:135-139.
    "Mega Vacuum Freezer": "full-pool",
    // GT5U@5.09.51.476 gtPlusPlus/xmod/gregtech/common/tileentities/machines/multi/production/MTEQuantumForceTransformer.java:511-515
    "Quantum Force Transformer": "no-single-amp-clamp",
  },
};

/** The machine's hatch power rule in `gameVersion`, when it is not the base class's. */
export function hatchPowerRule(
  machineType: string | undefined,
  gameVersion: string,
): HatchPowerRule | undefined {
  if (!machineType) return undefined;
  return HATCH_POWER[gameVersion as Version]?.[machineType];
}
