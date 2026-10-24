/*
 * Import rule for every overrides-2.8.1 file: import only types from
 * ../machine-table (`import type`). machine-table.ts loads these files through
 * version-overrides.ts, so a value read from it here is still uninitialised
 * when this file runs, whichever module loads first. A value an entry needs
 * (an overclock rule, a control) goes in a separate module that imports
 * neither machine-table.ts nor these files. load-order.test.ts loads every
 * file first in turn and fails on a break.
 */
import type { MachineBehaviour, MachineContext } from "../machine-table";
import { f32, floatBonus, speedFromBonus } from "../java-float";
import { OVERCLOCK, choiceControl } from "../table-builders";

/**
 * The GT++ hammer's anvil, the block in the middle of its 3x3x3 (vanilla 1,
 * Railcraft steel 2, Ender IO dark steel or Thaumic Bases thaumium 3, void
 * metal 4): its position + 1 is the anvil tier the parallels scale on.
 * GT5U@5.09.51.476 gtPlusPlus/xmod/gregtech/common/tileentities/machines/multi/processing/MTEIndustrialForgeHammer.java:131-143
 */
export const FORGE_HAMMER_ANVIL_CONTROL = choiceControl("forgeHammerAnvil", "Anvil", [
  "Vanilla Anvil",
  "Steel Anvil",
  "Dark Steel or Thaumium Anvil",
  "Void Metal Anvil",
]);

/** The item pipe knob 2.9 gives these machines, and the fluid one the scraper offers them. */
const NO_PIPES = ["pipeCasing", "itemPipeCasing"];

/** The 2.8.1 coke oven casings by control key: the key is the parallel count. */
const COKE_OVEN_CASING_PARALLELS: Record<string, number> = { "18": 18, "30": 30 };
const COKE_OVEN_DEFAULT_PARALLELS = 18;
/** The 2.9 casing keys a converted plan stores, read as the 2.8.1 casing they name. */
const COKE_OVEN_LEGACY_CASING_KEYS: Record<string, string> = { heat_resistant: "18", heat_proof: "30" };

function normalizeCokeOvenCasing(settings: Record<string, string>): Record<string, string> {
  const mapped = COKE_OVEN_LEGACY_CASING_KEYS[settings.cokeOvenCasing ?? ""];
  return mapped ? { ...settings, cokeOvenCasing: mapped } : settings;
}

/**
 * The coke oven's casing as the card resolved it, or undefined when the recipe has no casing control (the
 * brick oven). A key 2.8.1 has no casing for (a dataset still on the 2.9 keys) counts as the default, and
 * `known` is false so the card says so.
 */
function cokeOvenCasing(c: MachineContext): { key: string; parallels: number; known: boolean } | undefined {
  const control = c.recipe?.machineConfigControls?.find((entry) => entry.id === "cokeOvenCasing");
  if (!control) return undefined;
  const key = control.tiers[c.tier("cokeOvenCasing")]?.key ?? control.defaultKey ?? control.minimumKey;
  const parallels = COKE_OVEN_CASING_PARALLELS[key];
  return parallels === undefined
    ? { key, parallels: COKE_OVEN_DEFAULT_PARALLELS, known: false }
    : { key, parallels, known: true };
}

/**
 * 2.8.1 GT++ multiblocks whose knob 2.9 changed or added (sawblades, item pipe
 * casings, the forge hammer's solenoid, the macerator chip's speed, coke oven
 * slices and coils). Each entry names its 2.8.1 class and line. A saved
 * setting for a knob 2.8.1 lacks is read by no formula here, so it changes
 * nothing.
 */
export const GTPP_KNOB_OVERRIDES: Record<string, Partial<MachineBehaviour> | null> = {
  // GT5U@5.09.51.476 gtPlusPlus/xmod/gregtech/common/tileentities/machines/multi/processing/MTEIndustrialCuttingMachine.java:183-190
  // (setSpeedBonus(1F / 3F), setEuModifier(0.75F), 4 x getTier(getMaxInputVoltage())): no sawblade.
  // 2.9: GT5U@5.09.54.205 gregtech/common/tileentities/machines/multi/MTEIndustrialCuttingMachine.java:292-315 (sawblade tier).
  "Industrial Cutting Factory": {
    speed: speedFromBonus(floatBonus(3)),
    power: f32(0.75),
    parallels: (c) => 4 * c.voltageTier,
    controls: [],
    hidesControls: ["sawblade", "cuttingSawblade"],
  },
  // GT5U@5.09.51.476 gtPlusPlus/xmod/gregtech/common/tileentities/machines/multi/processing/MTEIndustrialForgeHammer.java:238,244
  // (setSpeedBonus(1 / 2F), 8 x anvil tier x getTier(getMaxInputVoltage())): an anvil, no solenoid.
  // 2.9: GT5U@5.09.54.205 gregtech/common/tileentities/machines/multi/MTEIndustrialForgeHammer.java:199-205 (6 x solenoid).
  "Industrial Sledgehammer": {
    speed: 2,
    parallels: (c) => 8 * (c.tier("forgeHammerAnvil") + 1) * c.voltageTier,
    controls: [FORGE_HAMMER_ANVIL_CONTROL],
    hidesControls: ["solenoidCoil"],
  },
  // GT5U@5.09.51.476 gtPlusPlus/xmod/gregtech/common/tileentities/machines/multi/processing/MTEIndustrialMacerator.java:358-366
  // (setSpeedBonus(1F / 1.6F) whatever the controller tier; max(1, (chip ? 8 : 2) x max(1, tier))).
  // 1F / 1.6F rounds to exactly 0.625, so the speed is 1.6.
  // 2.9: GT5U@5.09.54.205 gregtech/common/tileentities/machines/multi/MTEIndustrialMacerator.java:405-415 (the chip speeds it up).
  "Industrial Maceration Stack": {
    speed: speedFromBonus(floatBonus(1.6)),
    parallels: (c) => Math.max(1, (c.tier("maceratorUpgrade") === 1 ? 8 : 2) * Math.max(1, c.voltageTier)),
  },
  // GT5U@5.09.51.476 gtPlusPlus/xmod/gregtech/common/tileentities/machines/multi/processing/MTEIndustrialMixer.java:181-187
  // (setSpeedBonus(1F / 3.5F), 8 x getTier(getMaxInputVoltage())): no item pipe.
  // 2.9: GT5U@5.09.54.205 gregtech/common/tileentities/machines/multi/MTEIndustrialMixer.java:214-221 (item pipe tier).
  "Industrial Mixing Machine": {
    speed: speedFromBonus(floatBonus(3.5)),
    parallels: (c) => 8 * c.voltageTier,
    controls: [],
    hidesControls: NO_PIPES,
  },
  // GT5U@5.09.51.476 gtPlusPlus/xmod/gregtech/common/tileentities/machines/multi/processing/MTEIndustrialWireMill.java:161-162,184
  // (setSpeedBonus(1F / 3F), setEuModifier(0.75F), 4 x getTier(getMaxInputVoltage())): no item pipe.
  // 2.9: GT5U@5.09.54.205 gregtech/common/tileentities/machines/multi/MTEIndustrialWireMill.java:157-169 (item pipe tier).
  "Industrial Wire Factory": {
    speed: speedFromBonus(floatBonus(3)),
    power: f32(0.75),
    parallels: (c) => 4 * c.voltageTier,
    controls: [],
    hidesControls: NO_PIPES,
  },
  // GT5U@5.09.51.476 gtPlusPlus/xmod/gregtech/common/tileentities/machines/multi/misc/MTEAmazonPackager.java:159-160,177
  // (setSpeedBonus(1F / 6F), setEuModifier(0.75F), 16 x getTier(getMaxInputVoltage())): no item pipe.
  // 2.9: GT5U@5.09.54.205 gregtech/common/tileentities/machines/multi/MTEIndustrialPackager.java:184-241 (item pipe tier).
  "Amazon Warehousing Depot": {
    speed: speedFromBonus(floatBonus(6)),
    power: f32(0.75),
    parallels: (c) => 16 * c.voltageTier,
    controls: [],
    hidesControls: NO_PIPES,
  },
  // GT5U@5.09.51.476 gtPlusPlus/xmod/gregtech/common/tileentities/machines/multi/processing/MTEIndustrialCokeOven.java:204,209
  // (setEuModifier((100F - getTier(getMaxInputVoltage()) x 4) / 100F); 6 + 12 x casing tier parallels, so 18 Heat
  // Resistant and 30 Heat Proof; :148-150 refuse to form without a full casing tier). No coils and no slices.
  // The 2.8.1 casing control keys each casing by its parallels ("18", "30"). The Railcraft brick oven under the
  // "Coke Oven" alias has no casing control: one parallel and no overclocks, as in 2.9.
  // 2.9: GT5U@5.09.54.205 gregtech/common/tileentities/machines/multi/MTEIndustrialCokeOven.java:354-363 (coils, slices).
  "Industrial Coke Oven": {
    overclock: (c) => (cokeOvenCasing(c) ? OVERCLOCK.normal() : OVERCLOCK.none()),
    power: (c) => f32(f32(100 - 4 * c.voltageTier) / 100),
    parallels: (c) => cokeOvenCasing(c)?.parallels ?? 1,
    normalizeConfig: normalizeCokeOvenCasing,
    settingWarning: (c) => {
      const casing = cokeOvenCasing(c);
      return casing && !casing.known
        ? // The line says what the card counts and why, with no casing key: on such a dataset a picked casing
          // snaps back to the default one, so a key would name the wrong casing.
          `The casing setting could not be read, so this counts Heat Resistant casings: ${COKE_OVEN_DEFAULT_PARALLELS} parallels.`
        : undefined;
    },
    hidesControls: ["heatingCoil", "cokeOvenSlices"],
    note: undefined,
  },
};
