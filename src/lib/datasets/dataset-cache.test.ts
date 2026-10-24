import { describe, expect, it, vi } from "vitest";
import { DatasetCache, datasetServesPlan, refusesRecipeOnPlan } from "./dataset-cache";
import type { DatasetManifest, DatasetVersion, RecipeDataset } from "./types";

const version = (id: string) => ({ id }) as DatasetVersion;
const dataset = (id: string, gtnhVersion: string) =>
  ({ datasetVersionId: id, gtnhVersion }) as RecipeDataset;

describe("datasetServesPlan", () => {
  it("serves a plan only on its own game version", () => {
    const rc2 = { gtnhVersion: "2.9.0-RC-2" };
    const v281 = { gtnhVersion: "2.8.1" };
    // No version field reads as 2.9.
    expect(datasetServesPlan(rc2, {})).toBe(true);
    expect(datasetServesPlan(rc2, { gameVersion: "2.9" })).toBe(true);
    expect(datasetServesPlan(rc2, { gameVersion: "2.8.1" })).toBe(false);
    expect(datasetServesPlan(v281, { gameVersion: "2.8.1" })).toBe(true);
    expect(datasetServesPlan(v281, {})).toBe(false);
    expect(datasetServesPlan(rc2, { gameVersion: "2.10" })).toBe(false);
    expect(datasetServesPlan(undefined, {})).toBe(false);
  });
});

describe("refusesRecipeOnPlan", () => {
  const manifest = {
    schemaVersion: 1,
    versions: [
      { id: "gtnh-2.9.0", gtnhVersion: "2.9.0" },
      { id: "gtnh-2.8.1", gtnhVersion: "2.8.1" },
      { id: "local-2.8.4", gtnhVersion: "2.8.4" },
    ],
  } as DatasetManifest;
  const from = (datasetVersionId: string) => ({ source: { datasetVersionId } }) as Parameters<typeof refusesRecipeOnPlan>[1];

  it("reads a hidden dataset's body as unlisted, whatever the manifest says", () => {
    const on29 = { datasetManifest: manifest, selectedDatasetVersionId: "gtnh-2.9.0", project: {} };
    expect(refusesRecipeOnPlan(on29, from("local-2.8.4"))).toBe(false);
    expect(refusesRecipeOnPlan(on29, from("gtnh-2.8.1"))).toBe(true);
    // Unlisted lands only while the selected version serves the plan.
    const waiting = { ...on29, selectedDatasetVersionId: "gtnh-2.8.1" };
    expect(refusesRecipeOnPlan(waiting, from("local-2.8.4"))).toBe(true);
  });
});

describe("DatasetCache", () => {
  it("loads each version once, shares a load in flight and keeps every dataset", async () => {
    const loader = vi.fn(async (_url: string, v: DatasetVersion) =>
      dataset(v.id, v.id === "a" ? "2.9.0" : "2.8.1"),
    );
    const cache = new DatasetCache(loader);
    const first = cache.load("/m.json", version("a"));
    const second = cache.load("/m.json", version("a"));
    expect(cache.isLoading("a")).toBe(true);
    expect(cache.get("a")).toBeUndefined();
    const [one, two] = await Promise.all([first, second]);
    expect(one).toBe(two);
    expect(loader).toHaveBeenCalledTimes(1);
    expect(cache.isLoading("a")).toBe(false);

    await cache.load("/m.json", version("b"));
    expect(cache.get("a")).toBe(one);
    expect(cache.get("b")?.gtnhVersion).toBe("2.8.1");
    await cache.load("/m.json", version("a"));
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it("forgets a failed load so the next ask tries again", async () => {
    const loader = vi
      .fn<(url: string, v: DatasetVersion) => Promise<RecipeDataset>>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(dataset("a", "2.9.0"));
    const cache = new DatasetCache(loader);
    await expect(cache.load("/m.json", version("a"))).rejects.toThrow("offline");
    expect(cache.isLoading("a")).toBe(false);
    expect((await cache.load("/m.json", version("a"))).datasetVersionId).toBe("a");
  });
});
