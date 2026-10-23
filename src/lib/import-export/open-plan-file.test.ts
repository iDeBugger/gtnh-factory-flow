import { describe, expect, it, vi } from "vitest";
import type { DatasetManifest, DatasetVersion, RecipeDataset } from "@/lib/datasets";
import { DatasetCache } from "@/lib/datasets/dataset-cache";
import { PROJECT_SCHEMA_VERSION, type FactoryProject, type Recipe } from "@/lib/model/types";
import { replaceDatasetCacheForTests, useFactoryStore } from "@/store/factory-store";
import { useDesignStore } from "@/store/design-store";
import { looksLikePlanJson, openPlanJsonText } from "./open-plan-file";

/** Which dataset each recipe call asked, as `<version>|<what>`. */
const asked = vi.hoisted(() => [] as string[]);
vi.mock("@/lib/datasets/browser-loader", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/datasets/browser-loader")>()),
  getRecipeDatasetRecipeIds: async (_url: string, version: DatasetVersion) => {
    asked.push(`${version.id}|ids`);
    return ["shared"];
  },
  getRecipeDatasetRecipe: async (_url: string, version: DatasetVersion, id: string): Promise<Recipe> => {
    asked.push(`${version.id}|${id}`);
    return { ...recipe(id), durationTicks: version.id === "local-2.8.1" ? 80 : 400, source: { datasetVersionId: version.id } };
  },
  resolveRecipeDatasetRecipes: async () => ({ matches: [] }),
}));

function recipe(id: string): Recipe {
  return {
    id,
    name: id,
    machineType: "Electric Blast Furnace",
    minimumTier: "MV",
    durationTicks: 1,
    eut: 120,
    inputs: [],
    outputs: [{ kind: "item", id: "silicon", amount: 1 }],
  };
}

describe("open-plan-file", () => {
  it("tells a plan file's JSON from a link or a code", () => {
    expect(looksLikePlanJson('{"schemaVersion":1}')).toBe(true);
    expect(looksLikePlanJson('  \n {"name":"x"}')).toBe(true);
    expect(looksLikePlanJson("gtnh1.abc")).toBe(false);
    expect(looksLikePlanJson("https://gtnhplanner.com/#p=gtnh1.abc")).toBe(false);
  });

  it("an imported 2.8.1 file hydrates against 2.8.1 while 2.9 is open", async () => {
    const manifest = {
      schemaVersion: 1,
      latestStableVersion: "local-2.9.0-rc-2",
      versions: [
        { id: "local-2.9.0-rc-2", gtnhVersion: "2.9.0-RC-2", publishedAt: "2026-10-23T00:00:00.000Z" },
        { id: "local-2.8.1", gtnhVersion: "2.8.1", publishedAt: "2026-10-23T00:00:00.000Z" },
      ],
    } as unknown as DatasetManifest;
    const catalog = (version: DatasetVersion) =>
      ({ datasetVersionId: version.id, gtnhVersion: version.gtnhVersion, resources: [], recipes: [] }) as unknown as RecipeDataset;
    replaceDatasetCacheForTests(new DatasetCache(async (_url, version) => catalog(version)));
    const store = useFactoryStore.getState();
    store.setDatasetManifest(manifest, "/m.json");
    await store.ensureDatasetFor("2.9");
    const open = useFactoryStore.getState().project;
    const imported: FactoryProject[] = [];
    useDesignStore.setState({
      importProjectAsDesign: async (project: FactoryProject) => {
        imported.push(project);
      },
    } as never);

    const file: FactoryProject = {
      schemaVersion: PROJECT_SCHEMA_VERSION,
      id: "file-281",
      name: "Silicon on 2.8.1",
      gameVersion: "2.8.1",
      fuelProfiles: [],
      recipes: [recipe("shared")],
      nodes: [{ id: "n1", recipeId: "shared", position: { x: 0, y: 0 }, machineCount: 1, parallel: 1, overclockTier: "MV", enabled: true }],
      edges: [],
    };
    asked.length = 0;
    await openPlanJsonText(JSON.stringify(file));

    expect(asked).toEqual(["local-2.8.1|ids", "local-2.8.1|shared"]);
    expect(imported).toHaveLength(1);
    expect(imported[0]?.gameVersion).toBe("2.8.1");
    expect(imported[0]?.recipes[0]?.durationTicks).toBe(80);
    // The open 2.9 plan and the active dataset are untouched; 2.8.1 waits in the cache.
    expect(useFactoryStore.getState().project).toBe(open);
    expect(useFactoryStore.getState().dataset?.datasetVersionId).toBe("local-2.9.0-rc-2");
  });

  it("a file on a version this site does not serve opens as it was written", async () => {
    const imported: FactoryProject[] = [];
    useDesignStore.setState({
      importProjectAsDesign: async (project: FactoryProject) => {
        imported.push(project);
      },
    } as never);
    asked.length = 0;
    await openPlanJsonText(
      JSON.stringify({
        schemaVersion: PROJECT_SCHEMA_VERSION,
        id: "file-210",
        name: "From 2.10",
        gameVersion: "2.10",
        fuelProfiles: [],
        recipes: [recipe("shared")],
        nodes: [],
        edges: [],
      }),
    );
    expect(asked).toEqual([]);
    expect(imported[0]?.recipes[0]?.durationTicks).toBe(1);
  });
});
