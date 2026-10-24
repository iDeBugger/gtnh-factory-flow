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
import { f32, floatBonus, speedFromBonus } from "../java-float";

/**
 * 2.8.1 GT++ multiblocks with a flat speed, power or parallel bonus that 2.9
 * changed. Each entry names its 2.8.1 class and line.
 */
export const GTPP_FLAT_OVERRIDES: Record<string, Partial<MachineBehaviour> | null> = {
  // GT5U@5.09.51.476 gtPlusPlus/xmod/gregtech/common/tileentities/machines/multi/processing/MTEIndustrialThermalCentrifuge.java:152-159
  // (setSpeedBonus(1F / 2.5F), setEuModifier(0.8F), 8 x getTier(getMaxInputVoltage())). It has no coil or
  // solenoid. 2.9: GT5U@5.09.54.205 gregtech/common/tileentities/machines/multi/MTEIndustrialThermalCentrifuge.java:230-237.
  "Large Thermal Refinery": {
    speed: speedFromBonus(floatBonus(2.5)),
    power: f32(0.8),
    parallels: (c) => 8 * c.voltageTier,
  },
  // GT5U@5.09.51.476 gtPlusPlus/xmod/gregtech/common/tileentities/machines/multi/processing/MTEIndustrialVacuumFreezer.java:262-269
  // (setSpeedBonus(1F / 2.2F), setEuModifier(0.9F), 8 parallels).
  // 2.9: GT5U@5.09.54.205 gregtech/common/tileentities/machines/multi/MTECryogenicFreezer.java:212-219.
  "Cryogenic Freezer": {
    speed: speedFromBonus(floatBonus(2.2)),
    power: f32(0.9),
    parallels: 8,
  },
  // GT5U@5.09.51.476 gtPlusPlus/xmod/gregtech/common/tileentities/machines/multi/processing/MTEIndustrialCentrifuge.java:209-216
  // (setEuModifier(0.9F), setSpeedBonus(1F / 2.25F), 6 x getTier(getMaxInputVoltage())): a flat speed, no ramp.
  // 2.9: GT5U@5.09.54.205 gregtech/common/tileentities/machines/multi/MTEIndustrialCentrifuge.java:221-232 (momentum).
  // The 2.8.1 Multiblock Centrifuge map has this one machine, so the pipeline gives it no handlers and its
  // cards are named after the map: the alias reaches them.
  "Industrial Centrifuge": {
    aliases: ["Multiblock Centrifuge"],
    speed: speedFromBonus(floatBonus(2.25)),
    power: f32(0.9),
    parallels: (c) => 6 * c.voltageTier,
    note: undefined,
  },
  // GT5U@5.09.51.476 gtPlusPlus/xmod/gregtech/common/tileentities/machines/multi/processing/MTEIndustrialExtruder.java:157-163
  // (setSpeedBonus(1F / 3.5F), 4 x getTier(getMaxInputVoltage())).
  // 2.9: GT5U@5.09.54.205 gregtech/common/tileentities/machines/multi/MTEIndustrialExtruder.java:197-203.
  "Industrial Extrusion Machine": {
    speed: speedFromBonus(floatBonus(3.5)),
    parallels: (c) => 4 * c.voltageTier,
  },
  // GT5U@5.09.51.476 gtPlusPlus/xmod/gregtech/common/tileentities/machines/multi/processing/MTEndustrialElectrolyzer.java:150-162
  // (setSpeedBonus(1F / 2.8F), setEuModifier(0.9F), 2 x getTier(getMaxInputVoltage())).
  // 2.9: GT5U@5.09.54.205 gregtech/common/tileentities/machines/multi/MTEIndustrialElectrolyzer.java:169-176.
  "Multiblock Electrolyzer": {
    speed: speedFromBonus(floatBonus(2.8)),
    power: f32(0.9),
    parallels: (c) => 2 * c.voltageTier,
  },
  // GT5U@5.09.51.476 gtPlusPlus/xmod/gregtech/common/tileentities/machines/multi/processing/advanced/MTEAdvDistillationTower.java:366-374
  // (distillery: setEuModifier(0.15F), setSpeedBonus(1F / 2F), 8 x getTier(getMaxInputVoltage()) at any height;
  // tower: 1F, 1F / 3.5F, DT_MODE_MAX_PARALLELS = 12 at line 69). 1F / 2F is exact, so distillery speed is 2.
  // 2.9: GT5U@5.09.54.205 same path, lines 397-403.
  "Dangote Distillus": {
    speed: (c) => (c.recipeMap?.toLowerCase() === "distillery" ? 2 : speedFromBonus(floatBonus(3.5))),
    power: (c) => (c.recipeMap?.toLowerCase() === "distillery" ? f32(0.15) : 1),
    parallels: (c) => (c.recipeMap?.toLowerCase() === "distillery" ? 8 * c.voltageTier : 12),
    controlsFor: () => [],
    note: "Distillery mode: 8 parallels per voltage tier. Tower mode: 12 parallels. Power comes from ordinary energy hatches; multi-amp and laser hatches are not supported.",
  },
  // GT5U@5.09.51.476 gregtech/api/recipe/RecipeMaps.java:286 gives the arc furnace map 3 A (amperage(3)), and
  // gregtech/loaders/preload/LoaderMetaTileEntities.java:8181-8186 registers the machines with no EU/t multiplier
  // (5.09.51 has no setMachineEUtMultiplier): recipes run at the EU/t written.
  // 2.9: GT5U@5.09.54.205 gregtech/loaders/preload/LoaderMetaTileEntities.java:7301-7302 (amperage 3, EU/t x3).
  "Arc Furnace": { power: 1 },
  // GT5U@5.09.51.476 gregtech/loaders/preload/LoaderMetaTileEntities.java:8287-8291 (ArcFurnaceUV, "Ultimate Short Circuit Heater"): the UV+ arc furnaces, as above.
  // 2.9: GT5U@5.09.54.205 gregtech/loaders/preload/LoaderMetaTileEntities.java:7396-7407.
  "Short Circuit Heater": { power: 1 },
};
