import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import rawResourceMap29 from "./data/resource-map.json";
import rawMachineIcons29 from "./data/machine-icons.json";
import { getPowerMachineIcon, resolvePowerResource } from "./planner-data";
import { buildPowerRecipe } from "./power-recipe";

// Icon file names carry a content hash that changes when the pipeline re-renders an icon, so
// these tests pin the icon path's shape (dataset, folder) and the resource id, never the hash.
const RENDERED_2_8_1 = /^\/datasets\/gtnh\/local-2\.8\.1\/textures\/rendered\/[^/]+\.png$/;

describe("resource-map.json 2.8.1", () => {
  test("resource-map.json 2.8.1 resolves the 2.8.1 fuel names", () => {
    // GT++'s agrichem fluids (fuels.ts SEMIFLUID_FUELS): Poop Juice is the fluid raw.waste.
    expect(resolvePowerResource("Poop Juice", "2.8.1")).toMatchObject({ kind: "fluid", id: "fluid.raw.waste" });
    expect(resolvePowerResource("Manure Slurry", "2.8.1")).toMatchObject({ kind: "fluid", id: "fluid.manure.slurry" });
    expect(resolvePowerResource("Fertile Manure Slurry", "2.8.1")).toMatchObject({
      kind: "fluid",
      id: "fluid.fertile.manure.slurry",
    });
    // 2.8.1 registers no fluid for the two seed oils, so the catalog has only their cells.
    expect(resolvePowerResource("Hemp Seed Oil", "2.8.1")).toBeUndefined();
    expect(resolvePowerResource("Lin Seed Oil", "2.8.1")).toBeUndefined();
    // The workbook's "Ethanol" is bioethanol on both packs, whatever each shows it as.
    expect(resolvePowerResource("Ethanol", "2.8.1")?.id).toBe("bioethanol");
    expect(resolvePowerResource("Poop Juice", "2.9")).toBeUndefined();
  });

  test("resource-map.json 2.8.1 resolves bartworks' nine HTGR pebble names", () => {
    const ids = Object.fromEntries(
      ["Thorium", "Uranium", "Plutonium"].flatMap((fuel) =>
        [`TRISO pebble (${fuel})`, `Burned out TRISO Ball (${fuel})`, `Burned out TRISO Pebble (${fuel})`].map(
          (name) => [name, resolvePowerResource(name, "2.8.1")?.id],
        ),
      ),
    );
    expect(ids).toEqual({
      "TRISO pebble (Thorium)": "bartworks:bw.htgrmaterials@4",
      "Burned out TRISO Ball (Thorium)": "bartworks:bw.htgrmaterials@5",
      "Burned out TRISO Pebble (Thorium)": "bartworks:bw.htgrmaterials@6",
      "TRISO pebble (Uranium)": "bartworks:bw.htgrmaterials@11",
      "Burned out TRISO Ball (Uranium)": "bartworks:bw.htgrmaterials@12",
      "Burned out TRISO Pebble (Uranium)": "bartworks:bw.htgrmaterials@13",
      "TRISO pebble (Plutonium)": "bartworks:bw.htgrmaterials@18",
      "Burned out TRISO Ball (Plutonium)": "bartworks:bw.htgrmaterials@19",
      "Burned out TRISO Pebble (Plutonium)": "bartworks:bw.htgrmaterials@20",
    });
  });

  test("resource-map.json 2.8.1 resolves the magic fuels 2.8.1 names by the bare material", () => {
    // 2.8.1 names GT gems "Amber" and "Vinteum", its Void material "Void" and the life essence
    // cell "Life Cell"; each is a magic fuel there (5.09.51.476 ProcessingGem.java:62,
    // ProcessingDust.java:57-62, ProcessingPlate.java:107-112, ProcessingCell.java:52-60).
    const ids = Object.fromEntries(
      ["Amber Gem", "Vinteum Gem", "Life Essence Cell", "Void Metal Dust", "Void Metal Plate"].map((name) => [
        name,
        resolvePowerResource(name, "2.8.1")?.id,
      ]),
    );
    expect(ids).toEqual({
      "Amber Gem": "gregtech:gt.metaitem.01@8514",
      "Vinteum Gem": "gregtech:gt.metaitem.01@8529",
      "Life Essence Cell": "gregtech:gt.metaitem.01@30694",
      "Void Metal Dust": "gregtech:gt.metaitem.01@2970",
      "Void Metal Plate": "gregtech:gt.metaitem.01@17970",
    });
    // Forbidden Magic's FMResource:3 (5.09.51.476 FuelRecipes.java:49-52) is in neither pack's catalog.
    expect(resolvePowerResource("Tainted Blood Shard", "2.8.1")).toBeUndefined();
    // 2.9 names its Void material "Void Metal", so those items match by name there.
    expect(resolvePowerResource("Void Metal Dust", "2.9")?.id).toBe("gregtech:gt.metaitem.01@2970");
  });

  test("resource-map.json 2.9 resolves the magic gems and the life essence cell by the bare name", () => {
    // 5.09.54.205: Amber and Vinteum are magic fuel 32 (MaterialsInit.java:2855, :11770), LifeEssence 100.
    const ids = Object.fromEntries(
      ["Amber Gem", "Vinteum Gem", "Life Essence Cell"].map((name) => [name, resolvePowerResource(name, "2.9")?.id]),
    );
    expect(ids).toEqual({
      "Amber Gem": "gregtech:gt.metaitem.01@8514",
      "Vinteum Gem": "gregtech:gt.metaitem.01@8529",
      "Life Essence Cell": "gregtech:gt.metaitem.01@30694",
    });
    expect(resolvePowerResource("Tainted Blood Shard", "2.9")).toBeUndefined();
  });

  test("resource-map.json 2.8.1 icons are 2.8.1's", () => {
    expect(resolvePowerResource("Steam", "2.8.1")?.iconPath).toMatch(RENDERED_2_8_1);
    expect(resolvePowerResource("Poop Juice", "2.8.1")?.iconPath).toMatch(RENDERED_2_8_1);
  });

  test("resource-map.json 2.9 is the 2.9 map, and an unknown version reads it too", () => {
    const steam29 = (rawResourceMap29 as { resources: Record<string, unknown> }).resources.Steam;
    expect(resolvePowerResource("Steam", "2.9")).toEqual(steam29);
    expect(resolvePowerResource("Steam", "2.10")).toEqual(steam29);
  });
});

describe("machine-icons.json 2.8.1", () => {
  test("machine-icons.json 2.8.1 names a 2.8.1 icon path", () => {
    expect(getPowerMachineIcon("steam-turbine", "2.8.1")?.iconPath).toMatch(RENDERED_2_8_1);
  });

  test("machine-icons.json 2.8.1 draws 2.8.1's multiblock controllers by their 2.8.1 ids", () => {
    expect(getPowerMachineIcon("large-gas-turbine", "2.8.1")).toMatchObject({
      id: "gregtech:gt.blockmachines@1151",
      displayName: "Large Gas Turbine",
    });
    expect(getPowerMachineIcon("large-gas-turbine", "2.9")?.id).toBe("gregtech:gt.blockmachines@15527");
    expect(getPowerMachineIcon("large-neutralization-engine", "2.8.1")).toBeUndefined();
  });

  test("machine-icons.json 2.9 is the 2.9 map", () => {
    const machines29 = (rawMachineIcons29 as { machines: Record<string, unknown> }).machines;
    expect(getPowerMachineIcon("steam-turbine", "2.9")).toEqual(machines29["steam-turbine"]);
  });

  test("every 2.8.1 icon path, faces and fuels, is a file in the local-2.8.1 dataset when it is on disk", () => {
    const read = (file: string) => JSON.parse(readFileSync(path.join(__dirname, "data", "2.8.1", file), "utf8"));
    const entries: Array<[string, { iconPath?: string }]> = [
      ...Object.entries((read("machine-icons.json") as { machines: Record<string, { iconPath?: string }> }).machines),
      ...Object.entries((read("resource-map.json") as { resources: Record<string, { iconPath?: string }> }).resources),
    ];
    for (const [name, entry] of entries) {
      expect(entry.iconPath, name).toMatch(RENDERED_2_8_1);
    }
    // The dataset is not checked in; where it is present, a stale map (icons re-rendered under
    // new hashes since it was made) fails here.
    const root = path.join(process.cwd(), "public");
    if (existsSync(path.join(root, "datasets", "gtnh", "local-2.8.1", "textures", "rendered"))) {
      const missing = entries.filter(([, entry]) => !existsSync(path.join(root, entry.iconPath!))).map(([name]) => name);
      expect(missing).toEqual([]);
    }
  });
});

describe("2.8.1 power cards wire the 2.8.1 names", () => {
  test("a 2.8.1 semifluid generator on Poop Juice takes Raw Animal Waste as a port", () => {
    const recipe = buildPowerRecipe("semifluid-generator", { fuel: "Poop Juice" }, "r1", "2.8.1")!;
    expect(recipe.inputs).toEqual([expect.objectContaining({ kind: "fluid", id: "fluid.raw.waste" })]);
    expect(recipe.power?.stats.some((line) => line.label === "Poop Juice")).toBe(false);
  });

  test("a 2.8.1 HTGR takes its TRISO pebbles as a port and returns both burned forms", () => {
    const recipe = buildPowerRecipe("htgr", undefined, "r1", "2.8.1")!;
    expect(recipe.inputs.map((input) => input.id)).toContain("bartworks:bw.htgrmaterials@4");
    expect(recipe.outputs.map((output) => output.id)).toEqual(
      expect.arrayContaining(["bartworks:bw.htgrmaterials@5", "bartworks:bw.htgrmaterials@6"]),
    );
    expect(recipe.power?.stats.some((line) => /TRISO/.test(line.label))).toBe(false);
  });
});
