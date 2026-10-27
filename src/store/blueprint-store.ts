"use client";

import { create } from "zustand";
import {
  deleteBlueprint,
  getBlueprint,
  listBlueprints,
  saveBlueprint,
  updateBlueprint,
} from "@/lib/blueprints/client";
import { computeBlueprintIo } from "@/lib/blueprints/io-stats";
import type { BlueprintSort, BlueprintSummary } from "@/lib/blueprints/types";
import type { EntryIcon } from "@/lib/community/types";
import { preparePayloadForPlan } from "@/lib/datasets/convert-payload-version";
import { useFactoryStore, type BoardClipboardPayload } from "@/store/factory-store";

/**
 * A request for the one blueprint save dialog (rendered once at app level):
 * a new shelf row, or an overwrite when `blueprintId` is set.
 */
export interface BlueprintSaveRequest {
  payload: BoardClipboardPayload;
  name: string;
  icon?: EntryIcon;
  tags?: string[];
  /** Set when the save overwrites an existing shelf row instead of creating. */
  blueprintId?: string;
}

/**
 * The account's blueprint library: its own cloud-stored sub-assemblies.
 * Summaries load once per session (and after every mutation); payloads are
 * fetched only when a blueprint is actually placed on the board.
 */
interface BlueprintStore {
  blueprints: BlueprintSummary[];
  sort: BlueprintSort;
  hasLoaded: boolean;
  isLoading: boolean;
  /** The blueprint currently saving/loading/deleting, for row spinners. */
  busyId?: string;
  isSaving: boolean;
  error?: string;

  /**
   * Pocket-picker mode: the shelf is waiting for the user to click a pocket
   * on the board — either to overwrite an owned blueprint (blueprintId set)
   * or to upload the picked pocket as a brand-new one (create set). The
   * board reads this to wear the mode — banner up top, pockets ringed.
   */
  overwritePicking?: { blueprintId: string; name: string; create?: boolean };
  setOverwritePicking: (picking?: {
    blueprintId: string;
    name: string;
    create?: boolean;
  }) => void;

  /** The pocket-save dialog's pending request, rendered once at app level. */
  saveRequest?: BlueprintSaveRequest;
  setSaveRequest: (request?: BlueprintSaveRequest) => void;

  setSort: (sort: BlueprintSort) => void;
  refresh: () => Promise<void>;
  /** Forget the shelf (sign-out). */
  reset: () => void;
  /** Creates a shelf row and returns its summary. */
  save: (
    name: string,
    payload: BoardClipboardPayload,
    icon?: EntryIcon,
    tags?: string[],
  ) => Promise<BlueprintSummary | undefined>;
  /** The blueprint's payload, prepared for the plan on the board at call time (`preparePayloadForPlan`). */
  load: (blueprintId: string) => Promise<BoardClipboardPayload | undefined>;
  remove: (blueprintId: string) => Promise<void>;
  /**
   * Edit in place — rename, overwrite the payload from a board pocket, or
   * both. The row keeps its id.
   */
  update: (
    blueprintId: string,
    patch: {
      name?: string;
      payload?: BoardClipboardPayload;
      tags?: string[];
      icon?: EntryIcon | null;
    },
  ) => Promise<boolean>;
}

export const useBlueprintStore = create<BlueprintStore>((set, get) => ({
  blueprints: [],
  sort: "newest",
  hasLoaded: false,
  isLoading: false,
  busyId: undefined,
  isSaving: false,
  error: undefined,

  overwritePicking: undefined,
  setOverwritePicking: (overwritePicking) => set({ overwritePicking }),

  saveRequest: undefined,
  setSaveRequest: (saveRequest) => set({ saveRequest }),

  setSort: (sort) => set({ sort }),
  refresh: async () => {
    if (get().isLoading) {
      return;
    }

    set({ isLoading: true, error: undefined });
    try {
      set({ blueprints: await listBlueprints(), hasLoaded: true });
    } catch (error) {
      set({ error: error instanceof Error ? error.message : "Blueprints could not be loaded." });
    } finally {
      set({ isLoading: false });
    }
  },
  reset: () =>
    set({ blueprints: [], hasLoaded: false, isLoading: false, error: undefined }),
  save: async (name, payload, icon, tags) => {
    set({ isSaving: true, error: undefined });
    try {
      const created = await saveBlueprint(name, payload, computeBlueprintIo(payload), icon, tags);
      set((state) => ({ blueprints: [created, ...state.blueprints] }));
      return created;
    } catch (error) {
      set({ error: error instanceof Error ? error.message : "Blueprint could not be saved." });
      return undefined;
    } finally {
      set({ isSaving: false });
    }
  },
  load: async (blueprintId) => {
    set({ busyId: blueprintId, error: undefined });
    try {
      const detail = await getBlueprint(blueprintId);
      // Ready for the plan on the board now: a blueprint saved on another game version arrives converted.
      return await preparePayloadForPlan(detail.payload, useFactoryStore.getState().project);
    } catch (error) {
      set({ error: error instanceof Error ? error.message : "Blueprint could not be loaded." });
      return undefined;
    } finally {
      set((state) => (state.busyId === blueprintId ? { busyId: undefined } : state));
    }
  },
  update: async (blueprintId, patch) => {
    set({ busyId: blueprintId, error: undefined });
    try {
      const updated = await updateBlueprint(blueprintId, {
        name: patch.name,
        payload: patch.payload,
        io: patch.payload ? computeBlueprintIo(patch.payload) : undefined,
        tags: patch.tags,
        icon: patch.icon,
      });
      set((state) => ({
        blueprints: state.blueprints.map((blueprint) =>
          blueprint.id === blueprintId ? { ...blueprint, ...updated } : blueprint,
        ),
      }));
      return true;
    } catch (error) {
      set({ error: error instanceof Error ? error.message : "Blueprint could not be updated." });
      return false;
    } finally {
      set((state) => (state.busyId === blueprintId ? { busyId: undefined } : state));
    }
  },
  remove: async (blueprintId) => {
    set({ busyId: blueprintId, error: undefined });
    try {
      await deleteBlueprint(blueprintId);
      set((state) => ({
        blueprints: state.blueprints.filter((blueprint) => blueprint.id !== blueprintId),
      }));
    } catch (error) {
      set({ error: error instanceof Error ? error.message : "Blueprint could not be deleted." });
    } finally {
      set((state) => (state.busyId === blueprintId ? { busyId: undefined } : state));
    }
  },
}));
