import { useSyncExternalStore } from "react";
import { flashNotice } from "@/components/flow/clean/rail/NoticeBar";
import { gameVersionLabel, planGameVersion, type GameVersion } from "@/lib/model/game-version";
import type { FactoryProject } from "@/lib/model/types";
import { useDesignStore } from "@/store/design-store";
import { useFactoryStore } from "@/store/factory-store";
import { convertProjectToVersion } from "./convert-plan-version";
import { servedGameVersions } from "./new-plan-version";
import { DEFAULT_DATASET_MANIFEST_URL, pickDatasetVersionFor } from "./remote";
import type { DatasetManifest } from "./types";

/** What a failed conversion says. The plan it started from is untouched, so trying again is safe. */
export const CONVERT_FAILED_TEXT = "Couldn't convert the plan. Try again.";

/** The versions a plan of `planVersion` can be converted to: every version this site serves but its own. */
export function convertTargets(manifest: DatasetManifest | undefined, planVersion: GameVersion): GameVersion[] {
  return servedGameVersions(manifest).filter((version) => version !== planVersion);
}

/** The conversion running now: its target, and the design it started from when one was named. */
export interface PendingConversion {
  target: GameVersion;
  sourceDesignId?: string;
}

/** One conversion at a time: a second press while one runs would open a second copy. */
let pending: PendingConversion | undefined;
const listeners = new Set<() => void>();

function setPending(next: PendingConversion | undefined): void {
  pending = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The conversion running now, for the keys that show it (the tab, the notice's key, the menu row). */
export function usePendingConversion(): PendingConversion | undefined {
  return useSyncExternalStore(subscribe, () => pending, () => undefined);
}

/** What a key says while its conversion runs. */
export function convertingLabel(v: GameVersion): string {
  return `Converting to ${gameVersionLabel(v)}...`;
}

/**
 * Opens a copy of `project` converted to `target` as a NEW design. The target's dataset is loaded first
 * (`ensureDatasetFor`, which only activates it for a plan of that version), so the new tab lands on its own
 * recipes. The source plan and its stored record are never written: the conversion works on a clone, and nothing
 * here calls `setProject`. Leaving Welcome or the library happens only once the copy opens (`importProjectAsDesign`).
 * Returns false when nothing opened.
 */
export async function convertPlan(
  project: FactoryProject,
  target: GameVersion,
  sourceDesignId?: string,
): Promise<boolean> {
  if (pending || planGameVersion(project) === target) return false;
  const factory = useFactoryStore.getState();
  const manifest = factory.datasetManifest;
  const version = manifest && pickDatasetVersionFor(manifest, target);
  if (!version) return false;
  setPending({ target, ...(sourceDesignId ? { sourceDesignId } : {}) });
  try {
    const dataset = await factory.ensureDatasetFor(target);
    if (!dataset) throw new Error(`The ${target} dataset did not load.`);
    const converted = await convertProjectToVersion(project, {
      manifestUrl: useFactoryStore.getState().datasetManifestUrl ?? DEFAULT_DATASET_MANIFEST_URL,
      version,
    });
    await useDesignStore.getState().importProjectAsDesign(converted.project, converted.project.name);
    return true;
  } catch (error) {
    console.error(error);
    flashNotice("warn", CONVERT_FAILED_TEXT);
    return false;
  } finally {
    setPending(undefined);
  }
}

/** Converts the plan on the board now (the version notice's key, a tab menu's row on the open tab). */
export function convertOpenPlan(target: GameVersion): Promise<boolean> {
  return convertPlan(useFactoryStore.getState().project, target, useDesignStore.getState().activeDesignId);
}
