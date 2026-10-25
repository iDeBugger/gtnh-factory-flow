// Steam multiblocks whose structure has no fluid input hatch, by pack. NEI lists
// each on its whole recipe map, but a recipe with a fluid input never starts in
// one, so the normalizer leaves them off such recipes. Any 2.9 build reads the base.

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

/**
 * The handlers that can run a recipe: a steam multiblock without a fluid input
 * hatch leaves a recipe with a fluid input. Undefined stays undefined.
 */
export function withoutSteamHandlersLackingFluidInput(handlers, inputs, gtnhVersion) {
  if (!Array.isArray(handlers) || !(inputs ?? []).some((input) => input?.kind === "fluid")) {
    return handlers;
  }
  const lacking = steamMultiblocksWithoutFluidInput(gtnhVersion);
  const kept = handlers.filter((handler) => !(handler.kind === "multiblock" && lacking.has(handler.label)));
  return kept.length === handlers.length ? handlers : kept;
}
