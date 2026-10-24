import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { LiveOp, LivePlan } from "@/lib/live/ops";
import type { ServerFrame } from "@/lib/live/protocol";
import { FlushQueue } from "./flush-queue";
import { Journal } from "./journal";
import { Room, type RoomDeps, type RoomPeer } from "./room";
import type { LeaseOutcome, PlanStore } from "./store";

/**
 * One room against a store it can hold still: the order its writes reach
 * the database in, whatever the timers do meanwhile.
 */

const OWNER = "11111111-1111-4111-8111-111111111111";
const DOC = `${OWNER}:design-room-1`;
const dirs: string[] = [];

interface Write {
  kind: "lease" | "renew" | "flush" | "release";
  until: string | null;
  done: () => void;
}

/** A store whose writes wait until the test lets them through, with a lease token as the database keeps it. */
class HeldStore implements PlanStore {
  readonly writes: Write[] = [];
  hold = false;
  /** The token the design's lease holds. */
  token: string | null = null;
  plan: LivePlan = { name: "Plan", tasks: [{ id: "t1", title: "One", status: "todo", order: "a0" }] };

  private write(kind: Write["kind"], until: Date | null): Promise<void> {
    return new Promise((resolve) => {
      const entry: Write = { kind, until: until ? until.toISOString() : null, done: resolve };
      this.writes.push(entry);
      if (!this.hold) {
        resolve();
      }
    });
  }

  async account() {
    return undefined;
  }
  forgetAccount() {}
  async role() {
    return "owner" as const;
  }
  async size() {
    return JSON.stringify(this.plan).length;
  }
  async lease(_owner: string, _design: string, token: string, until: Date) {
    await this.write("lease", until);
    this.token = token;
    return { plan: this.plan, seq: 0 };
  }
  async renew(_owner: string, _design: string, token: string, until: Date): Promise<LeaseOutcome> {
    if (token !== this.token) {
      return "lost";
    }
    await this.write("renew", until);
    return "held";
  }
  async flush(
    _owner: string,
    _design: string,
    token: string,
    plan: LivePlan,
    _seq: number,
    until: Date | null,
  ): Promise<LeaseOutcome> {
    if (token !== this.token) {
      return "lost";
    }
    await this.write("flush", until);
    this.plan = plan;
    if (!until) {
      this.token = null;
    }
    return "held";
  }
  async release(_owner: string, _design: string, token: string) {
    if (token === this.token) {
      await this.write("release", null);
      this.token = null;
    }
  }
  async members() {
    return [];
  }
  async usernames() {
    return new Map([[OWNER, "ann"]]);
  }
}

const peer: RoomPeer = {
  connId: "c1",
  userId: OWNER,
  username: "ann",
  client: "web",
  send: (frame: ServerFrame) => void frame,
  sendText: (text: string) => void text,
  reload: () => undefined,
  forget: () => undefined,
};

/** A peer that keeps what it is sent. */
function listener(connId = "c2") {
  const frames: ServerFrame[] = [];
  let reloaded = 0;
  const listening: RoomPeer = {
    ...peer,
    connId,
    send: (frame) => frames.push(frame),
    sendText: (text) => frames.push(JSON.parse(text) as ServerFrame),
    reload: () => {
      reloaded += 1;
    },
  };
  return { peer: listening, frames, reloads: () => reloaded };
}

async function openRoom(
  store: PlanStore,
  timing: Partial<RoomDeps["timing"]> = {},
  extra: Partial<RoomDeps> = {},
) {
  const dir = mkdtempSync(path.join(tmpdir(), "gtnh-room-"));
  dirs.push(dir);
  const room = await Room.open(DOC, {
    store,
    journal: new Journal(dir),
    flushes: new FlushQueue(),
    timing: { flushMs: 60_000, renewMs: 60_000, leaseMs: 5_000, lingerMs: 0, ...timing },
    cids: new Map(),
    log: () => undefined,
    onClosed: () => undefined,
    ...extra,
  });
  if (!room) {
    throw new Error("the room did not open");
  }
  return room;
}

const rename = (title: string): LiveOp[] => [
  { o: "patch", c: "tasks", id: "t1", f: { title } },
];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("a room's writes", () => {
  it("never write the lease back after the last flush let it go", async () => {
    const store = new HeldStore();
    const room = await openRoom(store);
    await room.apply(peer, "c1", rename("Two"));
    store.hold = true;
    const closing = room.closeIfEmpty();
    await expect.poll(() => store.writes.filter((w) => w.kind === "flush").length).toBe(1);
    // A timed flush comes due while the last one is on its way.
    const timed = room.flush();
    store.writes.at(-1)!.done();
    await closing;
    expect(await timed).toBe(false);
    expect(room.closed).toBe(true);
    const flushes = store.writes.filter((w) => w.kind === "flush");
    expect(flushes.map((w) => w.until)).toEqual([null]);
  });
});

describe("the journal", () => {
  it("writes the lines a turn brings in one write and one sync, in order", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "gtnh-journal-"));
    dirs.push(dir);
    const journal = new Journal(dir);
    const entry = (seq: number) => ({ seq, cid: `c${seq}`, by: OWNER, at: "now", ops: rename(`T${seq}`) });
    await Promise.all(Array.from({ length: 50 }, (_, at) => journal.append(DOC, entry(at + 1))));
    expect(journal.writes).toBe(1);
    await journal.append(DOC, entry(51));
    expect(journal.writes).toBe(2);
    expect((await journal.read(DOC)).map((line) => line.seq)).toEqual(
      Array.from({ length: 51 }, (_, at) => at + 1),
    );
    await journal.durable(DOC);
  });
});

describe("a room's batches", () => {
  it("go out only once their journal line is on disk", async () => {
    const room = await openRoom(new HeldStore());
    const other = listener();
    room.peers.add(other.peer);
    const result = room.apply(peer, "c1", rename("Two"));
    expect(result).toMatchObject({ kind: "applied", seq: 1 });
    expect(other.frames).toEqual([]);
    await room.whenDurable();
    expect(other.frames).toMatchObject([{ t: "ops", seq: 1, cid: "c1" }]);
  });

  it("are refused as rate while the journal holds too much the database has not taken", async () => {
    const store = new HeldStore();
    const room = await openRoom(store, {}, { maxJournalBytes: 600 });
    const results = Array.from({ length: 6 }, (_, at) =>
      room.apply(peer, `c${at}`, rename(`A title long enough to fill the journal ${at}`)),
    );
    expect(results.map((result) => result.kind)).toContain("refused");
    expect(results.at(-1)).toMatchObject({ kind: "refused", code: "rate" });
    // Stored: the journal's lines no longer count, and batches go through again.
    expect(await room.flush()).toBe(true);
    expect(room.apply(peer, "after", rename("Again"))).toMatchObject({ kind: "applied" });
  });

  it("fail the room when the journal cannot be written: everyone joins again", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "gtnh-room-"));
    dirs.push(dir);
    // A file where the journal's folder should be: nothing can be written.
    const blocked = path.join(dir, "blocked");
    writeFileSync(blocked, "not a folder");
    let closed = 0;
    const room = await openRoom(new HeldStore(), {}, {
      journal: new Journal(path.join(blocked, "journal")),
      onClosed: () => {
        closed += 1;
      },
    });
    const other = listener();
    room.peers.add(other.peer);
    expect(room.apply(peer, "c1", rename("Lost"))).toMatchObject({ kind: "applied" });
    await expect(room.whenDurable()).rejects.toThrow();
    await expect.poll(() => room.closed).toBe(true);
    expect(closed).toBe(1);
    expect(other.reloads()).toBe(1);
    // Nothing that was never on disk went out.
    expect(other.frames).toEqual([]);
    expect(readFileSync(blocked, "utf8")).toBe("not a folder");
  });
});

describe("a room's game version", () => {
  it("a live room keeps gameVersion through a batch and a flush", async () => {
    const store = new HeldStore();
    store.plan = { ...store.plan, gameVersion: "2.8.1" };
    const room = await openRoom(store);
    expect(room.apply(peer, "c1", rename("Two"))).toMatchObject({ kind: "applied" });
    expect(await room.flush()).toBe(true);
    expect(store.plan).toMatchObject({ gameVersion: "2.8.1", tasks: [{ id: "t1", title: "Two" }] });
  });

  it("refuses a batch that sets the version, and stores none on a plan that had none", async () => {
    const store = new HeldStore();
    const room = await openRoom(store);
    expect(room.apply(peer, "c1", [{ o: "meta", f: { gameVersion: "2.8.1" } }])).toMatchObject({
      kind: "refused",
    });
    expect(room.apply(peer, "c2", rename("Two"))).toMatchObject({ kind: "applied" });
    expect(await room.flush()).toBe(true);
    expect("gameVersion" in store.plan).toBe(false);
  });
});

describe("a room's lease", () => {
  it("is the room's own: once another holds it, the room stops writing and everyone joins again", async () => {
    const store = new HeldStore();
    const room = await openRoom(store);
    const other = listener();
    room.peers.add(other.peer);
    room.apply(peer, "c1", rename("Mine"));
    await room.whenDurable();
    // Someone else takes the lease (or it lapsed and a save cleared it).
    store.token = "someone else's";
    const before = store.writes.length;
    expect(await room.flush()).toBe(false);
    expect(room.closed).toBe(true);
    expect(other.reloads()).toBe(1);
    expect(store.writes.length).toBe(before);
    expect((store.plan.tasks as Array<{ title: string }>)[0]!.title).toBe("One");
    // Opened again, it takes the lease afresh and replays what it journalled.
    const again = await Room.open(DOC, {
      store,
      journal: room["deps"].journal,
      flushes: new FlushQueue(),
      timing: { flushMs: 60_000, renewMs: 60_000, leaseMs: 5_000, lingerMs: 0 },
      cids: new Map(),
      log: () => undefined,
      onClosed: () => undefined,
    });
    expect((again!.plan.tasks as Array<{ title: string }>)[0]!.title).toBe("Mine");
    expect(await again!.flush()).toBe(true);
  });
});

describe("what the server writes on a task", () => {
  it("is who made it: the sender of a new task, kept by a put over it, never patched", async () => {
    const room = await openRoom(new HeldStore());
    const bob: RoomPeer = { ...peer, connId: "c-bob", userId: "22222222-2222-4222-8222-222222222222" };
    const task = (id: string, extra: Record<string, unknown> = {}) => ({
      o: "put" as const,
      c: "tasks" as const,
      id,
      v: { id, title: "T", status: "todo", order: "a1", ...extra },
    });
    const createdBy = (id: string) =>
      (room.plan.tasks as Array<{ id: string; createdBy?: string }>).find((t) => t.id === id)
        ?.createdBy;
    expect(room.apply(bob, "b1", [task("t2", { createdBy: OWNER })])).toMatchObject({
      kind: "applied",
    });
    expect(createdBy("t2")).toBe(bob.userId);
    room.apply(peer, "a1", [task("t2", { createdBy: OWNER, title: "Renamed" })]);
    expect(createdBy("t2")).toBe(bob.userId);
    room.apply(peer, "a2", [
      { o: "patch", c: "tasks", id: "t2", f: { createdBy: OWNER } },
      { o: "patch", c: "tasks", id: "t1", f: {}, d: ["createdBy"] },
    ]);
    expect(createdBy("t2")).toBe(bob.userId);
    // A task from before, made by nobody the server knows, stays that way.
    room.apply(bob, "b2", [task("t1", { createdBy: bob.userId })]);
    expect(createdBy("t1")).toBeUndefined();
  });
});

describe("a room dropped as deleted", () => {
  it("takes its waiting journal lines with it, and nobody is told to reload", async () => {
    const logged: string[] = [];
    const room = await openRoom(new HeldStore(), {}, { log: (message) => logged.push(message) });
    const other = listener();
    room.peers.add(other.peer);
    room.apply(peer, "c1", rename("Gone"));
    await room.drop("deleted");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(room.closed).toBe(true);
    expect(other.reloads()).toBe(0);
    expect(other.frames).toMatchObject([{ t: "kicked", reason: "deleted" }]);
    // Not a journal failure: nothing to join again for.
    expect(logged.filter((line) => line.includes("journal"))).toEqual([]);
  });
});
