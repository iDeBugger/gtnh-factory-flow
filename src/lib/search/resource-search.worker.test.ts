import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const file = (schemaVersion: number) => ({
  schemaVersion,
  resourceIndex: [
    {
      kind: "item",
      id: "gregtech:steel",
      displayName: "Steel Ingot",
      iconPath: "/a.png",
      recipeCount: 3,
    },
    {
      kind: "item",
      id: "minecraft:glass",
      displayName: "Glass",
      iconPath: "/b.png",
      recipeCount: 2,
    },
  ],
  directionCounts: [],
  sources: { plants: [], bees: [] },
});

let replies: Array<Record<string, unknown>>;
let onmessage: (event: { data: unknown }) => Promise<void> | void;

async function loadWorker(schemaVersion: number) {
  vi.resetModules();
  replies = [];
  const host = {
    postMessage: (reply: Record<string, unknown>) => replies.push(reply),
    onmessage: undefined as unknown,
  };
  vi.stubGlobal("self", host);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) =>
      url.includes("popularity")
        ? new Response(JSON.stringify({ entries: [] }), { status: 200 })
        : new Response(JSON.stringify(file(schemaVersion)), { status: 200 }),
    ),
  );
  await import("./resource-search.worker");
  onmessage = host.onmessage as typeof onmessage;
  await onmessage({
    data: { type: "load", itemsUrl: "http://x/items", popularityUrl: "http://x/popularity" },
  });
}

describe("the item search worker", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("refuses an items file of another format, so the page asks the API", async () => {
    await loadWorker(3);
    expect(replies).toEqual([{ type: "failed", error: "Item search file has format 3." }]);
  });

  it("reads the current format and the one before it, which is the same without an order", async () => {
    for (const schemaVersion of [1, 2]) {
      await loadWorker(schemaVersion);
      expect(replies[0]).toMatchObject({ type: "ready" });
    }
  });

  it("answers with the route's JSON and skips a query cancelled before it ran", async () => {
    await loadWorker(1);
    expect(replies[0]).toMatchObject({ type: "ready" });
    const request = { query: "steel", offset: 0, limit: 120 };
    await onmessage({ data: { type: "query", id: 1, request } });
    await onmessage({ data: { type: "query", id: 2, request } });
    await onmessage({ data: { type: "cancel", id: 1 } });
    await vi.runAllTimersAsync();
    const answered = replies.slice(1);
    expect(answered.map((reply) => reply.id)).toEqual([2]);
    expect(JSON.parse(answered[0]!.json as string)).toMatchObject({
      total: 1,
      resources: [{ id: "gregtech:steel" }],
    });
  });

  it("answers one query a task, so a cancel sent while one walks still drops the next", async () => {
    await loadWorker(1);
    const request = { query: "steel", offset: 0, limit: 120 };
    await onmessage({ data: { type: "query", id: 1, request } });
    await onmessage({ data: { type: "query", id: 2, request } });
    await onmessage({ data: { type: "query", id: 3, request } });
    await vi.advanceTimersToNextTimerAsync();
    expect(replies.slice(1).map((reply) => reply.id)).toEqual([1]);
    await onmessage({ data: { type: "cancel", id: 2 } });
    await vi.runAllTimersAsync();
    expect(replies.slice(1).map((reply) => reply.id)).toEqual([1, 3]);
  });
});
