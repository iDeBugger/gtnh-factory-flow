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
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(busy())
      .mockResolvedValueOnce(json(200, { recipeIds: ["a"] }))
      .mockResolvedValueOnce(busy())
      .mockResolvedValueOnce(json(200, { matches: [] }));
    vi.stubGlobal("fetch", fetchMock);
    const { getRecipeDatasetRecipeIds, resolveRecipeDatasetRecipes } = await loader();

    const ids = getRecipeDatasetRecipeIds("manifest", version);
    await vi.advanceTimersByTimeAsync(1000);
    await expect(ids).resolves.toEqual(["a"]);
    const matches = resolveRecipeDatasetRecipes("manifest", version, []);
    await vi.advanceTimersByTimeAsync(1000);
    await expect(matches).resolves.toEqual({ matches: [] });
    expect(fetchMock).toHaveBeenCalledTimes(4);
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
