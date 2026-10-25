import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatasetVersion } from "./types";

const v29 = { id: "local-2.9.0-rc-2", checksumSha256: "abc" } as DatasetVersion;
const v281 = { id: "local-2.8.1", checksumSha256: "def" } as DatasetVersion;

class FakeWorker {
  static all: FakeWorker[] = [];
  posted: unknown[] = [];
  terminated = false;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() {
    FakeWorker.all.push(this);
  }
  postMessage(message: unknown) {
    this.posted.push(message);
  }
  terminate() {
    this.terminated = true;
  }
  reply(data: unknown) {
    this.onmessage?.({ data });
  }
}

async function client() {
  return import("./resource-search-client");
}

describe("the browser's item search worker, from the page's side", () => {
  beforeEach(() => {
    vi.resetModules();
    FakeWorker.all = [];
    vi.stubGlobal("Worker", FakeWorker);
    vi.stubGlobal("window", { location: { origin: "http://localhost" } });
    vi.stubGlobal("navigator", { deviceMemory: 8 });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("leaves every query to the API until the worker is ready", async () => {
    const search = await client();
    expect(
      search.searchResourcesInBrowser(v29, { query: "st", offset: 0, limit: 120 }),
    ).toBeUndefined();
    search.startBrowserResourceSearch(
      v29,
      "/datasets/gtnh/v/client/items.0123456789abcdef0123.json",
    );
    const worker = FakeWorker.all[0]!;
    expect(worker.posted[0]).toEqual({
      type: "load",
      itemsUrl: "http://localhost/datasets/gtnh/v/client/items.0123456789abcdef0123.json",
      popularityUrl: "http://localhost/api/resource-popularity",
    });
    expect(
      search.searchResourcesInBrowser(v29, { query: "st", offset: 0, limit: 120 }),
    ).toBeUndefined();
  });

  it("sends the request as the route reads it and hands back the route's JSON", async () => {
    const search = await client();
    search.startBrowserResourceSearch(v29, "/items.json");
    const worker = FakeWorker.all[0]!;
    worker.reply({ type: "ready", buildMs: 1 });

    const answer = search.searchResourcesInBrowser(v29, {
      query: "steel",
      offset: 0,
      limit: 500,
      sort: "relevance",
      kind: "gas",
    });
    expect(worker.posted[1]).toEqual({
      type: "query",
      id: 1,
      request: {
        query: "steel",
        offset: 0,
        limit: 120,
        kind: undefined,
        mod: undefined,
        sort: undefined,
        source: undefined,
      },
    });
    worker.reply({ type: "result", id: 1, json: JSON.stringify({ total: 3, resources: [] }) });
    await expect(answer).resolves.toEqual({ total: 3, resources: [] });

    const fallback = search.searchResourcesInBrowser(v29, {
      query: "",
      offset: 0,
      limit: 24,
      sort: "popular",
    });
    worker.reply({ type: "fallback", id: 2 });
    await expect(fallback).resolves.toBeUndefined();
  });

  it("rejects an aborted query at once, and answers nothing for another version", async () => {
    const search = await client();
    search.startBrowserResourceSearch(v29, "/items.json");
    FakeWorker.all[0]!.reply({ type: "ready", buildMs: 1 });
    const controller = new AbortController();
    const answer = search.searchResourcesInBrowser(
      v29,
      { query: "s", offset: 0, limit: 120 },
      controller.signal,
    );
    controller.abort();
    await expect(answer).rejects.toMatchObject({ name: "AbortError" });
    // The worker is told, so a query still waiting there is skipped.
    expect(FakeWorker.all[0]!.posted.at(-1)).toEqual({ type: "cancel", id: 1 });
    expect(
      search.searchResourcesInBrowser(v281, { query: "s", offset: 0, limit: 120 }),
    ).toBeUndefined();
  });

  it("keeps one version's worker: another ends it and its open queries go to the API", async () => {
    const search = await client();
    search.startBrowserResourceSearch(v29, "/a.json");
    const first = FakeWorker.all[0]!;
    first.reply({ type: "ready", buildMs: 1 });
    const open = search.searchResourcesInBrowser(v29, { query: "s", offset: 0, limit: 120 });
    search.startBrowserResourceSearch(v281, "/b.json");
    expect(first.terminated).toBe(true);
    await expect(open).resolves.toBeUndefined();
    expect(FakeWorker.all).toHaveLength(2);
    // The same version again starts nothing.
    search.startBrowserResourceSearch(v281, "/b.json");
    expect(FakeWorker.all).toHaveLength(2);
  });

  it("stays off on a device with under 4 GB, and after a failed load", async () => {
    vi.stubGlobal("navigator", { deviceMemory: 2 });
    const small = await client();
    small.startBrowserResourceSearch(v29, "/a.json");
    expect(FakeWorker.all).toHaveLength(0);

    vi.resetModules();
    vi.stubGlobal("navigator", { deviceMemory: 8 });
    const search = await client();
    search.startBrowserResourceSearch(v29, "/a.json");
    FakeWorker.all[0]!.reply({ type: "failed", error: "404" });
    expect(FakeWorker.all[0]!.terminated).toBe(true);
    expect(search.browserResourceSearchStarted(v29)).toBe(false);
    search.startBrowserResourceSearch(v29, "/a.json");
    expect(FakeWorker.all).toHaveLength(1);
  });
});
