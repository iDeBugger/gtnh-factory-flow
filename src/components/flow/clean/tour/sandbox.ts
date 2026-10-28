import { createNewProject } from "@/examples";
import type { FactoryProject } from "@/lib/model/types";
import { leaveLibrary } from "@/lib/library/library-tab";
import { leaveWelcomeTab } from "@/lib/welcome/welcome-tab";
import { useDesignStore } from "@/store/design-store";
import { useFactoryStore } from "@/store/factory-store";
import { getMinimap, setMinimap, snapshotMinimap, type MinimapSettings } from "../minimap/minimap-settings";

/**
 * The tour's own plan, kept apart from the player's: the player's design is saved first and put aside, the tour
 * plays on a design of its own called "Tour plan", and what it borrows (the minimap's
 * settings, the items column's search, the recipe search's machine selection, set to every machine) is
 * copied first and put back. Leaving from any step keeps the player where
 * they are: if the tour put anything on the plan in front of them it stays, joining their plans as "Tour plan";
 * if not, it is removed and their own design comes back.
 */

export const TOUR_PLAN_NAME = "Tour plan";

interface Saved {
  priorDesignId?: string;
  tourDesignId?: string;
  minimap: MinimapSettings;
  recipeSearch: string;
  /** The designs there were once the tour's plan was made: any other was made by the tour (a task board). */
  known?: Set<string>;
}

let saved: Saved | undefined;

export function sandboxActive(): boolean {
  return saved !== undefined;
}

/** A fresh plan for the tour: the new-design project, named for the tour. */
export function tourProject(): FactoryProject {
  return { ...structuredClone(createNewProject()), name: TOUR_PLAN_NAME };
}

export async function enterSandbox(): Promise<void> {
  if (saved) return;
  const designs = useDesignStore.getState();
  const factory = useFactoryStore.getState();
  const prior = designs.activeDesignId;
  saved = {
    priorDesignId: prior,
    minimap: snapshotMinimap(),
    recipeSearch: factory.recipeSearch,
  };
  // The player's work is saved before the plan is put aside.
  if (prior) await designs.saveActiveProject(prior, factory.project);
  leaveWelcomeTab();
  leaveLibrary();
  await designs.importProjectAsDesign(tourProject(), TOUR_PLAN_NAME);
  saved.tourDesignId = useDesignStore.getState().activeDesignId;
  saved.known = new Set(useDesignStore.getState().designs.map((d) => d.id));
  // The tour shows its own board: the map on.
  setMinimap({ show: true });
}

/** The settings the tour borrows, put back to what the tour started them at (a step replayed by Back or a jump). */
export function resetBorrowedSettings(): void {
  if (!saved) return;
  setMinimap({ ...saved.minimap, show: true });
}

function madeByTour(s: Saved): string[] {
  return useDesignStore
    .getState()
    .designs.map((d) => d.id)
    .filter((id) => s.known !== undefined && !s.known.has(id));
}

/** The design in front of the player, so a step's start can name it. */
export function currentDesignId(): string | undefined {
  return useDesignStore.getState().activeDesignId;
}

/**
 * Back to the design a step started on. Back to the tour's own plan, the designs the tour made after it (a task board
 * from a later step) go: the step makes them again.
 */
export async function returnToDesign(designId: string | undefined): Promise<void> {
  const s = saved;
  if (!s || !designId) return;
  const designs = useDesignStore.getState();
  if (designs.activeDesignId !== designId && designs.designs.some((d) => d.id === designId)) {
    await designs.switchToDesign(designId);
  }
  if (designId !== s.tourDesignId) return;
  for (const id of madeByTour(s)) await useDesignStore.getState().removeDesign(id);
}

/** Puts the tour's plan back to what a step started from (Back). */
export function restoreProject(project: FactoryProject): void {
  const factory = useFactoryStore.getState();
  factory.clearResourceBrowser();
  factory.setRecipeSearch("");
  factory.markHydratedProject(structuredClone(project));
  factory.frameBoardNodes();
}

/** Whether the tour has put anything on its plan. */
export function tourPlanTouched(): boolean {
  const p = useFactoryStore.getState().project;
  return p.nodes.length > 0 || (p.storages?.length ?? 0) > 0 || (p.annotations?.length ?? 0) > 0;
}

export async function leaveSandbox(): Promise<void> {
  const s = saved;
  if (!s) return;
  saved = undefined;
  leaveLibrary();
  // What the tour made besides its plan (a task board) goes; left on one, the player is back on the tour's plan.
  const made = madeByTour(s);
  if (s.tourDesignId && made.includes(useDesignStore.getState().activeDesignId ?? "")) {
    await useDesignStore.getState().switchToDesign(s.tourDesignId);
  }
  for (const id of made) await useDesignStore.getState().removeDesign(id);
  const designs = useDesignStore.getState();
  const factory = useFactoryStore.getState();
  factory.clearResourceBrowser();
  factory.setRecipeSearch(s.recipeSearch);
  setMinimap(s.minimap);
  const onTourPlan = s.tourDesignId !== undefined && designs.activeDesignId === s.tourDesignId;
  if (onTourPlan && tourPlanTouched()) {
    // The plan in front of them joins theirs as "Tour plan": saved as it is, and the screen stays.
    await designs.saveActiveProject(s.tourDesignId, factory.project);
    return;
  }
  const prior = s.priorDesignId;
  if (prior && designs.designs.some((d) => d.id === prior)) await designs.switchToDesign(prior);
  if (s.tourDesignId) await designs.removeDesign(s.tourDesignId);
}

export function currentMinimap(): MinimapSettings {
  return getMinimap();
}
