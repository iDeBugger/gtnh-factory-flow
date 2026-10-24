import { useEffect, useSyncExternalStore } from "react";
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

/**
 * Whether the remembered choice is one only a manifest can confirm: anything but the default. A device with
 * no choice, or the default, makes 2.9 plans whether or not the manifest is in.
 */
export function newPlanVersionNeedsManifest(): boolean {
  const stored = readStored()?.trim();
  return Boolean(stored) && stored !== DEFAULT_GAME_VERSION;
}

/**
 * The version of the plan last open on this device: a boot hint, not a setting. It only decides whether the boot
 * dataset load starts before the stored plans are read; the open plan's own version still decides what loads.
 */
export const OPEN_PLAN_VERSION_STORAGE_KEY = "gtnh-factory-flow.open-plan-version.v1";

/** A stored hint that is not a version number (digits and dots) is ignored: it is not one this code wrote. */
const OPEN_PLAN_VERSION_SHAPE = /^\d+(?:\.\d+)*$/;

/** The stored hint, or undefined when it is missing, blank, not a version number or unreadable. */
export function readOpenPlanVersion(): GameVersion | undefined {
  try {
    const stored = window.localStorage.getItem(OPEN_PLAN_VERSION_STORAGE_KEY)?.trim();
    return stored && OPEN_PLAN_VERSION_SHAPE.test(stored) ? stored : undefined;
  } catch {
    return undefined;
  }
}

export function writeOpenPlanVersion(v: GameVersion): void {
  try {
    if (window.localStorage.getItem(OPEN_PLAN_VERSION_STORAGE_KEY) !== v) {
      window.localStorage.setItem(OPEN_PLAN_VERSION_STORAGE_KEY, v);
    }
  } catch {
    // Storage refused: boot then waits for the stored plans whenever the new-plan choice is not 2.9.
  }
}

/**
 * Whether boot must wait for the stored plans before its first dataset load: only when something points away from
 * 2.9 (the plan last open here, or with none known the remembered new-plan choice). A 2.9 player's catalog starts as
 * soon as the manifest lands; a 2.8.1 player never downloads 2.9.
 */
export function bootWaitsForPlans(): boolean {
  const open = readOpenPlanVersion();
  return open !== undefined ? open !== DEFAULT_GAME_VERSION : newPlanVersionNeedsManifest();
}

/**
 * Writes the next boot's hint: the open plan's version, once the stored plans are in and a stored plan is open
 * (not the empty starting one), and again whenever the open plan's version changes.
 */
export function useOpenPlanVersionHint(
  designsHydrated: boolean,
  activeDesignId: string | undefined,
  planVersion: GameVersion,
): void {
  useEffect(() => {
    if (designsHydrated && activeDesignId) writeOpenPlanVersion(planVersion);
  }, [activeDesignId, designsHydrated, planVersion]);
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
