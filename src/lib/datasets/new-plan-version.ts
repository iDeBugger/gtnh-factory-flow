import { useSyncExternalStore } from "react";
import { DEFAULT_GAME_VERSION, gameVersionLabel, gameVersionOfDataset, type GameVersion } from "@/lib/model/game-version";
import { HIDDEN_DATASET_VERSION_IDS, pickDatasetVersionFor } from "./remote";
import type { DatasetManifest } from "./types";

/**
 * The game version new plans are made for, remembered per device. It has a visible control (the
 * top bar's New plans picker, or the + menu's row on a phone), so persisting it is allowed.
 */
export const NEW_PLAN_VERSION_STORAGE_KEY = "gtnh-factory-flow.new-plan-version.v1";

const listeners = new Set<() => void>();

/** A choice storage refused, kept for this page so the picker does not jump back to the default. */
let sessionChoice: string | undefined;

/** The refused pick first: storage that reads but will not write still holds the older choice. */
function readStored(): string | undefined {
  if (sessionChoice !== undefined) {
    return sessionChoice;
  }
  try {
    return window.localStorage.getItem(NEW_PLAN_VERSION_STORAGE_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * The version a new plan is made for: the remembered choice while this site serves it, else
 * the default. A choice this site no longer serves (or no manifest yet) reads as the default,
 * so a new plan never lands on a version with no recipes here.
 */
export function readNewPlanVersion(manifest: DatasetManifest | undefined): GameVersion {
  const stored = readStored()?.trim();
  if (stored && manifest && pickDatasetVersionFor(manifest, stored)) {
    return stored;
  }
  return DEFAULT_GAME_VERSION;
}

export function writeNewPlanVersion(v: GameVersion): void {
  try {
    window.localStorage.setItem(NEW_PLAN_VERSION_STORAGE_KEY, v);
    sessionChoice = undefined;
  } catch {
    // Storage refused: the choice holds for this page only.
    sessionChoice = v;
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key === NEW_PLAN_VERSION_STORAGE_KEY) listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

/** The picker's value, re-read when it is written here or in another tab. */
export function useNewPlanVersion(manifest: DatasetManifest | undefined): GameVersion {
  return useSyncExternalStore(
    subscribe,
    () => readNewPlanVersion(manifest),
    () => DEFAULT_GAME_VERSION,
  );
}

/** The game versions this site has recipes for, the default first. Hidden datasets serve none. */
export function servedGameVersions(manifest: DatasetManifest | undefined): GameVersion[] {
  if (!manifest) {
    return [];
  }
  const families: GameVersion[] = [];
  for (const version of manifest.versions) {
    if (HIDDEN_DATASET_VERSION_IDS.has(version.id)) continue;
    const family = gameVersionOfDataset(version);
    if (!families.includes(family)) families.push(family);
  }
  return families.sort((a, b) => (a === DEFAULT_GAME_VERSION ? -1 : b === DEFAULT_GAME_VERSION ? 1 : 0));
}

/** "GTNH 2.9", "GTNH 2.9 and GTNH 2.8.1", "GTNH 2.9, GTNH 2.8.1 and GTNH 3". */
function labelList(versions: readonly GameVersion[]): string {
  const labels = versions.map(gameVersionLabel);
  return labels.length <= 1 ? (labels[0] ?? "") : `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
}

/** The notice on a plan whose version this site has no recipes for. */
export function unservedPlanText(v: GameVersion, served: readonly GameVersion[]): string {
  return `This plan is for ${gameVersionLabel(v)}. This site has recipes for ${labelList(served)}.`;
}

/** What the recipe browser and the item list say on such a plan. */
export function recipesNotOnSiteText(v: GameVersion): string {
  return `Recipes for ${gameVersionLabel(v)} are not on this site.`;
}

/** The Convert row and key: a copy of the plan for `v` opens as a new plan. */
export function convertToLabel(v: GameVersion): string {
  return `Convert to ${gameVersionLabel(v)}`;
}

/** The unserved-version notice's key: such a plan converts to the default version. */
export const CONVERT_TO_DEFAULT_LABEL = convertToLabel(DEFAULT_GAME_VERSION);

/** Forgets the page's own choice (tests start from an empty device). */
export function resetNewPlanVersionForTests(): void {
  sessionChoice = undefined;
}
