import { randomUUID } from "node:crypto";
import { COMMUNITY_UPLOAD_MAX_BYTES } from "@/lib/community/types";
import { cloneJson, type LiveOp, type LivePlan } from "@/lib/live/ops";
import {
  colorFor,
  parseDocKey,
  type LiveMember,
  type LivePerson,
  type ServerFrame,
} from "@/lib/live/protocol";
import { prepareBatch } from "./batch";
import { LiveDoc } from "./doc";
import type { FlushQueue } from "./flush-queue";
import type { AppliedCid, Journal } from "./journal";
import type { PlanStore } from "./store";

/**
 * One open plan: the plan in memory, its seq, who is in it, and the timers
 * that keep the database up to date. Every change to the room (a batch, a
 * join, closing) runs through one queue, so batches apply in arrival order
 * and a snapshot never sees half a batch.
 *
 * A batch is applied in memory at once and goes to the journal, which syncs
 * a turn's worth of lines together (journal.ts); it is broadcast, the sender
 * included, only once its line is on disk. Nothing leaves the room before it
 * is durable: a snapshot or a flush first waits for the journal to catch up.
 * A journal that cannot be written fails the room: everyone in it is told to
 * join again, and the plan is opened afresh from the database and the
 * journal, which hold exactly what was ever acknowledged.
 *
 * An empty room lingers (a minute by default) before its last flush lets the
 * lease go, so someone leaving and coming back, or a page reloading, costs
 * the database nothing. Every write of the whole plan waits its turn in the
 * service's flush queue (flush-queue.ts).
 *
 * The room's lease carries a token of its own; every write it makes is
 * conditional on it. A lease that is no longer the room's (taken by another,
 * or lapsed and cleared by a REST save) fails the room the same way: it never
 * writes over a plan someone else now holds.
 */

export interface RoomTiming {
  /** At most one flush this often while edited. */
  flushMs: number;
  /** Lease renewal period. */
  renewMs: number;
  /** How far ahead each lease reaches. */
  leaseMs: number;
  /** How long a room nobody is in stays open before it lets its lease go. */
  lingerMs: number;
}

export interface RoomPeer {
  readonly connId: string;
  readonly userId: string;
  readonly username: string;
  readonly client: "game" | "web";
  send(frame: ServerFrame): void;
  /** A frame already serialized (a broadcast serializes once for everyone). */
  sendText(text: string): void;
  /** The peer is out of this room (kicked): it forgets the room. */
  forget(doc: string): void;
  /**
   * The room failed and is gone: the client must join again for a fresh
   * snapshot and send its unacknowledged batches again (the service closes
   * its socket as a restart would).
   */
  reload(): void;
}

export interface RoomDeps {
  store: PlanStore;
  journal: Journal;
  /** The service's queue for writes of whole plans. */
  flushes: FlushQueue;
  timing: RoomTiming;
  /** The plan size limit, in JSON characters (the library's upload limit). */
  maxPlanChars?: number;
  /**
   * How many bytes of batches the journal may hold for the room before a
   * flush trims them (default 8 MB): while the database is down nothing is
   * trimmed, and past this batches are refused as `rate` until it is back.
   */
  maxJournalBytes?: number;
  /** Recently applied batch ids, kept across the room closing and opening again. */
  cids: Map<string, number>;
  log: (message: string) => void;
  /** Called once the room has closed (flushed and let go, or deleted). */
  onClosed: (room: Room) => void;
}

export type BatchResult =
  | { kind: "applied"; seq: number; ops: LiveOp[] }
  | { kind: "duplicate"; seq: number }
  | { kind: "refused"; code: "bad_op" | "too_big" | "rate"; msg: string };

export const DEFAULT_MAX_JOURNAL_BYTES = 8 * 1024 * 1024;

const RECENT_CIDS = 5000;
/** Batch ids a room keeps on disk past a flush (journal.ts), so a late resend is still known. */
export const ROOM_RECENT_CIDS = 1000;

function sizeOf(value: unknown): number {
  return value === undefined ? 0 : JSON.stringify(value).length;
}

function sameMembers(a: LiveMember[], b: LiveMember[]): boolean {
  return (
    a.length === b.length &&
    a.every((member, at) => member.id === b[at]!.id && member.username === b[at]!.username)
  );
}

/** The fields the server writes on a comment: who wrote it and when. */
const COMMENT_STAMPS = ["by", "byName", "at"] as const;

export class Room {
  readonly doc: string;
  readonly ownerId: string;
  readonly designId: string;
  /** The plan, kept so a batch costs what it touches (doc.ts). */
  content = new LiveDoc({});
  seq = 0;
  members: LiveMember[] = [];
  ownerName = "";
  readonly peers = new Set<RoomPeer>();
  closed = false;

  private flushedSeq = 0;
  /** The last seq whose journal line is on disk. */
  private durableSeq = 0;
  /** Each journalled batch the database does not have yet: its seq and its line's bytes. */
  private unflushed: Array<[seq: number, bytes: number]> = [];
  private journalBytes = 0;
  /** The plan's JSON for snapshots, made once per version of the plan. */
  private planJson: { plan: LivePlan; text: string } | undefined;
  /** The plan's size in JSON characters, kept exact across batches and flushes. */
  private chars = 0;
  /** This room's last applied batch ids and their seqs, oldest first. */
  private readonly recent = new Map<string, number>();
  /** This room's lease: every write it makes is conditional on it. */
  private readonly token = randomUUID();
  private queue: Promise<unknown> = Promise.resolve();
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private renewTimer: ReturnType<typeof setInterval> | undefined;
  private lingerTimer: ReturnType<typeof setTimeout> | undefined;
  private lastFlushAt = 0;
  private flushing: Promise<boolean> | undefined;
  /**
   * The room's last flush (or the lease's release) is under way: no timed
   * flush may start after it, or it would write the lease back once the room
   * has let it go.
   */
  private ending = false;
  /** The design went: the room is being dropped, its journal with it. */
  private dropping = false;

  private constructor(
    doc: string,
    private readonly deps: RoomDeps,
    /** The account whose join opened the room; none when a journal replay did. */
    readonly openedBy: string | undefined,
  ) {
    const key = parseDocKey(doc)!;
    this.doc = doc;
    this.ownerId = key.ownerId;
    this.designId = key.designId;
  }

  /**
   * Opens a room: takes the lease and reads the plan, replays any journal
   * left by a crash, and starts renewing the lease. Undefined when the design
   * is missing or deleted. `openedBy` is the account whose join opened it:
   * the rooms an account leaves lingering are counted against it.
   */
  static async open(doc: string, deps: RoomDeps, openedBy?: string): Promise<Room | undefined> {
    const room = new Room(doc, deps, openedBy);
    const loaded = await deps.store.lease(
      room.ownerId,
      room.designId,
      room.token,
      room.leaseUntil(),
    );
    if (!loaded) {
      return undefined;
    }
    room.content = new LiveDoc(loaded.plan && typeof loaded.plan === "object" ? loaded.plan : {});
    room.seq = loaded.seq;
    room.flushedSeq = loaded.seq;
    room.durableSeq = loaded.seq;
    room.lastFlushAt = Date.now();
    // Batch ids from before the last flush, then the journal's own: a resend
    // of any of them is acknowledged, never applied again.
    for (const [cid, seq] of await deps.journal.readCids(doc)) {
      room.remember(cid, seq);
    }
    const journalled = await deps.journal.read(doc);
    const replay = journalled.filter((entry) => entry.seq > room.seq);
    // Entries already stored but never trimmed still name applied batches.
    for (const entry of journalled) {
      if (entry.seq <= room.seq) {
        room.remember(entry.cid, entry.seq);
      }
    }
    if (journalled.length > replay.length) {
      // Flushed before a crash but never trimmed.
      await deps.journal.trim(doc, room.seq, room.recentCids());
    }
    for (const entry of replay) {
      // The same batch journalled twice is applied once; its seq still counts.
      if (!room.recent.has(entry.cid)) {
        room.content.commit(entry.ops);
        room.remember(entry.cid, entry.seq);
      }
      room.seq = entry.seq;
      room.durableSeq = entry.seq;
      room.noteJournalled(entry.seq, Buffer.byteLength(JSON.stringify(entry)) + 1);
    }
    if (replay.length > 0) {
      deps.log(`${doc}: replayed ${replay.length} journalled batches up to seq ${room.seq}`);
    }
    room.chars = sizeOf(room.plan);
    const [members, names] = await Promise.all([
      deps.store.members(room.ownerId, room.designId),
      deps.store.usernames([room.ownerId]),
    ]);
    room.members = members;
    room.ownerName = names.get(room.ownerId) ?? "";
    room.renewTimer = setInterval(() => void room.renew(), deps.timing.renewMs);
    room.renewTimer.unref?.();
    if (room.dirty) {
      room.scheduleFlush();
    }
    return room;
  }

  /** The plan as it stands: a plain object that stays as it is while the room goes on. */
  get plan(): LivePlan {
    return this.content.toPlan();
  }

  get dirty(): boolean {
    return this.seq > this.flushedSeq;
  }

  /** The plan's size in JSON characters: what the room holds against the service's plan budget. */
  get size(): number {
    return this.chars;
  }

  /** Everyone in the room, one entry per connection. */
  get present(): LivePerson[] {
    return [...this.peers].map((peer) => ({
      id: peer.userId,
      username: peer.username,
      color: colorFor(peer.userId),
      client: peer.client,
      conn: peer.connId,
    }));
  }

  /** What the account may do here, by the members the room knows: kept current by notices and every lease renewal. */
  roleOf(userId: string): "owner" | "editor" | null {
    if (userId === this.ownerId) {
      return "owner";
    }
    return this.members.some((member) => member.id === userId) ? "editor" : null;
  }

  /** Lets a peer in (in the room's turn); a room lingering empty stays open. */
  admit(peer: RoomPeer): void {
    this.peers.add(peer);
    clearTimeout(this.lingerTimer);
    this.lingerTimer = undefined;
  }

  /** Nobody is in it: it is only waiting out its linger. */
  get idle(): boolean {
    return this.peers.size === 0 && !this.closed;
  }

  /** Runs `work` after everything queued before it. */
  enqueue<T>(work: () => Promise<T> | T): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => undefined);
    return next;
  }

  broadcast(frame: ServerFrame, except?: RoomPeer): void {
    if (this.peers.size === 0 || (this.peers.size === 1 && this.peers.has(except!))) {
      return;
    }
    const text = JSON.stringify(frame);
    for (const peer of this.peers) {
      if (peer !== except) {
        peer.sendText(text);
      }
    }
  }

  /**
   * The snapshot frame for someone joining. The plan's JSON is made once per
   * version of the plan, however many join or join again: a snapshot is the
   * room's biggest frame by far.
   */
  snapshotText(role: "owner" | "editor"): string {
    const plan = this.content.toPlan();
    if (this.planJson?.plan !== plan) {
      this.planJson = { plan, text: JSON.stringify(plan) };
    }
    const head = JSON.stringify({ t: "snapshot", doc: this.doc, seq: this.seq });
    const tail = JSON.stringify({
      role,
      members: this.members,
      present: this.present,
      owner: { id: this.ownerId, username: this.ownerName },
    });
    return `${head.slice(0, -1)},"plan":${this.planJson.text},${tail.slice(1)}`;
  }

  /** Settles once everything applied so far is on disk (rejects when the journal failed). */
  whenDurable(): Promise<void> {
    return this.deps.journal.durable(this.doc);
  }

  /**
   * Applies one batch from `peer`: refused whole when its result breaks a
   * schema or the size limit, acknowledged without applying when its cid was
   * applied already (a resend after a reconnect). Comments get the server's
   * stamp: who wrote them and when. Applied in memory at once and journalled;
   * broadcast once its journal line is on disk.
   */
  apply(peer: RoomPeer, cid: string, incoming: LiveOp[]): BatchResult {
    if (this.closed) {
      return { kind: "refused", code: "bad_op", msg: "The plan is closed." };
    }
    const seen = this.recent.get(cid) ?? this.deps.cids.get(this.cidKey(cid));
    if (seen !== undefined) {
      return { kind: "duplicate", seq: seen };
    }
    const stamped = this.stampComments(peer, incoming);
    if ("error" in stamped) {
      return { kind: "refused", code: "bad_op", msg: stamped.error };
    }
    const prepared = prepareBatch(this.content, stamped.ops);
    if ("error" in prepared) {
      return { kind: "refused", code: "bad_op", msg: prepared.error };
    }
    const ops = prepared.ops;
    const size = this.chars + prepared.sizeChange;
    const limit = this.deps.maxPlanChars ?? COMMUNITY_UPLOAD_MAX_BYTES;
    if (size > limit) {
      return {
        kind: "refused",
        code: "too_big",
        msg: `The plan would be over the ${Math.round(limit / 1024 / 1024)} MB limit.`,
      };
    }
    const seq = this.seq + 1;
    const line = `${JSON.stringify({ seq, cid, by: peer.userId, at: new Date().toISOString(), ops })}\n`;
    const bytes = Buffer.byteLength(line);
    const maxJournal = this.deps.maxJournalBytes ?? DEFAULT_MAX_JOURNAL_BYTES;
    if (this.journalBytes + bytes > maxJournal) {
      // The database has not taken the plan for a while (it is down, or slow):
      // the edit waits on its sender's side rather than piling up here.
      return {
        kind: "refused",
        code: "rate",
        msg: "The plan cannot be saved right now. The edit goes again shortly.",
      };
    }
    const durable = this.deps.journal.appendLine(this.doc, line);
    this.content.commit(ops);
    this.chars = size;
    this.seq = seq;
    this.remember(cid, seq);
    this.noteJournalled(seq, bytes);
    const frame: ServerFrame = { t: "ops", doc: this.doc, seq, by: peer.userId, cid, ops };
    // Lines settle in order, so broadcasts go out in seq order.
    void durable.then(
      () => {
        if (!this.closed) {
          this.durableSeq = Math.max(this.durableSeq, seq);
          try {
            this.broadcast(frame);
          } catch (error) {
            this.deps.log(this.doc + ": broadcast failed: " + String(error));
          }
        }
      },
      (error) => {
        // A plan dropped as deleted takes its journal, and its waiting lines, with it.
        if (!this.dropping) {
          this.fail(`the journal could not be written: ${String(error)}`);
        }
      },
    );
    this.scheduleFlush();
    return { kind: "applied", seq, ops };
  }

  private noteJournalled(seq: number, bytes: number): void {
    this.unflushed.push([seq, bytes]);
    this.journalBytes += bytes;
  }

  /** The database has the plan up to `seq`: its journal lines no longer count. */
  private noteFlushed(seq: number): void {
    let drop = 0;
    while (drop < this.unflushed.length && this.unflushed[drop]![0] <= seq) {
      this.journalBytes -= this.unflushed[drop]![1];
      drop += 1;
    }
    this.unflushed.splice(0, drop);
  }

  /**
   * What the server writes, never the client: a comment's author and time,
   * and who made a task.
   *
   * A new comment gets the sender and now; changing an existing one is its
   * author's alone and keeps its stamps. Anyone in the room may delete one (a
   * task going takes its comments with it). A new task's `createdBy` is the
   * sender; a task put over an existing one keeps the existing one's; a patch
   * cannot set or delete it.
   */
  private stampComments(peer: RoomPeer, ops: LiveOp[]): { ops: LiveOp[] } | { error: string } {
    if (!ops.some((op) => "c" in op && (op.c === "taskComments" || op.c === "tasks"))) {
      return { ops };
    }
    const now = new Date().toISOString();
    const putInBatch = new Set<string>();
    const tasksPut = new Set<string>();
    const out: LiveOp[] = [];
    for (const op of ops) {
      if ("c" in op && op.c === "tasks") {
        out.push(this.stampTask(peer, op, tasksPut));
        continue;
      }
      if (!("c" in op) || op.c !== "taskComments") {
        out.push(op);
        continue;
      }
      const old = putInBatch.has(op.id) ? undefined : this.content.find(op.c, op.id);
      if (op.o === "put") {
        if (old && old.by !== peer.userId) {
          return { error: "Only its author can change a comment." };
        }
        const v = cloneJson(op.v);
        if (old) {
          for (const stamp of COMMENT_STAMPS) {
            v[stamp] = old[stamp];
          }
        } else {
          v.by = peer.userId;
          v.byName = peer.username;
          v.at = now;
          putInBatch.add(op.id);
        }
        out.push({ ...op, v });
      } else if (op.o === "patch") {
        if (old && old.by !== peer.userId) {
          return { error: "Only its author can change a comment." };
        }
        const f = { ...op.f };
        COMMENT_STAMPS.forEach((stamp) => delete f[stamp]);
        const d = op.d?.filter((name) => !(COMMENT_STAMPS as readonly string[]).includes(name));
        out.push(d && d.length > 0 ? { ...op, f, d } : { o: "patch", c: op.c, id: op.id, f });
      } else {
        out.push(op);
      }
    }
    return { ops: out };
  }

  private stampTask(peer: RoomPeer, op: LiveOp, putInBatch: Set<string>): LiveOp {
    if (op.o === "put") {
      const old = putInBatch.has(op.id) ? undefined : this.content.find("tasks", op.id);
      const v = { ...op.v };
      if (old) {
        if (old.createdBy === undefined) {
          delete v.createdBy;
        } else {
          v.createdBy = old.createdBy;
        }
      } else {
        v.createdBy = peer.userId;
        putInBatch.add(op.id);
      }
      return { ...op, v };
    }
    if (op.o === "patch" && (Object.hasOwn(op.f, "createdBy") || op.d?.includes("createdBy"))) {
      const f = { ...op.f };
      delete f.createdBy;
      const d = op.d?.filter((name) => name !== "createdBy");
      return d && d.length > 0 ? { ...op, f, d } : { o: "patch", c: op.c, id: op.id, f };
    }
    return op;
  }

  private cidKey(cid: string): string {
    return `${this.doc}\u0000${cid}`;
  }

  private remember(cid: string, seq: number): void {
    this.recent.delete(cid);
    this.recent.set(cid, seq);
    while (this.recent.size > ROOM_RECENT_CIDS) {
      const oldest = this.recent.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.recent.delete(oldest);
    }
    const cids = this.deps.cids;
    cids.set(this.cidKey(cid), seq);
    while (cids.size > RECENT_CIDS) {
      const oldest = cids.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      cids.delete(oldest);
    }
  }

  private recentCids(): AppliedCid[] {
    return [...this.recent];
  }

  private leaseUntil(): Date {
    return new Date(Date.now() + this.deps.timing.leaseMs);
  }

  /** Flushes once the flush period since the last one has passed. */
  scheduleFlush(): void {
    if (this.flushTimer || this.closed) {
      return;
    }
    const wait = Math.max(0, this.lastFlushAt + this.deps.timing.flushMs - Date.now());
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      void this.flush().then(() => {
        if (this.closed) {
          return;
        }
        if (this.peers.size === 0 && !this.lingerTimer) {
          // Everyone left, it lingered, and its last flush failed: close now.
          void this.closeIfEmpty();
        } else if (this.dirty) {
          this.scheduleFlush();
        }
      });
    }, wait);
    this.flushTimer.unref?.();
  }

  /**
   * Writes the plan and seq (and the lease: extended, or ended when `final`),
   * then trims the journal to what came after. False when the write failed
   * (the journal keeps everything; the next flush tries again) or the design
   * is gone (the room is dropped as deleted).
   */
  async flush(final = false): Promise<boolean> {
    while (this.flushing) {
      await this.flushing;
    }
    if (this.closed || (this.ending && !final)) {
      return false;
    }
    const run = this.deps.flushes
      .run(() => this.write(final))
      .catch((error: unknown) => {
        this.deps.log(`${this.doc}: flush failed, kept in the journal: ${String(error)}`);
        return false;
      });
    this.flushing = run;
    try {
      return await run;
    } finally {
      this.flushing = undefined;
    }
  }

  /**
   * One flush, in its turn of the flush queue: the plan as far as the
   * journal has it, written while the lease is the room's. Throws when the
   * database fails, which pauses the queue.
   */
  private async write(final: boolean): Promise<boolean> {
    // The room may have moved on while this waited for its turn.
    if (this.closed || (this.ending && !final)) {
      return false;
    }
    const captured = await this.capture();
    if (!captured || this.closed) {
      return false;
    }
    const { plan, seq } = captured;
    const sizeAtCapture = this.chars;
    this.lastFlushAt = Date.now();
    const outcome = await this.deps.store.flush(
      this.ownerId,
      this.designId,
      this.token,
      plan,
      seq,
      final ? null : this.leaseUntil(),
    );
    if (outcome !== "held") {
      await this.leaseMissed(outcome);
      return false;
    }
    this.flushedSeq = Math.max(this.flushedSeq, seq);
    this.noteFlushed(seq);
    // Exact again: the stored plan measured, plus what came after it.
    this.chars = sizeOf(plan) + (this.chars - sizeAtCapture);
    try {
      await this.deps.journal.trim(this.doc, seq, this.recentCids());
    } catch (error) {
      // Stored all the same: the journal keeps the lines, and the next trim takes them.
      this.deps.log(`${this.doc}: trimming the journal failed: ${String(error)}`);
    }
    return true;
  }

  /** Lets the lease go without writing the plan, in the flush queue's turn. */
  private release(): Promise<void> {
    return this.deps.flushes.run(() =>
      this.deps.store.release(this.ownerId, this.designId, this.token),
    );
  }

  /**
   * The plan and its seq as far as the journal has them on disk, for a flush:
   * the database never gets a batch its sender could still lose. Batches
   * apply whole between turns of the event loop, so the plan is consistent
   * whenever it is read; when the journal keeps falling behind (a burst of
   * edits), this flush is skipped and the next one tries.
   */
  private async capture(): Promise<{ plan: LivePlan; seq: number } | undefined> {
    for (let round = 0; round < 5; round += 1) {
      if (this.durableSeq >= this.seq) {
        return { plan: this.plan, seq: this.seq };
      }
      try {
        await this.whenDurable();
      } catch {
        return undefined;
      }
      if (this.closed) {
        return undefined;
      }
    }
    return undefined;
  }

  private async renew(): Promise<void> {
    if (this.closed) {
      return;
    }
    try {
      const outcome = await this.deps.store.renew(
        this.ownerId,
        this.designId,
        this.token,
        this.leaseUntil(),
      );
      if (outcome !== "held") {
        await this.leaseMissed(outcome);
        return;
      }
      // Who may be here, as the database has it: a sharing change whose
      // notice never reached the service still takes effect within a renewal.
      const members = await this.deps.store.members(this.ownerId, this.designId);
      if (!this.closed && !sameMembers(members, this.members)) {
        await this.enqueue(() => {
          if (!this.closed) {
            this.updateMembers(members);
          }
        });
      }
    } catch (error) {
      this.deps.log(`${this.doc}: lease renewal failed: ${String(error)}`);
    }
  }

  /** A write found the design gone (dropped as deleted) or its lease another's (the room fails). */
  private async leaseMissed(outcome: "gone" | "lost"): Promise<void> {
    if (outcome === "gone") {
      await this.drop("deleted");
    } else {
      this.fail("its lease is no longer its own (taken, or lapsed and cleared by a save)");
    }
  }

  /** Takes a peer out; the room lingers once the last one goes, then closes. */
  leave(peer: RoomPeer): void {
    if (!this.peers.delete(peer)) {
      return;
    }
    this.broadcast({ t: "present", doc: this.doc, present: this.present });
    if (this.peers.size === 0) {
      this.linger();
    }
  }

  /** Nobody is here: the room closes once `lingerMs` passes with nobody back. */
  private linger(): void {
    if (this.closed || this.lingerTimer) {
      return;
    }
    this.lingerTimer = setTimeout(() => {
      this.lingerTimer = undefined;
      if (this.peers.size === 0) {
        void this.closeIfEmpty();
      }
    }, this.deps.timing.lingerMs);
    this.lingerTimer.unref?.();
  }

  /**
   * Closes the room once it is empty and its plan is safely stored: the last
   * flush also ends the lease. A failed flush keeps the room (and its lease)
   * and tries again on the flush timer; a join meanwhile finds it still open.
   */
  closeIfEmpty(): Promise<void> {
    return this.enqueue(async () => {
      if (this.peers.size > 0 || this.closed) {
        return;
      }
      this.ending = true;
      const stored = this.dirty
        ? await this.flush(true)
        : await this.release().then(
            () => true,
            (error) => {
              this.deps.log(`${this.doc}: releasing the lease failed: ${String(error)}`);
              return true;
            },
          );
      if (this.closed) {
        return;
      }
      if (!stored) {
        this.ending = false;
        this.scheduleFlush();
        return;
      }
      this.finish();
    });
  }

  /** Flushes and lets go, whoever is in the room (the service is stopping). */
  async shutdown(): Promise<void> {
    await this.enqueue(async () => {
      if (this.closed) {
        return;
      }
      this.ending = true;
      if (this.dirty) {
        await this.flush(true);
      } else {
        await this.release().catch(() => undefined);
      }
      this.finish();
    });
  }

  /** Sharing changed: tell everyone, and drop whoever may no longer be here. */
  updateMembers(members: LiveMember[]): void {
    this.members = members;
    this.broadcast({ t: "members", doc: this.doc, members });
    const allowed = new Set([this.ownerId, ...members.map((member) => member.id)]);
    const removed = [...this.peers].filter((peer) => !allowed.has(peer.userId));
    for (const peer of removed) {
      peer.send({ t: "kicked", doc: this.doc, reason: "unshared" });
      this.peers.delete(peer);
      peer.forget(this.doc);
    }
    if (removed.length > 0) {
      this.broadcast({ t: "present", doc: this.doc, present: this.present });
      if (this.peers.size === 0) {
        this.linger();
      }
    }
  }

  /** The design is gone: everyone out, nothing written back, the journal forgotten. */
  async drop(reason: "deleted"): Promise<void> {
    if (this.closed) {
      return;
    }
    this.dropping = true;
    this.broadcast({ t: "kicked", doc: this.doc, reason });
    this.peers.forEach((peer) => peer.forget(this.doc));
    this.peers.clear();
    await this.deps.journal.remove(this.doc).catch(() => undefined);
    this.finish();
  }

  /**
   * The room can no longer be trusted (its journal failed): it closes without
   * writing anything, and everyone in it joins again, which opens the plan
   * afresh from the database and the journal.
   */
  private fail(reason: string): void {
    if (this.closed) {
      return;
    }
    this.deps.log(`${this.doc}: ${reason}; everyone in it joins again`);
    const peers = [...this.peers];
    this.peers.clear();
    this.abandon();
    this.deps.onClosed(this);
    for (const peer of peers) {
      peer.forget(this.doc);
      peer.reload();
    }
  }

  /** Stops the room's timers and stores nothing (a crash, simulated in tests). */
  abandon(): void {
    this.closed = true;
    clearTimeout(this.flushTimer);
    clearTimeout(this.lingerTimer);
    clearInterval(this.renewTimer);
  }

  private finish(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    clearTimeout(this.flushTimer);
    clearTimeout(this.lingerTimer);
    clearInterval(this.renewTimer);
    this.flushTimer = undefined;
    this.lingerTimer = undefined;
    this.deps.onClosed(this);
  }
}
