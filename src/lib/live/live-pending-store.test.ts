import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it } from "vitest";
import { deleteDesign } from "@/lib/designs/design-storage";
import {
  forgetDetachedBase,
  keepDetachedBase,
  moveDetachedBase,
  readDetachedBase,
  readPending,
  shiftDetachedBase,
  takeDetachedBase,
  writePending,
} from "./live-pending-store";
import type { LivePlan } from "./ops";

/**
 * The base of edits made away from a live room, on a real IndexedDB (fake-indexeddb): stored beside the pending
 * batches but never listed with them, the first one kept, taken in one transaction with the batches made of it,
 * moved only when one is kept.
 */

const DOC = "11111111-1111-4111-8111-111111111111:design-1";

function plan(text: string): LivePlan {
  return { annotations: [{ id: "n1", text }] } as LivePlan;
}

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
});

describe("the base of edits made away from a live room", () => {
  it("keeps the first base, and is never listed as pending batches", async () => {
    await keepDetachedBase("design-1", () => plan("first"));
    let asked = false;
    await keepDetachedBase("design-1", () => {
      asked = true;
      return plan("second");
    });

    expect(asked).toBe(false);
    expect(await readDetachedBase("design-1")).toEqual(plan("first"));
    expect(await readPending()).toEqual([]);
    expect(await readPending("detached|design-1")).toEqual([]);
  });

  it("is read from storage by every reader: one that another tab forgot is gone here too", async () => {
    await keepDetachedBase("design-1", () => plan("first"));
    // Another tab's delete goes straight to storage (no copy kept in memory here survives it).
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open("gtnh-factory-flow-live");
      request.onsuccess = () => {
        const tx = request.result.transaction("pending", "readwrite");
        tx.objectStore("pending").delete("detached|design-1");
        tx.oncomplete = () => {
          request.result.close();
          resolve();
        };
        tx.onerror = () => reject(tx.error);
      };
    });

    expect(await readDetachedBase("design-1")).toBeUndefined();
    // A later edit away from the room keeps a new base.
    await keepDetachedBase("design-1", () => plan("later"));
    expect(await readDetachedBase("design-1")).toEqual(plan("later"));
  });

  it("is taken with the batches made of it in one go, and only once", async () => {
    await keepDetachedBase("design-1", () => plan("base"));
    const batch = { cid: "away-1", ops: [], inverse: [] };

    let got: LivePlan | undefined;
    await takeDetachedBase("design-1", (base) => {
      got = base;
      return { doc: DOC, tabId: "tab-a", pending: [batch] };
    });
    expect(got).toEqual(plan("base"));
    expect(await readDetachedBase("design-1")).toBeUndefined();
    expect((await readPending(DOC)).map((entry) => entry.pending)).toEqual([[batch]]);

    let again: unknown = "not called";
    await takeDetachedBase("design-1", (base) => {
      again = base;
      return undefined;
    });
    expect(again).toBeUndefined();
  });

  it("stays when the taker does not use it", async () => {
    await keepDetachedBase("design-1", () => plan("base"));
    await takeDetachedBase("design-1", () => undefined);

    expect(await readDetachedBase("design-1")).toEqual(plan("base"));
  });

  it("stores neither the batches nor the removal when taking it fails", async () => {
    await keepDetachedBase("design-1", () => plan("base"));
    await writePending(DOC, "tab-a", [{ cid: "older", ops: [], inverse: [] }]);

    await expect(
      takeDetachedBase("design-1", () => {
        throw new Error("no");
      }),
    ).rejects.toBeDefined();

    expect(await readDetachedBase("design-1")).toEqual(plan("base"));
    expect((await readPending(DOC))[0]!.pending.map((batch) => batch.cid)).toEqual(["older"]);
  });

  it("moves and shifts only a base that is kept", async () => {
    await moveDetachedBase("design-1", plan("moved"));
    await shiftDetachedBase("design-1", [{ o: "patch", c: "annotations", id: "n1", f: { text: "shifted" } }]);
    expect(await readDetachedBase("design-1")).toBeUndefined();

    await keepDetachedBase("design-1", () => plan("base"));
    await shiftDetachedBase("design-1", [{ o: "patch", c: "annotations", id: "n1", f: { text: "shifted" } }]);
    expect(await readDetachedBase("design-1")).toEqual(plan("shifted"));
    await moveDetachedBase("design-1", plan("moved"));
    expect(await readDetachedBase("design-1")).toEqual(plan("moved"));

    await forgetDetachedBase("design-1");
    expect(await readDetachedBase("design-1")).toBeUndefined();
  });

  it("goes with its design: a later design of the same id (a plan shared again) starts with none", async () => {
    await keepDetachedBase("shared-owner-design", () => plan("base"));
    await deleteDesign("shared-owner-design");

    expect(await readDetachedBase("shared-owner-design")).toBeUndefined();
  });

  it("waits for a base still being written before reading or taking it", async () => {
    const keeping = keepDetachedBase("design-1", () => plan("in flight"));
    const read = readDetachedBase("design-1");

    expect(await read).toEqual(plan("in flight"));
    await keeping;
  });
});
