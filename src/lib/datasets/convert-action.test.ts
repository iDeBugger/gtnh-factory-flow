// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { DesignRecord, DesignSummary } from "@/lib/designs/design-library";
import { PROJECT_SCHEMA_VERSION, type FactoryProject, type Recipe } from "@/lib/model/types";
import type { DatasetManifest, DatasetVersion, RecipeDataset } from "./types";

/** The design library as the browser keeps it: each record as the bytes written. */
const stored = vi.hoisted(() => new Map<string, string>());
vi.mock("@/lib/designs/design-storage", async () => {
  const { toDesignSummary } = await vi.importActual<typeof import("@/lib/designs/design-library")>(
    "@/lib/designs/design-library",
  );
  const read = (id: string) => {
    const json = stored.get(id);
    return json ? (JSON.parse(json) as DesignRecord) : undefined;
  };
  return {
    ACTIVE_DESIGN_STORAGE_KEY: "active",
    isDesignStorageAvailable: () => true,
    listDesignSummaries: async () => [...stored.keys()].map((id) => toDesignSummary(read(id)!)),
    listDesignFolders: async () => [],
    readDesign: async (id: string) => read(id),
    readDesignSummary: async (id: string) => {
      const record = read(id);
      return record ? toDesignSummary(record) : undefined;
    },
    writeDesign: async (record: DesignRecord) => {
      stored.set(record.id, JSON.stringify(record));
    },
    writeDesignIfUnchanged: async (record: DesignRecord) => {
      stored.set(record.id, JSON.stringify(record));
      return "written";
    },
    writeDesignSummary: async (_summary: DesignSummary) => undefined,
    writeDesignFolder: async () => undefined,
    deleteDesign: async (id: string) => {
      stored.delete(id);
    },
    deleteDesignFolder: async () => undefined,
    readActiveDesignId: () => undefined,
    writeActiveDesignId: () => undefined,
  };
});

/** Each served dataset's bodies by id, as the recipe API answers them. */
const bodies = vi.hoisted(() => new Map<string, Map<string, unknown>>());
vi.mock("./browser-loader", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./browser-loader")>()),
  getRecipeDatasetRecipe: async (_url: string, version: { id: string }, id: string) => {
    const found = bodies.get(version.id)?.get(id);
    if (!found) throw new Error(`404 ${id}`);
    return structuredClone(found);
  },
  resolveRecipeDatasetRecipes: async () => ({ matches: [] }),
}));

import { useDesignStore } from "@/store/design-store";
import { replaceDatasetCacheForTests, useFactoryStore } from "@/store/factory-store";
import { DatasetCache } from "./dataset-cache";
import { renderHook } from "@testing-library/react";
import { convertOpenPlan, convertTargets, usePendingConversion, type PendingConversion } from "./convert-action";

const version29 = { id: "local-2.9.0-rc-2", gtnhVersion: "2.9.0-RC-2", publishedAt: "2026-10-01T00:00:00Z" } as DatasetVersion;
const version281 = { id: "local-2.8.1", gtnhVersion: "2.8.1", publishedAt: "2026-10-01T00:00:00Z" } as DatasetVersion;
const manifest = { schemaVersion: 1, latestStableVersion: version29.id, versions: [version29, version281] } as DatasetManifest;

function recipe(id: string, datasetVersionId: string, ticks: number): Recipe {
  return {
    id,
    name: "Macerator: Silicon Dust",
    kind: "gregtech_machine",
    machineType: "Macerator",
    minimumTier: "LV",
    durationTicks: ticks,
    eut: 2,
    inputs: [{ kind: "item", id: "gregtech:ore:silicon", amount: 1 }],
    outputs: [{ kind: "item", id: "gregtech:dust:silicon", amount: 2 }],
    source: { datasetVersionId, recipeMap: "Macerator" },
  };
}

const sameId = "oracle:gregtech:gt-recipe-macerator:1";
const changedId = "oracle:gregtech:gt-recipe-macerator:2";

function plan281(recipes: Recipe[]): FactoryProject {
  return {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    gameVersion: "2.8.1",
    id: "plan-1",
    name: "Silicon",
    recipes,
    nodes: recipes.map((entry, index) => ({
      id: `n${index}`,
      recipeId: entry.id,
      machineCount: 1,
      parallel: 1,
      overclockTier: "LV",
      enabled: true,
      position: { x: index * 300, y: 0 },
    })),
    edges: [],
    fuelProfiles: [],
  };
}

const loader = vi.fn(async (_url: string, version: DatasetVersion) =>
  ({ datasetVersionId: version.id, gtnhVersion: version.gtnhVersion, recipes: [], resources: [] }) as unknown as RecipeDataset,
);

beforeEach(() => {
  stored.clear();
  bodies.clear();
  bodies.set(version29.id, new Map([[sameId, recipe(sameId, version29.id, 100)]]));
  loader.mockClear();
  replaceDatasetCacheForTests(new DatasetCache(loader));
  useFactoryStore.setState({ datasetManifest: manifest, datasetManifestUrl: "/manifest.json" });
  useDesignStore.setState({ designs: [], folders: [], activeDesignId: undefined, publicViews: [], publicView: undefined });
});
afterEach(() => vi.restoreAllMocks());

async function openOriginal(project: FactoryProject): Promise<{ id: string; bytes: string }> {
  await useDesignStore.getState().importProjectAsDesign(project, project.name);
  const id = useDesignStore.getState().activeDesignId!;
  return { id, bytes: stored.get(id)! };
}

describe("convertOpenPlan", () => {
  test("opens a new design for the target version, never calls setProject, and leaves the original record as it was", async () => {
    const original = await openOriginal(plan281([recipe(sameId, version281.id, 100), recipe(changedId, version281.id, 80)]));
    const setProject = vi.spyOn(useFactoryStore.getState(), "setProject");
    useFactoryStore.setState({ setProject });

    expect(await convertOpenPlan("2.9")).toBe(true);

    expect(setProject).not.toHaveBeenCalled();
    const { activeDesignId, designs } = useDesignStore.getState();
    expect(activeDesignId).not.toBe(original.id);
    expect(designs.map((design) => design.id).sort()).toEqual([original.id, activeDesignId].sort());
    expect(stored.get(original.id)).toBe(original.bytes);
    // The 2.9 dataset was loaded for it.
    expect(loader).toHaveBeenCalledWith("/manifest.json", version29);

    const converted = useFactoryStore.getState().project;
    expect(converted.gameVersion).toBe("2.9");
    expect(converted.name).toBe("Silicon");
    expect(converted.recipes.map((entry) => entry.source?.datasetVersionId)).toEqual([version29.id]);
    expect(converted.nodes.map((node) => Boolean(node.unconverted))).toEqual([false, true]);
  });

  test("a plan whose every recipe matches opens with no marked card", async () => {
    await openOriginal(plan281([recipe(sameId, version281.id, 100)]));
    await convertOpenPlan("2.9");
    const converted = useFactoryStore.getState().project;
    expect(converted.gameVersion).toBe("2.9");
    expect(converted.nodes.some((node) => node.unconverted)).toBe(false);
  });

  test("a failed match leaves the open plan and the library as they were", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const original = await openOriginal(plan281([recipe(changedId, version281.id, 80)]));
    loader.mockRejectedValueOnce(new Error("offline"));
    expect(await convertOpenPlan("2.9")).toBe(false);
    expect(useDesignStore.getState().activeDesignId).toBe(original.id);
    expect(useDesignStore.getState().designs).toHaveLength(1);
    expect(stored.get(original.id)).toBe(original.bytes);
  });

  test("one conversion at a time: a second press while one runs opens nothing, and the pending one names its source", async () => {
    const original = await openOriginal(plan281([recipe(sameId, version281.id, 100)]));
    let release: () => void = () => undefined;
    loader.mockImplementationOnce(
      (_url, version) =>
        new Promise((resolve) => {
          release = () => resolve({ datasetVersionId: version.id, gtnhVersion: version.gtnhVersion } as unknown as RecipeDataset);
        }),
    );
    const seen: Array<PendingConversion | undefined> = [];
    const { result } = renderHook(() => usePendingConversion());
    const first = convertOpenPlan("2.9");
    await vi.waitFor(() => expect(result.current).toEqual({ target: "2.9", sourceDesignId: original.id }));
    seen.push(result.current);
    expect(await convertOpenPlan("2.9")).toBe(false);
    release();
    expect(await first).toBe(true);
    await vi.waitFor(() => expect(result.current).toBeUndefined());
    expect(useDesignStore.getState().designs).toHaveLength(2);
    expect(seen).toHaveLength(1);
  });

  test("nothing opens for the plan's own version or one this site does not serve", async () => {
    await openOriginal(plan281([recipe(sameId, version281.id, 100)]));
    expect(await convertOpenPlan("2.8.1")).toBe(false);
    expect(await convertOpenPlan("2.10")).toBe(false);
    expect(useDesignStore.getState().designs).toHaveLength(1);
  });
});

describe("convertTargets", () => {
  test("every served version but the plan's own", () => {
    expect(convertTargets(manifest, "2.8.1")).toEqual(["2.9"]);
    expect(convertTargets(manifest, "2.9")).toEqual(["2.8.1"]);
    expect(convertTargets(manifest, "2.8.4")).toEqual(["2.9", "2.8.1"]);
    expect(convertTargets({ ...manifest, versions: [version29] }, "2.9")).toEqual([]);
    expect(convertTargets(undefined, "2.8.1")).toEqual([]);
  });
});
