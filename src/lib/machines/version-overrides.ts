import type { GameVersion } from "@/lib/model/game-version";
import type { MachineBehaviour } from "./machine-table";
import { MACHINE_OVERRIDES_2_8_1 } from "./overrides-2.8.1";

/**
 * What differs in a game version, by item name: a partial is merged over the
 * base item, and `null` says the item does not exist in that version. A
 * version with no entry for an item reads the base unchanged. An override
 * needs a base: an item only one version has is a base entry, hidden with
 * `null` in the versions that lack it.
 */
export type VersionOverrides<T> = Partial<Record<GameVersion, Record<string, Partial<T> | null>>>;

/** The item as it is in `gameVersion`: the base, the base with its override merged over it, or undefined when absent. */
export function forVersion<T>(
  name: string,
  base: T | undefined,
  overrides: VersionOverrides<T>,
  gameVersion: GameVersion,
): T | undefined {
  const byName = overrides[gameVersion];
  if (!byName || !Object.prototype.hasOwnProperty.call(byName, name)) {
    return base;
  }
  const override = byName[name];
  if (override === null) {
    return undefined;
  }
  // An override is a change to a base item: with no base there is nothing whole to hand back, and a partial
  // must never pass for a complete item.
  if (base === undefined) {
    return undefined;
  }
  return { ...base, ...override } as T;
}

/** Machine table entries that differ by game version, keyed by the table's canonical names. */
export const MACHINE_OVERRIDES: VersionOverrides<MachineBehaviour> = { "2.8.1": MACHINE_OVERRIDES_2_8_1 };
