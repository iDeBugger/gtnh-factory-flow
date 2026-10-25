import { describe, expect, it } from "vitest";
import { loadBiodieselDemoProject } from "@/examples";
import { parseDatasetManifestJson, parseRecipeDatasetJson } from "./dataset-json";
import { parseFactoryProjectJson, serializeFactoryProject } from "./factory-json";

describe("factory JSON import/export", () => {
  it("round-trips the biodiesel demo through the public schema", () => {
    const project = loadBiodieselDemoProject();
    const json = serializeFactoryProject(project);
    const parsed = parseFactoryProjectJson(json);

    expect(parsed.name).toBe(project.name);
    expect(parsed.recipes).toHaveLength(7);
    expect(parsed.nodes).toHaveLength(7);
    expect(parsed.metadata?.isDemo).toBe(true);
  });

  it("keeps the plan's game version, and adds none to a plan saved without one", () => {
    const project = loadBiodieselDemoProject();
    expect(parseFactoryProjectJson(serializeFactoryProject({ ...project, gameVersion: "2.8.1" })).gameVersion).toBe(
      "2.8.1",
    );
    // A version this site does not know is kept as written, not dropped or remapped.
    const later = serializeFactoryProject({ ...project, gameVersion: "2.10" });
    expect(JSON.parse(later).gameVersion).toBe("2.10");
    expect(parseFactoryProjectJson(later).gameVersion).toBe("2.10");
    const { gameVersion, ...old } = project;
    void gameVersion;
    const parsed = parseFactoryProjectJson(JSON.stringify(old));
    expect("gameVersion" in parsed).toBe(false);
    expect("gameVersion" in JSON.parse(serializeFactoryProject(parsed))).toBe(false);
  });

  it("opens a plan file whose game version is blank as one with none", () => {
    const project = loadBiodieselDemoProject();
    for (const blank of ["", "   "]) {
      const parsed = parseFactoryProjectJson(JSON.stringify({ ...project, gameVersion: blank }));
      expect(parsed.gameVersion).toBeUndefined();
      expect("gameVersion" in JSON.parse(serializeFactoryProject(parsed))).toBe(false);
    }
    expect(parseFactoryProjectJson(JSON.stringify({ ...project, gameVersion: " 2.8.1 " })).gameVersion).toBe("2.8.1");
  });

  it("drops icons that are not the site's own art", () => {
    const evil = "https://evil.example";
    const plan = JSON.parse(serializeFactoryProject(loadBiodieselDemoProject()));
    const kept = "/datasets/gtnh/local-2.9.0-rc-2/textures/rendered/x-0123456789ab.png";
    plan.recipes[0].outputs[0].iconPath = "http://127.0.0.1:3177/i.png";
    plan.recipes[0].outputs.push({ kind: "item", id: "kept", amount: 1, iconPath: kept });
    plan.recipes[1].inputs[0].iconAtlas = {
      imagePath: `${evil}/a.png`,
      atlasWidth: 1,
      atlasHeight: 1,
      x: 0,
      y: 0,
      width: 1,
      height: 1,
    };
    plan.recipes[0].nei = { iconPath: `${evil}/m.png`, backgroundImage: `${evil}/b.png` };
    plan.storages[0].iconPath = `${evil}/s.png`;
    plan.icon = { kind: "item", resourceId: "fish", iconPath: `${evil}/p.png` };

    const parsed = parseFactoryProjectJson(JSON.stringify(plan));
    expect(parsed.recipes[0]!.outputs[0]!.iconPath).toBeUndefined();
    expect(parsed.recipes[0]!.outputs[1]!.iconPath).toBe(kept);
    expect(parsed.recipes[1]!.inputs[0]!.iconAtlas).toBeUndefined();
    expect(parsed.recipes[0]!.nei?.iconPath).toBeUndefined();
    expect(parsed.recipes[0]!.nei?.backgroundImage).toBeUndefined();
    expect(parsed.storages![0]!.iconPath).toBeUndefined();
    expect(parsed.icon?.iconPath).toBeUndefined();
    expect(parsed.icon?.resourceId).toBe("fish");
    expect(serializeFactoryProject(plan)).not.toContain("evil.example");
    expect(serializeFactoryProject(plan)).not.toContain("127.0.0.1");
  });

  it("reports invalid JSON and invalid factory data", () => {
    expect(() => parseFactoryProjectJson("{")).toThrow(/Invalid JSON/);
    expect(() =>
      parseFactoryProjectJson(
        JSON.stringify({
          schemaVersion: 1,
          id: "bad",
          name: "",
          recipes: [],
          nodes: [],
          edges: [],
          fuelProfiles: [],
        }),
      ),
    ).toThrow(/Invalid factory project/);
  });

  it("accepts recipes with zero outputs (unpicked crop-farm placeholder)", () => {
    const project = parseFactoryProjectJson(
      JSON.stringify({
        schemaVersion: 1,
        id: "crop-placeholder",
        name: "Crop placeholder plan",
        recipes: [
          {
            id: "factoryflow:crop-farm:empty",
            name: "Crop Farm",
            machineType: "Crop Farm",
            minimumTier: "ULV",
            durationTicks: 256,
            eut: 0,
            inputs: [],
            outputs: [],
          },
        ],
        nodes: [
          {
            id: "node-crop",
            recipeId: "factoryflow:crop-farm:empty",
            machineCount: 1,
            parallel: 1,
            overclockTier: "ULV",
            enabled: true,
            position: { x: 0, y: 0 },
          },
        ],
        edges: [],
        fuelProfiles: [],
      }),
    );

    expect(project.recipes[0]?.outputs).toEqual([]);
  });

  it("normalizes hidden fractional recipe parallelism to one operation", () => {
    const project = parseFactoryProjectJson(
      JSON.stringify({
        schemaVersion: 1,
        id: "fractional-parallel",
        name: "Fractional parallel",
        recipes: [],
        nodes: [
          {
            id: "node-1",
            recipeId: "recipe-1",
            machineCount: 1,
            parallel: 0.01,
            overclockTier: "HV",
            enabled: true,
            position: { x: 0, y: 0 },
          },
        ],
        edges: [],
        fuelProfiles: [],
      }),
    );

    expect(project.nodes[0]?.parallel).toBe(1);
  });

  it("accepts zero output machine config tiers for disabled production states", () => {
    const project = parseFactoryProjectJson(
      JSON.stringify({
        schemaVersion: 1,
        id: "zero-output-control",
        name: "Zero output control",
        recipes: [
          {
            id: "bee-recipe",
            name: "Bee Produce: Test Bee",
            machineType: "Apiary",
            minimumTier: "NONE",
            durationTicks: 550,
            eut: 0,
            inputs: [{ kind: "item", id: "factoryflow:bee_species:test", amount: 1 }],
            outputs: [{ kind: "item", id: "test:comb", amount: 1 }],
            machineConfigControls: [
              {
                id: "beeEnvironment",
                label: "Climate",
                minimumKey: "wrong",
                defaultKey: "preferred",
                tiers: [
                  {
                    key: "wrong",
                    label: "Wrong",
                    outputMultiplier: 0,
                    resource: {
                      kind: "item",
                      id: "factoryflow:bee_environment_wrong",
                      amount: 1,
                    },
                  },
                ],
              },
            ],
          },
        ],
        nodes: [],
        edges: [],
        fuelProfiles: [],
      }),
    );

    expect(project.recipes[0]?.machineConfigControls?.[0]?.tiers[0]?.outputMultiplier).toBe(0);
  });

  it("validates normalized recipe datasets", () => {
    const dataset = parseRecipeDatasetJson(
      JSON.stringify({
        schemaVersion: 1,
        datasetVersionId: "gtnh-test",
        gtnhVersion: "test",
        sourceInfo: {
          sourceId: "nesql",
          generatedAt: "2026-05-19T00:00:00.000Z",
        },
        resources: [
          {
            id: "item:gregtech:test",
            kind: "item",
            displayName: "Test Dust",
          },
        ],
        recipes: [
          {
            id: "recipe-test",
            name: "Test Dust",
            machineType: "Macerator",
            minimumTier: "LV",
            durationTicks: 200,
            eut: 30,
            inputs: [{ kind: "item", id: "ore:test", amount: 1 }],
            outputs: [{ kind: "item", id: "item:gregtech:test", amount: 2 }],
            source: {
              datasetVersionId: "gtnh-test",
              recipeMap: "macerator",
              exporter: "nesql",
            },
          },
        ],
        oreDictionary: {},
        recipeMaps: ["macerator"],
        generatedAt: "2026-05-19T00:00:00.000Z",
      }),
    );

    expect(dataset.sourceInfo.sourceId).toBe("nesql");
    expect(dataset.recipes[0]?.source?.recipeMap).toBe("macerator");
  });

  it("validates dataset manifests with version metadata", () => {
    const manifest = parseDatasetManifestJson(
      JSON.stringify({
        schemaVersion: 1,
        latestStableVersion: "gtnh-2.7.4",
        versions: [
          {
            id: "gtnh-2.7.4",
            gtnhVersion: "2.7.4",
            channel: "stable",
            publishedAt: "2026-05-19T00:00:00.000Z",
            manifestPath: "/datasets/gtnh/datasets.manifest.json",
            recipeDatasetPath: "/datasets/gtnh/2.7.4/recipes.json",
            sourceInfo: {
              sourceId: "nesql",
              generatedAt: "2026-05-19T00:00:00.000Z",
            },
          },
        ],
      }),
    );

    expect(manifest.latestStableVersion).toBe("gtnh-2.7.4");
    expect(manifest.versions[0]?.recipeDatasetPath).toBe("/datasets/gtnh/2.7.4/recipes.json");
  });
});
