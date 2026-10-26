/**
 * The seam between the factory store and live editing (live-session.ts),
 * kept in its own module so neither imports the other.
 *
 * - Project changes made `quietly` are not edits: a plan landing, a recipe
 *   refresh, fetched data, a remote batch applied. Live editing turns every
 *   other project change into a batch.
 * - While a live plan is on the canvas, undo and redo go to its handler
 *   (recorded inverses of this person's own edits) and the store keeps no
 *   whole-plan snapshots.
 * - The design store asks which design is live, to save it as a cache rather
 *   than guard it as a tab's own copy.
 */

let quietDepth = 0;
let screenOnlyDepth = 0;

/** Runs `change` with its project changes not counted as edits. */
export function quietly<T>(change: () => T): T {
  quietDepth += 1;
  try {
    return change();
  } finally {
    quietDepth -= 1;
  }
}

export function isQuietChange(): boolean {
  return quietDepth > 0;
}

/**
 * A quiet change to the plan already on the canvas, made on this screen only (the recipe refresh re-keying a card's
 * recipe), as opposed to a plan landing. Live editing moves the base of edits made away from a room by it, so it is
 * never sent as anyone's edit.
 */
export function quietlyOnThisScreen<T>(change: () => T): T {
  screenOnlyDepth += 1;
  try {
    return quietly(change);
  } finally {
    screenOnlyDepth -= 1;
  }
}

export function isScreenOnlyChange(): boolean {
  return screenOnlyDepth > 0;
}

export interface LiveUndoHandler {
  undo(): void;
  redo(): void;
}

let undoHandler: LiveUndoHandler | undefined;
let liveDesignId: string | undefined;

/** Set while a live plan is on the canvas; undefined puts the store's own undo back. */
export function setLiveUndoHandler(handler: LiveUndoHandler | undefined): void {
  undoHandler = handler;
}

export function liveUndoHandler(): LiveUndoHandler | undefined {
  return undoHandler;
}

/** The design (local id) bound to a live plan in this tab, if any. */
export function setLiveDesignId(designId: string | undefined): void {
  liveDesignId = designId;
}

export function liveDesignIdInThisTab(): string | undefined {
  return liveDesignId;
}

/*
 * Which designs are open live in ANY tab of this browser: the tab holding one
 * stamps a localStorage mark every few seconds, so the account sync in every
 * tab knows its plan is the live service's to write.
 */

const OPEN_MARK_PREFIX = "gtnh-factory-flow.live-open.";
/** A mark older than this is a tab that went away without clearing it. */
const OPEN_MARK_FRESH_MS = 45_000;

export function markDesignOpenLive(designId: string): void {
  try {
    window.localStorage.setItem(`${OPEN_MARK_PREFIX}${designId}`, String(Date.now()));
  } catch {
    // Without storage the other tabs fall back on the server's refusal.
  }
}

export function clearDesignOpenLive(designId: string): void {
  try {
    window.localStorage.removeItem(`${OPEN_MARK_PREFIX}${designId}`);
  } catch {
    // Same: the mark goes stale by itself.
  }
}

/** The design's plan is being edited live here or in another tab right now. */
export function isDesignOpenLive(designId: string): boolean {
  if (liveDesignId === designId) {
    return true;
  }
  try {
    const stamp = Number(window.localStorage.getItem(`${OPEN_MARK_PREFIX}${designId}`));
    return Number.isFinite(stamp) && Date.now() - stamp < OPEN_MARK_FRESH_MS;
  } catch {
    return false;
  }
}

/*
 * Designs just made in this tab, whose account row the sync created a moment ago: the first live snapshot of one is
 * the plan as that push read it, which can be behind the canvas (autosave lags, and edits made while the row was being
 * created). The canvas wins there, and only there: nobody else can have edited a plan this young.
 */

const FRESH_MS = 20_000;
const freshDesigns = new Map<string, number>();

export function markDesignFresh(designId: string): void {
  freshDesigns.set(designId, Date.now());
}

/** Whether `designId` was made here moments ago (once: asking uses it up). */
export function takeDesignFresh(designId: string): boolean {
  const at = freshDesigns.get(designId);
  freshDesigns.delete(designId);
  return at !== undefined && Date.now() - at < FRESH_MS;
}
