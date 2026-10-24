import { getMachineBehaviour } from "@/lib/machines/machine-table";
import type { GameVersion } from "@/lib/model/game-version";

// ProcessingLogic power overrides, checked against GT5-Unofficial source.
// Separate from coefficient coverage: these rules also apply to scraped machines.
// Each rule is one list of name alternatives shared by every version; a version
// that lacks a machine drops its alternative here instead of copying the list.

const STEAM_MULTIS = "steam (grinder|squasher|separator|purifier|presser|blender|fuser|hearth)";

// The kubatech Industrial Arc Furnace sets 0 tier skips and no amperage overclock.
// 2.8.1 has no kubatech arc furnace; the name instead matches GT++'s "High Current
// Industrial Arc Furnace" (GT5U@5.09.51.476 GregtechIndustrialArcFurnace.java:22), which
// keeps ProcessingLogic's defaults: 1 tier skip (ProcessingLogic.java:52) and amperage
// overclocks (MTEMultiBlockBase.java:1024).
const KUBATECH_ARC_FURNACE = "industrial arc furnace";

const EXCLUDED_BY_VERSION: Partial<Record<GameVersion, ReadonlySet<string>>> = {
  "2.8.1": new Set([KUBATECH_ARC_FURNACE]),
};

const ZERO_TIER_SKIPS = ["precise (?:auto-)?assembler", KUBATECH_ARC_FURNACE, STEAM_MULTIS];

const NO_AMPERAGE_OVERCLOCK = [
  "fusion",
  "nano forge",
  "transcendent plasma mixer",
  "godforge",
  "(?:smelting|molten|plasma|exotic) module",
  "nanochip",
  "(?:assembly matrix|biological coordination|board processor|cutting chamber|encasement wrapper|etching array|optical organizer|smd processor|superconductor splitter|splitter|wire tracer) module",
  KUBATECH_ARC_FURNACE,
  STEAM_MULTIS,
];

// Built once per rule and version: these run per machine on every solve.
const patternCache = new Map<string, RegExp>();

function versionPattern(rule: string, alternatives: readonly string[], gameVersion: GameVersion): RegExp {
  const key = `${rule}\u0000${gameVersion}`;
  let pattern = patternCache.get(key);
  if (!pattern) {
    const excluded = EXCLUDED_BY_VERSION[gameVersion];
    const kept = excluded ? alternatives.filter((alternative) => !excluded.has(alternative)) : alternatives;
    pattern = new RegExp(kept.join("|"));
    patternCache.set(key, pattern);
  }
  return pattern;
}

export function maxInputTierSkips(machine: string | undefined, gameVersion: GameVersion): number {
  if (getMachineBehaviour(machine, gameVersion)?.unlimitedTierSkip) return Infinity;
  const name = (machine ?? "").toLowerCase();
  if (versionPattern("tierSkips", ZERO_TIER_SKIPS, gameVersion).test(name)) return 0;
  return 1;
}

// Takes the plan's version: which machines skip amperage overclocks is a version's rule.
export function hasAmperageOverclock(machine: string | undefined, gameVersion: GameVersion): boolean {
  const name = (machine ?? "").toLowerCase();
  return !versionPattern("amperageOC", NO_AMPERAGE_OVERCLOCK, gameVersion).test(name);
}
