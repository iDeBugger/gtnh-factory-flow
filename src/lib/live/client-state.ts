import { applyOps, diffPlans, invertOps, type LiveOp, type LivePlan } from "./ops";

/**
 * One client's copy of a live plan: the confirmed/pending engine every editor
 * (the website and the game) runs the same way.
 *
 * - `confirmed` is the plan at the last seq heard from the server.
 * - `pending` holds this client's own batches the server has not echoed yet.
 * - What the editor shows (`view`) is `confirmed` with `pending` applied on top.
 * - A local edit becomes a batch with a fresh cid and its inverse (for undo),
 *   goes to the end of `pending`, and is sent.
 * - A batch from someone else lands on `confirmed`; `pending` is re-applied on
 *   top. The echo of an own batch (same cid) lands on `confirmed` and leaves
 *   `pending`. Undo is the recorded inverse sent as a new edit.
 * - Reconnecting takes the snapshot as `confirmed` and sends every pending
 *   batch again. The server acknowledges a batch it already applied without
 *   applying it twice.
 *
 * Pure apart from the cid source; serializable (`save` / `restore`) so pending
 * edits survive a closed tab or a crashed game.
 */

export interface LiveBatch {
  cid: string;
  ops: LiveOp[];
}

export interface PendingBatch extends LiveBatch {
  /** What undoes this batch, computed against the view it was made on. */
  inverse: LiveOp[];
}

/** The `ops` frame a client sends. */
export interface LiveOpsFrame {
  t: "ops";
  doc: string;
  base: number;
  cid: string;
  ops: LiveOp[];
}

/** A batch as the server broadcasts it. */
export interface LiveServerBatch {
  seq: number;
  cid: string;
  by?: string;
  ops: LiveOp[];
}

export interface ReceiveResult {
  /** The batch was this client's own, now confirmed. */
  own: boolean;
  /**
   * Batches were missed (the seq jumped): the copy can no longer be trusted
   * and the client should join again for a fresh snapshot.
   */
  gap: boolean;
}

export interface SavedLiveState {
  seq: number;
  confirmed: LivePlan;
  pending: PendingBatch[];
}

let cidCounter = 0;

/** A batch id unique enough across every client of one plan: random plus a counter. */
export function makeCid(): string {
  cidCounter = (cidCounter + 1) % 1_000_000;
  const random =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID().replace(/-/g, "").slice(0, 16)
      : Math.random().toString(36).slice(2, 18);
  return `${random}${cidCounter.toString(36)}`;
}

export class LiveClientState {
  seq: number;
  confirmed: LivePlan;
  pending: PendingBatch[] = [];
  private shown: LivePlan | null = null;
  private readonly undoStack: LiveOp[][] = [];
  private readonly redoStack: LiveOp[][] = [];
  private readonly nextCid: () => string;

  constructor(snapshot: { seq: number; plan: LivePlan }, options: { makeCid?: () => string } = {}) {
    this.seq = snapshot.seq;
    this.confirmed = snapshot.plan;
    this.nextCid = options.makeCid ?? makeCid;
  }

  /** What the editor shows: confirmed with every pending batch on top. */
  get view(): LivePlan {
    if (!this.shown) {
      let plan = this.confirmed;
      for (const batch of this.pending) {
        plan = applyOps(plan, batch.ops);
      }
      this.shown = plan;
    }
    return this.shown;
  }

  /** The cids still waiting for the server, oldest first. */
  get pendingCids(): string[] {
    return this.pending.map((batch) => batch.cid);
  }

  /**
   * A local edit given as the plan it produced: the difference from the view
   * becomes a batch. Null when nothing changed.
   */
  edit(next: LivePlan): PendingBatch | null {
    return this.localOps(diffPlans(this.view, next));
  }

  /** A local edit given as ops. Null when there are none. */
  localOps(
    ops: LiveOp[],
    options: { keepRedo?: boolean; undoable?: boolean } = {},
  ): PendingBatch | null {
    if (ops.length === 0) {
      return null;
    }
    const before = this.view;
    const batch: PendingBatch = { cid: this.nextCid(), ops, inverse: invertOps(before, ops) };
    this.pending.push(batch);
    this.shown = applyOps(before, ops);
    if (options.undoable !== false) {
      this.undoStack.push(batch.inverse);
    }
    if (!options.keepRedo) {
      this.redoStack.length = 0;
    }
    return batch;
  }

  /** The frame that sends a batch, based on the seq heard so far. */
  frame(doc: string, batch: LiveBatch): LiveOpsFrame {
    return { t: "ops", doc, base: this.seq, cid: batch.cid, ops: batch.ops };
  }

  /** A batch from the server: someone else's, or the echo of one of ours. */
  receive(batch: LiveServerBatch): ReceiveResult {
    const gap = batch.seq > this.seq + 1;
    const mine = this.pending.findIndex((pending) => pending.cid === batch.cid);
    this.confirmed = applyOps(this.confirmed, batch.ops);
    this.seq = Math.max(this.seq, batch.seq);
    if (mine >= 0) {
      this.pending.splice(mine, 1);
    }
    this.shown = null;
    return { own: mine >= 0, gap };
  }

  /**
   * The server refused one of our batches (an `error` frame naming its cid):
   * it never happened, so it leaves `pending` and the view.
   */
  refuse(cid: string): boolean {
    const at = this.pending.findIndex((pending) => pending.cid === cid);
    if (at < 0) {
      return false;
    }
    this.pending.splice(at, 1);
    this.shown = null;
    return true;
  }

  /**
   * Batches another client of this person's left unsent (a closed tab's, read
   * back from storage), added to the end of `pending` as they are, so they are
   * shown and go out with ours. Batches already pending are skipped. They
   * stay out of undo: they were not edits made here. Returns those added.
   */
  adopt(batches: PendingBatch[]): PendingBatch[] {
    const known = new Set(this.pending.map((batch) => batch.cid));
    const added = batches.filter((batch) => !known.has(batch.cid));
    if (added.length > 0) {
      this.pending.push(...added);
      this.shown = null;
    }
    return added;
  }

  /**
   * Batches older than every pending one (a closed tab's, edits made before this room was opened), put in front of
   * `pending`, so the edits made here since go after them and win. Only before anything pending was sent: the
   * server applies batches in the order they arrive. Batches already pending are skipped; none enter undo.
   */
  adoptBefore(batches: PendingBatch[]): PendingBatch[] {
    const known = new Set(this.pending.map((batch) => batch.cid));
    const added = batches.filter((batch) => !known.has(batch.cid));
    if (added.length > 0) {
      this.pending.unshift(...added);
      this.shown = null;
    }
    return added;
  }

  /** Batches put in front of the pending batch `cid` (not sent yet), so they go just before it. */
  insertBefore(cid: string, batches: PendingBatch[]): void {
    const at = this.pending.findIndex((batch) => batch.cid === cid);
    if (at < 0 || batches.length === 0) {
      return;
    }
    this.pending.splice(at, 0, ...batches);
    this.shown = null;
  }

  /**
   * A fresh snapshot (after joining again): it becomes `confirmed`, and every
   * pending batch is returned, oldest first, to be sent again.
   */
  resync(snapshot: { seq: number; plan: LivePlan }): PendingBatch[] {
    this.confirmed = snapshot.plan;
    this.seq = snapshot.seq;
    this.shown = null;
    return this.pending.slice();
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /**
   * Undoes this client's last own edit: its recorded inverse, sent as a new
   * edit. Fields someone else changed since are overwritten, as in Figma.
   */
  undo(): PendingBatch | null {
    const inverse = this.undoStack.pop();
    if (!inverse) {
      return null;
    }
    const batch = this.localOps(inverse, { keepRedo: true, undoable: false });
    if (batch) {
      this.redoStack.push(batch.inverse);
    }
    return batch;
  }

  redo(): PendingBatch | null {
    const ops = this.redoStack.pop();
    if (!ops) {
      return null;
    }
    return this.localOps(ops, { keepRedo: true });
  }

  save(): SavedLiveState {
    return { seq: this.seq, confirmed: this.confirmed, pending: this.pending.slice() };
  }

  static restore(saved: SavedLiveState, options: { makeCid?: () => string } = {}): LiveClientState {
    const state = new LiveClientState({ seq: saved.seq, plan: saved.confirmed }, options);
    state.pending = saved.pending.slice();
    return state;
  }
}
