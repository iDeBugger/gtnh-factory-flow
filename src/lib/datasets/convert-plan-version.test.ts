import { describe, expect, test, vi } from "vitest";
import { PROJECT_SCHEMA_VERSION, type FactoryEdge, type FactoryNode, type FactoryProject, type Recipe } from "@/lib/model/types";
import { pickRecipeRefMatch } from "@/lib/import-export/recipe-ref-match";
import { parseFactoryProjectJson, serializeFactoryProject } from "@/lib/import-export";
import { createCustomRatePlaceholderRecipe } from "@/lib/model/custom-rate";
import { createCropFarmPlaceholderRecipe } from "@/lib/model/passive-production";
import { buildPowerRecipe } from "@/lib/power/power-recipe";
import { getSelectedMachineHandler } from "@/lib/model/recipe-rules";
import type { DatasetVersion } from "./types";
import { convertProjectToVersion, matchRecipesToVersion } from "./convert-plan-version";

/** Each served dataset's bodies by id. */
const datasets = vi.hoisted(() => new Map<string, Map<string, unknown>>());
/** Body fetches that fail the way a dropped network does. */
const failing = vi.hoisted(() => new Set<string>());
/** The loader as the server answers it: bodies by id, and content matches scored the way `resolveDatasetRecipeRefs` scores them. */
vi.mock("./browser-loader", () => ({
  // The crop picker's list: the dataset's Crop Farm map.
  listRecipeDatasetCrops: async (_manifestUrl: string, version: { id: string }) => ({
    crops: ([...(datasets.get(version.id)?.values() ?? [])] as Recipe[])
      .filter((recipe) => recipe.source?.recipeMap === "Crop Farm")
      .map((recipe) => ({ ...recipe, recipeMap: "Crop Farm" })),
  }),
  getRecipeDatasetRecipe: async (_manifestUrl: string, version: { id: string }, id: string) => {
    if (failing.has(id)) throw new Error("Failed to fetch");
    const found = datasets.get(version.id)?.get(id);
    if (!found) throw new Error(`404 ${id}`);
    return structuredClone(found);
  },
  resolveRecipeDatasetRecipes: async (
    _manifestUrl: string,
    version: { id: string },
    refs: Parameters<typeof pickRecipeRefMatch>[0][],
  ) => ({
    matches: refs.flatMap((ref) => {
      const candidates = [...(datasets.get(version.id)?.values() ?? [])] as Recipe[];
      const match = pickRecipeRefMatch(
        ref,
        candidates.filter((candidate) => candidate.source?.recipeMap === ref.recipeMap),
      );
      return match && match.score >= 300
        ? [{ importedId: ref.id, recipeId: match.candidate.id, exact: match.exact }]
        : [];
    }),
  }),
}));

const version29 = { id: "local-2.9.0-rc-2", gtnhVersion: "2.9.0-RC-2" } as DatasetVersion;
const version281 = { id: "local-2.8.1", gtnhVersion: "2.8.1" } as DatasetVersion;
const target29 = { manifestUrl: "/manifest.json", version: version29 };
const target281 = { manifestUrl: "/manifest.json", version: version281 };

function gtRecipe(
  id: string,
  datasetVersionId: string,
  overrides: Partial<Recipe> = {},
): Recipe {
  return {
    id,
    name: "Blast Furnace: Raw Silicon Ingot",
    kind: "gregtech_machine",
    machineType: "Blast Furnace",
    minimumTier: "MV",
    durationTicks: 80,
    eut: 120,
    inputs: [{ kind: "item", id: "gregtech:dust:silicon", amount: 1 }],
    outputs: [{ kind: "item", id: "gregtech:ingot:silicon", amount: 1 }],
    source: { datasetVersionId, recipeMap: "Blast Furnace" },
    ...overrides,
  };
}

// The changed recipe from the 2.8.1 spot check: Raw Silicon Ingot takes 80 t on 2.8.1 and 400 t on 2.9, ids by content.
const silicon281 = gtRecipe("oracle:gregtech:gt-recipe-blastfurnace:c7dfbb47010378b1", version281.id);
const silicon29 = gtRecipe("oracle:gregtech:gt-recipe-blastfurnace:68b67d723eb95e92", version29.id, { durationTicks: 400 });
// An unchanged recipe: one content id in both datasets.
const dustId = "oracle:gregtech:gt-recipe-macerator:aaaa000011112222";
const dust = (datasetVersionId: string) =>
  gtRecipe(dustId, datasetVersionId, {
    name: "Macerator: Silicon Dust",
    machineType: "Macerator",
    durationTicks: 100,
    eut: 2,
    inputs: [{ kind: "item", id: "gregtech:ore:silicon", amount: 1 }],
    outputs: [{ kind: "item", id: "gregtech:dust:silicon", amount: 2 }],
    source: { datasetVersionId, recipeMap: "Macerator" },
  });

function install(versionId: string, recipes: Recipe[]) {
  datasets.set(versionId, new Map(recipes.map((recipe) => [recipe.id, recipe])));
}
// A picked CropsNH crop: 2.9 has the Crop Farm map, 2.8.1 ships no CropsNH.
const wheatId = "oracle:cropsnh:crop-farm:wheat0000";
const wheat = gtRecipe(wheatId, version29.id, {
  name: "Crop Farm: Wheat",
  kind: "crop_produce",
  category: "cropsnh-crop",
  machineType: "Crop Farm",
  minimumTier: "NONE",
  durationTicks: 256,
  eut: 0,
  inputs: [],
  outputs: [{ kind: "item", id: "minecraft:wheat", amount: 1 }],
  source: { datasetVersionId: version29.id, recipeMap: "Crop Farm" },
});
install(version281.id, [silicon281, dust(version281.id)]);
install(version29.id, [silicon29, dust(version29.id), wheat]);

function node(id: string, recipeId: string, extra: Partial<FactoryNode> = {}): FactoryNode {
  return {
    id,
    recipeId,
    machineCount: 2,
    parallel: 1,
    overclockTier: "MV",
    enabled: true,
    position: { x: 0, y: 0 },
    ...extra,
  };
}

function plan(gameVersion: string, recipes: Recipe[], nodes: FactoryNode[], edges: FactoryEdge[] = []): FactoryProject {
  return {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    gameVersion,
    id: "plan-1",
    name: "Silicon line",
    recipes,
    nodes,
    edges,
    fuelProfiles: [],
  };
}

const wire: FactoryEdge = {
  id: "e1",
  source: "n1",
  target: "n2",
  sourceHandle: "output:item:gregtech%3Adust%3Asilicon:0",
  targetHandle: "input:item:gregtech%3Adust%3Asilicon:0",
  resourceKind: "item",
  resourceId: "gregtech:dust:silicon",
} as FactoryEdge;

const plan281 = plan(
  "2.8.1",
  [dust(version281.id), silicon281],
  [node("n1", dustId), node("n2", silicon281.id, { solvePin: 3, coilTier: "kanthal", machineConfigTiers: { x: "1" } })],
  [wire],
);

describe("convertProjectToVersion", () => {
  test("a 2.8.1 plan with a recipe that changed converts to a 2.9 plan with that card marked and the original unchanged", async () => {
    const before = structuredClone(plan281);
    const { project, unconverted } = await convertProjectToVersion(plan281, target29);
    expect(project.gameVersion).toBe("2.9");
    expect(project.name).toBe("Silicon line (GTNH 2.9)");
    expect(unconverted).toEqual([
      {
        nodeId: "n2",
        section: 0,
        recipe: {
          fromGameVersion: "2.8.1",
          recipeId: silicon281.id,
          recipeName: "Blast Furnace: Raw Silicon Ingot",
          machineType: "Blast Furnace",
        },
      },
    ]);
    expect(project.recipes.some((r) => r.id === plan281.nodes[1]!.recipeId)).toBe(false);
    // Not swapped for the 400 t recipe that looks the same.
    expect(project.recipes.some((r) => r.id === silicon29.id)).toBe(false);
    // The unchanged recipe takes the 2.9 body under its own id.
    expect(project.recipes.find((r) => r.id === dustId)?.source?.datasetVersionId).toBe(version29.id);
    const card = project.nodes.find((n) => n.id === "n2")!;
    expect(card).toMatchObject({ recipeId: silicon281.id, machineCount: 2, solvePin: 3, coilTier: "kanthal", overclockTier: "MV", machineConfigTiers: { x: "1" } });
    expect(card.unconverted?.fromGameVersion).toBe("2.8.1");
    expect(project.nodes.find((n) => n.id === "n1")?.unconverted).toBeUndefined();
    expect(project.edges).toEqual(plan281.edges);
    expect(plan281).toEqual(before);
  });

  test("a card marked going to 2.9 finds its recipe by id again when the copy is converted back to 2.8.1", async () => {
    const { project: on29 } = await convertProjectToVersion(plan281, target29);
    const { project: back, unconverted } = await convertProjectToVersion(on29, target281);
    expect(unconverted).toEqual([]);
    expect(back.gameVersion).toBe("2.8.1");
    const card = back.nodes.find((n) => n.id === "n2")!;
    expect(card.unconverted).toBeUndefined();
    expect(card).toMatchObject({ recipeId: silicon281.id, solvePin: 3, coilTier: "kanthal" });
    expect(back.recipes.find((r) => r.id === silicon281.id)?.durationTicks).toBe(80);
    expect(back.edges).toEqual(plan281.edges);
  });

  test("a marked section the target still lacks keeps its earlier marker", async () => {
    const { project: on29 } = await convertProjectToVersion(plan281, target29);
    const { project: again, unconverted } = await convertProjectToVersion(on29, target29);
    // Still marked, so still reported: the notice counts it.
    expect(unconverted).toEqual([
      { nodeId: "n2", section: 0, recipe: expect.objectContaining({ recipeId: silicon281.id, fromGameVersion: "2.8.1" }) },
    ]);
    expect(again.nodes.find((n) => n.id === "n2")?.unconverted).toMatchObject({
      fromGameVersion: "2.8.1",
      recipeId: silicon281.id,
      recipeName: "Blast Furnace: Raw Silicon Ingot",
    });
    expect(again.recipes.some((r) => r.id === silicon281.id)).toBe(false);
  });

  test("a marked shared-machine section is found again by id on the way back", async () => {
    // A second macerator recipe only 2.8.1 has, on the same machine as the card's first.
    const onlyId = "oracle:gregtech:gt-recipe-macerator:only2810000";
    const only281 = { ...dust(version281.id), id: onlyId, name: "Macerator: Gravel", inputs: [{ kind: "item" as const, id: "minecraft:gravel", amount: 1 }] };
    const restore = [...(datasets.get(version281.id)?.values() ?? [])] as Recipe[];
    install(version281.id, [...restore, only281]);
    try {
      const shared = plan("2.8.1", [dust(version281.id), only281], [node("s", dustId, { extraRecipes: [{ recipeId: onlyId }] })]);
      const { project: on29, unconverted } = await convertProjectToVersion(shared, target29);
      expect(unconverted).toEqual([{ nodeId: "s", section: 1, recipe: expect.objectContaining({ recipeId: onlyId }) }]);
      const { project: back, unconverted: none } = await convertProjectToVersion(on29, target281);
      expect(none).toEqual([]);
      expect(back.nodes[0]?.extraRecipes).toEqual([{ recipeId: onlyId }]);
      expect(back.recipes.map((r) => r.id).sort()).toEqual([dustId, onlyId].sort());
    } finally {
      install(version281.id, restore);
    }
  });

  test("matched by content gets the target id and body, with its overrides carried", async () => {
    // A plan holding a version-stamped id; the target lists the same recipe under its content id, slots reordered.
    const stampedId = "oracle:local-2.9.0-rc-2:gregtech:gt-recipe-mixer:1";
    const mixerInputs = [
      { kind: "item" as const, id: "ore:dustAny", amount: 1, alternatives: [{ kind: "item" as const, id: "gregtech:dust:copper", amount: 1 }] },
      { kind: "fluid" as const, id: "water", amount: 100 },
    ];
    const stored = gtRecipe(stampedId, version29.id, {
      name: "Mixer: Paste",
      machineType: "Mixer",
      inputs: mixerInputs,
      outputs: [{ kind: "item", id: "paste", amount: 1 }],
      source: { datasetVersionId: version29.id, recipeMap: "Mixer" },
    });
    const current = { ...stored, id: "oracle:gregtech:gt-recipe-mixer:bbbb", inputs: [mixerInputs[1]!, mixerInputs[0]!], source: { datasetVersionId: version281.id, recipeMap: "Mixer" } };
    install(version281.id, [silicon281, dust(version281.id), current]);
    const override = { kind: "item" as const, id: "gregtech:dust:copper", amount: 1 };
    const source = plan(
      "2.9",
      [stored],
      [node("m", stampedId, { recipeInputOverrides: { "0": override } })],
      [{ id: "w", source: "x", target: "m", targetHandle: "input:fluid:water:1", resourceKind: "fluid", resourceId: "water" } as FactoryEdge],
    );

    const { project, unconverted } = await convertProjectToVersion(source, target281);

    expect(unconverted).toEqual([]);
    expect(project.gameVersion).toBe("2.8.1");
    expect(project.recipes.map((r) => r.id)).toEqual([current.id]);
    expect(project.recipes[0]?.source?.datasetVersionId).toBe(version281.id);
    const card = project.nodes[0]!;
    expect(card.recipeId).toBe(current.id);
    expect(card.recipeInputOverrides).toEqual({ "1": override });
    expect(project.edges[0]?.targetHandle).toBe("input:fluid:water:0");
    install(version281.id, [silicon281, dust(version281.id)]);
  });

  test("converts a shared machine with one unmatched section", async () => {
    const source = plan(
      "2.8.1",
      [dust(version281.id), silicon281],
      [node("s", dustId, { extraRecipes: [{ recipeId: silicon281.id }] })],
    );
    const { project, unconverted } = await convertProjectToVersion(source, target29);
    expect(unconverted).toEqual([{ nodeId: "s", section: 1, recipe: expect.objectContaining({ recipeId: silicon281.id }) }]);
    const card = project.nodes[0]!;
    expect(card.unconverted).toBeUndefined();
    expect(card.recipeId).toBe(dustId);
    expect(card.extraRecipes).toEqual([{ recipeId: silicon281.id, unconverted: expect.objectContaining({ fromGameVersion: "2.8.1" }) }]);
    expect(project.recipes.map((r) => r.id)).toEqual([dustId]);
  });

  test("power cards re-synthesize; custom rate cards stay", async () => {
    const power = buildPowerRecipe("large-combustion-engine", undefined, "power:lce", "2.9")!;
    const stalePower = { ...power, outputs: [] };
    const lne = buildPowerRecipe("large-neutralization-engine", undefined, "power:lne", "2.9")!;
    const custom = { ...createCustomRatePlaceholderRecipe("custom:1"), outputs: [{ kind: "item" as const, id: "x", amount: 5 }] };
    const crop = createCropFarmPlaceholderRecipe();
    const demo = { ...gtRecipe("demo:1", "demo"), isDemo: true };
    const source = plan(
      "2.9",
      [stalePower, lne, custom, crop, demo],
      [node("p", "power:lce"), node("l", "power:lne"), node("c", "custom:1"), node("f", crop.id), node("d", "demo:1")],
    );

    const { project, unconverted } = await convertProjectToVersion(source, target281);

    expect(project.recipes.find((r) => r.id === "power:lce")?.outputs).toEqual(power.outputs);
    expect(project.recipes.find((r) => r.id === "custom:1")).toEqual(custom);
    expect(project.recipes.find((r) => r.id === crop.id)).toEqual(crop);
    expect(project.recipes.find((r) => r.id === "demo:1")).toEqual(demo);
    // The Large Neutralization Engine is not in 2.8.1: marked with the reason, its body gone.
    expect(project.recipes.some((r) => r.id === "power:lne")).toBe(false);
    expect(unconverted).toEqual([
      { nodeId: "l", section: 0, recipe: expect.objectContaining({ recipeId: "power:lne", reason: "Not in GTNH 2.8.1." }) },
    ]);
  });

  describe("a power card's fuel keeps the source version's meaning", () => {
    /** One power card on `sourceId` converted from `from`: its stored settings and its recipe's warnings and inputs. */
    async function convertCard(sourceId: string, settings: Record<string, string> | undefined, from: string) {
      const recipe = buildPowerRecipe(sourceId, settings, "power:card", from)!;
      const source = plan(from, [recipe], [node("p", "power:card", { machineConfigTiers: settings })]);
      const { project } = await convertProjectToVersion(source, from === "2.9" ? target281 : target29);
      const card = project.recipes.find((r) => r.id === "power:card")!;
      return {
        settings: project.nodes[0]!.machineConfigTiers,
        warnings: card.power?.warnings ?? [],
        burns: card.inputs.map((slot) => slot.displayName),
      };
    }

    test("a 2.9 superheated boiler with no liquid stored says its Ether is now Solid Super Fuel on 2.8.1", async () => {
      const titanium = await convertCard("large-titanium-boiler", undefined, "2.9");
      expect(titanium.settings).toMatchObject({ liquidFuel: "Ether", solidFuel: "None" });
      expect(titanium.warnings).toContain("Not in GTNH 2.8.1: Ether. Using Solid Super Fuel.");
      expect(titanium.burns).toContain("Solid Super Fuel");
    });

    test("a 2.9 card with only a solid stored keeps its implicit liquid and says which fuel 2.8.1 burns", async () => {
      const bronze = await convertCard("large-bronze-boiler", { solidFuel: "Coal" }, "2.9");
      expect(bronze.settings).toMatchObject({ liquidFuel: "Fish Oil", solidFuel: "Coal" });
      expect(bronze.warnings).toContain("GTNH 2.8.1 boilers burn one fuel at a time. Using Fish Oil.");
      const titanium = await convertCard("large-titanium-boiler", { solidFuel: "Solid Super Fuel" }, "2.9");
      // Its implicit Ether has no 2.8.1 option: the line names it as well as the one fuel burned.
      expect(titanium.warnings).toContain(
        "Not in GTNH 2.8.1: Ether. GTNH 2.8.1 boilers burn one fuel at a time. Using Solid Super Fuel.",
      );
    });

    test("a 2.8.1 boiler's one fuel lands on 2.9's liquid or solid select, the other set to None", async () => {
      const coal = await convertCard("large-bronze-boiler", { fuel: "Coal" }, "2.8.1");
      expect(coal.settings).toMatchObject({ liquidFuel: "None", solidFuel: "Coal" });
      expect(coal.warnings).toEqual([]);
      expect(coal.burns).toContain("Coal");
      expect(coal.burns).not.toContain("Fish Oil");
      // The default fuel too: a 2.8.1 superheated boiler burns Solid Super Fuel, never 2.9's default Ether.
      const titanium = await convertCard("large-titanium-boiler", undefined, "2.8.1");
      expect(titanium.settings).toMatchObject({ liquidFuel: "None", solidFuel: "Solid Super Fuel" });
      expect(titanium.burns).not.toContain("Ether");
    });

    test("a fuel stored by an earlier conversion never overrules the card's own", async () => {
      // A 2.9 card that went to 2.8.1 and came back keeps the 2.8.1 fuel under its old id.
      const back = await convertCard("large-bronze-boiler", { fuel: "Coal", liquidFuel: "Creosote Oil", solidFuel: "None" }, "2.9");
      expect(back.settings?.fuel).toBeUndefined();
      expect(back.burns).toContain("Creosote Oil");
    });

    test("the HTGR's material carries across both reactors, and one the other lacks is named", async () => {
      // 2.8.1's bartworks fuels are 2.9's kubatech pebbles of the same element.
      const thorium = await convertCard("htgr", undefined, "2.8.1");
      expect(thorium.settings).toEqual({ pebble: "Thorium" });
      expect(thorium.warnings).toEqual([]);
      expect(thorium.burns).toContain("TRISO Fuel (Thorium)");
      // A material carried under another name keeps the source's choice beside it, and the card names the carry.
      const uranium = await convertCard("htgr", { fuel: "Uranium" }, "2.8.1");
      expect(uranium.settings).toEqual({ pebble: "Uranium-235", fuel: "Uranium" });
      expect(uranium.warnings).toEqual(["Not in GTNH 2.9: Uranium. Using Uranium-235."]);
      const back = await convertCard("htgr", { pebble: "Uranium-235" }, "2.9");
      expect(back.settings).toEqual({ fuel: "Uranium", pebble: "Uranium-235" });
      expect(back.warnings).toEqual(["Not in GTNH 2.8.1: Uranium-235. Using Uranium."]);
      // Converted back to the card it came from, the carry is undone with no line.
      const roundTrip = await convertCard("htgr", uranium.settings, "2.9");
      expect(roundTrip.settings).toEqual({ fuel: "Uranium" });
      expect(roundTrip.warnings).toEqual([]);
      expect((await convertCard("htgr", { pebble: "Thorium" }, "2.9")).warnings).toEqual([]);
      // 2.8.1's reactor has no Glowstone or Silver fuel: the card says what it burns instead.
      const glowstone = await convertCard("htgr", undefined, "2.9");
      expect(glowstone.warnings).toEqual(["Not in GTNH 2.8.1: Glowstone. Using Thorium."]);
      // A pebble count 2.9's reactor has no setting for is named, not silently replaced.
      expect((await convertCard("htgr", { fuel: "Thorium", pebbles: "100000" }, "2.8.1")).warnings).toEqual([
        "Not in GTNH 2.9: Pebbles kept. Using Pebble fill 10,000.",
      ]);
    });

    test("a 2.8.1 boiler fuel 2.9 has no option for is named once, with what the card burns", async () => {
      // No served 2.8.1 fuel is missing from 2.9 today; an old stored key stands in for one.
      const recipe = buildPowerRecipe("large-bronze-boiler", { fuel: "Unobtainium" }, "power:card", "2.8.1")!;
      const source = plan("2.8.1", [recipe], [node("p", "power:card", { machineConfigTiers: { fuel: "Unobtainium" } })]);
      const { project } = await convertProjectToVersion(source, target29);
      expect(project.recipes.find((r) => r.id === "power:card")?.power?.warnings).toEqual([
        "Not in GTNH 2.9: Unobtainium. Using Fish Oil.",
      ]);
    });

    test("a converted boiler keeps no copy of the fuel it carried", async () => {
      expect((await convertCard("large-bronze-boiler", { fuel: "Coal" }, "2.8.1")).settings?.fuel).toBeUndefined();
    });

    test("a default both versions offer is carried with no line", async () => {
      // The magic absorber's first fuel differs by version: the converted card keeps the one it burned.
      const absorber = await convertCard("magic-energy-absorber", undefined, "2.9");
      expect(absorber.settings).toMatchObject({ fuel: "Magic Tallow" });
      expect(absorber.warnings).toEqual([]);
    });
  });

  test("crop maths absent in 2.8.1 marks a picked crop with the reason when the dataset has no CropsNH crops", async () => {
    const { project, unconverted } = await convertProjectToVersion(plan("2.9", [wheat], [node("w", wheatId)]), target281);
    expect(unconverted).toEqual([
      { nodeId: "w", section: 0, recipe: expect.objectContaining({ recipeId: wheatId, machineType: "Crop Farm", reason: "Not in GTNH 2.8.1." }) },
    ]);
    expect(project.recipes).toEqual([]);
    // 2.9 has the crop: it converts like any recipe.
    const on29 = await convertProjectToVersion(plan("2.8.1", [wheat], [node("w", wheatId)]), target29);
    expect(on29.unconverted).toEqual([]);
    expect(on29.project.recipes.map((r) => r.id)).toEqual([wheatId]);
  });

  test("an unconverted marker survives parse and serialize", async () => {
    const source = plan(
      "2.8.1",
      [dust(version281.id), silicon281],
      [node("n2", silicon281.id), node("s", dustId, { extraRecipes: [{ recipeId: silicon281.id }] })],
    );
    const { project } = await convertProjectToVersion(source, target29);
    const reread = parseFactoryProjectJson(serializeFactoryProject(project));
    expect(reread.gameVersion).toBe("2.9");
    expect(reread.nodes.find((n) => n.id === "n2")?.unconverted).toEqual(project.nodes[0]!.unconverted);
    expect(reread.nodes.find((n) => n.id === "s")?.extraRecipes?.[0]?.unconverted).toEqual(
      project.nodes[1]!.extraRecipes![0]!.unconverted,
    );
  });

  test("the name is clipped to 80 characters and an earlier conversion's suffix is replaced", async () => {
    const long = { ...plan281, name: "x".repeat(100) };
    const { project } = await convertProjectToVersion(long, target29);
    expect(project.name).toHaveLength(80);
    expect(project.name.endsWith(" (GTNH 2.9)")).toBe(true);
    const back = await convertProjectToVersion({ ...plan281, name: "Silicon line (GTNH 2.9)" }, target29);
    expect(back.project.name).toBe("Silicon line (GTNH 2.9)");
  });
});

describe("matchRecipesToVersion", () => {
  test("keys bodies by the source id and leaves a changed recipe unmatched", async () => {
    const { bodies, unmatched } = await matchRecipesToVersion([dust(version281.id), silicon281], target29);
    expect([...bodies.keys()]).toEqual([dustId]);
    expect(unmatched).toEqual(new Set([silicon281.id]));
  });
});

describe("a content match counts only with the same numbers", () => {
  const stampedId = "oracle:local-2.8.1:gregtech:gt-recipe-centrifuge:1";
  const base = gtRecipe(stampedId, version281.id, {
    name: "Centrifuge: Glowstone Dust",
    machineType: "Centrifuge",
    inputs: [
      { kind: "item", id: "glowstone", amount: 1 },
      { kind: "item", id: "circuit:1", amount: 0, consumed: false },
    ],
    outputs: [
      { kind: "item", id: "redstone", amount: 1 },
      { kind: "item", id: "gold", amount: 1, chance: 1000 },
    ],
    specialValue: 1800,
    programmedCircuit: "1",
    source: { datasetVersionId: version281.id, recipeMap: "Centrifuge" },
  });
  const against = async (candidate: Recipe) => {
    install(version29.id, [silicon29, dust(version29.id), { ...candidate, id: "oracle:gregtech:gt-recipe-centrifuge:cccc" }]);
    try {
      return await matchRecipesToVersion([base], target29);
    } finally {
      install(version29.id, [silicon29, dust(version29.id)]);
    }
  };
  const withOutputs = (outputs: Recipe["outputs"]) => ({ ...base, outputs });
  const withInputs = (inputs: Recipe["inputs"]) => ({ ...base, inputs });

  test("a legacy stamped id with the same content matches", async () => {
    const { bodies } = await against({ ...base, source: { datasetVersionId: version29.id, recipeMap: "Centrifuge" } });
    expect(bodies.get(stampedId)?.id).toBe("oracle:gregtech:gt-recipe-centrifuge:cccc");
  });
  test.each([
    ["an output chance", withOutputs([base.outputs[0]!, { ...base.outputs[1]!, chance: 2500 }])],
    ["an amount", withOutputs([{ ...base.outputs[0]!, amount: 2 }, base.outputs[1]!])],
    ["the special value", { ...base, specialValue: 2700 }],
    ["the ticks", { ...base, durationTicks: 81 }],
    ["the EU", { ...base, eut: 121 }],
    ["a non-consumed circuit", withInputs([base.inputs[0]!, { ...base.inputs[1]!, id: "circuit:2" }])],
    ["the consumed flag", withInputs([base.inputs[0]!, { ...base.inputs[1]!, consumed: true }])],
    ["the programmed circuit", { ...base, programmedCircuit: "2" }],
  ])("%s that differs leaves it unmatched", async (_label, candidate) => {
    const { bodies, unmatched } = await against(candidate as Recipe);
    expect(bodies.size).toBe(0);
    expect(unmatched).toEqual(new Set([stampedId]));
  });

  test("a crafting pattern in another layout is another recipe", async () => {
    const shaped = (x: number): Recipe =>
      gtRecipe("oracle:local-2.8.1:crafting:shaped:1", version281.id, {
        name: "Shaped Crafting: Rod",
        machineType: "Shaped Crafting",
        durationTicks: 1,
        eut: 0,
        inputs: [{ kind: "item", id: "stick", amount: 1, neiSlot: { x, y: 0 } }],
        outputs: [{ kind: "item", id: "rod", amount: 1 }],
        source: { datasetVersionId: version281.id, recipeMap: "Shaped Crafting" },
      });
    install(version29.id, [{ ...shaped(18), id: "oracle:crafting:shaped:dddd" }]);
    try {
      expect((await matchRecipesToVersion([shaped(0)], target29)).bodies.size).toBe(0);
      expect((await matchRecipesToVersion([shaped(18)], target29)).bodies.size).toBe(1);
    } finally {
      install(version29.id, [silicon29, dust(version29.id)]);
    }
  });

  test("an arcane recipe with its grid is compared in full; only an item-free old body takes the grid", async () => {
    type Slot = [kind: "item" | "aspect", id: string];
    const arcane = (id: string, versionId: string, slots: Slot[]): Recipe =>
      gtRecipe(id, versionId, {
        name: "Thaumcraft Arcane Crafting: Vis Reader",
        machineType: "Thaumcraft Arcane Crafting",
        durationTicks: 1,
        eut: 0,
        inputs: slots.map(([kind, slotId]) => ({ kind, id: slotId, amount: kind === "aspect" ? 3 : 1 })),
        outputs: [{ kind: "item", id: "automagy:blockvisreader", amount: 1 }],
        source: { datasetVersionId: versionId, recipeMap: "Thaumcraft Arcane Crafting" },
      });
    const vis: Slot[] = [["aspect", "thaumcraft:aspect:aer"], ["aspect", "thaumcraft:aspect:ordo"]];
    const threeItems = arcane("oracle:thaumcraft:arcane:eeee", version29.id, [
      ["item", "quartz"], ["item", "stone"], ["item", "crystal"], ...vis,
    ]);
    install(version29.id, [threeItems]);
    try {
      const oneItem = arcane("oracle:thaumcraft:arcane:ffff", version281.id, [["item", "quartz"], ...vis]);
      expect((await matchRecipesToVersion([oneItem], target29)).unmatched).toEqual(new Set([oneItem.id]));
      const gridless = arcane("oracle:local-2.9.0-beta-2:thaumcraft:arcane:1", version281.id, vis);
      expect((await matchRecipesToVersion([gridless], target29)).bodies.get(gridless.id)?.id).toBe(threeItems.id);
    } finally {
      install(version29.id, [silicon29, dust(version29.id)]);
    }
  });

  test("a body the match service named but that cannot be fetched throws instead of marking the card", async () => {
    const candidate = { ...base, id: "oracle:gregtech:gt-recipe-centrifuge:cccc" };
    install(version29.id, [silicon29, dust(version29.id), candidate]);
    failing.add(candidate.id);
    try {
      await expect(matchRecipesToVersion([base], target29)).rejects.toThrow("Failed to fetch");
    } finally {
      failing.clear();
      install(version29.id, [silicon29, dust(version29.id)]);
    }
  });
});

describe("a card keeps its machine", () => {
  const handler = (id: string, label: string) => ({ id, label, machineType: label, minimumTier: "MV", kind: "multiblock" as const });
  const ebfId = "oracle:gregtech:gt-recipe-blastfurnace:9999";
  const ebf = (datasetVersionId: string, handlers: ReturnType<typeof handler>[]) =>
    gtRecipe(ebfId, datasetVersionId, { name: "Blast Furnace: Steel", machineHandlers: handlers });
  const ebf29 = ebf(version29.id, [handler("electric-blast-furnace", "Electric Blast Furnace"), handler("exothermic-hearth", "Exothermic Hearth")]);
  const ebf281 = ebf(version281.id, [handler("electric-blast-furnace", "Electric Blast Furnace"), handler("mega-electric-blast-furnace", "Mega Electric Blast Furnace")]);

  test("a card on a machine the target version lacks is marked, not moved to another machine", async () => {
    install(version281.id, [silicon281, dust(version281.id), ebf281]);
    try {
      const source = plan("2.9", [ebf29], [node("h", ebfId, { machineHandlerId: "exothermic-hearth" }), node("e", ebfId)]);
      const { project, unconverted } = await convertProjectToVersion(source, target281);
      expect(unconverted).toEqual([
        {
          nodeId: "h",
          section: 0,
          recipe: { fromGameVersion: "2.9", recipeId: ebfId, recipeName: "Blast Furnace: Steel", machineType: "Exothermic Hearth", reason: "Not in GTNH 2.8.1." },
        },
      ]);
      expect(project.nodes[0]?.machineHandlerId).toBe("exothermic-hearth");
      // The plain EBF card still uses the recipe, so its 2.8.1 body stays.
      expect(project.recipes.map((r) => r.source?.datasetVersionId)).toEqual([version281.id]);
      expect(project.nodes[1]?.unconverted).toBeUndefined();

      const alone = await convertProjectToVersion(plan("2.9", [ebf29], [node("h", ebfId, { machineHandlerId: "exothermic-hearth" })]), target281);
      expect(alone.project.recipes).toEqual([]);
    } finally {
      install(version281.id, [silicon281, dust(version281.id)]);
    }
  });

  test("a machine renamed between versions moves to its new id; a default card stays on its machine", async () => {
    const fusionId = "oracle:gregtech:gt-recipe-fusion:1";
    const fusion = (datasetVersionId: string, handlers: ReturnType<typeof handler>[]) =>
      gtRecipe(fusionId, datasetVersionId, { name: "Fusion: Helium Plasma", machineType: "Mixer", machineHandlers: handlers, source: { datasetVersionId, recipeMap: "Mixer" } });
    const mixId = "oracle:gregtech:gt-recipe-mixer:2";
    const mix = (datasetVersionId: string, handlers: ReturnType<typeof handler>[]) =>
      gtRecipe(mixId, datasetVersionId, { name: "Mixer: Dust", machineType: "Mixer", machineHandlers: handlers, source: { datasetVersionId, recipeMap: "Mixer" } });
    install(version29.id, [
      fusion(version29.id, [handler("fusion-control-computer-mk-i", "Fusion Control Computer Mk-I")]),
      mix(version29.id, [handler("industrial-mixing-machine", "Industrial Mixing Machine"), handler("steam-blender", "Steam Blender")]),
    ]);
    try {
      const source = plan(
        "2.8.1",
        [
          fusion(version281.id, [handler("fusion-control-computer-mark-i", "Fusion Control Computer Mark I")]),
          mix(version281.id, [handler("steam-blender", "Steam Blender"), handler("industrial-mixing-machine", "Industrial Mixing Machine")]),
        ],
        [node("f", fusionId, { machineHandlerId: "fusion-control-computer-mark-i" }), node("m", mixId)],
      );
      const { project, unconverted } = await convertProjectToVersion(source, target29);
      expect(unconverted).toEqual([]);
      expect(project.nodes.map((n) => n.machineHandlerId)).toEqual(["fusion-control-computer-mk-i", "steam-blender"]);
    } finally {
      install(version29.id, [silicon29, dust(version29.id)]);
    }
  });
});

describe("the same machine across versions", () => {
  type Handler = { id: string; label: string; machineType: string; minimumTier: string; kind: "single" | "multiblock"; availableTiers?: string[] };
  const single = (id: string, label: string, tiers: string[]): Handler => ({
    id, label, machineType: label, minimumTier: tiers[0]!, kind: "single", availableTiers: tiers,
  });
  const multi = (id: string, label: string): Handler => ({ id, label, machineType: label, minimumTier: "LV", kind: "multiblock" });
  const recipeId = "oracle:gregtech:shared:1";
  const onMap = (map: string, versionId: string, handlers: Handler[]) =>
    gtRecipe(recipeId, versionId, { name: `${map}: Fuel`, machineType: map, machineHandlers: handlers as never, source: { datasetVersionId: versionId, recipeMap: map } });

  async function convertCard(
    from: "2.8.1" | "2.9",
    map: string,
    sourceHandlers: Handler[],
    targetHandlers: Handler[],
    card: Partial<FactoryNode>,
  ) {
    const [sourceVersion, targetVersion, targetSpec] =
      from === "2.8.1" ? [version281, version29, target29] : [version29, version281, target281];
    const restore = [...(datasets.get(targetVersion.id)?.values() ?? [])] as Recipe[];
    install(targetVersion.id, [onMap(map, targetVersion.id, targetHandlers)]);
    try {
      return await convertProjectToVersion(plan(from, [onMap(map, sourceVersion.id, sourceHandlers)], [node("c", recipeId, card)]), targetSpec);
    } finally {
      install(targetVersion.id, restore);
    }
  }

  const naq281 = [single("naquadah-reactor-mark", "Naquadah Reactor Mark", ["LuV"])];
  const naq29 = [single("naquadah-reactor-mk-iii", "Naquadah Reactor Mk-III", ["LuV"])];
  test("a 2.8.1 naquadah reactor Mark III card stays on the Mk-III, and back", async () => {
    const up = await convertCard("2.8.1", "Naquadah Reactor MkIII", naq281, naq29, { overclockTier: "LuV", machineHandlerId: "naquadah-reactor-mark" });
    expect(up.unconverted).toEqual([]);
    expect(up.project.nodes[0]?.machineHandlerId).toBe("naquadah-reactor-mk-iii");
    const down = await convertCard("2.9", "Naquadah Reactor MkIII", naq29, naq281, { overclockTier: "LuV", machineHandlerId: "naquadah-reactor-mk-iii" });
    expect(down.unconverted).toEqual([]);
    expect(down.project.nodes[0]?.machineHandlerId).toBe("naquadah-reactor-mark");
  });

  const plasma281 = [single("plasma-generator-mark", "Plasma Generator Mark", ["EV", "IV", "LuV", "ZPM"])];
  const plasma29 = [
    single("plasma-generator-mk-iv", "Plasma Generator Mk-IV", ["ZPM"]),
    single("plasma-generator-mk-i", "Plasma Generator Mk-I", ["EV"]),
    single("plasma-generator-mk-ii", "Plasma Generator Mk-II", ["IV"]),
    single("plasma-generator-mk-iii", "Plasma Generator Mk-III", ["LuV"]),
  ];
  test("a 2.8.1 plasma generator card at IV stays on the Mk-II, and back", async () => {
    const up = await convertCard("2.8.1", "Plasma Generator Fuels", plasma281, plasma29, { overclockTier: "IV" });
    expect(up.unconverted).toEqual([]);
    expect(up.project.nodes[0]?.machineHandlerId).toBe("plasma-generator-mk-ii");
    const down = await convertCard("2.9", "Plasma Generator Fuels", plasma29, plasma281, { overclockTier: "IV", machineHandlerId: "plasma-generator-mk-ii" });
    expect(down.unconverted).toEqual([]);
    expect(down.project.nodes[0]?.machineHandlerId).toBe("plasma-generator-mark");
  });

  const acid281 = ["LV", "MV", "HV", "EV"].map((tier) => single(`acid-generator-${tier.toLowerCase()}`, `Acid Generator ${tier}`, [tier]));
  const acid29 = [
    single("acid-generator", "Acid Generator", ["LV", "MV", "HV"]),
    single("corrosive-energy-releaser", "Corrosive Energy Releaser", ["IV"]),
    single("superacid-generator", "Superacid Generator", ["EV"]),
  ];
  test("tiered acid generators pair with the one 2.9 family by tier, and back", async () => {
    const up = await convertCard("2.8.1", "Acid Generator", acid281, acid29, { overclockTier: "MV", machineHandlerId: "acid-generator-mv" });
    expect(up.unconverted).toEqual([]);
    expect(up.project.nodes[0]?.machineHandlerId).toBe("acid-generator");
    const down = await convertCard("2.9", "Acid Generator", acid29, acid281, { overclockTier: "HV", machineHandlerId: "acid-generator" });
    expect(down.unconverted).toEqual([]);
    expect(down.project.nodes[0]?.machineHandlerId).toBe("acid-generator-hv");
    // 2.8.1's picker lists each tier's generator on its own, so the pinned id is one it offers.
    const body = down.project.recipes.find((recipe) => recipe.id === down.project.nodes[0]?.recipeId)!;
    expect(getSelectedMachineHandler(body, down.project.nodes[0]!).id).toBe("acid-generator-hv");
  });

  test("GT++'s High Current Industrial Arc Furnace is not the Industrial Arc Furnace: the card is marked", async () => {
    const { project, unconverted } = await convertCard(
      "2.8.1",
      "Arc Furnace",
      [multi("arc-furnace", "Arc Furnace"), multi("high-current-industrial-arc-furnace", "High Current Industrial Arc Furnace")],
      [multi("arc-furnace", "Arc Furnace"), multi("industrial-arc-furnace", "Industrial Arc Furnace")],
      { machineHandlerId: "high-current-industrial-arc-furnace" },
    );
    expect(unconverted).toEqual([
      { nodeId: "c", section: 0, recipe: expect.objectContaining({ machineType: "High Current Industrial Arc Furnace", reason: "Not in GTNH 2.9." }) },
    ]);
    expect(project.nodes[0]?.machineHandlerId).toBe("high-current-industrial-arc-furnace");
  });

  test("multiblock marks of one family are never paired by tier", async () => {
    const { unconverted } = await convertCard(
      "2.9",
      "Fusion Reactor",
      [multi("compact-fusion-computer-mk-iii", "Compact Fusion Computer Mk-III")],
      [multi("compact-fusion-computer-mk-ii", "Compact Fusion Computer Mk-II")],
      { machineHandlerId: "compact-fusion-computer-mk-iii" },
    );
    expect(unconverted).toHaveLength(1);
  });

  test("a handler both versions list stays put", async () => {
    const centrifuge281 = [multi("industrial-centrifuge", "Industrial Centrifuge")];
    const centrifuge29 = [multi("spinmatron-2737", "Spinmatron-2737"), multi("industrial-centrifuge", "Industrial Centrifuge")];
    const up = await convertCard("2.8.1", "Multiblock Centrifuge", centrifuge281, centrifuge29, {});
    expect(up.unconverted).toEqual([]);
    // Left on 2.8.1's default, the card is pinned to it rather than taking 2.9's first machine.
    expect(up.project.nodes[0]?.machineHandlerId).toBe("industrial-centrifuge");
    const down = await convertCard("2.9", "Multiblock Centrifuge", centrifuge29, centrifuge281, { machineHandlerId: "industrial-centrifuge" });
    expect(down.unconverted).toEqual([]);
    expect(down.project.nodes[0]?.machineHandlerId).toBe("industrial-centrifuge");
  });

  // The pipeline exports no handler list for a map with one machine family: its recipes name the synthesized
  // handler, the map's one machine. 2.8.1's Multiblock Centrifuge is that map's Industrial Centrifuge.
  const centrifuge29 = [multi("spinmatron-2737", "Spinmatron-2737"), multi("industrial-centrifuge", "Industrial Centrifuge")];

  test("an Industrial Centrifuge card stays on it both ways; 2.8.1's is pinned to it on 2.9", async () => {
    const down = await convertCard("2.9", "Multiblock Centrifuge", centrifuge29, [], { machineHandlerId: "industrial-centrifuge" });
    expect(down.unconverted).toEqual([]);
    expect(down.project.recipes).toHaveLength(1);
    expect(down.project.nodes[0]?.machineHandlerId).toBe("multiblock-centrifuge");
    for (const card of [{}, { machineHandlerId: "multiblock-centrifuge" }]) {
      const up = await convertCard("2.8.1", "Multiblock Centrifuge", [], centrifuge29, card);
      expect(up.unconverted).toEqual([]);
      // Not 2.9's first machine, the Spinmatron.
      expect(up.project.nodes[0]?.machineHandlerId).toBe("industrial-centrifuge");
    }
  });

  test("a Spinmatron card going to 2.8.1 is marked, chosen or on 2.9's default", async () => {
    for (const card of [{ machineHandlerId: "spinmatron-2737" }, {}]) {
      const { project, unconverted } = await convertCard("2.9", "Multiblock Centrifuge", centrifuge29, [], card);
      expect(unconverted).toEqual([
        { nodeId: "c", section: 0, recipe: expect.objectContaining({ machineType: "Spinmatron-2737", reason: "Not in GTNH 2.8.1." }) },
      ]);
      expect(project.recipes).toEqual([]);
    }
  });

  test("a map with no handler list in either version keeps its card on its one machine, unmarked", async () => {
    const { project, unconverted } = await convertCard("2.9", "Multiblock Electrolyzer", [], [], {});
    expect(unconverted).toEqual([]);
    expect(project.recipes).toHaveLength(1);
    expect(project.nodes[0]?.machineHandlerId).toBeUndefined();
  });

  test("a marked card matched by content keeps its own slot overrides and wire handles", async () => {
    const stamped = "oracle:local-2.9.0-rc-2:gregtech:gt-recipe-blastfurnace:1";
    const inputs = [
      { kind: "item" as const, id: "ore:dustAny", amount: 1, alternatives: [{ kind: "item" as const, id: "iron", amount: 1 }] },
      { kind: "fluid" as const, id: "oxygen", amount: 100 },
    ];
    const stored = gtRecipe(stamped, version29.id, { inputs, machineHandlers: [multi("exothermic-hearth", "Exothermic Hearth")] as never });
    const current = { ...stored, id: "oracle:gregtech:gt-recipe-blastfurnace:9", inputs: [inputs[1]!, inputs[0]!], machineHandlers: [multi("electric-blast-furnace", "Electric Blast Furnace")] as never, source: { datasetVersionId: version281.id, recipeMap: "Blast Furnace" } };
    const restore = [...(datasets.get(version281.id)?.values() ?? [])] as Recipe[];
    install(version281.id, [current]);
    try {
      const override = { kind: "item" as const, id: "iron", amount: 1 };
      const edge = { id: "w", source: "x", target: "h", targetHandle: "input:fluid:oxygen:1", resourceKind: "fluid", resourceId: "oxygen" } as FactoryEdge;
      const { project, unconverted } = await convertProjectToVersion(
        plan("2.9", [stored], [node("h", stamped, { recipeInputOverrides: { "0": override } })], [edge]),
        target281,
      );
      expect(unconverted).toHaveLength(1);
      expect(project.nodes[0]).toMatchObject({ recipeId: stamped, recipeInputOverrides: { "0": override } });
      expect(project.edges[0]?.targetHandle).toBe("input:fluid:oxygen:1");
      expect(project.recipes).toEqual([]);
    } finally {
      install(version281.id, restore);
    }
  });
});
