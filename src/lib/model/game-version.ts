import type { FactoryProject } from "./types";

/**
 * A game version family a plan belongs to: "2.9" or "2.8.1" today. Recipes,
 * machine rules and numbers are read for this version. Any other string read
 * from a plan is kept as written, so a plan from a site that serves another
 * version opens as that version instead of silently becoming this site's.
 */
export type GameVersion = string;

/** Plans saved before plans carried a version were all made for 2.9. */
export const DEFAULT_GAME_VERSION = "2.9";

/** The plan's version; absent or blank reads as 2.9 (old plans are never rewritten to say so). */
export function planGameVersion(project: Pick<FactoryProject, "gameVersion">): GameVersion {
  const version = project.gameVersion?.trim();
  return version ? version : DEFAULT_GAME_VERSION;
}

/**
 * The family a dataset serves. Every 2.9 build (2.9.0, its betas and release
 * candidates) is one family, so a plan made on one keeps opening on the next.
 */
export function gameVersionOfDataset(dataset: { gtnhVersion: string }): GameVersion {
  if (/^2\.9(\.|-|$)/.test(dataset.gtnhVersion)) {
    return "2.9";
  }
  if (dataset.gtnhVersion === "2.8.1") {
    return "2.8.1";
  }
  return dataset.gtnhVersion;
}

export function gameVersionLabel(v: GameVersion): string {
  return `GTNH ${v}`;
}
