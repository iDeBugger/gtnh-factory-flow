import { makeCid, type PendingBatch } from "./client-state";
import { applyOps, type LiveOp, type LivePlan } from "./ops";

/**
 * Live edits not yet confirmed by the live service, kept in IndexedDB so a
 * closed tab, a crash or a dropped connection loses nothing: the next time
 * the plan is open live they are sent again (the service acknowledges a
 * batch it already applied without applying it twice).
 *
 * One entry per plan per browser tab (`<doc>|<tabId>`): every tab edits a
 * live plan through its own connection. A tab adopts the entries of tabs
 * that are gone (`isTabAlive`), so edits a closed tab left behind still go.
 *
 * Its own database, so live plans never bump the design library's version.
 */

const DB_NAME = "gtnh-factory-flow-live";
const DB_VERSION = 1;
const STORE = "pending";

export interface StoredPending {
  key: string;
  doc: string;
  tabId: string;
  pending: PendingBatch[];
  updatedAt: string;
}

function available(): boolean {
  return typeof indexedDB !== "undefined";
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: "key" });
        store.createIndex("doc", "doc");
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Live storage could not open."));
  });
}

function done<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Live storage failed."));
  });
}

export function pendingKey(doc: string, tabId: string): string {
  return `${doc}|${tabId}`;
}

/** Writes this tab's unconfirmed batches for a plan; none removes the entry. */
export async function writePending(
  doc: string,
  tabId: string,
  pending: PendingBatch[],
): Promise<void> {
  if (!available()) {
    return;
  }
  const db = await open();
  try {
    const store = db.transaction(STORE, "readwrite").objectStore(STORE);
    const key = pendingKey(doc, tabId);
    if (pending.length === 0) {
      await done(store.delete(key));
    } else {
      const entry: StoredPending = {
        key,
        doc,
        tabId,
        pending,
        updatedAt: new Date().toISOString(),
      };
      await done(store.put(entry));
    }
  } finally {
    db.close();
  }
}

/** Every stored entry for a plan (all tabs), or for every plan when `doc` is omitted. */
export async function readPending(doc?: string): Promise<StoredPending[]> {
  if (!available()) {
    return [];
  }
  const db = await open();
  try {
    const store = db.transaction(STORE, "readonly").objectStore(STORE);
    const entries = await done(
      doc === undefined ? store.getAll() : store.index("doc").getAll(IDBKeyRange.only(doc)),
    );
    return (entries as StoredPending[]).filter((entry) => Array.isArray(entry.pending));
  } finally {
    db.close();
  }
}

export async function deletePending(key: string): Promise<void> {
  if (!available()) {
    return;
  }
  const db = await open();
  try {
    await done(db.transaction(STORE, "readwrite").objectStore(STORE).delete(key));
  } finally {
    db.close();
  }
}

/*
 * Edits made to a plan in the account while no room is open for it in this tab (the session does not know who is
 * signed in yet, or the service would not open the plan) are not batches: there is no live plan to diff against. The
 * plan as it stood before the first of them is kept instead, per design, so when the room opens the difference from
 * it to the canvas goes on top of the live plan rather than the snapshot wiping it. Same store, keys of their own
 * (no `pending`, so `readPending` never lists them).
 *
 * The first base wins until it is used or the account takes the plan: a later edit never moves it forward, or the
 * edits before it would be lost. IndexedDB is the only copy: every tab reads it there, so a base another tab used,
 * moved or forgot is seen at once, and taking it (`takeDetachedBase`) removes it in the same transaction that stores
 * the batches made of it, so two tabs never send the same edits. Every edit made away from the room checks storage
 * (one small transaction), so one right after another tab took the base keeps a new one. Memory holds only the
 * writes still to run, one chain per design: a room opening moments after an edit or a refresh waits for them, and
 * edits arriving while a keep waits its turn share it (its plan is the older one).
 */

interface StoredBase {
  key: string;
  doc: string;
  tabId: string;
  base: LivePlan;
  updatedAt: string;
  /** New at every write of the base: tells one base from a later one with the same plan. */
  stamp?: string;
}

function baseKey(designId: string): string {
  return `detached|${designId}`;
}

const writing = new Map<string, Promise<void>>();
/** A keep asked for and not started yet, per design: later edits share it. */
const queuedKeeps = new Map<string, Promise<void>>();

async function settled(designId: string): Promise<void> {
  await writing.get(designId)?.catch(() => undefined);
}

/** Runs `work` after every base write already asked for on this design, in order. */
function inTurn<T>(designId: string, work: () => Promise<T>): Promise<T> {
  const next = (writing.get(designId) ?? Promise.resolve()).catch(() => undefined).then(work);
  const tail = next.then(
    () => undefined,
    () => undefined,
  );
  writing.set(designId, tail);
  void tail.then(() => {
    if (writing.get(designId) === tail) {
      writing.delete(designId);
    }
  });
  return next;
}

/** One transaction on the store; resolves once it has committed, rejects if it aborts. */
async function transact(
  mode: IDBTransactionMode,
  work: (store: IDBObjectStore, abort: () => void) => void,
): Promise<void> {
  const db = await open();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error ?? new Error("Live storage failed."));
      tx.onerror = () => undefined;
      try {
        work(tx.objectStore(STORE), () => tx.abort());
      } catch (error) {
        tx.abort();
        reject(error);
      }
    });
  } finally {
    db.close();
  }
}

/** Reads the base in a transaction and hands it (or undefined) to `then`, inside the same transaction. */
function withBase(
  store: IDBObjectStore,
  designId: string,
  abort: () => void,
  then: (base: LivePlan | undefined, stamp: string | undefined) => void,
): void {
  const request = store.get(baseKey(designId));
  request.onsuccess = () => {
    try {
      const entry = request.result as StoredBase | undefined;
      then(entry?.base, entry?.stamp);
    } catch {
      abort();
    }
  };
}

function putBase(store: IDBObjectStore, designId: string, base: LivePlan): void {
  const key = baseKey(designId);
  const entry: StoredBase = {
    key,
    doc: key,
    tabId: "",
    base,
    updatedAt: new Date().toISOString(),
    stamp: makeCid(),
  };
  store.put(entry);
}

/**
 * The plan before the first edit made away from its room, unless one is kept already. `base` is called only when
 * none is, so an edit after the first costs one small read; edits while that read waits its turn share it.
 */
export function keepDetachedBase(designId: string, base: () => LivePlan): Promise<void> {
  if (!available()) {
    return Promise.resolve();
  }
  const queued = queuedKeeps.get(designId);
  if (queued) {
    // Not started yet: it reads storage after this edit, with a plan at least as old as this edit's.
    return queued;
  }
  const write = inTurn(designId, () => {
    queuedKeeps.delete(designId);
    return transact("readwrite", (store, abort) =>
      withBase(store, designId, abort, (existing) => {
        if (!existing) {
          putBase(store, designId, base());
        }
      }),
    );
  });
  queuedKeeps.set(designId, write);
  return write;
}

export async function readDetachedBase(designId: string): Promise<LivePlan | undefined> {
  if (!available()) {
    return undefined;
  }
  await settled(designId);
  let found: LivePlan | undefined;
  await transact("readonly", (store, abort) =>
    withBase(store, designId, abort, (base) => (found = base)),
  );
  return found;
}

/** What a tab stores in place of a base it takes: its pending batches for the plan, made of the base. */
export interface TakenBase {
  doc: string;
  tabId: string;
  pending: PendingBatch[];
}

/**
 * Takes the base: `use` gets it (undefined when none is kept) inside the transaction and returns the batches made of
 * it, which are stored as the tab's pending entry while the base is removed, both or neither; undefined leaves the
 * base where it is. `use` must not wait.
 * Rejects when the transaction did not commit: then nothing changed in storage.
 */
export async function takeDetachedBase(
  designId: string,
  use: (base: LivePlan | undefined, stamp: string | undefined) => TakenBase | undefined,
): Promise<void> {
  if (!available()) {
    use(undefined, undefined);
    return;
  }
  await inTurn(designId, () =>
    transact("readwrite", (store, abort) =>
      withBase(store, designId, abort, (base, stamp) => {
        const taken = use(base, stamp);
        if (!base || !taken) {
          return;
        }
        store.delete(baseKey(designId));
        const key = pendingKey(taken.doc, taken.tabId);
        if (taken.pending.length === 0) {
          store.delete(key);
        } else {
          const entry: StoredPending = { key, ...taken, updatedAt: new Date().toISOString() };
          store.put(entry);
        }
      }),
    ),
  );
}

/** The account now holds the plan as `base` (a push or a pull went through): later edits count from there. */
export async function moveDetachedBase(designId: string, base: LivePlan): Promise<void> {
  if (!available()) {
    return;
  }
  await inTurn(designId, () =>
    transact("readwrite", (store, abort) =>
      withBase(store, designId, abort, (existing) => {
        if (existing) {
          putBase(store, designId, base);
        }
      }),
    ),
  );
}

/**
 * A change made on this screen only (the recipe refresh re-keying a card's recipe) goes into the base too, so the
 * difference from it to the canvas stays this person's edits alone.
 */
export async function shiftDetachedBase(designId: string, ops: LiveOp[]): Promise<void> {
  if (!available() || ops.length === 0) {
    return;
  }
  // In turn with the other base writes: a room binding right after the refresh takes the base shifted.
  await inTurn(designId, () =>
    transact("readwrite", (store, abort) =>
      withBase(store, designId, abort, (existing) => {
        if (existing) {
          putBase(store, designId, applyOps(existing, ops));
        }
      }),
    ),
  );
}

/** The base was used (its edits are batches now) or its design is gone: nothing is waiting. */
export async function forgetDetachedBase(designId: string, onlyStamp?: string): Promise<void> {
  if (!available()) {
    return;
  }
  await inTurn(designId, () =>
    transact("readwrite", (store, abort) => {
      if (onlyStamp === undefined) {
        store.delete(baseKey(designId));
        return;
      }
      // Only the base that was read: one another tab kept since is someone's edits still to send.
      withBase(store, designId, abort, (base, stamp) => {
        if (base && stamp === onlyStamp) {
          store.delete(baseKey(designId));
        }
      });
    }),
  );
}

/*
 * Which tabs are alive: each tab holds a Web Lock named for it for as long as
 * it lives, and a lock nobody holds is a tab that is gone. Without the Locks
 * API a tab adopts only its own entries (a reload keeps its tab id).
 */

const LOCK_PREFIX = "gtnh-live-tab:";
let heldTabId: string | undefined;

type LockManagerLike = {
  request(name: string, callback: () => Promise<void>): Promise<void>;
  query(): Promise<{ held?: Array<{ name?: string }> }>;
};

function locks(): LockManagerLike | undefined {
  return typeof navigator === "undefined"
    ? undefined
    : ((navigator as unknown as { locks?: LockManagerLike }).locks ?? undefined);
}

/** Holds this tab's lock until the tab goes. */
export function holdTabLock(tabId: string): void {
  const manager = locks();
  if (!manager || heldTabId === tabId) {
    return;
  }
  heldTabId = tabId;
  void manager
    .request(`${LOCK_PREFIX}${tabId}`, () => new Promise<void>(() => undefined))
    .catch(() => undefined);
}

/** The tabs (ids) alive now, or undefined when this browser cannot tell. */
export async function aliveTabs(): Promise<Set<string> | undefined> {
  const manager = locks();
  if (!manager) {
    return undefined;
  }
  try {
    const state = await manager.query();
    return new Set(
      (state.held ?? [])
        .map((lock) => lock.name ?? "")
        .filter((name) => name.startsWith(LOCK_PREFIX))
        .map((name) => name.slice(LOCK_PREFIX.length)),
    );
  } catch {
    return undefined;
  }
}
