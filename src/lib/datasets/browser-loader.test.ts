import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatasetVersion } from "./types";

const version = { id: "local-2.9.0-rc-2", checksumSha256: "abc" } as DatasetVersion;

function json(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

const busy = () =>
  json(429, { error: "Too many requests. Wait a moment and try again." }, { "retry-after": "1" });

async function loader() {
  return import("./browser-loader");
}

describe("what the browser does when the server is busy", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.stubGlobal("window", { location: { origin: "http://localhost" } });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("asks again for a recipe body after Retry-After", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(busy())
      .mockResolvedValueOnce(json(200, { id: "r1" }));
    vi.stubGlobal("fetch", fetchMock);
    const { getRecipeDatasetRecipe } = await loader();

    const promise = getRecipeDatasetRecipe("manifest", version, "r1");
    await vi.advanceTimersByTimeAsync(999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(promise).resolves.toEqual({ id: "r1" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("waits for the id list and recipe resolution the same way", async () => {
    const answers = [busy(), json(200, { recipeIds: ["a"] }), busy(), json(200, { matches: [] })];
    // No static files listed: the id list comes from the API.
    const fetchMock = vi.fn((url: string) =>
      Promise.resolve(
        url.includes("/client-files")
          ? json(200, { complete: true, files: {} })
          : (answers.shift() ?? json(500, {})),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { getRecipeDatasetRecipeIds, resolveRecipeDatasetRecipes } = await loader();

    const ids = getRecipeDatasetRecipeIds("manifest", version);
    await vi.advanceTimersByTimeAsync(1000);
    await expect(ids).resolves.toEqual(["a"]);
    const matches = resolveRecipeDatasetRecipes("manifest", version, []);
    await vi.advanceTimersByTimeAsync(1000);
    await expect(matches).resolves.toEqual({ matches: [] });
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it("sends a long plan's refs in chunks of 500 and joins the matches in order", async () => {
    const refs = Array.from({ length: 1201 }, (_, i) => ({
      id: `imported-${i}`,
      name: "x",
      machineType: "m",
      outputs: [],
    }));
    const fetchMock = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      const sent = (JSON.parse(init.body as string) as { recipes: typeof refs }).recipes;
      return Promise.resolve(
        json(200, {
          matches: sent.map((ref) => ({
            importedId: ref.id,
            recipeId: `new-${ref.id}`,
            exact: true,
          })),
        }),
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const { resolveRecipeDatasetRecipes } = await loader();

    const { matches } = await resolveRecipeDatasetRecipes("manifest", version, refs);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const sizes = fetchMock.mock.calls.map(
      ([, init]) =>
        (JSON.parse((init as RequestInit).body as string) as { recipes: unknown[] }).recipes.length,
    );
    expect(sizes).toEqual([500, 500, 201]);
    expect(matches).toHaveLength(1201);
    expect(matches.map((match) => match.importedId)).toEqual(refs.map((ref) => ref.id));
  });

  it("shows a search its refusal at once", async () => {
    const fetchMock = vi.fn().mockResolvedValue(busy());
    vi.stubGlobal("fetch", fetchMock);
    const { queryRecipeDatasetRecipes } = await loader();

    await expect(
      queryRecipeDatasetRecipes("manifest", version, {
        query: "zz",
        mode: "recipes",
        maxTier: "all",
        offset: 0,
        limit: 48,
      }),
    ).rejects.toThrow("Too many requests. Wait a moment and try again.");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("gives up after six refusals, and stops when the caller gives up", async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(busy()));
    vi.stubGlobal("fetch", fetchMock);
    const { getRecipeDatasetRecipe } = await loader();

    const promise = getRecipeDatasetRecipe("manifest", version, "r2");
    promise.catch(() => {});
    for (let retry = 0; retry < 6; retry += 1) {
      await vi.advanceTimersByTimeAsync(1000);
    }
    await expect(promise).rejects.toThrow("Too many requests. Wait a moment and try again.");
    expect(fetchMock).toHaveBeenCalledTimes(7);

    const controller = new AbortController();
    const aborted = getRecipeDatasetRecipe("manifest", version, "r3", {
      signal: controller.signal,
    });
    aborted.catch(() => {});
    await vi.advanceTimersByTimeAsync(10);
    controller.abort();
    await expect(aborted).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchMock).toHaveBeenCalledTimes(8);
  });
});

describe("the cache key of every dataset request", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal("window", { location: { origin: "http://localhost" } });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("carries the dataset hash and the answer version, so a deploy never reads an old answer", async () => {
    const { DATASET_ANSWER_VERSION } = await import("./answer-version");
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        urls.push(url);
        return Promise.resolve(json(200, { recipeIds: [], crops: [], mobs: [], resources: [] }));
      }),
    );
    const api = await loader();
    await api.initRecipeDatasetVersion("manifest", version);
    await api.getRecipeDatasetRecipe("manifest", version, "r1");
    await api.getRecipeDatasetRecipeIds("manifest", version);
    await api.resolveRecipeDatasetRecipes("manifest", version, []);
    await api.queryRecipeDatasetRecipes("manifest", version, {
      query: "steel",
      mode: "recipes",
      maxTier: "all",
      offset: 0,
      limit: 48,
    });
    await api.listRecipeDatasetCrops("manifest", version);
    await api.listRecipeDatasetMobs("manifest", version);
    await api.queryRecipeDatasetResources("manifest", version, {
      query: "steel",
      offset: 0,
      limit: 120,
    });

    // Eight answers, and the listing of the static copies once: one with no
    // files is kept for a while rather than asked before every answer.
    expect(urls.filter((url) => !url.includes("/client-files"))).toHaveLength(8);
    expect(urls.filter((url) => url.includes("/client-files"))).toHaveLength(1);
    for (const url of urls) {
      const params = new URL(url).searchParams;
      expect(params.get("datasetHash"), url).toBe("abc");
      expect(params.get("appVersion"), url).toBe(DATASET_ANSWER_VERSION);
    }
  });
});

describe("the static copies of the answers every player shares", () => {
  const files = {
    catalog: "/datasets/gtnh/local-2.9.0-rc-2/client/catalog.0123456789abcdef0123.json",
    crops: "/datasets/gtnh/local-2.9.0-rc-2/client/crops.0123456789abcdef0123.json",
    "recipe-ids": "/datasets/gtnh/local-2.9.0-rc-2/client/recipe-ids.0123456789abcdef0123.json",
  };

  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal("window", { location: { origin: "http://localhost" } });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function serve(routes: (path: string) => Response) {
    const paths: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        const path = new URL(url).pathname;
        paths.push(path);
        return Promise.resolve(routes(path));
      }),
    );
    return paths;
  }

  it("fetches a listed file instead of the API, and keeps a complete listing", async () => {
    const paths = serve((path) =>
      path.endsWith("/client-files")
        ? json(200, { complete: true, files })
        : path === files.catalog
          ? json(200, { schemaVersion: 1 })
          : path === files["recipe-ids"]
            ? json(200, { recipeIds: ["r1"] })
            : json(500, { error: "API asked" }),
    );
    const api = await loader();
    await expect(api.initRecipeDatasetVersion("manifest", version)).resolves.toEqual({
      schemaVersion: 1,
    });
    await expect(api.getRecipeDatasetRecipeIds("manifest", version)).resolves.toEqual(["r1"]);
    expect(paths).toEqual([
      "/api/datasets/local-2.9.0-rc-2/client-files",
      files.catalog,
      files["recipe-ids"],
    ]);
  });

  it("asks the API for a kind not listed, a file that fails, or no listing at all", async () => {
    const paths = serve((path) =>
      path.endsWith("/client-files")
        ? json(200, { complete: false, files: { crops: files.crops } })
        : path === files.crops
          ? json(404, { error: "Dataset file not found." })
          : json(200, { mobs: [], crops: [] }),
    );
    const api = await loader();
    await expect(api.listRecipeDatasetCrops("manifest", version)).resolves.toEqual({
      mobs: [],
      crops: [],
    });
    await api.listRecipeDatasetMobs("manifest", version);
    expect(paths).toEqual([
      "/api/datasets/local-2.9.0-rc-2/client-files",
      files.crops,
      "/api/datasets/local-2.9.0-rc-2/crops",
      // An incomplete listing is kept for a while, then asked again.
      "/api/datasets/local-2.9.0-rc-2/mobs",
    ]);
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 46_000);
    await api.listRecipeDatasetMobs("manifest", version);
    vi.mocked(Date.now).mockRestore();
    expect(paths.slice(4)).toEqual([
      "/api/datasets/local-2.9.0-rc-2/client-files",
      "/api/datasets/local-2.9.0-rc-2/mobs",
    ]);

    vi.resetModules();
    const failing = serve((path) =>
      path.endsWith("/client-files") ? json(500, { error: "down" }) : json(200, { mobs: [] }),
    );
    await (await loader()).listRecipeDatasetMobs("manifest", version);
    expect(failing).toEqual([
      "/api/datasets/local-2.9.0-rc-2/client-files",
      "/api/datasets/local-2.9.0-rc-2/mobs",
    ]);
  });
});

describe("item queries before the browser's search is ready", () => {
  class IdleWorker {
    static count = 0;
    onmessage = null;
    onerror = null;
    constructor() {
      IdleWorker.count += 1;
    }
    postMessage() {}
    terminate() {}
  }

  beforeEach(() => {
    vi.resetModules();
    IdleWorker.count = 0;
    vi.stubGlobal("window", { location: { origin: "http://localhost" } });
    vi.stubGlobal("Worker", IdleWorker);
    vi.stubGlobal("navigator", { deviceMemory: 8 });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("each go to the API, with at most one listing while the server lacks the items file", async () => {
    const paths: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        const path = new URL(url).pathname;
        paths.push(path);
        return Promise.resolve(
          path.endsWith("/client-files")
            ? json(200, { complete: false, files: {} })
            : json(200, { resources: [], total: 0 }),
        );
      }),
    );
    const api = await loader();
    for (let query = 0; query < 10; query += 1) {
      await api.queryRecipeDatasetResources("manifest", version, {
        query: "steel".slice(0, (query % 5) + 1),
        offset: 0,
        limit: 120,
      });
    }
    expect(paths.filter((path) => path.endsWith("/resources"))).toHaveLength(10);
    expect(paths.filter((path) => path.endsWith("/client-files"))).toHaveLength(1);
    expect(IdleWorker.count).toBe(0);
  });

  it("start the worker on the first typed query once the file is listed, never on opening a plan", async () => {
    const items = "/datasets/gtnh/local-2.9.0-rc-2/client/items.0123456789abcdef0123.json";
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) =>
        Promise.resolve(
          new URL(url).pathname.endsWith("/client-files")
            ? json(200, { complete: true, files: { items } })
            : json(200, { schemaVersion: 1, resources: [], total: 0 }),
        ),
      ),
    );
    const api = await loader();
    await api.initRecipeDatasetVersion("manifest", version);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(IdleWorker.count).toBe(0);
    // The untyped list an item pane shows on opening starts nothing either.
    await api.queryRecipeDatasetResources("manifest", version, { query: "", offset: 0, limit: 24 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(IdleWorker.count).toBe(0);
    await api.queryRecipeDatasetResources("manifest", version, {
      query: "st",
      offset: 0,
      limit: 24,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(IdleWorker.count).toBe(1);
  });
});
