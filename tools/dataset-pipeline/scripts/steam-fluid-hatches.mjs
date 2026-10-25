// Steam multiblocks whose structure has no fluid input or no fluid output hatch,
// by pack. NEI lists each on its whole recipe map, but a recipe with a fluid
// input never starts in one without an input hatch, and a recipe with a fluid
// output never starts in one without an output hatch: steam bases support void
// protection, and the default voiding mode is VOID_NONE (IVoidable
// .getDefaultVoidingMode on both packs), so VoidProtectionHelper finds no room
// for the fluid and the recipe gets no parallels. The normalizer leaves them off
// such recipes. Any 2.9 build reads the base.

// GT5U 5.09.54.205 gregtech/common/tileentities/machines/multi/steam: the hatch
// elements of MTESteamCentrifuge (steam buses and an OutputHatch),
// MTESteamMacerator, MTESteamAlloySmelter and MTESteamFurnaceMulti are steam
// buses only. MTESteamCompressor, MTESteamForgeHammer, MTESteamWasher and
// MTESteamMixer take an InputHatch.
const BASE = Object.freeze(new Set(["Steam Separator", "Steam Grinder", "Steam Fuser", "Steam Hearth"]));

const BY_PACK = Object.freeze({
  // GT5U 5.09.51.476 gtPlusPlus/xmod/gregtech/common/tileentities/machines/multi/processing/steam:
  // checkMachine requires mInputHatches.isEmpty() in MTESteamCentrifuge (:293), MTESteamMacerator
  // (:227), MTESteamAlloySmelter (:274), MTESteamCompressor (:231) and MTESteamForgeHammer (:281).
  // There is no Steam Hearth in 2.8.1.
  "2.8.1": Object.freeze(
    new Set(["Steam Separator", "Steam Grinder", "Steam Fuser", "Steam Squasher", "Steam Presser"]),
  ),
});

/** The steam multiblocks with no fluid input hatch in the pack `gtnhVersion` labels. */
export function steamMultiblocksWithoutFluidInput(gtnhVersion) {
  return BY_PACK[gtnhVersion] ?? BASE;
}

// Only the Separator (MTESteamCentrifuge, an OutputHatch element; 5.09.51 requires one) and the Blender
// (MTESteamMixer) take a fluid output hatch on either pack. 5.09.51's checkMachine requires
// mOutputHatches.isEmpty() in MTESteamMacerator (:226), MTESteamCompressor (:230), MTESteamForgeHammer (:280),
// MTESteamAlloySmelter (:273) and MTESteamWasher (:293); 5.09.54.205's structures of the same classes and
// MTESteamFurnaceMulti have no OutputHatch element.
const BASE_NO_OUTPUT = Object.freeze(
  new Set(["Steam Grinder", "Steam Squasher", "Steam Purifier", "Steam Presser", "Steam Fuser", "Steam Hearth"]),
);

const BY_PACK_NO_OUTPUT = Object.freeze({
  "2.8.1": Object.freeze(new Set(["Steam Grinder", "Steam Squasher", "Steam Purifier", "Steam Presser", "Steam Fuser"])),
});

/** The steam multiblocks with no fluid output hatch in the pack `gtnhVersion` labels. */
export function steamMultiblocksWithoutFluidOutput(gtnhVersion) {
  return BY_PACK_NO_OUTPUT[gtnhVersion] ?? BASE_NO_OUTPUT;
}

/**
 * The handlers that can run a recipe: a steam multiblock leaves a recipe with a
 * fluid input when it has no fluid input hatch, and one with a fluid output when
 * it has no fluid output hatch. Undefined stays undefined.
 */
export function withoutSteamHandlersLackingFluidHatches(handlers, inputs, outputs, gtnhVersion) {
  if (!Array.isArray(handlers)) return handlers;
  const fluidIn = (inputs ?? []).some((entry) => entry?.kind === "fluid");
  const fluidOut = (outputs ?? []).some((entry) => entry?.kind === "fluid");
  if (!fluidIn && !fluidOut) return handlers;
  const noInput = steamMultiblocksWithoutFluidInput(gtnhVersion);
  const noOutput = steamMultiblocksWithoutFluidOutput(gtnhVersion);
  const kept = handlers.filter(
    (handler) =>
      handler.kind !== "multiblock" ||
      !((fluidIn && noInput.has(handler.label)) || (fluidOut && noOutput.has(handler.label))),
  );
  return kept.length === handlers.length ? handlers : kept;
}
