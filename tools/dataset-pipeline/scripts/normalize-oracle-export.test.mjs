import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import oracle281Sample from "./__fixtures__/oracle-2.8.1-sample.json";
import singleblockCatalysts from "./__fixtures__/singleblock-catalysts.json";

const scriptPath = fileURLToPath(new URL("./normalize-oracle-export.mjs", import.meta.url));

/**
 * The normalizer runs work at import time, so it is exercised the way the
 * pipeline runs it: as a subprocess over a fixture export.
 */
function normalize(rawExport, version = { id: "test-fixture", label: "test" }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "normalize-oracle-"));
  const input = path.join(dir, "oracle-export.json");
  const output = path.join(dir, "recipes.json");
  fs.writeFileSync(input, JSON.stringify(rawExport));
  execFileSync(process.execPath, [scriptPath, input, output], {
    env: {
      ...process.env,
      GTNH_DATASET_VERSION_ID: version.id,
      GTNH_DATASET_VERSION_LABEL: version.label,
    },
    stdio: "pipe",
  });
  const dataset = JSON.parse(fs.readFileSync(output, "utf8"));
  const reportPath = path.join(dir, "oracle", "oracle-report.json");
  const report = fs.existsSync(reportPath) ? JSON.parse(fs.readFileSync(reportPath, "utf8")) : undefined;
  fs.rmSync(dir, { recursive: true, force: true });
  // The oracle report rides along without becoming part of the dataset's shape.
  Object.defineProperty(dataset, "oracleReport", { value: report, enumerable: false });
  return dataset;
}

function fluid(id, amount, displayName) {
  return { kind: "fluid", id, amount, displayName };
}

function item(id, amount, displayName) {
  return { kind: "item", id, amount, displayName };
}

it("retains long fusion thresholds independently of legacy specialValue", () => {
  const dataset = normalize({ domains: [{ id: "gregtech", recipeMaps: [{
    id: "gt.recipe.fusionreactor", name: "Fusion Reactor",
    catalysts: [{ resource: item("gregtech:gt.blockmachines@32023", 1, "Compact Fusion Computer MK-V"),
      multiblock: true, sourceClass: "goodgenerator.blocks.tileEntity.MTELargeFusionComputer5" }],
    recipes: [{ id: "fusion", durationTicks: 20, eut: 7864320, specialValue: 0, fusionStartupEu: 6_000_000_000,
      fluidInputs: [fluid("a", 1, "A")], fluidOutputs: [fluid("b", 1, "B")] }],
  }] }] });
  expect(dataset.recipes[0].metadata).toMatchObject({ fusionStartupEu: 6_000_000_000, specialValue: 0 });
});

it("retains real furnace tiers and separates the Ore Washing Plant controller across maps", () => {
  const dataset = normalize({ domains: [
    { id: "gregtech", recipeMaps: singleblockCatalysts
      .filter(map => ["gt.recipe.furnace", "gt.recipe.orewasher", "gtpp.recipe.simplewasher"].includes(map.id))
      .map(map => ({ ...map, recipes: map.id === "gt.recipe.furnace" ? [] : [{
        id: map.id, durationTicks: 20, eut: 30,
        itemInputs: [item("minecraft:stone", 1, "Stone")],
        itemOutputs: [item("minecraft:sand", 1, "Sand")],
      }] })) },
    { id: "smelting", recipes: [{ id: "smelt", input: item("minecraft:sand", 1, "Sand"), output: item("minecraft:glass", 1, "Glass") }] },
  ] });
  const furnace = dataset.recipes.find(recipe => recipe.source.recipeMap === "Furnace")
    .machineHandlers.find(handler => handler.id === "electric-furnace");
  expect(furnace).toMatchObject({minimumTier: "LV", maximumTier: "UMV", durationTicks: 128, eut: 4});
  expect(furnace.availableTiers).toEqual(["LV", "MV", "HV", "EV", "IV", "LuV", "ZPM", "UV", "UHV", "UEV", "UIV", "UMV"]);
  const washers = dataset.recipes.filter(recipe => recipe.source.recipeMap !== "Furnace");
  expect(washers).toHaveLength(2);
  for (const recipe of washers) {
    expect(recipe.machineHandlers.find(handler => handler.id === "ore-washing-plant-multiblock")?.kind).toBe("multiblock");
  }
});

const RESISTOR = "gregtech:gt.metaitem.01@32716";
const SMD_RESISTOR = "gregtech:gt.metaitem.03@32011";
const VACUUM_TUBE = "gregtech:gt.metaitem.01@32700";

/**
 * The Circuit Assembler recipe for an Electronic Circuit (the LV tier circuit),
 * as the oracle exports it from the running game. Every slot here is the real
 * thing, and each behaves differently on purpose:
 *
 *   Circuit Board 1x       one exact item, nothing else accepted
 *   Resistor 2x            also takes 2 SMD resistors: GregTech unifies them
 *                          through `componentCircuitResistor`, so NEI shows
 *                          the slot cycling between the two
 *   1x Red Alloy Wire 2x   its ore dictionary group has one member, so no
 *                          choice comes out of it
 *   Vacuum Tube 2x         shares `circuitPrimitive` with the NAND chip and
 *                          STILL takes only vacuum tubes, which is why ore
 *                          dictionary membership cannot be used as the rule
 *   Molten Soldering Alloy 72 L    or 144 L of tin, or 288 L of lead, from
 *                                  `SubstituteFluidStack.soldering(HALF_INGOTS)`
 *
 * Item substitutes come at the slot's own stack size (2 resistors, 2 SMD
 * resistors), fluid substitutes at their own amounts.
 */
const RAW_EXPORT = {
  schemaVersion: 1,
  exporter: "gtnh-oracle",
  format: "dev.gtnhplanner.oracle.v1",
  generatedAt: "2026-08-08T05:00:00.000Z",
  minecraftVersion: "1.7.10",
  loadedMods: [],
  adapters: [],
  recipeCount: 1,
  domains: [
    {
      id: "gregtech",
      recipeMaps: [
        {
          id: "gt.recipe.circuitassembler",
          name: "Circuit Assembler",
          sourceClass: "gregtech.api.recipe.RecipeMap",
          catalysts: [],
          recipes: [
            {
              id: "electronic-circuit",
              enabled: true,
              durationTicks: 200,
              eut: 15,
              itemInputs: [
                item("gregtech:gt.metaitem.03@32100", 1, "Circuit Board"),
                {
                  ...item(RESISTOR, 2, "Resistor"),
                  alternatives: [
                    item(RESISTOR, 2, "Resistor"),
                    item(SMD_RESISTOR, 2, "SMD Resistor"),
                  ],
                },
                item("gregtech:gt.blockmachines@2000", 2, "1x Red Alloy Wire"),
                item(VACUUM_TUBE, 2, "Vacuum Tube"),
              ],
              itemOutputs: [
                { kind: "item", id: "ic2:itempartcircuit", amount: 1, displayName: "Electronic Circuit" },
              ],
              fluidInputs: [
                {
                  ...fluid("molten.solderingalloy", 72, "Molten Soldering Alloy"),
                  alternatives: [
                    fluid("molten.solderingalloy", 72, "Molten Soldering Alloy"),
                    fluid("molten.tin", 144, "Molten Tin"),
                    fluid("molten.lead", 288, "Molten Lead"),
                  ],
                },
              ],
              fluidOutputs: [],
              nonConsumedInputs: [],
            },
          ],
        },
      ],
    },
  ],
};

describe("what a recipe slot accepts", () => {
  let dataset;
  let recipe;

  beforeAll(() => {
    dataset = normalize(RAW_EXPORT);
    recipe = dataset.recipes[0];
  });

  afterAll(() => {
    dataset = undefined;
    recipe = undefined;
  });

  it("keeps the slot's other fluids on the input", () => {
    const solder = recipe.inputs.find((input) => input.id === "molten.solderingalloy");

    expect(solder.alternatives?.map((entry) => entry.displayName)).toEqual([
      "Molten Soldering Alloy",
      "Molten Tin",
      "Molten Lead",
    ]);
  });

  it("stores each substitute as a ratio, not a stack size", () => {
    // 72 L of soldering alloy, 144 L of tin, 288 L of lead. Storing the ratio
    // means the slot can be switched on a recipe of any size, so the amount is
    // divided out here and multiplied back when the swap actually happens.
    const solder = recipe.inputs.find((input) => input.id === "molten.solderingalloy");
    const byId = new Map(solder.alternatives.map((entry) => [entry.id, entry.amount]));

    expect(byId.get("molten.solderingalloy")).toBe(1);
    expect(byId.get("molten.tin")).toBe(2);
    expect(byId.get("molten.lead")).toBe(4);
    expect(solder.amount * byId.get("molten.lead")).toBe(288);
  });

  it("offers the SMD resistor the resistor slot really takes", () => {
    const resistor = recipe.inputs.find((input) => input.id === RESISTOR);

    expect(resistor.alternatives?.map((entry) => entry.displayName)).toEqual([
      "Resistor",
      "SMD Resistor",
    ]);
  });

  it("keeps an item substitute at the slot's own count", () => {
    // The slot wants 2 resistors and takes 2 SMD resistors, so the ratio is
    // one to one and the count must not drift when the slot is switched.
    const resistor = recipe.inputs.find((input) => input.id === RESISTOR);
    const smd = resistor.alternatives.find((entry) => entry.id === SMD_RESISTOR);

    expect(smd.amount).toBe(1);
    expect(resistor.amount * smd.amount).toBe(2);
  });

  it("invents nothing for a slot that named one exact item", () => {
    // A vacuum tube shares `circuitPrimitive` with the NAND chip, and the
    // machine still takes only vacuum tubes. Offering the group here would
    // describe a recipe the game will not run.
    const vacuumTube = recipe.inputs.find((input) => input.id === VACUUM_TUBE);
    const board = recipe.inputs.find((input) => input.id === "gregtech:gt.metaitem.03@32100");

    expect(vacuumTube.alternatives).toBeUndefined();
    expect(board.alternatives).toBeUndefined();
  });

  it("never lets one recipe's substitutes follow the item into the catalog", () => {
    // The catalog is keyed by id and shared by every recipe. Soldering alloy is
    // swappable in THIS slot; writing that onto the item would offer tin and
    // lead in every other machine that uses solder.
    const solder = dataset.resources.find((entry) => entry.id === "molten.solderingalloy");

    expect(solder).toBeDefined();
    expect(solder.alternatives).toBeUndefined();
  });

  it("does not ship the marker that told the writer which kind these were", () => {
    for (const input of recipe.inputs) {
      expect(input).not.toHaveProperty("slotChoice");
    }
  });
});

/**
 * A slice of the mining domain the oracle exports from GregTech worldgen: one
 * vein spanning two planets (with a repeated material across layers), one
 * small ore, one underground fluid, and one underground fluid whose Forge
 * fluid never registered.
 */
const MINING_EXPORT = {
  schemaVersion: 1,
  exporter: "gtnh-oracle",
  format: "dev.gtnhplanner.oracle.v1",
  generatedAt: "2026-08-13T05:00:00.000Z",
  minecraftVersion: "1.7.10",
  loadedMods: [],
  adapters: [],
  recipeCount: 0,
  domains: [
    {
      id: "mining",
      dimensions: [
        { id: "Overworld", name: "Overworld", fullName: "Overworld", abbr: "Ow", tier: "T0" },
        {
          id: "GalacticraftCore_Moon",
          name: "Moon",
          fullName: "GalacticraftCore_Moon",
          abbr: "Mo",
          tier: "T1",
        },
      ],
      veins: [
        {
          id: "ore.mix.copper",
          name: "Copper",
          weight: 80,
          density: 4,
          size: 24,
          heightRange: "10-50",
          dims: ["Overworld", "GalacticraftCore_Moon"],
          dimAbbrs: ["Ow", "Mo"],
          dimHeightRanges: { Mo: "20-60" },
          dimChances: { Ow: 0.12, Mo: 0.3 },
          ores: [
            {
              role: "primary",
              material: { id: 855, internalName: "Chalcopyrite", name: "Chalcopyrite" },
              ore: item("gregtech:gt.blockores@855", 1, "Chalcopyrite Ore"),
            },
            {
              role: "secondary",
              material: { id: 35, internalName: "Copper", name: "Copper" },
              ore: item("gregtech:gt.blockores@35", 1, "Copper Ore"),
            },
            {
              role: "between",
              material: { id: 32, internalName: "Iron", name: "Iron" },
              ore: item("gregtech:gt.blockores@32", 1, "Iron Ore"),
            },
            {
              role: "sporadic",
              material: { id: 35, internalName: "Copper", name: "Copper" },
              ore: item("gregtech:gt.blockores@35", 1, "Copper Ore"),
            },
          ],
        },
      ],
      smallOres: [
        {
          id: "ore.small.copper",
          material: { id: 35, internalName: "Copper", name: "Copper" },
          heightRange: "40-100",
          amountPerChunk: 12,
          dims: ["Overworld"],
          enabledDims: ["Ow"],
          drops: [item("gregtech:gt.metaitem.01@5035", 1, "Raw Copper Ore")],
        },
      ],
      undergroundFluids: [
        {
          fluidId: "oil",
          fluid: fluid("oil", 1, "Oil"),
          deposits: [
            { dim: "Overworld", chance: 40, minAmount: 100, maxAmount: 625 },
            { dim: "Moon", chance: 20, minAmount: 0, maxAmount: 300 },
          ],
        },
        {
          fluidId: "never_registered",
          deposits: [{ dim: "Overworld", chance: 5, minAmount: 1, maxAmount: 2 }],
        },
      ],
    },
  ],
};

describe("mining worldgen becomes source recipes", () => {
  let dataset;

  beforeAll(() => {
    dataset = normalize(MINING_EXPORT);
  });

  afterAll(() => {
    dataset = undefined;
  });

  it("turns a vein into an instant zero-power source with no inputs", () => {
    const vein = dataset.recipes.find((recipe) => recipe.kind === "ore_vein");

    expect(vein).toBeDefined();
    expect(vein.name).toBe("Ore Vein: Copper");
    expect(vein.machineType).toBe("Ore Vein");
    expect(vein.inputs).toEqual([]);
    expect(vein.durationTicks).toBe(1);
    expect(vein.eut).toBe(0);
  });

  it("lists a twice-layered material once and keeps every layer's role", () => {
    const vein = dataset.recipes.find((recipe) => recipe.kind === "ore_vein");

    expect(vein.outputs.map((output) => output.id)).toEqual([
      "gregtech:gt.blockores@855",
      "gregtech:gt.blockores@35",
      "gregtech:gt.blockores@32",
    ]);
    expect(vein.metadata.oreLayers.map((layer) => layer.role)).toEqual([
      "primary",
      "secondary",
      "between",
      "sporadic",
    ]);
  });

  it("resolves planets to names, rocket tiers, and per-planet odds", () => {
    const vein = dataset.recipes.find((recipe) => recipe.kind === "ore_vein");

    expect(vein.metadata.dimensions).toEqual([
      { name: "Overworld", abbr: "Ow", tier: 0, chance: 0.12 },
      { name: "Moon", abbr: "Mo", tier: 1, chance: 0.3, heightRange: "20-60" },
    ]);
  });

  it("turns a small ore's drop list into its outputs", () => {
    const smallOre = dataset.recipes.find((recipe) => recipe.kind === "small_ore");

    expect(smallOre).toBeDefined();
    expect(smallOre.name).toBe("Small Ore: Copper");
    expect(smallOre.outputs.map((output) => output.id)).toEqual([
      "gregtech:gt.metaitem.01@5035",
    ]);
    expect(smallOre.metadata.amountPerChunk).toBe(12);
    expect(smallOre.metadata.dimensions).toEqual([{ name: "Overworld", abbr: "Ow", tier: 0 }]);
  });

  it("keeps underground fluid deposits per planet", () => {
    const undergroundFluid = dataset.recipes.find(
      (recipe) => recipe.kind === "underground_fluid",
    );

    expect(undergroundFluid).toBeDefined();
    expect(undergroundFluid.outputs.map((output) => output.id)).toEqual(["oil"]);
    expect(undergroundFluid.metadata.deposits).toEqual([
      { dimension: "Overworld", abbr: "Ow", tier: 0, chance: 40, minAmount: 100, maxAmount: 625 },
      { dimension: "Moon", abbr: "Mo", tier: 1, chance: 20, minAmount: 0, maxAmount: 300 },
    ]);
  });

  it("drops an underground fluid whose fluid never registered", () => {
    const ids = dataset.recipes.map((recipe) => recipe.id);

    expect(ids.some((id) => id.includes("never_registered"))).toBe(false);
  });

  it("registers the three source recipe maps", () => {
    expect(dataset.recipeMaps).toEqual(
      expect.arrayContaining(["Ore Vein", "Small Ore", "Underground Fluid"]),
    );
  });
});

/**
 * Two GregTech veins can carry the same ores (Nether Quartzite and the space
 * Quartzite & Quartz vein): they are still two veins, with their own name,
 * dimensions and stats. Only the same game identity exported twice folds.
 */
describe("recipes named by a game identity are not folded by their contents", () => {
  const quartzOres = [
    {
      role: "primary",
      material: { id: 523, internalName: "Quartzite", name: "Quartzite" },
      ore: item("gregtech:gt.blockores@523", 1, "Quartzite Ore"),
    },
    {
      role: "secondary",
      material: { id: 522, internalName: "CertusQuartz", name: "Certus Quartz" },
      ore: item("gregtech:gt.blockores@522", 1, "Certus Quartz Ore"),
    },
  ];
  const nether = { id: "ore.mix.quartz", name: "Quartzite", weight: 20, density: 2, size: 16,
    heightRange: "80-120", dims: ["Nether"], dimAbbrs: ["Ne"], ores: quartzOres };
  const space = { id: "ore.mix.quartzspace", name: "Quartzite & Quartz", weight: 20, density: 2, size: 16,
    heightRange: "40-80", dims: ["GalacticraftCore_Moon"], dimAbbrs: ["Mo"], ores: quartzOres };
  const smallOre = (id, dim) => ({
    id,
    material: { id: 527, internalName: "GarnetRed", name: "Red Garnet" },
    heightRange: "10-60",
    amountPerChunk: 8,
    dims: [dim],
    enabledDims: [dim === "Overworld" ? "Ow" : "Mo"],
    drops: [item("gregtech:gt.metaitem.01@5527", 1, "Raw Red Garnet Ore")],
  });
  const miningExport = (veins, smallOres = []) => ({
    ...MINING_EXPORT,
    domains: [{ ...MINING_EXPORT.domains[0], veins, smallOres, undergroundFluids: [] }],
  });

  it("keeps two veins with the same ores in different dimensions, each with its own name and dimensions", () => {
    const dataset = normalize(miningExport([nether, space]));
    const veins = dataset.recipes.filter((recipe) => recipe.kind === "ore_vein");

    expect(veins.map((vein) => vein.id).sort()).toEqual([
      "oracle:ore-vein:ore-mix-quartz",
      "oracle:ore-vein:ore-mix-quartzspace",
    ]);
    const byId = new Map(veins.map((vein) => [vein.metadata.veinId, vein]));
    expect(byId.get("ore.mix.quartz").name).toBe("Ore Vein: Quartzite");
    expect(byId.get("ore.mix.quartz").metadata.heightRange).toBe("80-120");
    expect(JSON.stringify(byId.get("ore.mix.quartz").metadata.dimensions)).toContain("Nether");
    expect(byId.get("ore.mix.quartzspace").name).toBe("Ore Vein: Quartzite & Quartz");
    expect(byId.get("ore.mix.quartzspace").metadata.heightRange).toBe("40-80");
    expect(JSON.stringify(byId.get("ore.mix.quartzspace").metadata.dimensions)).toContain("Moon");
    expect(JSON.stringify(byId.get("ore.mix.quartzspace").metadata.dimensions)).not.toContain("Nether");
  });

  it("keeps two small ores that drop the same ore", () => {
    const dataset = normalize(miningExport([], [smallOre("ore.small.garnetred", "Overworld"),
      smallOre("ore.small.redgarnet", "GalacticraftCore_Moon")]));
    const smallOres = dataset.recipes.filter((recipe) => recipe.kind === "small_ore");

    expect(smallOres.map((recipe) => recipe.id).sort()).toEqual([
      "oracle:small-ore:ore-small-garnetred",
      "oracle:small-ore:ore-small-redgarnet",
    ]);
  });

  it("still folds the same vein exported twice into one recipe", () => {
    const dataset = normalize(miningExport([nether, { ...nether }]));
    const veins = dataset.recipes.filter((recipe) => recipe.kind === "ore_vein");

    expect(veins.map((vein) => vein.id)).toEqual(["oracle:ore-vein:ore-mix-quartz"]);
    expect(dataset.oracleReport.failures).toEqual([]);
  });

  it("refuses an export that lists one identity twice with different contents", () => {
    let error;
    try {
      normalize(miningExport([nether, { ...nether, heightRange: "10-20" }], [
        smallOre("ore.small.garnetred", "Overworld"),
        smallOre("ore.small.garnetred", "GalacticraftCore_Moon"),
      ]));
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeDefined();
    expect(String(error.stderr)).toContain(
      "2 game identities are exported more than once with different contents (oracle:ore-vein:ore-mix-quartz, oracle:small-ore:ore-small-garnetred)",
    );
  });
});

describe("IC2 crops that drop something only on a block under them or with a redstone signal", () => {
  const stats = (id, drops, conditions) => ({
    id, label: id, growth: 23, gain: 31, resistance: 0, durationTicks: 1000,
    ...(conditions ? { conditions } : {}), drops: drops.map((resource) => ({ resource })),
  });
  const redGranite = { key: "ore:stoneGraniteRed", kind: "blockBelow", oreDict: "stoneGraniteRed", displayName: "Red Granite" };
  const granite = { key: "ore:blockGranite", kind: "blockBelow", oreDict: "blockGranite", displayName: "Granite" };
  const cobble = { key: "block:minecraft:cobblestone", kind: "blockBelow", block: "minecraft:cobblestone", displayName: "Cobblestone" };
  const stone = { key: "block:minecraft:stone", kind: "blockBelow", block: "minecraft:stone", displayName: "Stone" };
  const redstone = { key: "redstone", kind: "redstoneSignal", displayName: "a redstone signal" };
  const crop = (id, name, variants) => ({
    className: "Crop", id, name, owner: "berriespp", tier: 3, variants,
    seed: item("ic2:itemcropseed", 1, `${name} Seeds`),
  });
  const cropsExport = (crops) => ({ domains: [{ id: "ic2Crops", crops }] });
  const ic2Crops = (dataset) => dataset.recipes.filter((recipe) => recipe.category === "ic2-crop");

  it("makes one recipe per condition, named and required, with no plain recipe when the plain crop drops nothing", () => {
    const dataset = normalize(cropsExport([
      crop("35", "Red Stonelilly", [
        stats("23-31-0", [item("gregtech:gt.metaitem.01@2849", 2.5, "Red Granite Dust")], [redGranite]),
        stats("23-31-0", [item("gregtech:gt.blockgranites", 2.5, "Granite")], [granite]),
      ]),
      crop("37", "Gray Stonelilly", [
        stats("23-31-0", [item("gregtech:gt.metaitem.01@2299", 2.5, "Stone Dust")], [cobble, stone]),
      ]),
    ]));
    const recipes = ic2Crops(dataset);

    expect(recipes.map((recipe) => recipe.id).sort()).toEqual([
      "oracle:ic2-crop:berriespp:35:under-blockgranite",
      "oracle:ic2-crop:berriespp:35:under-stonegranitered",
      "oracle:ic2-crop:berriespp:37:under-minecraft-cobblestone-or-under-minecraft-stone",
    ]);
    const gray = recipes.find((recipe) => recipe.metadata.cropId === "37");
    expect(gray.name).toBe("IC2 Crop: Gray Stonelilly (on Cobblestone or Stone)");
    expect(gray.metadata.requirements).toEqual(["Needs Cobblestone or Stone under it"]);
    expect(gray.metadata.cropConditions.map((condition) => condition.block)).toEqual([
      "minecraft:cobblestone", "minecraft:stone",
    ]);
    expect(gray.notes).toContain("Needs Cobblestone or Stone under it.");
    expect(gray.outputs.map((slot) => slot.id)).toEqual(["gregtech:gt.metaitem.01@2299"]);
  });

  it("names a block with no item name after the item with its id, else after its id, never by the id", () => {
    const skullBlock = { key: "block:minecraft:skull", kind: "blockBelow", block: "minecraft:skull", displayName: "minecraft:skull" };
    const skullOre = { key: "ore:itemSkull", kind: "blockBelow", oreDict: "itemSkull", displayName: "Skeleton Skull" };
    const fence = { key: "block:minecraft:nether_brick_fence", kind: "blockBelow", block: "minecraft:nether_brick_fence",
      displayName: "minecraft:nether_brick_fence" };
    const dataset = normalize({ domains: [
      { id: "smelting", recipes: [{ id: "s", input: item("minecraft:bone", 1, "Bone"),
        output: item("minecraft:skull", 1, "Skeleton Skull") }] },
      { id: "ic2Crops", crops: [
        crop("58", "Essence Berry", [stats("23-31-0", [item("tconstruct:oreberries@5", 12, "Essence Berry")], [skullBlock, skullOre])]),
        crop("99", "Fence Berry", [stats("23-31-0", [item("minecraft:stick", 2, "Stick")], [fence])]),
      ] },
    ] });
    const [essence, fenceBerry] = ["58", "99"].map((id) => ic2Crops(dataset).find((recipe) => recipe.metadata.cropId === id));

    expect(essence.metadata.requirements).toEqual(["Needs Skeleton Skull under it"]);
    expect(essence.name).toBe("IC2 Crop: Essence Berry (on Skeleton Skull)");
    expect(essence.metadata.cropConditions.map((condition) => condition.displayName)).toEqual(["Skeleton Skull", "Skeleton Skull"]);
    expect(fenceBerry.metadata.requirements).toEqual(["Needs Nether Brick Fence under it"]);
    const shown = [essence, fenceBerry].flatMap((recipe) => [recipe.name, recipe.notes, ...recipe.metadata.requirements,
      ...recipe.metadata.cropConditions.map((condition) => condition.displayName)]);
    expect(shown.join("\n")).not.toContain("minecraft:");
  });

  it("names an IC2 crop exported by its lang key after its seed bag, with the same id", () => {
    const wheat = (name, seed) => ({ ...crop("15", name, [
      stats("23-31-0", [item("minecraft:redstone", 1.5, "Redstone")]),
    ]), owner: "IC2", seed });
    const named = ic2Crops(normalize(cropsExport([wheat("Redwheat", item("ic2:itemcropseed", 1, "Redwheat Seeds"))])))[0];
    const [fromSeed] = ic2Crops(normalize(cropsExport([wheat("ic2.crop.redwheat", item("ic2:itemcropseed", 1, "Redwheat Seeds"))])));
    const [fromKey] = ic2Crops(normalize(cropsExport([wheat("ic2.crop.terraWart", undefined)])));

    expect(fromSeed.name).toBe("IC2 Crop: Redwheat");
    expect(fromSeed.id).toBe(named.id);
    expect(fromSeed.inputs[0]).toMatchObject({ id: named.inputs[0].id, displayName: "Redwheat Seed" });
    expect(fromSeed.inputs[0].tooltip).toContain("Crop: Redwheat");
    expect(fromKey.name).toBe("IC2 Crop: Terra Wart");
    expect(fromKey.id).toBe(named.id);
  });

  it("renames only IC2's own crops: another mod's dotted name stays as it is", () => {
    const drops = [stats("23-31-0", [item("minecraft:redstone", 1, "Redstone")])];
    const [other] = ic2Crops(normalize(cropsExport([crop("7", "berriespp.crop.Ex.Ample", drops)])));
    const { owner, ...unowned } = crop("8", "ic2.crop.terraWart", drops);
    const [ic2Key] = ic2Crops(normalize(cropsExport([{ ...unowned, seed: undefined }])));

    expect(owner).toBe("berriespp");
    expect(other.name).toBe("IC2 Crop: berriespp.crop.Ex.Ample");
    expect(ic2Key.name).toBe("IC2 Crop: Terra Wart");
  });

  it("keeps the plain crop's recipe and id and adds the condition beside it", () => {
    const plainOnly = normalize(cropsExport([crop("15", "Red Wheat", [
      stats("23-31-0", [item("minecraft:redstone", 1.5, "Redstone"), item("minecraft:wheat", 1.5, "Wheat")]),
    ])]));
    const dataset = normalize(cropsExport([crop("15", "Red Wheat", [
      stats("23-31-0", [item("minecraft:redstone", 1.5, "Redstone"), item("minecraft:wheat", 1.5, "Wheat")]),
      stats("23-31-0", [item("minecraft:redstone", 3, "Redstone")], [redstone]),
    ])]));
    const [plain] = ic2Crops(plainOnly);
    const recipes = ic2Crops(dataset);

    expect(recipes).toHaveLength(2);
    const withoutStamp = (recipe) => ({ ...recipe, runtimeCalculation: { ...recipe.runtimeCalculation, generatedAt: undefined } });
    expect(withoutStamp(recipes.find((recipe) => recipe.id === plain.id))).toEqual(withoutStamp(plain));
    const powered = recipes.find((recipe) => recipe.id !== plain.id);
    expect(powered.id).toBe("oracle:ic2-crop:berriespp:15:redstone-signal");
    expect(powered.name).toBe("IC2 Crop: Red Wheat (with a redstone signal)");
    expect(powered.metadata.requirements).toEqual(["Needs a redstone signal"]);
    expect(powered.outputs.map((slot) => slot.id)).toEqual(["minecraft:redstone"]);
  });
});

describe("the two maps the game both calls Coke Oven", () => {
  const rawRecipe = (id, itemInputs, itemOutputs) => ({
    id,
    durationTicks: 1800,
    eut: 0,
    itemInputs,
    itemOutputs,
    fluidInputs: [],
    fluidOutputs: [],
  });
  let dataset;

  beforeAll(() => {
    dataset = normalize({
      schemaVersion: 1,
      exporter: "gtnh-oracle",
      format: "dev.gtnhplanner.oracle.v1",
      generatedAt: "2026-08-08T05:00:00.000Z",
      minecraftVersion: "1.7.10",
      loadedMods: [],
      adapters: [],
      recipeCount: 2,
      domains: [
        {
          id: "gregtech",
          recipeMaps: [
            {
              id: "gtpp.recipe.cokeoven",
              name: "Coke Oven",
              sourceClass: "gregtech.api.recipe.RecipeMap",
              recipes: [
                rawRecipe(
                  "ico-1",
                  [item("minecraft:log", 16, "Oak Log")],
                  [item("minecraft:coal@1", 20, "Charcoal")],
                ),
              ],
            },
            {
              id: "gt.recipe.cokeoven",
              name: "Coke Oven",
              sourceClass: "gregtech.api.recipe.RecipeMap",
              recipes: [
                rawRecipe(
                  "brick-1",
                  [item("minecraft:log", 1, "Oak Log")],
                  [item("minecraft:coal@1", 1, "Charcoal")],
                ),
              ],
            },
          ],
        },
      ],
    });
  });

  it("names the Industrial Coke Oven's map after the machine", () => {
    const ico = dataset.recipes.find(
      (recipe) => recipe.source?.rawRecipeId?.startsWith("gtpp.recipe.cokeoven:"),
    );

    expect(ico.machineType).toBe("Industrial Coke Oven");
    expect((ico.machineConfigControls ?? []).map((control) => control.id)).toEqual(
      expect.arrayContaining(["heatingCoil", "cokeOvenCasing", "cokeOvenSlices"]),
    );
  });

  it("leaves the Railcraft brick oven's map alone, without the ICO's knobs", () => {
    const brick = dataset.recipes.find(
      (recipe) => recipe.source?.rawRecipeId?.startsWith("gt.recipe.cokeoven:"),
    );

    expect(brick.machineType).toBe("Coke Oven");
    expect(brick.machineConfigControls ?? []).toEqual([]);
  });

  it("keeps the two families apart in the map list", () => {
    expect(dataset.recipeMaps).toEqual(
      expect.arrayContaining(["Industrial Coke Oven", "Coke Oven"]),
    );
  });
});

describe("the Tank: the planner's free canner", () => {
  let dataset;

  beforeAll(() => {
    dataset = normalize({
      schemaVersion: 1,
      exporter: "gtnh-oracle",
      format: "dev.gtnhplanner.oracle.v1",
      generatedAt: "2026-08-08T05:00:00.000Z",
      minecraftVersion: "1.7.10",
      loadedMods: [],
      adapters: [],
      recipeCount: 3,
      domains: [
        {
          id: "gregtech",
          recipeMaps: [
            {
              id: "gt.recipe.canner",
              name: "Canner",
              sourceClass: "gregtech.api.recipe.RecipeMap",
              recipes: [
                {
                  id: "fill-1",
                  durationTicks: 16,
                  eut: 1,
                  itemInputs: [item("ic2:itemcellempty", 1, "Empty Cell")],
                  fluidInputs: [fluid("water", 1000, "Water")],
                  itemOutputs: [item("ic2:itemfluidcell@water", 1, "Water Cell")],
                  fluidOutputs: [],
                },
                {
                  id: "empty-1",
                  durationTicks: 16,
                  eut: 1,
                  itemInputs: [item("ic2:itemfluidcell@water", 1, "Water Cell")],
                  fluidInputs: [],
                  itemOutputs: [item("ic2:itemcellempty", 1, "Empty Cell")],
                  fluidOutputs: [fluid("water", 1000, "Water")],
                },
                {
                  id: "food-1",
                  durationTicks: 16,
                  eut: 1,
                  itemInputs: [item("ic2:itemtincan", 1, "Tin Can"), item("minecraft:apple", 1, "Apple")],
                  fluidInputs: [],
                  itemOutputs: [item("ic2:itemfilledtincan", 1, "Filled Tin Can")],
                  fluidOutputs: [],
                },
              ],
            },
          ],
        },
      ],
    });
  });

  it("mirrors every fluid-touching Canner recipe as a free instant Tank recipe", () => {
    const tanks = dataset.recipes.filter((recipe) => recipe.machineType === "Tank");

    expect(tanks).toHaveLength(2);
    for (const tank of tanks) {
      expect(tank.eut).toBe(0);
      expect(tank.durationTicks).toBe(1);
      expect(tank.minimumTier).toBe("NONE");
    }
    const fill = tanks.find((recipe) =>
      recipe.inputs.some((slot) => slot.kind === "fluid"),
    );
    // The empty cell stays a real slot: the game never deletes one.
    expect(fill.inputs.map((slot) => slot.id)).toContain("ic2:itemcellempty");
  });

  it("leaves the Canner's own recipes untouched beside the copies", () => {
    const canners = dataset.recipes.filter((recipe) => recipe.machineType === "Canner");
    expect(canners).toHaveLength(3);
    expect(canners.every((recipe) => recipe.eut === 1)).toBe(true);
  });

  it("does not mirror fluid-free canning, and lists the Tank as a map", () => {
    const tanks = dataset.recipes.filter((recipe) => recipe.machineType === "Tank");
    expect(tanks.some((recipe) => recipe.name.includes("Tin Can"))).toBe(false);
    expect(dataset.recipeMaps).toContain("Tank");
    const icon = dataset.recipeMapIcons.find((entry) => entry.recipeMap === "Tank");
    expect(icon.resource.id).toBe("ic2:itemcellempty");
  });
});

describe("recipe ids survive a rebuild", () => {
  const steel = (id, extra = {}) => ({
    id,
    durationTicks: 500,
    eut: 120,
    itemInputs: [item("gregtech:dust.iron", 1, "Iron Dust"), item("gregtech:dust.coal", 1, "Coal Dust")],
    fluidInputs: [fluid("oxygen", 1000, "Oxygen")],
    itemOutputs: [item("gregtech:ingot.steel", 1, "Steel Ingot")],
    fluidOutputs: [],
    ...extra,
  });
  const exportWith = (recipes) => ({
    schemaVersion: 1,
    exporter: "gtnh-oracle",
    format: "dev.gtnhplanner.oracle.v1",
    generatedAt: "2026-08-08T05:00:00.000Z",
    minecraftVersion: "1.7.10",
    loadedMods: [],
    adapters: [],
    recipeCount: recipes.length,
    domains: [
      {
        id: "gregtech",
        recipeMaps: [
          {
            id: "gt.recipe.blastfurnace",
            name: "Blast Furnace",
            sourceClass: "gregtech.api.recipe.RecipeMap",
            recipes,
          },
        ],
      },
    ],
  });

  it("mints the same id for the same recipe whatever id the exporter gave it", () => {
    // The oracle's id hashed a JVM identity hash, so two exports of one
    // unchanged game disagreed on every id, and every saved plan lost its
    // recipes on import. The id now comes from the recipe's content.
    const first = normalize(exportWith([steel("run-one-7f3a")])).recipes[0];
    const second = normalize(exportWith([steel("run-two-91c0")])).recipes[0];
    expect(second.id).toBe(first.id);
    expect(second.source.rawRecipeId).toBe(first.source.rawRecipeId);
    expect(first.id).not.toContain("run-one");
  });

  it("gives a recipe that differs in one slot, tick or EU its own id", () => {
    const [a, b, c] = normalize(
      exportWith([
        steel("a"),
        steel("b", { itemInputs: [item("gregtech:dust.castiron", 1, "Cast Iron Dust")] }),
        steel("c", { fluidInputs: [fluid("oxygen", 2000, "Oxygen")] }),
      ]),
    ).recipes;
    expect(new Set([a.id, b.id, c.id]).size).toBe(3);
  });

  it("leaves the dataset version out of the id, so another pack's same recipe keeps it", () => {
    const recipe = normalize(exportWith([steel("a")])).recipes[0];
    expect(recipe.id).toMatch(/^oracle:gregtech:gt-recipe-blastfurnace:[0-9a-f]{16}$/);
    expect(recipe.id).not.toContain("test-fixture");
    expect(recipe.source.rawRecipeId).toBe(`gt.recipe.blastfurnace:${recipe.id.split(":").pop()}`);
  });

  it("numbers a pair that shares a key by its bodies, whatever order the export lists them in", () => {
    // The same slots registered in another order: addRecipe keeps both, the key cannot tell them apart.
    const swapped = (id) =>
      steel(id, {
        itemInputs: [item("gregtech:dust.coal", 1, "Coal Dust"), item("gregtech:dust.iron", 1, "Iron Dust")],
      });
    const forward = normalize(exportWith([steel("a"), swapped("b")])).recipes;
    const backward = normalize(exportWith([swapped("b"), steel("a")])).recipes;
    expect(forward).toHaveLength(2);
    expect(new Set(forward.map((recipe) => recipe.id)).size).toBe(2);
    const idOf = (recipes) =>
      new Map(recipes.map((recipe) => [recipe.inputs.map((slot) => slot.id).join(","), recipe.id]));
    expect(idOf(backward)).toEqual(idOf(forward));
  });
});

describe("crafting ids come from the recipe, not its registration", () => {
  const plank = { kind: "oreDictionary", names: ["plankWood"], amount: 1 };
  const stick = { kind: "oreDictionary", names: ["stickWood"], amount: 1 };
  const shaped = (id, pattern) => ({
    id,
    type: "shaped",
    width: 3,
    height: 3,
    output: item("minecraft:wooden_scythe", 1, "Wooden Scythe"),
    inputs: pattern.map((entry, slotIndex) => (entry ? { ...entry, slotIndex } : undefined)).filter(Boolean),
  });
  const crafting = (recipes) =>
    normalize({ domains: [{ id: "crafting", recipes }] }).recipes.filter((recipe) => recipe.category === "crafting");
  const right = [plank, plank, plank, undefined, undefined, stick, undefined, stick, undefined];
  const mirrored = [plank, plank, stick, plank, undefined, undefined, undefined, stick, undefined];

  it("gives the same pattern the same id under any exporter id", () => {
    const [first] = crafting([shaped("registered-17", right)]);
    const [second] = crafting([shaped("registered-4203", right)]);
    expect(second.id).toBe(first.id);
    expect(first.id).toMatch(/^oracle:crafting:shaped:[0-9a-f]{16}$/);
  });

  it("tells a mirrored pattern of ore dictionary slots apart by its layout", () => {
    const ids = crafting([shaped("a", right), shaped("b", mirrored)]).map((recipe) => recipe.id);
    expect(ids).toHaveLength(2);
    expect(ids.every((id) => /:[0-9a-f]{16}$/.test(id))).toBe(true);
    expect(new Set(ids).size).toBe(2);
  });
});

describe("the Extreme Entity Crusher: one recipe per mob", () => {
  const modifier = (name, fields) => ({ className: `com.kuba6000.mobsinfo.api.${name}`, ...(fields ? { fields } : {}) });
  const extra = (name, fields) => ({ className: `com.kuba6000.mobsinfo.loader.extras.${name}`, ...(fields ? { fields } : {}) });
  let dataset;
  let byMob;

  beforeAll(() => {
    dataset = normalize({
      domains: [
        {
          id: "mobDrops",
          machine: {
            mobSpawnInterval: 55,
            maxLootingLevel: 4,
            diamondSpikesDamage: 9,
            playerOnlyDropsModifier: 0.1,
            controller: item("gregtech:gt.blockmachines@14201", 1, "Extreme Entity Crusher"),
            experience: fluid("xpjuice", 120, "Liquid XP"),
            spawner: item("enderio:blockpoweredspawner", 1, "Powered Spawner"),
          },
          infernal: { eliteRarity: 20, ultraRarity: 10, infernoRarity: 7, minEliteModifiers: 2, minUltraModifiers: 5, minInfernoModifiers: 8, mobModHealthFactor: 1.8 },
          mobs: [
            {
              key: "Zombie",
              displayName: "Zombie",
              maxEntityHealth: 20,
              eut: 1920,
              durationTicks: 55,
              drops: [
                { resource: item("minecraft:rotten_flesh", 1, "Rotten Flesh"), chance: 10000, lootable: true },
                { resource: item("minecraft:iron_sword", 1, "Iron Sword"), chance: 3, enchantable: 14, damages: { 26: 1 } },
                { resource: item("minecraft:iron_sword", 1, "Iron Sword"), chance: 10, damages: { 26: 1 } },
                {
                  resource: item("forbiddenmagic:shard@5", 1, "Greed Shard"),
                  chance: 0,
                  chanceModifiers: [
                    modifier("IChanceModifier$NormalChance", { chance: 0 }),
                    modifier("IChanceModifier$EachLevelOfGives", { enchantment: { id: 21 }, change: 5 }),
                    extra("ForbiddenMagic$EachLevelOfGivesFocus", { change: 0 }),
                  ],
                },
                {
                  resource: item("thaumcraft:brain", 1, "Zombie Brain"),
                  chance: 0,
                  chanceModifiers: [modifier("IChanceModifier$NormalChance", { chance: 10 })],
                },
                {
                  resource: item("draconicevolution:soul", 1, "Mob Soul"),
                  chance: 0,
                  chanceModifiers: [extra("DraconicEvolution$DraconicEvolutionSoulChanceModifier", { baseChance: 0.125 })],
                },
                { resource: item("bloodarsenal:heart", 1, "Heart"), chance: 5000, playerOnly: true },
                {
                  resource: item("somemod:head", 1, "Odd Head"),
                  chance: 0,
                  chanceModifiers: [modifier("IChanceModifier$NormalChance", { chance: 5 }), extra("Mystery$NewGate")],
                },
              ],
            },
            {
              key: "Blaze",
              displayName: "Blaze",
              maxEntityHealth: 20,
              eut: 1920,
              durationTicks: 55,
              alwaysInfernal: true,
              drops: [{ resource: item("minecraft:blaze_rod", 1, "Blaze Rod"), chance: 5000, lootable: true }],
            },
            {
              key: "witchery.eye",
              displayName: "Eye",
              maxEntityHealth: 1,
              eut: 1920,
              durationTicks: 55,
              drops: [
                {
                  resource: item("minecraft:ender_eye", 1, "Eye"),
                  chance: 0,
                  chanceModifiers: [modifier("IChanceModifier$NormalChance", { chance: 50 }), modifier("IChanceModifier$PoweredCreeper")],
                },
              ],
            },
          ],
        },
      ],
    });
    byMob = Object.fromEntries(dataset.recipes.map((recipe) => [recipe.metadata.eec.mob, recipe]));
  });

  it("files every mob under the EEC's own map and machine picture", () => {
    expect(dataset.recipes).toHaveLength(3);
    expect(dataset.recipeMaps).toContain("Extreme Entity Crusher");
    expect(dataset.recipeMapIcons).toContainEqual(
      expect.objectContaining({ recipeMap: "Extreme Entity Crusher", resource: expect.objectContaining({ id: "gregtech:gt.blockmachines@14201" }) }),
    );
  });

  it("puts the mob's own spawner in the controller slot, never consumed", () => {
    const zombie = byMob.Zombie;
    expect(zombie).toMatchObject({ name: "Extreme Entity Crusher: Zombie", minimumTier: "EV", eut: 1920, durationTicks: 55 });
    expect(zombie.inputs).toEqual([
      expect.objectContaining({ id: "factoryflow:eec_mob:zombie", displayName: "Zombie Spawner", consumed: false }),
    ]);
  });

  it("keeps only the drops a plain EEC can roll, merging repeats of an item", () => {
    const zombie = byMob.Zombie;
    expect(zombie.outputs.map((output) => [output.id, output.amount, output.chance])).toEqual([
      ["minecraft:rotten_flesh", 1, undefined],
      // Two sword rolls, 3 and 10 in 10,000: one expected count.
      ["minecraft:iron_sword", 0.0013, undefined],
      // Only a Looting weapon makes greed shards: written at Looting I.
      ["forbiddenmagic:shard@5", 0.05, undefined],
      ["thaumcraft:brain", 1, 0.1],
      // Player-only drops come out at a tenth.
      ["bloodarsenal:heart", 1, 0.05],
      ["xpjuice", 120, undefined],
    ]);
    expect(zombie.metadata.eec.outputs[1].drops.every((drop) => drop.voidable)).toBe(true);
    expect(zombie.metadata.eec.outputs[2]).toEqual({ refLooting: 1, drops: [{ amount: 1, c0: 0, cL: 500 }] });
    expect(zombie.metadata.eec.outputs.at(-1)).toEqual({ xp: true });
    // A soul needs Reaper; an unknown modifier is treated as a gate too.
    expect(zombie.notes).toContain("Mob Soul");
    expect(zombie.notes).toContain("Odd Head");
  });

  it("charges an always-infernal mob eight times the power", () => {
    expect(byMob.Blaze).toMatchObject({ eut: 15360, minimumTier: "LuV" });
    expect(byMob.Blaze.metadata.eec.alwaysInfernal).toBe(true);
  });

  it("still lists the Liquid XP of a mob whose every drop is gated", () => {
    expect(byMob["witchery.eye"].outputs.map((output) => output.id)).toEqual(["xpjuice"]);
  });
});

// GT++ names the map gtpp.recipe.lftr.sparging up to 2.8 and gt.recipe.lftr.sparging since 2.9.
describe.each(["gtpp.recipe.lftr.sparging", "gt.recipe.lftr.sparging"])("LFTR sparging (%s): the rolled outputs the recipe registers at 0 L", (mapId) => {
  const tbSalt = (extra = {}) => ({
    id: "sparge-tb",
    durationTicks: 500,
    eut: 7680,
    itemInputs: [],
    fluidInputs: [fluid("fluorine", 100, "Fluorine"), fluid("molten.tbsalt", 50, "TB Salt")],
    itemOutputs: [],
    fluidOutputs: [fluid("molten.spargedtbsalt", 50, "Fluorine Sparged TB Salt")],
    ...extra,
  });
  const rolled = {
    spargeGasAmount: 100,
    spargeMaxByproduct: 20,
    spargeFluidOutputs: [
      fluid("molten.spargedtbsalt", 50, "Fluorine Sparged TB Salt"),
      fluid("fluorine", 0, "Fluorine"),
      fluid("lithiumfluoride", 0, "Lithium Fluoride"),
      fluid("neptuniumhexafluoride", 0, "Neptunium Hexafluoride"),
      fluid("technetiumhexafluoride", 0, "Technetium Hexafluoride"),
      fluid("seleniumhexafluoride", 0, "Selenium Hexafluoride"),
      fluid("thoriumtetrafluoride", 0, "Thorium Tetrafluoride"),
    ],
  };
  // Another sparging recipe that kept its rolled outputs, so a map can hold a plain one.
  const heliumSalt = () => ({
    id: "sparge-he",
    durationTicks: 500,
    eut: 7680,
    itemInputs: [],
    fluidInputs: [fluid("helium", 500, "Helium"), fluid("molten.spargedtbsalt", 50, "Fluorine Sparged TB Salt")],
    itemOutputs: [],
    fluidOutputs: [fluid("molten.heliumspargedtbsalt", 50, "Helium Sparged TB Salt")],
    spargeGasAmount: 500,
    spargeMaxByproduct: 200,
    spargeFluidOutputs: [
      fluid("molten.heliumspargedtbsalt", 50, "Helium Sparged TB Salt"),
      fluid("helium", 0, "Helium"),
      fluid("xenon", 0, "Xenon"),
      fluid("neon", 0, "Neon"),
    ],
  });
  const exportOf = (...recipes) => ({
    domains: [{
      id: "gregtech",
      recipeMaps: [{ id: mapId, name: "LFTR Gas Sparging", recipes }],
    }],
  });
  const tbOf = (dataset) => dataset.recipes.find((recipe) => recipe.inputs.some((slot) => slot.id === "molten.tbsalt"));

  it("lists the gas handed back and every byproduct at its average, ThF4 included", () => {
    const [recipe] = normalize(exportOf(tbSalt(rolled))).recipes;
    const byId = Object.fromEntries(recipe.outputs.map((slot) => [slot.id, slot.amount]));
    expect(recipe.outputs[0].id).toBe("molten.spargedtbsalt");
    // 1-20 L each, the cap never shrinking for the first four rolls.
    expect(byId.thoriumtetrafluoride).toBeGreaterThan(10.4);
    expect(byId.thoriumtetrafluoride).toBeLessThanOrEqual(10.5);
    expect(byId.lithiumfluoride).toBeCloseTo(10.5, 9);
    const byproducts = recipe.outputs.slice(2).reduce((sum, slot) => sum + slot.amount, 0);
    expect(byId.fluorine + byproducts).toBeCloseTo(100, 9);
    expect(recipe.nei.additionalInfo.some((line) => line.includes("1 to 20 L"))).toBe(true);
  });

  it("keeps the recipe id the plain export had, so saved plans keep their card", () => {
    const plain = tbOf(normalize(exportOf(tbSalt(), heliumSalt())));
    const full = tbOf(normalize(exportOf(tbSalt(rolled), heliumSalt())));
    expect(full.id).toBe(plain.id);
    expect(plain.outputs).toHaveLength(1);
    expect(full.outputs).toHaveLength(7);
  });

  it("refuses an export whose sparging recipes all lost their rolled outputs", () => {
    let error;
    try {
      normalize(exportOf(tbSalt(), { ...tbSalt(), id: "sparge-tb-2", fluidInputs: [fluid("fluorine", 150, "Fluorine"), fluid("molten.tbsalt", 50, "TB Salt")] }));
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeDefined();
    expect(String(error.stderr)).toContain(`2 recipe(s) in ${mapId} carry no spargeFluidOutputs`);
  });
});

describe("the wear data guard", () => {
  const ball = item("miscutils:milling.ball.alumina", 1, "Alumina Milling Ball");
  const milling = (id, extra) => ({
    id,
    durationTicks: 2400,
    eut: 1920,
    itemInputs: [item("gregtech:gt.blockores@35", 16, "Sphalerite Ore"), ball],
    itemOutputs: [item("gregtech:gt.metaitem.03@35", 64, "Milled Sphalerite")],
    fluidInputs: [],
    fluidOutputs: [],
    ...extra,
  });
  const worn = { wearingInputs: [{ id: "miscutils:milling.ball.alumina", durability: 50 }] };
  // 2.8.1 names the map gtpp.recipe.oremill; the guard reads it as the game's map.
  const exportOf = (...recipes) => ({
    domains: [{ id: "gregtech", recipeMaps: [{ id: "gtpp.recipe.oremill", name: "IsaMill Milling", recipes }] }],
  });
  const refusal = (rawExport) => {
    try {
      normalize(rawExport);
    } catch (caught) {
      return String(caught.stderr);
    }
    return undefined;
  };

  it("passes a map that carries wear data", () => {
    expect(normalize(exportOf(milling("a", worn), milling("b"))).oracleReport.failures).toEqual([]);
  });

  it("refuses a map whose recipes all lost their wear data", () => {
    expect(refusal(exportOf(milling("a"), milling("b")))).toContain(
      "2 recipe(s) in gtpp.recipe.oremill and none carries wearingInputs",
    );
  });

  it("refuses a map where reading the wear failed", () => {
    expect(refusal(exportOf(milling("a", worn), milling("b", { wearError: "java.lang.NoSuchMethodException" })))).toContain(
      "1 recipe(s) in gtpp.recipe.oremill failed to read which inputs wear (java.lang.NoSuchMethodException)",
    );
  });
});

it("leaves no recipes.json from an earlier run when it refuses an export", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "normalize-stale-"));
  const input = path.join(dir, "oracle-export.json");
  const output = path.join(dir, "recipes.json");
  fs.writeFileSync(output, "{\"stale\":true}");
  fs.writeFileSync(`${output}.gz`, "stale");
  fs.writeFileSync(input, JSON.stringify({ domains: [] }));
  expect(() =>
    execFileSync(process.execPath, [scriptPath, input, output], {
      env: { ...process.env, GTNH_DATASET_VERSION_ID: "test-fixture", GTNH_DATASET_VERSION_LABEL: "test" },
      stdio: "pipe",
    }),
  ).toThrow();
  expect(fs.existsSync(output)).toBe(false);
  expect(fs.existsSync(`${output}.gz`)).toBe(false);
  fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * Thaumcraft 4 arcane workbench recipes as the oracle exports them: the grid read from
 * `getInput()`, a shaped cell carrying its 3x3 position (`gridSlot`), a shapeless recipe one
 * entry per ingredient, and the vis cost as aspects.
 */
describe("Thaumcraft arcane recipes", () => {
  const aspect = (tag, amount) => ({ kind: "aspect", id: `thaumcraft:aspect:${tag}`, tag, amount, displayName: tag });
  const at = (resource, gridSlot) => ({ ...resource, gridSlot });
  const thaumium = { kind: "oreDictionary", names: ["ingotThaumium"] };
  const plank = item("thaumcraft:blockwoodenplanks", 1, "Greatwood Planks");
  const arcane = (id, extra) => ({
    id,
    sourceList: "craftingRecipes",
    type: "arcane",
    className: "thaumcraft.api.crafting.ShapedArcaneRecipe",
    research: "TEST",
    durationTicks: 1,
    ...extra,
  });
  // A 2x2 pattern: thaumium over planks, in the grid's top-left corner.
  const shaped = arcane("shaped", {
    width: 2,
    height: 2,
    output: item("thaumcraft:blocktable@15", 1, "Arcane Table"),
    components: [at(thaumium, 0), at(thaumium, 1), at(plank, 3), at(plank, 4)],
    aspects: [aspect("ordo", 5), aspect("aer", 3)],
  });
  const exportOf = (...recipes) => ({ domains: [{ id: "thaumcraft", recipes }] });
  const arcaneRecipes = (dataset) =>
    dataset.recipes.filter((recipe) => recipe.machineType === "Thaumcraft Arcane Crafting");

  it("a shaped recipe takes its grid items, each in its own cell, and its aspects", () => {
    const [recipe] = arcaneRecipes(normalize(exportOf(shaped)));
    expect(recipe.inputs.map((input) => [input.kind, input.id, input.amount])).toEqual([
      ["item", "oredict:ingotThaumium", 1],
      ["item", "oredict:ingotThaumium", 1],
      ["item", "thaumcraft:blockwoodenplanks", 1],
      ["item", "thaumcraft:blockwoodenplanks", 1],
      ["aspect", "thaumcraft:aspect:ordo", 5],
      ["aspect", "thaumcraft:aspect:aer", 3],
    ]);
    // Cells 0, 1, 3 and 4 of the 3x3 grid, not the first four in a row.
    const cells = recipe.nei.slots
      .filter((slot) => slot.side === "input" && slot.kind === "item")
      .map(({ x, y }) => ({ x, y }));
    expect(cells).toEqual([
      { x: 48, y: 33 },
      { x: 75, y: 33 },
      { x: 49, y: 60 },
      { x: 76, y: 60 },
    ]);
  });

  it("the id keys on the pattern, not on the order the aspects come in", () => {
    const [first] = arcaneRecipes(normalize(exportOf(shaped)));
    const [reordered] = arcaneRecipes(
      normalize(exportOf({ ...shaped, aspects: [...shaped.aspects].reverse() })),
    );
    expect(reordered.id).toBe(first.id);
    const flipped = {
      ...shaped,
      components: [at(plank, 0), at(plank, 1), at(thaumium, 3), at(thaumium, 4)],
    };
    const [other] = arcaneRecipes(normalize(exportOf(flipped)));
    expect(other.id).not.toBe(first.id);
  });

  it("a shapeless recipe takes every ingredient, not one of them", () => {
    const pearl = item("thaumcraft:itemresource@18", 1, "Avarice Pearl");
    const sliver = item("thaumcraft:itemresource@17", 1, "Sliver of Entropy");
    const [recipe] = arcaneRecipes(
      normalize(
        exportOf(
          arcane("shapeless", {
            className: "thaumcraft.api.crafting.ShapelessArcaneRecipe",
            output: item("thaumcraft:itemresource@19", 1, "Shattered Avarice Pearl"),
            components: [pearl, sliver],
            aspects: [aspect("perditio", 8)],
          }),
        ),
      ),
    );
    expect(recipe.inputs.map((input) => input.id)).toEqual([
      "thaumcraft:itemresource@18",
      "thaumcraft:itemresource@17",
      "thaumcraft:aspect:perditio",
    ]);
  });

  it("lists a recipe with an unreadable grid cell in the oracle report", () => {
    const short = {
      ...shaped,
      components: shaped.components.slice(0, 3),
      unresolvedGridInputs: 1,
      unresolvedGridCells: [{ gridSlot: 4, className: "net.minecraft.item.ItemStack", text: "0xitem.null@0" }],
    };
    const report = normalize(exportOf(short)).oracleReport;
    expect(report.unresolvedArcaneGrids).toEqual([
      expect.objectContaining({
        output: "thaumcraft:blocktable@15",
        unresolvedGridInputs: 1,
        cells: [expect.objectContaining({ gridSlot: 4, className: "net.minecraft.item.ItemStack" })],
      }),
    ]);
    expect(report.failures).toEqual([]);
  });

  it("refuses an export with more unreadable arcane grids than the ceiling allows", () => {
    const short = (id) => ({ ...shaped, id, research: id, unresolvedGridInputs: 1, unresolvedGridCells: [] });
    let error;
    try {
      normalize(exportOf(short("a"), short("b"), short("c")));
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeDefined();
    expect(String(error.stderr)).toContain("3 arcane recipe(s) have grid cells the oracle could not read");
  });

  it("wands that share an output item but differ by rod stay apart", () => {
    const wand = (rodId, rodName, nbt) =>
      arcane(`wand-${rodName}`, {
        width: 3,
        height: 3,
        output: { ...item("thaumcraft:wandcasting@110", 1, `${rodName} Wand`), nbt },
        components: [at(item("thaumcraft:wandcap", 1, "Iron Cap"), 2), at(item(rodId, 1, rodName), 4), at(item("thaumcraft:wandcap", 1, "Iron Cap"), 6)],
        aspects: [aspect("aer", 10)],
      });
    const recipes = arcaneRecipes(
      normalize(
        exportOf(
          wand("thaumcraft:wandrod@2", "Reed", '{rod:"reed"}'),
          wand("thaumcraft:wandrod@1", "Obsidian", '{rod:"obsidian"}'),
        ),
      ),
    );
    expect(recipes).toHaveLength(2);
    expect(new Set(recipes.map((recipe) => recipe.id)).size).toBe(2);
  });
});

/**
 * A GTNH 2.8.1 export, trimmed from the real one: GT and GT++ maps (GT++ still
 * names its maps gtpp.recipe.* there; one Cutting Machine recipe with the GT++
 * Industrial Cutting Factory among its machines), the Fluid Canner map 2.9 folded into
 * the Canner, crafting, Thaumcraft, a bee, an IC2 crop with no CropsNH beside
 * it, and mining with no dimension tiers and small ores named by `dims` alone.
 */
describe("a GTNH 2.8.1 export", () => {
  const VERSION = { id: "local-2.8.1", label: "2.8.1" };
  const gregtechMaps = () => oracle281Sample.domains.find((domain) => domain.id === "gregtech").recipeMaps;
  const mapsOf = (dataset, recipeMapId) =>
    dataset.recipes.filter((recipe) => recipe.metadata?.recipeMapId === recipeMapId);
  // The same maps as 2.9 names them, after GT++ merged into GregTech.
  const as29 = (renames) => ({
    ...oracle281Sample,
    domains: [{
      id: "gregtech",
      recipeMaps: gregtechMaps()
        .filter((map) => renames[map.id])
        .map((map) => ({ ...map, ...renames[map.id] })),
    }],
  });
  let dataset;

  beforeAll(() => {
    dataset = normalize(oracle281Sample, VERSION);
  });

  afterAll(() => {
    dataset = undefined;
  });

  it("is a 2.8.1 dataset", () => {
    expect(dataset.gtnhVersion).toBe("2.8.1");
    expect(dataset.datasetVersionId).toBe("local-2.8.1");
    expect(dataset.recipes.every((recipe) => recipe.source.datasetVersionId === "local-2.8.1")).toBe(true);
  });

  it("lists every recipe map the export has, and nothing else", () => {
    const names = gregtechMaps().map((map) => map.name);
    // Exact, so a map that vanished or came out under another name fails here.
    expect(dataset.recipeMaps).toEqual([
      ...names.filter((name) => name !== "Coke Oven" && !name.startsWith("gt.recipe.")),
      // GT++'s Coke Oven is 2.9's Industrial Coke Oven; the untranslated rock breaker is the Boldarnator.
      "Industrial Coke Oven",
      "Boldarnator",
      "Tank",
      "Shaped Crafting",
      "Furnace",
      "Thaumcraft Crucible",
      "Bee Produce",
      "IC2 Crop",
      "Ore Vein",
      "Small Ore",
      "Underground Fluid",
    ].sort());
  });

  it("a 2.8.1 GT++ map keeps its recipes and gets the same id key as its 2.9 twin", () => {
    const gtpp = dataset.recipes.filter((recipe) => recipe.metadata?.recipeMapId?.startsWith("gtpp.recipe."));
    const ids = gtpp.map((recipe) => recipe.id);
    expect(mapsOf(dataset, "gtpp.recipe.multimixer")).toHaveLength(2);
    expect(ids.every((id) => id.startsWith("oracle:"))).toBe(true);
    expect(ids.some((id) => id.includes(":gtpp.recipe."))).toBe(false);
    // Ids slug the map: gt.recipe.multimixer is `gt-recipe-multimixer`.
    expect(ids.some((id) => id.includes("gtpp-recipe"))).toBe(false);

    const twin = normalize(as29({
      "gtpp.recipe.multimixer": { id: "gt.recipe.multimixer" },
      "gtpp.recipe.cokeoven": { id: "gt.recipe.industrialcokeoven", name: "Industrial Coke Oven" },
    }), { id: "local-2.9.0-rc-2", label: "2.9.0-RC-2" });
    expect([
      ...mapsOf(dataset, "gtpp.recipe.multimixer"),
      ...mapsOf(dataset, "gtpp.recipe.cokeoven"),
    ].map((recipe) => recipe.id).sort()).toEqual(twin.recipes.map((recipe) => recipe.id).sort());
  });

  it("gives GT++'s Thermal Boiler map the id of its 2.9 twin, not GT's geothermal fuel map's", () => {
    const [boiler] = mapsOf(dataset, "gtpp.recipe.thermalgeneratorfuel");
    expect(boiler.machineType).toBe("Thermal Boiler");
    expect(boiler.id.startsWith("oracle:gregtech:gt-recipe-thermalboiler:")).toBe(true);
    expect(dataset.recipes.some((recipe) => recipe.id.includes("gt-recipe-thermalgeneratorfuel"))).toBe(false);

    const twin = normalize(as29({ "gtpp.recipe.thermalgeneratorfuel": { id: "gt.recipe.thermalboiler" } }));
    expect(boiler.id).toBe(twin.recipes[0].id);
  });

  it("names a map the game left untranslated after its machine", () => {
    const [recipe] = mapsOf(dataset, "gt.recipe.multiblockrockbreaker");
    expect(recipe.machineType).toBe("Boldarnator");
    expect(recipe.id.startsWith("oracle:gregtech:gt-recipe-multiblockrockbreaker:")).toBe(true);
    expect(dataset.recipeMaps).toContain("Boldarnator");
    expect(dataset.recipeMaps).not.toContain("gt.recipe.multiblockrockbreaker");
  });

  it("a 2.8.1 fluidcanner recipe is mirrored into the Tank map", () => {
    const [canner] = mapsOf(dataset, "gt.recipe.fluidcanner");
    const [tank] = mapsOf(dataset, "planner.tank");
    expect(canner.machineType).toBe("Fluid Canner");
    expect(tank).toMatchObject({ machineType: "Tank", eut: 0, durationTicks: 1 });
    expect(tank.inputs.map((slot) => slot.id)).toEqual(canner.inputs.map((slot) => slot.id));
    expect(tank.outputs.map((slot) => slot.id)).toEqual(canner.outputs.map((slot) => slot.id));
  });

  it("a 2.8.1 Industrial Coke Oven recipe offers its two casings and no coils or slices", () => {
    const ovens = mapsOf(dataset, "gtpp.recipe.cokeoven");
    expect(ovens.length).toBeGreaterThan(0);
    for (const oven of ovens) {
      expect(oven.machineConfigControls.map((control) => control.id)).toEqual(["cokeOvenCasing"]);
      expect(oven.machineConfigControls[0].tiers.map((tier) => tier.key)).toEqual(["18", "30"]);
    }
  });

  it("a 2.8.1 Industrial Cutting Factory keeps its tooltip stats and offers no sawblade; the same export as 2.9 does", () => {
    // 5.09.51.476 MTEIndustrialCuttingMachine.java:182-191: 4 parallels per tier, 1/3 time, 75% EU, no sawblade.
    const factoryOf = (normalized) => {
      const [saw] = mapsOf(normalized, "gt.recipe.cuttingsaw");
      return saw.machineHandlers.find((handler) => handler.id === "industrial-cutting-factory");
    };
    const factory = factoryOf(dataset);
    expect(factory.machineConfigControls.map((control) => control.id)).toEqual(["voltageParallel"]);
    expect(factory.machineConfigControls[0].tiers.map((tier) => tier.parallelPerVoltageTier)).toEqual([4]);
    expect(factory).toMatchObject({ durationTicks: 33, eut: 6 });

    const as29Export = normalize(oracle281Sample, { id: "local-2.9.0-rc-2", label: "2.9.0-RC-2" });
    expect(factoryOf(as29Export).machineConfigControls.map((control) => control.id)).toEqual([
      "voltageParallel",
      "cuttingSawblade",
    ]);
  });

  it("2.8.1 ore veins and small ores normalize without dimension tiers", () => {
    const vein = dataset.recipes.find((recipe) => recipe.kind === "ore_vein");
    const smallOre = dataset.recipes.find((recipe) => recipe.kind === "small_ore");
    const fluid = dataset.recipes.find((recipe) => recipe.kind === "underground_fluid");
    expect(vein.metadata.dimensions.map((dim) => dim.name)).toEqual(["Overworld", "TcetiE", "Twilight"]);
    // The small ore names its dimension by the full name; the alias resolves it.
    expect(smallOre.metadata.dimensions).toEqual([{ name: "Twilight", abbr: "TF" }]);
    for (const dim of [...vein.metadata.dimensions, ...smallOre.metadata.dimensions, ...fluid.metadata.deposits]) {
      expect(dim.tier).toBeUndefined();
      expect(dim.tierLabel).toBeUndefined();
    }
  });

  it("IC2 crops normalize when cropsNhCrops is not_present", () => {
    expect(oracle281Sample.adapters.find((adapter) => adapter.id === "cropsnh-crop-cards").status).toBe("not_present");
    const crop = dataset.recipes.find((recipe) => recipe.category === "ic2-crop");
    expect(crop).toMatchObject({ name: "IC2 Crop: Hemp", machineType: "IC2 Crop" });
    expect(crop.outputs.length).toBeGreaterThan(0);
    expect(new Set(crop.outputs.map((slot) => slot.id))).toEqual(new Set(["minecraft:string"]));
    expect(dataset.recipes.some((recipe) => recipe.category === "cropsnh-crop")).toBe(false);
  });

  it("keeps the crafting, Thaumcraft, furnace and bee recipes", () => {
    const categories = new Set(dataset.recipes.map((recipe) => recipe.category));
    for (const category of ["crafting", "thaumcraft", "furnace", "forestry-bee"]) {
      expect(categories.has(category)).toBe(true);
    }
    const crucible = dataset.recipes.find((recipe) => recipe.category === "thaumcraft");
    expect(crucible.inputs[0].id).toBe("oredict:dustGlowstone");
  });
});

describe("a recipe's minimum tier counts its map's amperage", () => {
  const MAPS = ["gt.recipe.thermalcentrifuge", "gt.recipe.arcfurnace", "gt.recipe.massfab"];
  const rawExport = () => ({ domains: [{ id: "gregtech", recipeMaps: singleblockCatalysts
    .filter((map) => MAPS.includes(map.id))
    .map((map) => ({ ...map, recipes: [
      { id: `${map.id}-low`, durationTicks: 500, eut: 30,
        itemInputs: [item("minecraft:stone", 1, "Stone")], itemOutputs: [item("minecraft:sand", 1, "Sand")] },
      { id: `${map.id}-high`, durationTicks: 500, eut: { "gt.recipe.thermalcentrifuge": 48, "gt.recipe.arcfurnace": 90, "gt.recipe.massfab": 256 }[map.id],
        itemInputs: [item("minecraft:dirt", 1, "Dirt")], itemOutputs: [item("minecraft:gravel", 1, "Gravel")] },
    ] })) }] });
  const tiers = (dataset, mapId, eut) => {
    const recipe = dataset.recipes.find((entry) => entry.metadata?.recipeMapId === mapId && entry.eut === eut);
    return {
      recipe: recipe.minimumTier,
      handlers: Object.fromEntries((recipe.machineHandlers ?? []).map((handler) => [handler.kind, handler.minimumTier])),
    };
  };

  it("2.9: thermal centrifuge (2 A) and mass fab (8 A) start on LV; the arc map is 1 A", () => {
    const dataset = normalize(rawExport(), { id: "local-2.9.0", label: "2.9.0" });
    // A singleblock queries at V x map amps (FindRecipeQuery.java:91); the Large Thermal Refinery's hatches carry the draw.
    expect(tiers(dataset, "gt.recipe.thermalcentrifuge", 48)).toEqual({ recipe: "LV", handlers: { single: "LV", multiblock: "MV" } });
    expect(tiers(dataset, "gt.recipe.thermalcentrifuge", 30).recipe).toBe("LV");
    expect(tiers(dataset, "gt.recipe.massfab", 256).recipe).toBe("LV");
    expect(tiers(dataset, "gt.recipe.arcfurnace", 90).recipe).toBe("MV");
  });

  it("2.8.1: the arc furnace map is 3 A as well", () => {
    const dataset = normalize(rawExport(), { id: "local-2.8.1", label: "2.8.1" });
    expect(tiers(dataset, "gt.recipe.arcfurnace", 90).recipe).toBe("LV");
    expect(tiers(dataset, "gt.recipe.arcfurnace", 90).handlers.single).toBe("LV");
    expect(tiers(dataset, "gt.recipe.thermalcentrifuge", 48)).toEqual({ recipe: "LV", handlers: { single: "LV", multiblock: "MV" } });
    expect(tiers(dataset, "gt.recipe.massfab", 256).recipe).toBe("LV");
  });
});

describe("a stand-in is chosen by the game's rules, never by export order", () => {
  const NEI_SORT = "nei.itemsort.minecraft,nei.itemsort.mod,nei.itemsort.id,nei.itemsort.default,nei.itemsort.damage,nei.itemsort.name";
  const hammer = (nbt, name) => ({ ...item("gregtech:gt.metatool.01@12", 1, name), ...(nbt ? { nbt } : {}) });
  const smelt = (id, input, output) => ({ id, input, output });
  const catalogEntry = (dataset, id) => dataset.resources.find((resource) => resource.id === id);

  it("takes the stack with no NBT, else the smallest NBT, whichever the export met first", () => {
    const recipes = [
      smelt("a", item("minecraft:stone", 1, "Stone"), hammer("{Material:Zinc}", "Zinc Hammer")),
      smelt("b", item("minecraft:sand", 1, "Sand"), hammer("{Material:Iron}", "Iron Hammer")),
    ];
    const forward = normalize({ domains: [{ id: "smelting", recipes }] });
    const backward = normalize({ domains: [{ id: "smelting", recipes: [...recipes].reverse() }] });
    expect(catalogEntry(forward, "gregtech:gt.metatool.01@12").displayName).toBe("Iron Hammer");
    expect(catalogEntry(backward, "gregtech:gt.metatool.01@12")).toEqual(catalogEntry(forward, "gregtech:gt.metatool.01@12"));
    const plain = normalize({
      domains: [{ id: "smelting", recipes: [...recipes, smelt("c", item("minecraft:dirt", 1, "Dirt"), hammer(undefined, "Hammer"))] }],
    });
    expect(catalogEntry(plain, "gregtech:gt.metatool.01@12").displayName).toBe("Hammer");
  });

  it("shows NEI's first listed stack for an item NEI lists", () => {
    const dataset = normalize({
      domains: [{ id: "smelting", recipes: [smelt("a", item("minecraft:stone", 1, "Stone"), hammer("{Material:Zinc}", "Zinc Hammer"))] }],
      neiItemList: {
        status: "exported",
        sort: NEI_SORT,
        stacks: ["item:gregtech:gt.metatool.01@12"],
        firstStacks: [hammer("{Material:Steel}", "Steel Hammer")],
      },
    });
    const entry = catalogEntry(dataset, "gregtech:gt.metatool.01@12");
    expect(entry.displayName).toBe("Steel Hammer");
    expect(entry.tooltip).toEqual(["NBT: {Material:Steel}"]);
  });

  it("lists an ore dictionary tag's members GregTech's unification target first, then in NEI's order, then by id", () => {
    const members = [item("mod:c", 1, "C"), item("mod:a", 1, "A"), item("mod:target", 1, "Target"), item("mod:b", 1, "B")];
    const exportWith = (entries) => ({
      domains: [
        { id: "oreDictionary", entries: { ingotThing: entries }, unificationTargets: { ingotThing: "mod:target" } },
        { id: "smelting", recipes: [smelt("a", { kind: "oreDictionary", names: ["ingotThing"], amount: 1 }, item("minecraft:glass", 1, "Glass"))] },
      ],
      neiItemList: { status: "exported", sort: NEI_SORT, stacks: ["item:mod:c", "item:mod:b"], firstStacks: [] },
    });
    const order = (dataset) => catalogEntry(dataset, "oredict:ingotThing").alternatives.map((entry) => entry.id);
    expect(order(normalize(exportWith(members)))).toEqual(["mod:target", "mod:c", "mod:b", "mod:a"]);
    expect(order(normalize(exportWith([...members].reverse())))).toEqual(["mod:target", "mod:c", "mod:b", "mod:a"]);
  });
});
