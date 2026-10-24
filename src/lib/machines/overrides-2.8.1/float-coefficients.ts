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
import { f32, fdiv, floatBonus, powInt, rampCeiling, speedFromBonus } from "../java-float";

/** Control ids, as machine-table.ts names them. */
const COIL = "heatingCoil";
const PIPE = "pipeCasing";
const ELECTROMAGNET = "electromagnet";

/**
 * 2.8.1's magnets, in the order of machine-table.ts's electromagnet control.
 * euModifier and speedBoost are Java floats, and the duration is the float
 * 1F / speedBoost. GT5U@5.09.51.476
 * gregtech/common/tileentities/machines/multi/MTEIndustrialElectromagneticSeparator.java:67-81.
 */
const MAGNETS_281 = [
  { power: 0.8, speed: 1.1 },
  { power: 0.75, speed: 1.25 },
  { power: 0.7, speed: 1.5 },
  { power: 0.6, speed: 2 },
  { power: 0.5, speed: 2.5 },
];

/** A magnet row, clamped as machine-table.ts clamps its rows. */
function magnet(index: number): { power: number; speed: number } {
  return MAGNETS_281[Math.min(Math.max(0, index), MAGNETS_281.length - 1)];
}

/**
 * The 2.8.1 Fluid Shaper's steady speed: a float `speedup += 0.025F` while
 * under 3 ends at 3.0000029. GT5U@5.09.51.476
 * gregtech/common/tileentities/machines/multi/MTEMultiSolidifier.java:85, :324-326.
 */
const SHAPER_SPEEDUP_281 = rampCeiling(1, 0.025, 3, true);

/**
 * 2.8.1 machines whose speed or power the Java computes in float where 2.9
 * (GT5U 5.09.54.205) passes a double. Each entry restates the 2.9 formula with
 * `f32` at every float operation and names its 2.8.1 class and line. A float
 * literal is stated as `speed`; a float a formula computes is stated as
 * `durationMultiplier`, since `1 / speed` cannot give back every float. No entry
 * for a float that is exact (1F / 2F, 1F / 4F, 0.75F, 0.5F, 1F / 1.6F), or for
 * a float both versions compute: that one is in machine-table.ts.
 */
export const FLOAT_COEFFICIENT_OVERRIDES: Record<string, Partial<MachineBehaviour> | null> = {
  // GT5U@5.09.51.476 gtPlusPlus/xmod/gregtech/common/tileentities/machines/multi/processing/advanced/MTEAdvEBF.java:255-256:
  // setSpeedBonus(1F / 2.2F), setEuModifier(0.9F).
  Volcanus: { speed: speedFromBonus(floatBonus(2.2)), power: f32(0.9) },
  // GT5U@5.09.51.476 gtPlusPlus/xmod/gregtech/common/tileentities/machines/multi/processing/MTEIndustrialFluidHeater.java:166-167:
  // setSpeedBonus(1F / 2.2F), setEuModifier(0.9F).
  "Thermic Heating Device": { speed: speedFromBonus(floatBonus(2.2)), power: f32(0.9) },
  // GT5U@5.09.51.476 gtPlusPlus/xmod/gregtech/common/tileentities/machines/multi/processing/MTEIndustrialDehydrator.java:245-246:
  // setSpeedBonus(1F / 2.2F); its 0.5F is exact.
  "Multiblock Dehydrator": { speed: speedFromBonus(floatBonus(2.2)) },
  // GT5U@5.09.51.476 gtPlusPlus/xmod/gregtech/common/tileentities/machines/multi/production/chemplant/MTEChemicalPlant.java:655:
  // setSpeedBonus(2F / (1 + coil)), a float division.
  "Chemical Plant": { durationMultiplier: (c) => fdiv(2, 1 + c.tier(COIL)) },
  // GT5U@5.09.51.476 gregtech/common/tileentities/machines/multi/MTEPyrolyseOven.java:157:
  // setSpeedBonus(2f / (1 + coil)), a float division.
  "Pyrolyse Oven": { durationMultiplier: (c) => fdiv(2, 1 + c.tier(COIL)) },
  // GT5U@5.09.51.476 gregtech/common/tileentities/machines/multi/MTEIndustrialBrewery.java:187:
  // setSpeedBonus(1F / 1.5F).
  "Big Barrel Brewery": { speed: speedFromBonus(floatBonus(1.5)) },
  // GT5U@5.09.51.476 gtPlusPlus/xmod/gregtech/common/tileentities/machines/multi/processing/MTENuclearSaltProcessingPlant.java:205:
  // setSpeedBonus(1F / 2.5F).
  "Nuclear Salt Processing Plant": { speed: speedFromBonus(floatBonus(2.5)) },
  // GT5U@5.09.51.476 gtPlusPlus/xmod/gregtech/common/tileentities/machines/multi/processing/MTEIndustrialWashPlant.java:240:
  // setSpeedBonus(1F / 5F).
  "Ore Washing Plant": { speed: speedFromBonus(floatBonus(5)) },
  // GT5U@5.09.51.476 gregtech/common/tileentities/machines/multi/MTEIndustrialExtractor.java:205, :207:
  // setSpeedBonus(1F / 3F), setEuModifier(0.85F).
  "Dissection Apparatus": { speed: speedFromBonus(floatBonus(3)), power: f32(0.85) },
  // GT5U@5.09.51.476 gregtech/common/tileentities/machines/multi/MTEMultiLathe.java:261:
  // setEuModifier(0.8F); its 1F / 4F is exact.
  "Industrial Precision Lathe": { power: f32(0.8) },
  // GT5U@5.09.51.476 gregtech/common/tileentities/machines/multi/MTEIndustrialLaserEngraver.java:360-361:
  // setSpeedBonus(1F / 3.5F), setEuModifier(0.8F).
  "Hyper-Intensity Laser Engraver": { speed: speedFromBonus(floatBonus(3.5)), power: f32(0.8) },
  // GT5U@5.09.51.476 gregtech/common/tileentities/machines/multi/compressor/MTEIndustrialCompressor.java:194:
  // setEuModifier(0.9F); its 1F / 2F is exact.
  "Large Electric Compressor": { power: f32(0.9) },
  // GT5U@5.09.51.476 gregtech/common/tileentities/machines/multi/compressor/MTEHIPCompressor.java:364:
  // setSpeedBonus(1F / 3.5F); its 0.75F is exact. Neither version models the overheated branch (:369-370).
  "Hot Isostatic Pressurization Unit": { speed: speedFromBonus(floatBonus(3.5)) },
  // GT5U@5.09.51.476 gtPlusPlus/xmod/gregtech/common/tileentities/machines/multi/processing/MTEIndustrialSifter.java:189:
  // setSpeedBonus(1F / 5F); its 0.75F is exact.
  "Large Sifter": { speed: speedFromBonus(floatBonus(5)) },
  // GT5U@5.09.51.476 gtPlusPlus/xmod/gregtech/common/tileentities/machines/multi/processing/MTEIndustrialPlatePress.java:184:
  // setSpeedBonus(1F / 6F).
  "Industrial Forming Press": { speed: speedFromBonus(floatBonus(6)) },
  // GT5U@5.09.51.476 gtPlusPlus/xmod/gregtech/common/tileentities/machines/multi/production/MTEMassFabricator.java:294:
  // setEuModifier(0.8F).
  "Matter Fabricator": { power: f32(0.8) },
  // GT5U@5.09.51.476 gregtech/common/tileentities/machines/multi/compressor/MTEBlackHoleCompressor.java:636-637:
  // setEuModifier(0.7F), setSpeedBonus(0.2F).
  "Pseudostable Black Hole Containment Field": { speed: speedFromBonus(f32(0.2)), power: f32(0.7) },
  // GT5U@5.09.51.476 gtPlusPlus/xmod/gregtech/common/tileentities/machines/multi/processing/MTEIndustrialChisel.java:291:
  // setSpeedBonus(1F / 3F); its 0.75F is exact.
  "Industrial 3D Copying Machine": { speed: speedFromBonus(floatBonus(3)) },
  // GT5U@5.09.51.476 gregtech/common/tileentities/machines/multi/MTEMultiSolidifier.java:314, :318:
  // setSpeedBonus(1F / speedup) at the float ramp's end, setEuModifier(0.8F).
  "Fluid Shaper": { durationMultiplier: fdiv(1, SHAPER_SPEEDUP_281), power: f32(0.8) },
  // GT5U@5.09.51.476 gregtech/common/tileentities/machines/multi/MTEIndustrialElectromagneticSeparator.java:282-283:
  // the magnet's float euModifier and 1F / speedBoost.
  "Magnetic Flux Exhibitor": {
    durationMultiplier: (c) => floatBonus(magnet(c.tier(ELECTROMAGNET)).speed),
    power: (c) => f32(magnet(c.tier(ELECTROMAGNET)).power),
  },
  // GT5U@5.09.51.476 gregtech/common/tileentities/machines/multi/MTEMultiAutoclave.java:311-316, :331-332:
  // (float) (12 - fluid pipe) / 12 and (float) 1 / (1 + 0.25f x coil). Both tiers count from 1 in the Java
  // (getCoilTier, :129-130).
  "Industrial Autoclave": {
    durationMultiplier: (c) => fdiv(1, 1 + f32(0.25) * (c.tier(COIL) + 1)),
    power: (c) => fdiv(12 - (c.tier(PIPE) + 1), 12),
  },
  // GT5U@5.09.51.476 gregtech/common/tileentities/machines/multi/MTELargeFluidExtractor.java:204-205, :399-412:
  // setSpeedBonus(1.0f / (float) (1.5 + (float) (0.1 x coil))) and
  // setEuModifier((float) (0.8 x powInt(0.9, coil))).
  "Large Fluid Extractor": {
    durationMultiplier: (c) => fdiv(1, f32(1.5 + f32(0.1 * c.tier(COIL)))),
    power: (c) => f32(0.8 * powInt(0.9, c.tier(COIL))),
  },
};
